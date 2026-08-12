import { useState, useRef, useEffect } from "react";
import { db } from "./firebase";
import { useAuth } from "./AuthContext";
import { collection, addDoc, serverTimestamp, query, where, getDocs, doc, getDoc } from "firebase/firestore";
import { callClaude, callGemini, MODEL, MODEL_FAST } from "./lib/api.js";
import {
  SYS_JSON_ARRAY, SYS_JSON_SHORT, STRUCTURE_READING_PROMPT,
  buildFileCorrectionsAnalysisPrompt,
  buildFileApplyCorrectionBatchPrompt,
  buildAnnotationCorrectionBatchPrompt,
  buildMethodologyReadingPrompt,
} from "./lib/prompts.js";
import { SpinDot } from "./components/SpinDot.jsx";
import { PhotoDropZone } from "./components/PhotoDropZone.jsx";
import { DropZone } from "./components/DropZone.jsx";
import { ClientMaterialsZone } from "./components/ClientMaterialsZone.jsx";
import { extractAnnotations } from "./lib/docxAnnotations.js";
import { openDocxForEditing, refreshTextMap, applyDocxReplacement, removeDocxComment, serializeDocx } from "./lib/docxSurgicalEdit.js";
import { findOutOfRangeCitationInText, countOutOfRangeCitations } from "./lib/citationFormatting.js";

// Скільки завдань ОДНОГО типу групувати в один виклик ШІ при застосуванні правок —
// основне джерело економії токенів: повний текст роботи надсилається раз на групу.
const BATCH_SIZE = 5;

// ─────────────────────────────────────────────
// Чи стосується конкретна правка методички/матеріалів клієнта — щоб не тягнути
// їх у КОЖЕН запит на виправлення (дорого), а лише туди, де це справді потрібно.
// ─────────────────────────────────────────────
const METHODICHKA_HINT_RE = /методичк|оформленн|стил[ьяю].*цитуванн|цитуванн.*стил|шрифт|інтервал|поля\b|таблиц.*оформ|номер.*сторінк|структур.*розділ|дсту|apa|mla/i;
const CLIENT_MATERIALS_HINT_RE = /матеріал.*клієнт|дані клієнта|розрахун|калькуляц|фактичні дані|компані[їя]|підприємств|наведені дані/i;

function classifyContextNeed(task) {
  const text = [task.annotatedText, task.instruction, task.issue, task.suggestion, task.location].filter(Boolean).join(" ");
  return {
    needsMethodichka: METHODICHKA_HINT_RE.test(text),
    needsClientMaterials: CLIENT_MATERIALS_HINT_RE.test(text),
  };
}

function buildExtraContext(task, methodInfo, clientMaterialsSummary) {
  const { needsMethodichka, needsClientMaterials } = classifyContextNeed(task);
  let block = "";
  if (needsMethodichka && methodInfo) {
    const parts = [methodInfo.sourcesFormatRules, methodInfo.citationStyle, methodInfo.formatting?.tableFormat, methodInfo.theoryRequirements].filter(Boolean);
    if (parts.length) block += `\nВИМОГИ МЕТОДИЧКИ: ${parts.join(". ")}`;
  }
  if (needsClientMaterials && clientMaterialsSummary?.rawText) {
    block += `\n\nМАТЕРІАЛИ КЛІЄНТА (використовуй ці дані — не вигадуй, не замінюй):\n${clientMaterialsSummary.rawText.slice(0, 80000)}`;
  }
  return block;
}

// ─────────────────────────────────────────────
// Пошук фрагмента для заміни: дослівно → в межах абзаца-контексту (рятує, якщо
// той самий рядок трапляється в тексті кілька разів) → гнучкий regex, що ігнорує
// різницю в пробілах/лапках/тире (рятує, коли ШІ трохи розходиться з оригіналом
// у пунктуації). Якщо нічого не знайдено — повертає null, і виклик має це
// показати користувачу, а не мовчки пропустити завдання.
// ─────────────────────────────────────────────
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFuzzyPattern(str) {
  return escapeRegex(str.trim())
    .replace(/\s+/g, "\\s+")
    .replace(/["""«»]/g, "[\"“”«»]")
    .replace(/['''`]/g, "['‘’`]")
    .replace(/[-–—]/g, "[-–—]");
}

function locateFragment(text, original, context) {
  if (!original) return null;
  if (context && text.includes(context)) {
    const ctxStart = text.indexOf(context);
    const localIdx = context.indexOf(original);
    if (localIdx !== -1) return { start: ctxStart + localIdx, end: ctxStart + localIdx + original.length };
    try {
      const m = context.match(new RegExp(buildFuzzyPattern(original)));
      if (m) {
        const idx = ctxStart + context.indexOf(m[0]);
        return { start: idx, end: idx + m[0].length };
      }
    } catch { /* некоректний патерн — пробуємо далі по всьому тексту */ }
  }
  const exactIdx = text.indexOf(original);
  if (exactIdx !== -1) return { start: exactIdx, end: exactIdx + original.length };
  try {
    const m = text.match(new RegExp(buildFuzzyPattern(original)));
    if (m) return { start: m.index, end: m.index + m[0].length };
  } catch { /* некоректний regex-патерн з фрагмента */ }
  return null;
}

// ─────────────────────────────────────────────
// Конвертація анотацій (виділення/коментарі Word) → tasks. kind:"annotation" —
// відрізняє їх від ручних зауважень (kind:"manual"), додаваних через doAnalyze,
// щоб doApply міг батчити кожен тип окремим промптом, не змішуючи формати.
// ─────────────────────────────────────────────
function annotationsToTasks(annotations) {
  const tasks = [];
  annotations.highlights.forEach((h, i) => {
    tasks.push({
      id: `h_${i}`,
      kind: "annotation",
      type: "highlight",
      colorInfo: h.colorInfo,
      label: `Виділено ${h.colorInfo?.ua || h.color}`,
      annotatedText: h.text,
      context: h.context,
      instruction: "Виправте або перепишіть виділену частину, зберігаючи стиль і мову документу.",
    });
  });
  annotations.comments.forEach((c, i) => {
    tasks.push({
      id: `c_${i}`,
      kind: "annotation",
      type: "comment",
      colorInfo: null,
      label: `Коментар: ${c.author}`,
      annotatedText: c.commentedText,
      context: null,
      instruction: c.instruction,
      commentId: c.id,
    });
  });
  return tasks;
}

// ─────────────────────────────────────────────
// Завантаження хірургічно відредагованого .docx — serializeDocx уже повертає
// готовий Blob з оригінальним файлом, у якому змінено лише виправлені фрагменти.
// ─────────────────────────────────────────────
function downloadDocxBlob(blob, originalName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const base = originalName?.replace(/\.docx$/i, "") || "документ";
  a.href = url;
  a.download = `${base}_виправлено.docx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────
// Стилі
// ─────────────────────────────────────────────
const cardStyle = { border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 14 };
const cardHead = (bg = "#1a1a14") => ({ padding: "11px 16px", background: bg, display: "flex", alignItems: "center", gap: 10 });
const cardBody = { padding: "14px 16px", background: "#faf8f3" };
const dot = (color) => ({ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 });
const labelStyle = { fontSize: 13, fontWeight: 600, color: "#f5f2eb" };
const btnPrimary = (disabled) => ({ background: disabled ? "#444" : "#1a1a14", color: disabled ? "#888" : "#e8ff47", border: "none", borderRadius: 6, padding: "9px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: disabled ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 });
const btnGreen = (disabled) => ({ background: disabled ? "#444" : "#1a4a1a", color: disabled ? "#aaa" : "#a8e060", border: "none", borderRadius: 6, padding: "9px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: disabled ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 });

// ─────────────────────────────────────────────
// StepBar
// ─────────────────────────────────────────────
const STEPS = ["Файл", "Правки", "Виправлення", "Готово"];

function StepBar({ current }) {
  return (
    <div style={{ display: "flex", alignItems: "center", marginBottom: 24, gap: 0 }}>
      {STEPS.map((s, i) => {
        const active = i === current;
        const done = i < current;
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", flex: i < STEPS.length - 1 ? 1 : "initial" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: done ? "#6a9000" : active ? "#1a1a14" : "#ddd", color: done ? "#fff" : active ? "#e8ff47" : "#aaa", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>
                {done ? "✓" : i + 1}
              </div>
              <div style={{ fontSize: 10, color: active ? "#1a1a14" : "#aaa", fontWeight: active ? 700 : 400, letterSpacing: 0.5 }}>
                {s}
              </div>
            </div>
            {i < STEPS.length - 1 && (
              <div style={{ flex: 1, height: 2, background: done ? "#6a9000" : "#ddd", margin: "0 4px", marginBottom: 16 }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────
// Рядок одного завдання (анотація або ручне зауваження) у списку кроку 1
// ─────────────────────────────────────────────
function TaskRow({ task, isChecked, onToggle }) {
  return (
    <div style={{ padding: "12px 16px", display: "flex", gap: 12, alignItems: "flex-start", opacity: isChecked ? 1 : 0.4 }}>
      <input type="checkbox" checked={isChecked} onChange={e => onToggle(e.target.checked)} style={{ marginTop: 3, accentColor: "#6a9000", flexShrink: 0, cursor: "pointer" }} />
      <div style={{ flex: 1 }}>
        {task.kind === "annotation" ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              {task.type === "highlight" && task.colorInfo && (
                <span style={{ display: "inline-block", background: task.colorInfo.css, color: task.colorInfo.text, fontSize: 10, borderRadius: 3, padding: "1px 7px", fontWeight: 600, letterSpacing: 0.3 }}>
                  {task.colorInfo.ua}
                </span>
              )}
              {task.type === "comment" && (
                <span style={{ display: "inline-block", background: "#dbeafe", color: "#1e40af", fontSize: 10, borderRadius: 3, padding: "1px 7px", fontWeight: 600 }}>
                  💬 {task.label}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "#c04020", marginBottom: task.type === "comment" ? 3 : 0, fontStyle: "italic" }}>
              «{task.annotatedText.slice(0, 120)}{task.annotatedText.length > 120 ? "..." : ""}»
            </div>
            {task.type === "comment" && (
              <div style={{ fontSize: 12, color: "#3a6010", marginTop: 2 }}>
                <span style={{ fontWeight: 600 }}>Інструкція:</span> {task.instruction}
              </div>
            )}
          </>
        ) : task.kind === "citation_pages" ? (
          <>
            <div style={{ fontSize: 10, background: "#dbeafe", color: "#1e40af", display: "inline-block", borderRadius: 3, padding: "1px 7px", fontWeight: 600, marginBottom: 4 }}>
              🔢 Автоматично, без ШІ
            </div>
            <div style={{ fontSize: 13, color: "#2a2a1e" }}>{task.label}</div>
            <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>Номер сторінки підбирається кодом у межах реального обсягу джерела — без ризику вигадування.</div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 10, background: "#e8dcc8", color: "#7a5a2a", display: "inline-block", borderRadius: 3, padding: "1px 7px", fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
              ✏️ {task.location}
            </div>
            <div style={{ fontSize: 13, color: "#c04020", marginBottom: 3 }}><span style={{ fontWeight: 600 }}>Проблема:</span> {task.issue}</div>
            <div style={{ fontSize: 13, color: "#3a6010" }}><span style={{ fontWeight: 600 }}>Що зробити:</span> {task.suggestion}</div>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Головний компонент
// ─────────────────────────────────────────────
export default function FileCorrectionsPage({ onBack }) {
  const { user } = useAuth();

  const [step, setStep] = useState(0);

  // Файл
  const [fileName, setFileName] = useState("");
  const [docText, setDocText] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const fileRef = useRef();
  // {zip, docXml} — живі об'єкти для хірургічного редагування оригінального
  // .docx; не в React-стейті, бо мутуються напряму (DOM/JSZip), а не через рендер.
  const docStateRef = useRef(null);

  // Завдання: об'єднує і автоматично знайдені виділення/коментарі (kind:"annotation"),
  // і ручно введені зауваження (kind:"manual") — програма сама розпізнає перше під
  // час завантаження файлу, друге можна додати в будь-який момент на кроці 1.
  const [extractLoading, setExtractLoading] = useState(false);
  const [annotations, setAnnotations] = useState({ highlights: [], comments: [] });
  const [tasks, setTasks] = useState([]);
  const [checked, setChecked] = useState({});

  // Ручні зауваження — форма для доповнення списку завдань
  const [manualOpen, setManualOpen] = useState(false);
  const [correctionsText, setCorrectionsText] = useState("");
  const [correctionPhotos, setCorrectionPhotos] = useState([]);
  const [analysisLoading, setAnalysisLoading] = useState(false);

  // Застосування (крок 2-3)
  const [applyLoading, setApplyLoading] = useState(false);
  const [applyProgress, setApplyProgress] = useState(0);
  const [correctedText, setCorrectedText] = useState("");
  const [failedTasks, setFailedTasks] = useState([]);
  const [error, setError] = useState("");

  // Контекст (необов'язково): методичка + матеріали клієнта — підтягуються лише
  // до тих правок, де це справді доречно (classifyContextNeed), а не завжди й одразу.
  const [contextOpen, setContextOpen] = useState(false);
  const [myOrders, setMyOrders] = useState(null); // null = ще не завантажено
  const [myOrdersLoading, setMyOrdersLoading] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [methodInfo, setMethodInfo] = useState(null);
  const [methodFileLabel, setMethodFileLabel] = useState("");
  const [methodLoading, setMethodLoading] = useState(false);
  const [methodError, setMethodError] = useState("");
  const [clientMaterials, setClientMaterials] = useState([]);
  const [clientMaterialsManualText, setClientMaterialsManualText] = useState("");

  const clientMaterialsSummary = (() => {
    const combined = [
      ...clientMaterials.map(m => `=== ${m.name} ===\n${m.text}`),
      clientMaterialsManualText.trim(),
    ].filter(Boolean).join("\n\n");
    return combined ? { rawText: combined } : null;
  })();

  // Витрати
  const tokenAccRef = useRef({ inTok: 0, outTok: 0, costUsd: 0, claudeInTok: 0, claudeOutTok: 0, claudeCostUsd: 0 });
  const [sessionCost, setSessionCost] = useState(0);

  useEffect(() => {
    const handler = (e) => {
      if (e.detail.model?.startsWith("gemini") || e.detail.model === "serper") return;
      const cost = e.detail.cost || 0;
      tokenAccRef.current = {
        inTok: tokenAccRef.current.inTok + (e.detail.inTok || 0),
        outTok: tokenAccRef.current.outTok + (e.detail.outTok || 0),
        costUsd: tokenAccRef.current.costUsd + cost,
        claudeInTok: tokenAccRef.current.claudeInTok + (e.detail.inTok || 0),
        claudeOutTok: tokenAccRef.current.claudeOutTok + (e.detail.outTok || 0),
        claudeCostUsd: tokenAccRef.current.claudeCostUsd + cost,
      };
      setSessionCost(c => c + cost);
    };
    window.addEventListener("apicost", handler);
    return () => window.removeEventListener("apicost", handler);
  }, []);

  const checkedCount = Object.values(checked).filter(Boolean).length;

  // ── Список власних замовлень із уже проаналізованою методичкою (для автопідвантаження,
  // щоб не змушувати завантажувати методичку вдруге для роботи, згенерованої в цій програмі) ──
  async function loadMyOrders() {
    if (!user?.uid || myOrders !== null) return;
    setMyOrdersLoading(true);
    try {
      const q = query(collection(db, "orders"), where("uid", "==", user.uid));
      const snap = await getDocs(q);
      const withMethod = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(d => d.methodInfo)
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
        .slice(0, 30);
      setMyOrders(withMethod);
    } catch (e) {
      console.error("Не вдалося завантажити список замовлень", e);
      setMyOrders([]);
    }
    setMyOrdersLoading(false);
  }

  async function selectOrder(orderId) {
    setSelectedOrderId(orderId);
    if (!orderId) { setMethodInfo(null); return; }
    try {
      const snap = await getDoc(doc(db, "orders", orderId));
      const d = snap.data();
      if (d?.methodInfo) setMethodInfo(d.methodInfo);
      if (d?.clientMaterialsSummary?.rawText) setClientMaterialsManualText(d.clientMaterialsSummary.rawText);
    } catch (e) {
      setMethodError("Не вдалося завантажити дані замовлення: " + e.message);
    }
  }

  // ── Ручне завантаження методички (якщо роботу згенеровано не в цій програмі) ──
  async function handleMethodFile(name, b64, type) {
    setMethodFileLabel(name);
    setMethodLoading(true);
    setMethodError("");
    try {
      const docPart = { type: "document", source: { type: "base64", media_type: type || "application/pdf", data: b64 } };
      const structMsgs = [docPart, { type: "text", text: STRUCTURE_READING_PROMPT }];
      const structRaw = await callGemini([{ role: "user", content: structMsgs }], null, SYS_JSON_SHORT, 2000, null, "gemini-2.5-flash", true);
      const structMatch = structRaw.match(/\{[\s\S]*\}/);
      let structureInfo = null;
      try { structureInfo = structMatch ? JSON.parse(structMatch[0]) : null; } catch { /* необов'язковий крок */ }

      const methodMsgs = [docPart, { type: "text", text: buildMethodologyReadingPrompt(structureInfo) }];
      const raw = await callGemini([{ role: "user", content: methodMsgs }], null, SYS_JSON_SHORT, 8000, null, "gemini-2.5-flash", true);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
      setMethodInfo(parsed);
    } catch (e) {
      setMethodError("Не вдалося проаналізувати методичку: " + e.message);
    }
    setMethodLoading(false);
  }

  // ── Витяг анотацій — викликається одразу після завантаження файлу. Програма сама
  // визначає, чи є у файлі виділення/коментарі; якщо немає — просто відкриває форму
  // ручного вводу замість того, щоб змушувати користувача заздалегідь обирати варіант.
  // Заодно суто кодом (без ШІ) перевіряє сторінки у внутрітекстових цитатах на
  // відповідність реальному обсягу джерела — якщо є невалідні, додає окреме
  // завдання, що застосовується напряму, без виклику ШІ (число підбирає код). ──
  async function doExtract(buffer, plainText) {
    setExtractLoading(true);
    setError("");
    try {
      const result = await extractAnnotations(buffer);
      setAnnotations(result);
      const newTasks = annotationsToTasks(result);

      const citationIssues = countOutOfRangeCitations(plainText);
      if (citationIssues > 0) {
        newTasks.push({
          id: "citation_pages",
          kind: "citation_pages",
          label: `Сторінки в цитатах поза межами джерела (${citationIssues})`,
        });
      }

      if (newTasks.length) {
        const defaultChecked = {};
        newTasks.forEach(t => { defaultChecked[t.id] = true; });
        setTasks(newTasks);
        setChecked(defaultChecked);
      } else {
        setManualOpen(true);
      }
    } catch (e) {
      setError("Помилка читання виділень: " + e.message);
      setManualOpen(true);
    }
    setExtractLoading(false);
  }

  // ── Завантаження файлу ──
  async function handleFile(file) {
    if (!file) return;
    setFileLoading(true);
    setError("");
    setTasks([]); setChecked({}); setAnnotations({ highlights: [], comments: [] });
    setManualOpen(false); setCorrectionsText(""); setCorrectionPhotos([]);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const { zip, docXml, plainText } = await openDocxForEditing(arrayBuffer);
      if (!plainText.trim()) throw new Error("Не вдалося витягти текст з документа");
      docStateRef.current = { zip, docXml };
      setFileName(file.name);
      setDocText(plainText);
      await doExtract(arrayBuffer, plainText);
      setStep(1);
    } catch (e) {
      setError("Помилка читання файлу: " + e.message);
    }
    setFileLoading(false);
  }

  // ── Аналіз ручних зауважень — ДОДАЄ нові завдання до вже наявного списку
  // (виявлені виділення/коментарі нікуди не зникають), а не замінює його. ──
  async function doAnalyze() {
    if (!correctionsText.trim() && correctionPhotos.length === 0) return;
    setAnalysisLoading(true);
    setError("");
    try {
      const prompt = buildFileCorrectionsAnalysisPrompt({ documentText: docText, correctionsText });
      const imageContent = correctionPhotos.map(p => ({ type: "image", source: { type: "base64", media_type: p.type, data: p.b64 } }));
      const userContent = imageContent.length ? [...imageContent, { type: "text", text: prompt }] : prompt;
      const raw = await callClaude([{ role: "user", content: userContent }], null, SYS_JSON_ARRAY, 2000, null, MODEL_FAST);
      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
      if (!Array.isArray(parsed)) throw new Error("Некоректна відповідь");
      // Власний унікальний id (а не той, що повернув ШІ) — інакше повторний аналіз
      // міг би дати ті самі "task_1" і зіштовхнутись зі стейтом checked.
      const manualTasks = parsed.map((t, i) => ({ ...t, id: `m_${Date.now()}_${i}`, kind: "manual" }));
      const defaultChecked = {};
      manualTasks.forEach(t => { defaultChecked[t.id] = true; });
      setTasks(prev => [...prev, ...manualTasks]);
      setChecked(prev => ({ ...prev, ...defaultChecked }));
      setCorrectionsText("");
      setCorrectionPhotos([]);
    } catch (e) {
      setError("Помилка аналізу: " + e.message);
    }
    setAnalysisLoading(false);
  }

  // ── Застосування виправлень ──
  async function doApply() {
    const toFix = tasks.filter(t => checked[t.id] !== false);
    if (!toFix.length) return;
    setApplyLoading(true);
    setApplyProgress(0);
    setError("");
    setFailedTasks([]);
    // map/text перебудовуються після КОЖНОЇ застосованої правки (refreshTextMap) —
    // інакше позиції наступних locateFragment з'їдуть відносно вже зміненого XML.
    let { map, plainText: text } = refreshTextMap(docStateRef.current.docXml);
    const failed = [];

    // Групуємо підряд по BATCH_SIZE завдань ОДНОГО типу (annotation/manual — різні
    // промпти) в один виклик ШІ: повний текст роботи надсилається раз на групу.
    const batches = [];
    for (let i = 0; i < toFix.length;) {
      const kind = toFix[i].kind;
      const group = [];
      while (i < toFix.length && toFix[i].kind === kind && group.length < BATCH_SIZE) {
        group.push(toFix[i]); i++;
      }
      batches.push({ kind, items: group });
    }

    let done = 0;
    try {
      for (const { kind, items: batch } of batches) {
        // Сторінки в цитатах — суто кодова перевірка, без ШІ: номер підбирає
        // pickPageInRange у межах реального обсягу джерела, тож ризику
        // вигадування немає. Застосовуємо всі знайдені випадки одразу.
        if (kind === "citation_pages") {
          const task = batch[0];
          let fixedCount = 0;
          for (let guard = 0; guard < 500; guard++) {
            const fix = findOutOfRangeCitationInText(text);
            if (!fix) break;
            applyDocxReplacement(map, fix.start, fix.end, fix.replacement);
            ({ map, plainText: text } = refreshTextMap(docStateRef.current.docXml));
            fixedCount++;
          }
          if (fixedCount === 0) {
            failed.push({ task, reason: "Не вдалося повторно знайти невалідні сторінки — можливо, документ змінився з моменту завантаження." });
          }
          done += batch.length;
          setApplyProgress(done);
          continue;
        }

        const tasksForPrompt = batch.map(t => ({
          ...t,
          extraContext: buildExtraContext(t, methodInfo, clientMaterialsSummary),
        }));
        const prompt = kind === "annotation"
          ? buildAnnotationCorrectionBatchPrompt({ documentText: text, tasks: tasksForPrompt })
          : buildFileApplyCorrectionBatchPrompt({ documentText: text, tasks: tasksForPrompt });
        const maxTokens = Math.min(80000, Math.max(6000, 6000 * batch.length));

        let items = null;
        try {
          const result = await callClaude([{ role: "user", content: prompt }], null, SYS_JSON_ARRAY, maxTokens, null, MODEL);
          const parsed = JSON.parse(result.replace(/```json|```/g, "").trim());
          if (!Array.isArray(parsed)) throw new Error("не масив");
          items = parsed;
        } catch {
          batch.forEach(task => failed.push({ task, reason: "Не вдалося розпізнати відповідь ШІ." }));
          done += batch.length;
          setApplyProgress(done);
          continue;
        }

        for (let i = 0; i < batch.length; i++) {
          const task = batch[i];
          const item = items.find(p => p?.index === i) ?? items[i];
          if (!item) {
            failed.push({ task, reason: "ШІ не повернув результат для цього завдання." });
          } else if (item.status === "needs_review") {
            failed.push({ task, reason: item.note || "Потрібна ручна перевірка — ШІ не може підтвердити правильне значення." });
          } else {
            const loc = item.original ? locateFragment(text, item.original, task.context) : null;
            if (loc) {
              applyDocxReplacement(map, loc.start, loc.end, item.replacement || "");
              if (task.commentId) await removeDocxComment(docStateRef.current.zip, docStateRef.current.docXml, task.commentId);
              ({ map, plainText: text } = refreshTextMap(docStateRef.current.docXml));
            } else {
              failed.push({ task, reason: "Фрагмент не знайдено в тексті документа — заміну не застосовано." });
            }
          }
          done++;
          setApplyProgress(done);
        }
      }
      setCorrectedText(text);
      setFailedTasks(failed);
      setStep(3);
      try {
        const acc = tokenAccRef.current;
        await addDoc(collection(db, "orders"), {
          mode: "file_corrections", type: "file_corrections",
          topic: `Правки: ${fileName}`, uid: user?.uid || null,
          createdAt: new Date().toISOString(), timestamp: serverTimestamp(),
          fileName, correctionsApplied: toFix.length - failed.length, correctionsFailed: failed.length,
          totalInTok: acc.inTok, totalOutTok: acc.outTok, totalCostUsd: acc.costUsd,
          claudeInTok: acc.claudeInTok, claudeOutTok: acc.claudeOutTok, claudeCostUsd: acc.claudeCostUsd,
          geminiInTok: 0, geminiOutTok: 0, geminiCostUsd: 0, serperCredits: 0, serperCostUsd: 0,
          info: { topic: `Правки: ${fileName}`, orderNumber: null },
        });
      } catch { /**/ }
    } catch (e) {
      setError("Помилка виправлення: " + e.message);
    }
    setApplyLoading(false);
  }

  function toggleAll(val) {
    const next = {};
    tasks.forEach(t => { next[t.id] = val; });
    setChecked(next);
  }

  function resetFile() {
    docStateRef.current = null;
    setStep(0); setFileName(""); setDocText("");
    setAnnotations({ highlights: [], comments: [] }); setTasks([]); setChecked({});
    setManualOpen(false); setCorrectionsText(""); setCorrectionPhotos([]);
    setCorrectedText(""); setError(""); setApplyProgress(0); setFailedTasks([]);
  }

  function reset() {
    resetFile();
    setContextOpen(false); setSelectedOrderId(""); setMethodInfo(null);
    setMethodFileLabel(""); setMethodError(""); setClientMaterials([]); setClientMaterialsManualText("");
  }

  // ─────────────────────────────────────────────
  // РЕНДЕР
  // ─────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "#f5f2eb", fontFamily: "'Spectral', Georgia, serif", padding: "0 0 60px" }}>
      {/* Хедер */}
      <div style={{ background: "#1a1a14", padding: "14px 24px", display: "flex", alignItems: "center", gap: 14, position: "sticky", top: 0, zIndex: 10 }}>
        <button
          onClick={() => {
            if (step === 0) { onBack(); return; }
            if (step === 1) { resetFile(); return; }
            if (step === 2) { setStep(1); setApplyProgress(0); return; }
            // currentDocText НЕ скидаємо на docText — оригінальний docXml у docStateRef
            // вже незворотно змінено попередніми правками, тож текст має й далі
            // відповідати саме йому, а не давно застарілому вихідному тексту.
            if (step === 3) { setStep(1); setCorrectedText(""); setApplyProgress(0); setFailedTasks([]); }
          }}
          style={{ background: "none", border: "none", color: "#888", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: 4 }}
        >←</button>
        <div style={{ color: "#e8ff47", fontFamily: "'Spectral SC',serif", fontSize: 14, letterSpacing: 3 }}>ПРАВКИ ДО ФАЙЛУ</div>
        {sessionCost > 0 && <div style={{ marginLeft: "auto", fontSize: 11, color: "#888", fontFamily: "monospace" }}>сесія: ${sessionCost.toFixed(4)}</div>}
      </div>

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "28px 20px 0" }}>
        <StepBar current={step} />

        {error && (
          <div style={{ background: "#fff0f0", border: "1.5px solid #f00a", borderRadius: 8, padding: "10px 16px", marginBottom: 14, fontSize: 13, color: "#c00" }}>
            {error}
          </div>
        )}

        {/* ═══ КРОК 0: Завантаження файлу ═══ */}
        {step === 0 && (
          <>
            <div style={cardStyle}>
              <div style={cardHead()}>
                <div style={dot("#e8ff47")} />
                <div style={labelStyle}>Завантажте вашу роботу (.docx)</div>
              </div>
              <div style={cardBody}>
                <div
                  onClick={() => fileRef.current.click()}
                  onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}
                  onDragOver={e => e.preventDefault()}
                  style={{ minHeight: 120, border: "1.5px dashed #c4bfb4", borderRadius: 6, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer", background: "#ede9e0" }}
                >
                  {fileLoading || extractLoading
                    ? <><SpinDot /><div style={{ fontSize: 12, color: "#888" }}>{fileLoading ? "Читаю файл..." : "Шукаю виділення та коментарі..."}</div></>
                    : <>
                      <div style={{ fontSize: 32 }}>📄</div>
                      <div style={{ fontSize: 13, color: "#555" }}>Перетягніть або клікніть щоб вибрати .docx</div>
                      <div style={{ fontSize: 11, color: "#aaa" }}>Кольорові виділення й коментарі Word розпізнаються автоматично — якщо їх немає, можна буде додати зауваження вручну</div>
                    </>
                  }
                </div>
                <input ref={fileRef} type="file" accept=".docx" style={{ display: "none" }} onChange={e => handleFile(e.target.files[0])} />
              </div>
            </div>

            {/* Опціональний контекст: методичка / матеріали клієнта — підтягуються лише
                до тих правок, де це дійсно доречно (формат, стиль цитування, розрахунки тощо) */}
            <div style={cardStyle}>
              <div
                onClick={() => { setContextOpen(o => !o); if (!contextOpen) loadMyOrders(); }}
                style={{ ...cardHead("#2a2a1e"), cursor: "pointer", justifyContent: "space-between" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={dot(methodInfo || clientMaterialsSummary ? "#a8e060" : "#666")} />
                  <div style={labelStyle}>Контекст роботи (необов'язково): методичка, матеріали клієнта</div>
                </div>
                <div style={{ color: "#888", fontSize: 12 }}>{contextOpen ? "▲" : "▼"}</div>
              </div>
              {contextOpen && (
                <div style={cardBody}>
                  <div style={{ fontSize: 11, color: "#888", marginBottom: 10, lineHeight: 1.6 }}>
                    Потрібно лише для правок, що стосуються оформлення за методичкою (таблиці, цитування) або даних клієнта. Для звичайних стилістичних правок можна пропустити.
                  </div>

                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, color: "#aaa", marginBottom: 6, letterSpacing: 0.5 }}>ЦЯ РОБОТА ЗГЕНЕРОВАНА В ACADEM ASSIST?</div>
                    {myOrdersLoading ? (
                      <div style={{ fontSize: 12, color: "#888", display: "flex", alignItems: "center", gap: 8 }}><SpinDot />Завантажую ваші замовлення...</div>
                    ) : (
                      <select
                        value={selectedOrderId}
                        onChange={e => selectOrder(e.target.value)}
                        style={{ width: "100%", fontSize: 13, padding: "8px 10px", borderRadius: 6, border: "1px solid #d4cfc4", background: "#f5f2ea", color: "#2a2a1e", fontFamily: "inherit" }}
                      >
                        <option value="">— оберіть замовлення, якщо є —</option>
                        {(myOrders || []).map(o => (
                          <option key={o.id} value={o.id}>{o.topic || o.info?.topic || o.id}</option>
                        ))}
                      </select>
                    )}
                    {selectedOrderId && methodInfo && (
                      <div style={{ fontSize: 11, color: "#6a9000", marginTop: 6 }}>✓ Дані методички й матеріалів підтягнуто із замовлення</div>
                    )}
                  </div>

                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, color: "#aaa", marginBottom: 6, letterSpacing: 0.5 }}>АБО ЗАВАНТАЖТЕ МЕТОДИЧКУ САМІ (PDF)</div>
                    <DropZone fileLabel={methodFileLabel} onFile={handleMethodFile} />
                    {methodLoading && <div style={{ fontSize: 12, color: "#888", marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}><SpinDot />Аналізую методичку...</div>}
                    {methodError && <div style={{ fontSize: 12, color: "#c00", marginTop: 6 }}>{methodError}</div>}
                    {methodInfo && !methodLoading && !selectedOrderId && <div style={{ fontSize: 11, color: "#6a9000", marginTop: 6 }}>✓ Методичку проаналізовано</div>}
                  </div>

                  <div>
                    <div style={{ fontSize: 11, color: "#aaa", marginBottom: 6, letterSpacing: 0.5 }}>МАТЕРІАЛИ КЛІЄНТА (необов'язково)</div>
                    <ClientMaterialsZone
                      materials={clientMaterials}
                      onAdd={m => setClientMaterials(prev => [...prev, m])}
                      onRemove={i => setClientMaterials(prev => prev.filter((_, idx) => idx !== i))}
                      manualText={clientMaterialsManualText}
                      onManualText={setClientMaterialsManualText}
                    />
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* ═══ КРОК 1: Список правок (виявлені автоматично + додані вручну) ═══ */}
        {step === 1 && (
          <>
            <div style={{ ...cardStyle, marginBottom: 14 }}>
              <div style={cardHead("#1a2a00")}>
                <div style={dot("#a8e060")} />
                <div style={labelStyle}>Файл завантажено</div>
                <div style={{ marginLeft: "auto", fontSize: 11, color: "#a8e060" }}>{fileName}</div>
              </div>
            </div>

            {tasks.length > 0 && (
              <div style={{ ...cardStyle, border: "1.5px solid #4a6a00" }}>
                <div style={{ ...cardHead("#1a2a00"), justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={dot("#a8e060")} />
                    <div style={labelStyle}>
                      Знайдено правок: {tasks.length} ({annotations.highlights.length} виділень, {annotations.comments.length} коментарів{tasks.some(t => t.kind === "citation_pages") ? ", сторінки в цитатах" : ""}{tasks.some(t => t.kind === "manual") ? `, ${tasks.filter(t => t.kind === "manual").length} вручну` : ""})
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => toggleAll(true)} style={{ fontSize: 10, color: "#a8e060", background: "transparent", border: "1px solid #4a6a00", borderRadius: 4, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Всі</button>
                    <button onClick={() => toggleAll(false)} style={{ fontSize: 10, color: "#888", background: "transparent", border: "1px solid #444", borderRadius: 4, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Жоден</button>
                  </div>
                </div>
                <div style={{ background: "#faf8f3" }}>
                  {tasks.map((task, i) => (
                    <div key={task.id} style={{ borderBottom: i < tasks.length - 1 ? "1px solid #e8e4dc" : "none" }}>
                      <TaskRow task={task} isChecked={checked[task.id] !== false} onToggle={val => setChecked(prev => ({ ...prev, [task.id]: val }))} />
                    </div>
                  ))}
                </div>
                <div style={{ padding: "12px 16px", background: "#1a2a00", display: "flex", gap: 10, alignItems: "center" }}>
                  <button onClick={() => setStep(2)} disabled={checkedCount === 0} style={btnGreen(checkedCount === 0)}>
                    Виправити обрані ({checkedCount}) →
                  </button>
                </div>
              </div>
            )}

            {/* Ручні зауваження — завжди доступно як доповнення до автоматично знайденого */}
            <div style={cardStyle}>
              <div
                onClick={() => setManualOpen(o => !o)}
                style={{ ...cardHead(), cursor: "pointer", justifyContent: "space-between" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={dot("#e8ff47")} />
                  <div style={labelStyle}>{tasks.length ? "Додати зауваження вручну (необов'язково)" : "Зауваження викладача"}</div>
                </div>
                <div style={{ color: "#888", fontSize: 12 }}>{manualOpen ? "▲" : "▼"}</div>
              </div>
              {manualOpen && (
                <div style={cardBody}>
                  <textarea
                    value={correctionsText}
                    onChange={e => setCorrectionsText(e.target.value)}
                    placeholder={"Вставте зауваження від викладача...\nНаприклад: «Висновки надто короткі. Вступ не розкриває актуальність.»"}
                    style={{ width: "100%", minHeight: 130, fontSize: 13, lineHeight: "1.8", color: "#2a2a1e", background: "#f5f2ea", borderRadius: 6, padding: "12px 14px", border: "1px solid #d4cfc4", fontFamily: "'Spectral',serif", resize: "vertical", boxSizing: "border-box" }}
                  />
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 11, color: "#888", marginBottom: 6, letterSpacing: 1 }}>АБО ДОДАЙТЕ ФОТО ЗАУВАЖЕНЬ:</div>
                    <PhotoDropZone
                      photos={correctionPhotos}
                      onAdd={photo => setCorrectionPhotos(prev => [...prev, photo])}
                      onRemove={i => setCorrectionPhotos(prev => prev.filter((_, idx) => idx !== i))}
                    />
                  </div>
                  <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center" }}>
                    <button onClick={doAnalyze} disabled={analysisLoading || (!correctionsText.trim() && correctionPhotos.length === 0)} style={btnPrimary(analysisLoading || (!correctionsText.trim() && correctionPhotos.length === 0))}>
                      {analysisLoading ? <><SpinDot />Аналізую...</> : "Додати до списку правок →"}
                    </button>
                    {analysisLoading && <span style={{ fontSize: 12, color: "#888" }}>Claude визначає що потрібно виправити</span>}
                  </div>
                </div>
              )}
            </div>

            <button onClick={resetFile} style={{ background: "none", border: "none", color: "#aaa", fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: "4px 0" }}>
              ← Завантажити інший файл
            </button>
          </>
        )}

        {/* ═══ КРОК 2: Виправлення ═══ */}
        {step === 2 && (
          <>
            <div style={{ ...cardStyle, border: "1.5px solid #4a6a00" }}>
              <div style={cardHead("#1a2a00")}>
                <div style={dot("#a8e060")} />
                <div style={labelStyle}>Виправляю {checkedCount} елементів...</div>
              </div>
              <div style={{ padding: "16px", background: "#faf8f3" }}>
                <div style={{ height: 6, borderRadius: 3, background: "#e8e4dc", overflow: "hidden", marginBottom: 12 }}>
                  <div style={{ height: "100%", borderRadius: 3, background: "#a8e060", width: `${Math.round((applyProgress / checkedCount) * 100)}%`, transition: "width 0.4s ease" }} />
                </div>
                <div style={{ fontSize: 13, color: "#3a6010" }}>
                  {applyLoading
                    ? `Виправляю... (${applyProgress} з ${checkedCount})`
                    : applyProgress === 0
                      ? "Готово до виправлення"
                      : "Завершено"}
                </div>
              </div>
              <div style={{ padding: "12px 16px", background: "#1a2a00" }}>
                <button onClick={doApply} disabled={applyLoading} style={btnGreen(applyLoading)}>
                  {applyLoading ? <><SpinDot light />Виправляю...</> : "Почати виправлення →"}
                </button>
              </div>
            </div>
            <button onClick={() => { setStep(1); setApplyProgress(0); }} style={{ background: "none", border: "none", color: "#aaa", fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: "4px 0" }}>
              ← Назад до списку
            </button>
          </>
        )}

        {/* ═══ КРОК 3: Готово ═══ */}
        {step === 3 && (
          <>
            <div style={{ ...cardStyle, border: "1.5px solid #4a6a00" }}>
              <div style={cardHead("#1a2a00")}>
                <div style={dot("#a8e060")} />
                <div style={labelStyle}>{failedTasks.length ? "Виправлення внесено частково" : "Виправлення внесено"}</div>
              </div>
              <div style={{ ...cardBody, maxHeight: 300, overflowY: "auto" }}>
                <pre style={{ fontSize: 12, color: "#333", whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit", lineHeight: 1.7 }}>
                  {correctedText.slice(0, 1200)}{correctedText.length > 1200 ? "\n\n...[решта документа]" : ""}
                </pre>
              </div>
            </div>

            {failedTasks.length > 0 && (
              <div style={{ ...cardStyle, border: "1.5px solid #a04a1a", marginTop: 14 }}>
                <div style={cardHead("#3a1a0a")}>
                  <div style={dot("#e8a060")} />
                  <div style={labelStyle}>Не вдалося виправити автоматично ({failedTasks.length}) — перевірте вручну</div>
                </div>
                <div style={{ background: "#faf8f3" }}>
                  {failedTasks.map(({ task, reason }, i) => (
                    <div key={i} style={{ padding: "12px 16px", borderBottom: i < failedTasks.length - 1 ? "1px solid #e8e4dc" : "none" }}>
                      <div style={{ fontSize: 12, color: "#c04020", fontStyle: "italic", marginBottom: 3 }}>
                        «{(task.annotatedText || task.issue || task.location || task.label || "").slice(0, 140)}»
                      </div>
                      <div style={{ fontSize: 12, color: "#a04a1a" }}><span style={{ fontWeight: 600 }}>Причина:</span> {reason}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 14 }}>
              <button
                onClick={async () => {
                  const blob = await serializeDocx(docStateRef.current.zip, docStateRef.current.docXml);
                  downloadDocxBlob(blob, fileName);
                }}
                style={btnGreen(false)}
              >
                Завантажити виправлений .docx
              </button>
              <button
                onClick={() => { setStep(1); setApplyProgress(0); setCorrectedText(""); setFailedTasks([]); }}
                style={{ ...btnPrimary(false), background: "transparent", color: "#555", border: "1px solid #ccc" }}
              >
                Внести ще правки
              </button>
              <button onClick={reset} style={{ background: "none", border: "none", color: "#aaa", fontSize: 12, cursor: "pointer", fontFamily: "inherit", alignSelf: "center" }}>
                Новий файл
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
