import { useState, useRef, useEffect, useMemo } from "react";
import { db } from "./firebase";
import { useAuth } from "./AuthContext";
import { collection, addDoc, updateDoc, serverTimestamp, query, where, getDocs, doc, getDoc } from "firebase/firestore";
import { callClaude, callGemini, MODEL, MODEL_FAST, resetGenerationCost, getGenerationCost, GENERATION_COST_LIMIT } from "./lib/api.js";
import {
  SYS_JSON, SYS_JSON_ARRAY, SYS_JSON_SHORT, STRUCTURE_READING_PROMPT,
  buildSYS,
  buildFileCorrectionsAnalysisPrompt,
  buildFileApplyCorrectionBatchPrompt,
  buildAnnotationCorrectionBatchPrompt,
  buildDocumentWideCorrectionPrompt,
  buildSourcesRestructureAnalysisPrompt,
  buildSourcePlacementInTextPrompt,
  buildMethodologyReadingPrompt,
} from "./lib/prompts.js";
import { SpinDot } from "./components/SpinDot.jsx";
import { PhotoDropZone } from "./components/PhotoDropZone.jsx";
import { DropZone } from "./components/DropZone.jsx";
import { ClientMaterialsZone } from "./components/ClientMaterialsZone.jsx";
import { extractAnnotations } from "./lib/docxAnnotations.js";
import { openDocxForEditing, refreshTextMap, applyDocxReplacement, removeDocxComment, serializeDocx } from "./lib/docxSurgicalEdit.js";
import { findOutOfRangeCitationInText, countOutOfRangeCitations, locateSourcesZone, findNextCitationToRenumber, formatSourcesWithRetry } from "./lib/citationFormatting.js";
import { locateFragment } from "./lib/textFragmentLocate.js";

// Скільки завдань ОДНОГО типу групувати в один виклик ШІ при застосуванні правок —
// основне джерело економії токенів: повний текст роботи надсилається раз на групу.
const BATCH_SIZE = 5;

const LANG_OPTIONS = ["Українська", "English", "Польська", "Німецька", "Французька", "Іспанська"];

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

// ─────────────────────────────────────────────
// Зауваження, що явно стосується ВСЬОГО документа ("так має бути по всій
// роботі", "виправ скрізь" тощо), а не лише одного позначеного місця — такі
// завдання йдуть окремим шляхом (applyDocumentWideTask): ШІ шукає й виправляє
// ВСІ відповідні місця в тексті за один прохід, а не тільки те, де було
// залишено саме зауваження.
// ─────────────────────────────────────────────
const DOCUMENT_WIDE_HINT_RE = /по\s+всій\s+робот|по\s+всьому\s+документ|у\s+всьому\s+текст|у\s+всій\s+роботі|скрізь|усюди|кожного\s+разу|весь\s+документ|усі\s+згадк|щораз/i;

function isDocumentWideTask(task) {
  const text = [task.annotatedText, task.instruction, task.noteText, task.issue, task.suggestion].filter(Boolean).join(" ");
  return DOCUMENT_WIDE_HINT_RE.test(text);
}

// ─────────────────────────────────────────────
// Типова обізнаність розділу — знаходить, чи фрагмент лежить у Вступі/Висновках/
// Списку джерел (за найближчим заголовком ПЕРЕД ним), щоб не дати ШІ поламати
// структурні вимоги до цих розділів (нумерацію джерел, склад вступу тощо).
// ─────────────────────────────────────────────
const ZONE_HEADING_RE = /^(ВСТУП|INTRODUCTION|ВИСНОВКИ|CONCLUSIONS?|СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ|СПИСОК ЛІТЕРАТУРИ|REFERENCES|BIBLIOGRAPHY|РОЗДІЛ\s+\d+|CHAPTER\s+\d+)\s*$/im;

function detectZoneAtPosition(text, pos) {
  if (pos == null || pos < 0) return null;
  const before = text.slice(0, pos);
  const re = new RegExp(ZONE_HEADING_RE.source, "gim");
  let m, zone = null;
  while ((m = re.exec(before))) {
    const h = m[1].toUpperCase();
    if (/ВСТУП|INTRODUCTION/.test(h)) zone = "intro";
    else if (/ВИСНОВК|CONCLUSION/.test(h)) zone = "conclusions";
    else if (/ДЖЕРЕЛ|ЛІТЕРАТУР|REFERENCES|BIBLIOGRAPHY/.test(h)) zone = "sources";
    else zone = null;
  }
  return zone;
}

function detectZoneFromLocation(location) {
  if (!location) return null;
  if (/джерел|літератур|references|bibliography/i.test(location)) return "sources";
  if (/висновк|conclusion/i.test(location)) return "conclusions";
  if (/вступ|introduction/i.test(location)) return "intro";
  return null;
}

function buildZoneGuard(zone) {
  if (zone === "intro") return "\nЦе ВСТУП — обов'язково збережи всі стандартні структурні елементи (актуальність теми, мета, завдання дослідження, об'єкт, предмет, методи дослідження, практичне значення, структура роботи) в тому ж порядку й кількості, навіть якщо виправляєш лише частину.";
  if (zone === "conclusions") return "\nЦе ВИСНОВКИ — збережи структуру по одному абзацу на кожен пункт, без нумерації та без нових посилань [N].";
  if (zone === "sources") return "\nЦе СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ — КАТЕГОРИЧНО ЗАБОРОНЕНО змінювати нумерацію, порядок чи кількість джерел. Виправляй ЛИШЕ те, про що сказано в завданні (форматування, розділові знаки).";
  return "";
}

function buildCitationGuard(existingCitationNumbers) {
  if (!existingCitationNumbers?.length) {
    return "\nЦИТУВАННЯ: у цьому фрагменті немає визначеного списку джерел — категорично заборонено додавати нові посилання [N].";
  }
  return `\nЦИТУВАННЯ: у документі існують лише джерела з номерами ${existingCitationNumbers.join(", ")}. Можеш посилатись на будь-яке з них під його реальним номером, якщо доречно. КАТЕГОРИЧНО ЗАБОРОНЕНО вигадувати номер джерела, якого немає в цьому списку.`;
}

function buildIllustrationGuard(hasIt) {
  return hasIt ? "\nІЛЮСТРАЦІЇ КЛІЄНТА: якщо у фрагменті є рядок-маркер [КЛІЄНТ-ІЛЮСТРАЦІЯ:N] — ОБОВ'ЯЗКОВО збережи його ТОЧНО без змін, включно з номером N." : "";
}

// Комбінує весь додатковий контекст для одного завдання: методичка/матеріали
// клієнта (лише коли ключові слова завдання натякають, що це доречно) + захисні
// правила (цитування, тип розділу, маркери ілюстрацій) — застосовуються завжди.
function buildTaskPromptExtras(task, { methodInfo, clientMaterialsSummary, existingCitationNumbers, text }) {
  const { needsMethodichka, needsClientMaterials } = classifyContextNeed(task);
  let block = "";
  if (needsMethodichka && methodInfo) {
    const parts = [methodInfo.sourcesFormatRules, methodInfo.citationStyle, methodInfo.formatting?.tableFormat, methodInfo.theoryRequirements].filter(Boolean);
    if (parts.length) block += `\nВИМОГИ МЕТОДИЧКИ: ${parts.join(". ")}`;
  }
  if (needsClientMaterials && clientMaterialsSummary?.rawText) {
    block += `\n\nМАТЕРІАЛИ КЛІЄНТА (використовуй ці дані — не вигадуй, не замінюй):\n${clientMaterialsSummary.rawText.slice(0, 80000)}`;
  }

  const zone = task.kind === "manual"
    ? detectZoneFromLocation(task.location)
    : detectZoneAtPosition(text, locateFragment(text, task.annotatedText, task.context)?.start);
  block += buildZoneGuard(zone);
  block += buildCitationGuard(existingCitationNumbers);

  const hasIllustrations = /\[КЛІЄНТ-ІЛЮСТРАЦІЯ:/.test(task.annotatedText || task.context || task.location || "");
  block += buildIllustrationGuard(hasIllustrations);

  return block;
}

// ─────────────────────────────────────────────
// Контроль обсягу — якщо виправлений фрагмент сильно "поплив" відносно оригіналу
// (значне ручне завдання, не дрібна правка), допрошуємо ШІ дописати чи скоротити
// до приблизно того самого обсягу, щоб довжина роботи не "гуляла" від правок.
// ─────────────────────────────────────────────
function wc(s) {
  const t = (s || "").trim();
  return t ? t.split(/\s+/).length : 0;
}

async function adjustVolume({ original, replacement, lang, methodInfo, label }) {
  const origWords = wc(original);
  const newWords = wc(replacement);
  if (origWords <= 30 || !replacement) return replacement;
  const sys = buildSYS(lang, methodInfo);
  if (newWords < origWords * 0.7) {
    const missing = origWords - newWords;
    const contPrompt = `Ось поточний текст фрагмента "${label || ""}" (${newWords} слів, оригінал мав ${origWords}):\n\n${replacement}\n\nДопиши ще приблизно ${missing} слів, органічно продовжуючи виклад далі, не повторюючи вже написане. Без вступних фраз, без заголовків. Просто продовж текст.`;
    try {
      const contRaw = await callClaude([{ role: "user", content: contPrompt }], null, sys, Math.min(20000, Math.max(2000, Math.round(missing * 3))), null, MODEL, { cache: true });
      return (replacement + "\n\n" + contRaw).trim();
    } catch { return replacement; }
  }
  if (newWords > origWords * 1.5) {
    const shortenPrompt = `Ось поточний текст фрагмента "${label || ""}" (${newWords} слів):\n\n${replacement}\n\nСкороти його до приблизно ${origWords} слів: прибери повтори та другорядні деталі, збережи головні тези. Поверни лише скорочений текст, без коментарів.`;
    try {
      const shortRaw = await callClaude([{ role: "user", content: shortenPrompt }], null, sys, Math.min(30000, Math.max(4000, Math.round(origWords * 3))), null, MODEL, { cache: true });
      return shortRaw.trim();
    } catch { return replacement; }
  }
  return replacement;
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
      instruction: "Виправте або перепишіть виділену частину, зберігаючи стиль і мову документу. Якщо всередині виділеного фрагмента є питання чи вимога від керівника (звернення до автора, знак питання, прохання щось уточнити чи додати) — це НЕ частина тексту роботи: розпізнай його окремо, дай на нього фактичну відповідь (якщо вона однозначно випливає з контексту — наприклад, автор перекладу цитати) і органічно встав цю відповідь у текст, а саме питання повністю прибери з фінального результату. Якщо відповідь не випливає однозначно з контексту — не вигадуй її, залиш позначку needs_review.",
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
  // Нотатки, вписані прямо в абзац червонуватим кольором шрифту (не справжній
  // коментар Word і не підсвітка) — на відміну від highlight/comment вище,
  // тут "фрагмент для заміни" (annotatedText) — ВЕСЬ абзац, а не сама нотатка:
  // сам проблемний текст, на який вона вказує, лежить поруч, а не всередині неї.
  (annotations.colorNotes || []).forEach((n, i) => {
    tasks.push({
      id: `cn_${i}`,
      kind: "annotation",
      type: "color_note",
      colorInfo: null,
      label: "Нотатка (колір шрифту)",
      annotatedText: n.context,
      context: null,
      noteText: n.text,
      instruction: `У цьому фрагменті вписана від руки нотатка керівника, виділена кольором шрифту: "${n.text}". Виправ фрагмент відповідно до цієї нотатки (якщо вона стосується сусіднього тексту — виправ саме його), і обов'язково повністю прибери саму нотатку з фінального тексту.`,
    });
  });
  tasks.forEach(t => { t.documentWide = isDocumentWideTask(t); });
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
// Рядок одного завдання (анотація, ручне зауваження, сторінки в цитатах чи
// перебудова джерел) у списку кроку 1
// ─────────────────────────────────────────────
function TaskRow({ task, isChecked, onToggle, hasConflict }) {
  return (
    <div style={{ padding: "12px 16px", display: "flex", gap: 12, alignItems: "flex-start", opacity: isChecked ? 1 : 0.4 }}>
      <input type="checkbox" checked={isChecked} onChange={e => onToggle(e.target.checked)} style={{ marginTop: 3, accentColor: "#6a9000", flexShrink: 0, cursor: "pointer" }} />
      <div style={{ flex: 1 }}>
        {task.kind === "annotation" ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
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
              {task.type === "color_note" && (
                <span style={{ display: "inline-block", background: "#fbe0e0", color: "#a01e1e", fontSize: 10, borderRadius: 3, padding: "1px 7px", fontWeight: 600 }}>
                  🖊 {task.label}
                </span>
              )}
              {hasConflict && (
                <span title="Ще одна правка стосується того самого фрагмента тексту" style={{ display: "inline-block", background: "#fde2b8", color: "#8a4a00", fontSize: 10, borderRadius: 3, padding: "1px 7px", fontWeight: 600 }}>
                  ⚠ перетинається з іншою правкою
                </span>
              )}
              {task.documentWide && (
                <span title="ШІ шукатиме й виправлятиме всі відповідні місця в документі, не лише це" style={{ display: "inline-block", background: "#dfe8ff", color: "#1e3a8a", fontSize: 10, borderRadius: 3, padding: "1px 7px", fontWeight: 600 }}>
                  📌 стосується всього документа
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "#c04020", marginBottom: task.type === "comment" || task.type === "color_note" ? 3 : 0, fontStyle: "italic" }}>
              «{(task.type === "color_note" ? task.noteText : task.annotatedText).slice(0, 120)}{(task.type === "color_note" ? task.noteText : task.annotatedText).length > 120 ? "..." : ""}»
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
        ) : task.kind === "sources_restructure" ? (
          <>
            <div style={{ fontSize: 10, background: "#fbe8e0", color: "#c04020", display: "inline-block", borderRadius: 3, padding: "1px 7px", fontWeight: 600, marginBottom: 4 }}>
              ⚠ Перебудова списку джерел
            </div>
            <div style={{ fontSize: 13, color: "#c04020", marginBottom: 3 }}><span style={{ fontWeight: 600 }}>Проблема:</span> {task.issue}</div>
            <div style={{ fontSize: 13, color: "#3a6010" }}><span style={{ fontWeight: 600 }}>Що зробити:</span> {task.suggestion}</div>
          </>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
              <div style={{ fontSize: 10, background: "#e8dcc8", color: "#7a5a2a", display: "inline-block", borderRadius: 3, padding: "1px 7px", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
                ✏️ {task.location}
              </div>
              {task.documentWide && (
                <span title="ШІ шукатиме й виправлятиме всі відповідні місця в документі, не лише це" style={{ display: "inline-block", background: "#dfe8ff", color: "#1e3a8a", fontSize: 10, borderRadius: 3, padding: "1px 7px", fontWeight: 600 }}>
                  📌 стосується всього документа
                </span>
              )}
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
  // Той самий Firestore-документ оновлюється (не пересоздається) на кожному
  // наступному раунді правок у межах цієї сесії — так history накопичується
  // в одному записі, а не розсипається по окремих.
  const orderDocIdRef = useRef(null);

  // Завдання: об'єднує і автоматично знайдені виділення/коментарі (kind:"annotation"),
  // і ручно введені зауваження (kind:"manual") — програма сама розпізнає перше під
  // час завантаження файлу, друге можна додати в будь-який момент на кроці 1.
  const [extractLoading, setExtractLoading] = useState(false);
  const [annotations, setAnnotations] = useState({ highlights: [], comments: [], colorNotes: [] });
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
  const [currentBatchLabel, setCurrentBatchLabel] = useState("");
  const [correctedText, setCorrectedText] = useState("");
  const [failedTasks, setFailedTasks] = useState([]);
  const [applyMessages, setApplyMessages] = useState([]); // [{type:"success"|"error", text}]
  const [appliedChanges, setAppliedChanges] = useState([]); // [{label, original, replacement}] — приклади "до/після"
  const [correctionHistory, setCorrectionHistory] = useState([]);
  const [error, setError] = useState("");

  // Мова роботи — впливає на системний промпт (заборона змішування скриптів,
  // заборона рос./біл. джерел тощо). За замовчуванням українська; автопідтягується
  // з обраного замовлення, якщо його вибрано.
  const [lang, setLang] = useState("Українська");

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

  // ── Конфлікти між завданнями: для виділень/коментарів/нотаток фрагмент для заміни
  // відомий заздалегідь (task.annotatedText), тож можна знайти його позицію в docText
  // ще ДО застосування і позначити пари, чиї діапазони перетинаються — інакше друга
  // правка з тієї самої пари або не знайде вже змінений фрагмент, або мовчки
  // перезапише результат першої. Для kind:"manual" точний фрагмент з'являється лише
  // з відповіді ШІ під час застосування, тож наперед його не визначити (розпізнається
  // постфактум у doApply — див. roundStartText).
  const conflictTaskIds = useMemo(() => {
    const ranges = [];
    tasks.forEach(t => {
      if (t.kind !== "annotation") return;
      const loc = locateFragment(docText, t.annotatedText, t.context);
      if (loc) ranges.push({ id: t.id, ...loc });
    });
    const conflicts = new Set();
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        if (ranges[i].start < ranges[j].end && ranges[j].start < ranges[i].end) {
          conflicts.add(ranges[i].id);
          conflicts.add(ranges[j].id);
        }
      }
    }
    return conflicts;
  }, [tasks, docText]);

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
      if (d?.info?.language) setLang(d.info.language);
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
    setTasks([]); setChecked({}); setAnnotations({ highlights: [], comments: [], colorNotes: [] });
    setManualOpen(false); setCorrectionsText(""); setCorrectionPhotos([]);
    orderDocIdRef.current = null; setCorrectionHistory([]);
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
      const manualTasks = parsed.map((t, i) => ({
        ...t,
        id: `m_${Date.now()}_${i}`,
        kind: t.sourcesAction === "restructure" ? "sources_restructure" : "manual",
        documentWide: t.sourcesAction !== "restructure" && isDocumentWideTask(t),
      }));
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
    resetGenerationCost();
    setFailedTasks([]);
    setApplyMessages([]);
    setAppliedChanges([]);
    // map/text перебудовуються після КОЖНОЇ застосованої правки (refreshTextMap) —
    // інакше позиції наступних locateFragment з'їдуть відносно вже зміненого XML.
    let { map, plainText: text } = refreshTextMap(docStateRef.current.docXml);
    // Знімок тексту на старт раунду — якщо фрагмент завдання не знайдеться в ПОТОЧНОМУ
    // тексті, але знайдеться тут, значить його вже переписала інша правка цього ж
    // раунду (типовий конфлікт між двома завданнями на той самий фрагмент), а не
    // випадок "фрагмента взагалі нема в документі".
    const roundStartText = text;
    const failed = [];
    const messages = [];
    const changes = [];

    // Групуємо підряд по BATCH_SIZE завдань ОДНОГО типу (annotation/manual — різні
    // промпти) в один виклик ШІ: повний текст роботи надсилається раз на групу.
    // citation_pages, sources_restructure і documentWide не батчуються — кожне йде
    // своїм окремим кодовим чи багатоетапним шляхом (documentWide — бо це один
    // виклик ШІ на ВЕСЬ документ, який сам шукає всі відповідні місця).
    const batches = [];
    for (let i = 0; i < toFix.length;) {
      if (toFix[i].documentWide) {
        batches.push({ kind: "document_wide", items: [toFix[i]] });
        i++;
        continue;
      }
      const kind = toFix[i].kind;
      const group = [];
      while (i < toFix.length && toFix[i].kind === kind && group.length < BATCH_SIZE && kind !== "sources_restructure" && !toFix[i].documentWide) {
        group.push(toFix[i]); i++;
      }
      if (!group.length) { group.push(toFix[i]); i++; }
      batches.push({ kind, items: group });
    }

    let done = 0;
    const sysPromptSuffix = "\n\nВідповідай ЛИШЕ JSON, як описано вище. Без markdown, без пояснень поза ним.";

    // Один виклик ШІ на батч — якщо ВЕСЬ масив не розпарсився (типово: одна відповідь
    // містить незекрановані лапки й ламає JSON цілого батчу), пробуємо кожне завдання
    // окремо, а не валимо всі одразу — так само надійно, як старий підхід "один виклик
    // на завдання", але дешевше в щасливому випадку, коли батч парситься з першого разу.
    async function applyOneBatch(kind, batch) {
      setCurrentBatchLabel(kind === "annotation" ? `Виділення та коментарі (${batch.length})` : `Ручні зауваження (${batch.length})`);
      const zoneNow = locateSourcesZone(text);
      const existingCitationNumbers = zoneNow?.entries.map(e => e.number) || [];
      const tasksForPrompt = batch.map(t => ({
        ...t,
        extraContext: buildTaskPromptExtras(t, { methodInfo, clientMaterialsSummary, existingCitationNumbers, text }),
      }));
      const prompt = kind === "annotation"
        ? buildAnnotationCorrectionBatchPrompt({ documentText: text, tasks: tasksForPrompt })
        : buildFileApplyCorrectionBatchPrompt({ documentText: text, tasks: tasksForPrompt });
      const maxTokens = Math.min(80000, Math.max(8000, 6000 * batch.length));
      const sysPrompt = buildSYS(lang, methodInfo) + sysPromptSuffix;

      let items;
      try {
        const result = await callClaude([{ role: "user", content: prompt }], null, sysPrompt, maxTokens, null, MODEL, { cache: true });
        const parsed = JSON.parse(result.replace(/```json|```/g, "").trim());
        if (!Array.isArray(parsed)) throw new Error("не масив");
        items = parsed;
      } catch (e) {
        if (e?.isCostLimit) {
          batch.forEach(task => failed.push({ task, reason: e.message }));
          done += batch.length;
          setApplyProgress(done);
          return;
        }
        if (batch.length === 1) {
          failed.push({ task: batch[0], reason: "Не вдалося розпізнати відповідь ШІ." });
          done++;
          setApplyProgress(done);
          return;
        }
        for (const singleTask of batch) await applyOneBatch(kind, [singleTask]);
        return;
      }

      for (let i = 0; i < batch.length; i++) {
        const task = batch[i];
        const item = items.find(p => p?.index === i) ?? items[i];
        if (!item) {
          failed.push({ task, reason: "ШІ не повернув результат для цього завдання." });
        } else if (item.status === "needs_review") {
          failed.push({ task, reason: item.note || "Потрібна ручна перевірка — ШІ не може підтвердити правильне значення." });
        } else {
          // Кандидат на заміну: спершу шматок, який сам вказав ШІ (item.original) —
          // він вужчий і точніший (бачить повний текст роботи, тож для нотаток
          // кольором шрифту вкаже конкретне речення, а не цілий абзац, як раніше).
          // Якщо ШІ процитував неточно і цей шматок не знайшовся — для анотацій є
          // резерв: task.annotatedText, узятий напряму з XML при витягу анотацій,
          // на 100% присутній у документі саме таким, яким його бачив код.
          let original = kind === "annotation" ? (item.original || task.annotatedText) : item.original;
          let loc = original ? locateFragment(text, original, task.context) : null;
          if (!loc && kind === "annotation" && item.original && task.annotatedText && item.original !== task.annotatedText) {
            original = task.annotatedText;
            loc = locateFragment(text, original, task.context);
          }
          if (loc) {
            // Контроль обсягу — лише для суттєвих ручних завдань (кілька речень
            // і більше); для короткого виділення природно, що заміна коротша.
            let replacement = item.replacement || "";
            if (kind === "manual" && original) {
              replacement = await adjustVolume({ original, replacement, lang, methodInfo, label: task.location });
            }
            applyDocxReplacement(map, loc.start, loc.end, replacement);
            changes.push({ label: task.label || task.location || (original || "").slice(0, 60), original, replacement });
            if (task.commentId) await removeDocxComment(docStateRef.current.zip, docStateRef.current.docXml, task.commentId);
            ({ map, plainText: text } = refreshTextMap(docStateRef.current.docXml));
          } else {
            // Фрагмент відсутній у поточному тексті — перевіряємо, чи він був там на
            // старті раунду: якщо так, це не "фрагмента нема", а інша правка вище по
            // списку вже його змінила.
            const wasThereAtStart = original ? !!locateFragment(roundStartText, original, task.context) : false;
            failed.push({
              task,
              reason: wasThereAtStart
                ? "Фрагмент уже змінено іншою правкою вище по списку — перевірте вручну, чи потрібна ця правка ще."
                : "Фрагмент не знайдено в тексті документа — заміну не застосовано.",
            });
          }
        }
        done++;
        setApplyProgress(done);
      }
    }

    // ── Зауваження, що стосується ВСЬОГО документа ("так має бути по всій
    // роботі" тощо, — DOCUMENT_WIDE_HINT_RE) — один виклик ШІ на весь текст
    // роботи, що сам знаходить і виправляє КОЖНЕ відповідне місце, а не лише
    // те, де було залишено саме зауваження. Кожна знайдена заміна застосовується
    // тим самим хірургічним шляхом, з оновленням text/map між замінами. ──
    async function applyDocumentWideTask(task) {
      setCurrentBatchLabel(`Шукаю всі місця в документі (${task.label || task.location || "зауваження"})...`);
      try {
        const prompt = buildDocumentWideCorrectionPrompt({ documentText: text, task });
        const sysPrompt = buildSYS(lang, methodInfo) + sysPromptSuffix;
        const raw = await callClaude([{ role: "user", content: prompt }], null, sysPrompt, 20000, null, MODEL, { cache: true });
        const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
        if (!Array.isArray(parsed)) throw new Error("не масив");

        let appliedCount = 0;
        for (const item of parsed) {
          if (!item?.original) continue;
          const loc = locateFragment(text, item.original, null);
          if (!loc) continue;
          const replacement = item.replacement || "";
          applyDocxReplacement(map, loc.start, loc.end, replacement);
          changes.push({ label: task.label || task.location || "По всьому документу", original: item.original, replacement });
          ({ map, plainText: text } = refreshTextMap(docStateRef.current.docXml));
          appliedCount++;
        }
        if (task.commentId) await removeDocxComment(docStateRef.current.zip, docStateRef.current.docXml, task.commentId);

        if (appliedCount > 0) {
          messages.push({ type: "success", text: `Виправлено по всьому документу: ${appliedCount} місце(ць) (${task.label || task.location || "зауваження"}).` });
        } else {
          failed.push({ task, reason: "Не вдалося знайти в документі жодного місця, що підпадає під це зауваження — перевірте вручну." });
        }
      } catch (e) {
        failed.push({ task, reason: "Помилка пошуку по всьому документу: " + e.message });
      }
      done++;
      setApplyProgress(done);
    }

    // ── Перебудова списку джерел: додати/видалити конкретне джерело, перенумерувати
    // всі цитати по документу, вставити цитування нових джерел. Без структури
    // sections/content — усе працює прямо на плоскому тексті через хірургічні
    // заміни, як і решта інструмента. Підтримує лише нумерований стиль [N]. ──
    async function applySourcesRestructureTask(task) {
      setCurrentBatchLabel("Перебудовую список джерел...");
      const zone = locateSourcesZone(text);
      if (!zone || !zone.entries.length) {
        failed.push({ task, reason: "Не вдалося знайти пронумерований список джерел у документі." });
        done++; setApplyProgress(done);
        return;
      }
      try {
        const currentSourcesText = zone.entries.map(e => `${e.number}. ${e.text}`).join("\n");
        const restructurePrompt = buildSourcesRestructureAnalysisPrompt({ currentSourcesText, issue: task.issue, suggestion: task.suggestion });
        const restructureRaw = await callClaude([{ role: "user", content: restructurePrompt }], null, SYS_JSON, 2000, null, MODEL);
        const restructureParsed = JSON.parse(restructureRaw.replace(/```json|```/g, "").trim());
        const removeNumbers = new Set((restructureParsed.remove || []).map(Number).filter(Number.isFinite));
        const addRaw = (restructureParsed.add || []).filter(s => s && s.trim());

        const survivors = zone.entries.filter(e => !removeNumbers.has(e.number));
        const removedCount = zone.entries.length - survivors.length;

        const sourcesStyle = methodInfo?.sourcesStyle || "ДСТУ 8302:2015";
        let newFormatted = [];
        if (addRaw.length) {
          newFormatted = await formatSourcesWithRetry({
            rawRefs: addRaw, findStructured: () => null, sourcesStyle,
            sourcesFormatRules: methodInfo?.sourcesFormatRules, callClaude,
          });
        }

        const finalTexts = [...survivors.map(e => e.text), ...newFormatted];
        const oldToNew = {};
        survivors.forEach((e, idx) => { oldToNew[e.number] = idx + 1; });
        removeNumbers.forEach(n => { oldToNew[n] = null; });
        const newSourceFinalNumbers = newFormatted.map((_, idx) => survivors.length + idx + 1);

        // 1) Замінити сам блок списку джерел на новий пронумерований варіант
        const newSourcesBlock = finalTexts.map((t2, i) => `${i + 1}. ${t2}`).join("\n");
        applyDocxReplacement(map, zone.sourcesStart, zone.sourcesEnd, "\n" + newSourcesBlock + "\n");
        ({ map, plainText: text } = refreshTextMap(docStateRef.current.docXml));

        // 2) Перенумерувати/прибрати цитати по всьому тексту поза списком джерел —
        // одна за одною, без ШІ, так само як сторінки в цитатах.
        let renumberedCount = 0;
        for (let guard = 0; guard < 2000; guard++) {
          const zoneNow = locateSourcesZone(text);
          const fix = findNextCitationToRenumber(text, oldToNew, zoneNow?.sourcesStart ?? text.length, zoneNow?.sourcesEnd ?? text.length);
          if (!fix) break;
          applyDocxReplacement(map, fix.start, fix.end, fix.replacement);
          ({ map, plainText: text } = refreshTextMap(docStateRef.current.docXml));
          renumberedCount++;
        }

        // 3) Знайти в тексті доречне місце й вставити цитування кожного нового джерела
        const unplaced = [];
        for (let i = 0; i < newFormatted.length; i++) {
          const finalN = newSourceFinalNumbers[i];
          const marker = `[${finalN}]`;
          try {
            const placementPrompt = buildSourcePlacementInTextPrompt({ documentText: text, newSourceText: newFormatted[i], citationMarker: marker });
            const placementRaw = await callClaude([{ role: "user", content: placementPrompt }], null, SYS_JSON, 2000, null, MODEL);
            const placementParsed = JSON.parse(placementRaw.replace(/```json|```/g, "").trim());
            const anchorLoc = placementParsed?.found && placementParsed.anchor ? locateFragment(text, placementParsed.anchor, null) : null;
            if (anchorLoc) {
              applyDocxReplacement(map, anchorLoc.start, anchorLoc.end, text.slice(anchorLoc.start, anchorLoc.end) + ` ${marker}`);
              ({ map, plainText: text } = refreshTextMap(docStateRef.current.docXml));
            } else {
              unplaced.push(finalN);
            }
          } catch {
            unplaced.push(finalN);
          }
        }

        const summaryParts = [];
        if (removedCount) summaryParts.push(`видалено ${removedCount} джерел${renumberedCount ? ` (прибрано/перенумеровано посилань: ${renumberedCount})` : ""}`);
        if (newFormatted.length) summaryParts.push(`додано ${newFormatted.length} нових джерел${unplaced.length ? ` (для №${unplaced.join(", ")} не вдалося автоматично підібрати місце цитування — процитуйте вручну)` : ""}`);
        if (!summaryParts.length) summaryParts.push("змін у списку джерел не знайдено за цим зауваженням");
        messages.push({ type: "success", text: `Список джерел оновлено: ${summaryParts.join("; ")}.` });
      } catch (e) {
        failed.push({ task, reason: "Помилка перебудови списку джерел: " + e.message });
      }
      done++;
      setApplyProgress(done);
    }

    try {
      for (const { kind, items: batch } of batches) {
        if (getGenerationCost() > GENERATION_COST_LIMIT) {
          messages.push({ type: "error", text: `⛔ Зупинено: вартість цих правок перевищила ліміт $${GENERATION_COST_LIMIT}. Уже застосовані правки збережено — решту завдань (${toFix.length - done}) перевірте вручну.` });
          break;
        }
        // Сторінки в цитатах — суто кодова перевірка, без ШІ: номер підбирає
        // pickPageInRange у межах реального обсягу джерела, тож ризику
        // вигадування немає. Застосовуємо всі знайдені випадки одразу.
        if (kind === "citation_pages") {
          setCurrentBatchLabel("Сторінки в цитатах (без ШІ)");
          const task = batch[0];
          let fixedCount = 0;
          for (let guard = 0; guard < 500; guard++) {
            const fix = findOutOfRangeCitationInText(text);
            if (!fix) break;
            const before = text.slice(fix.start, fix.end);
            applyDocxReplacement(map, fix.start, fix.end, fix.replacement);
            changes.push({ label: "Сторінка в цитаті", original: before, replacement: fix.replacement });
            ({ map, plainText: text } = refreshTextMap(docStateRef.current.docXml));
            fixedCount++;
          }
          if (fixedCount === 0) {
            failed.push({ task, reason: "Не вдалося повторно знайти невалідні сторінки — можливо, документ змінився з моменту завантаження." });
          } else {
            messages.push({ type: "success", text: `Сторінки в цитатах: виправлено ${fixedCount}.` });
          }
          done += batch.length;
          setApplyProgress(done);
          continue;
        }

        if (kind === "sources_restructure") {
          await applySourcesRestructureTask(batch[0]);
          continue;
        }

        if (kind === "document_wide") {
          await applyDocumentWideTask(batch[0]);
          continue;
        }

        await applyOneBatch(kind, batch);
      }
      setCorrectedText(text);
      setFailedTasks(failed);
      setApplyMessages(messages);
      setAppliedChanges(changes);

      // Успішно застосовані завдання — знімаємо чекбокс (щоб повторний "Виправити
      // обрані" не намагався заново виправити вже виправлене — для анотацій
      // фрагмент цього разу просто не знайдеться); невдалі лишаються позначені,
      // готові до повторної спроби одним кліком.
      const failedIds = new Set(failed.map(f => f.task.id));
      const appliedCount = toFix.length - failed.length;
      setChecked(prev => {
        const next = { ...prev };
        toFix.forEach(t => { next[t.id] = failedIds.has(t.id); });
        return next;
      });

      let updatedHistory = correctionHistory;
      if (appliedCount > 0) {
        const entry = {
          clientTimestamp: Date.now(),
          appliedCount,
          failedCount: failed.length,
          labels: toFix.filter(t => !failedIds.has(t.id)).map(t => t.label || t.location || (t.annotatedText || "").slice(0, 40)).filter(Boolean).slice(0, 10),
        };
        updatedHistory = [...correctionHistory, entry];
        setCorrectionHistory(updatedHistory);
      }

      setStep(3);
      try {
        const acc = tokenAccRef.current;
        const payload = {
          mode: "file_corrections", type: "file_corrections",
          topic: `Правки: ${fileName}`, uid: user?.uid || null,
          fileName, correctionsApplied: appliedCount, correctionsFailed: failed.length,
          totalInTok: acc.inTok, totalOutTok: acc.outTok, totalCostUsd: acc.costUsd,
          claudeInTok: acc.claudeInTok, claudeOutTok: acc.claudeOutTok, claudeCostUsd: acc.claudeCostUsd,
          geminiInTok: 0, geminiOutTok: 0, geminiCostUsd: 0, serperCredits: 0, serperCostUsd: 0,
          info: { topic: `Правки: ${fileName}`, orderNumber: null },
          correctionHistory: updatedHistory,
          timestamp: serverTimestamp(),
        };
        if (orderDocIdRef.current) {
          await updateDoc(doc(db, "orders", orderDocIdRef.current), payload);
        } else {
          const ref = await addDoc(collection(db, "orders"), { ...payload, createdAt: new Date().toISOString() });
          orderDocIdRef.current = ref.id;
        }
      } catch { /**/ }
    } catch (e) {
      setError("Помилка виправлення: " + e.message);
    }
    setApplyLoading(false);
    setCurrentBatchLabel("");
  }

  function toggleAll(val) {
    const next = {};
    tasks.forEach(t => { next[t.id] = val; });
    setChecked(next);
  }

  function resetFile() {
    docStateRef.current = null;
    orderDocIdRef.current = null;
    setStep(0); setFileName(""); setDocText("");
    setAnnotations({ highlights: [], comments: [], colorNotes: [] }); setTasks([]); setChecked({});
    setManualOpen(false); setCorrectionsText(""); setCorrectionPhotos([]);
    setCorrectedText(""); setError(""); setApplyProgress(0); setFailedTasks([]);
    setApplyMessages([]); setAppliedChanges([]); setCorrectionHistory([]);
  }

  function reset() {
    resetFile();
    setContextOpen(false); setSelectedOrderId(""); setMethodInfo(null);
    setMethodFileLabel(""); setMethodError(""); setClientMaterials([]); setClientMaterialsManualText("");
    setLang("Українська");
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
            if (step === 3) { setStep(1); setCorrectedText(""); setApplyProgress(0); setFailedTasks([]); setApplyMessages([]); setAppliedChanges([]); }
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

            {/* Опціональний контекст: методичка / матеріали клієнта / мова — підтягуються
                лише до тих правок, де це дійсно доречно (формат, стиль цитування тощо) */}
            <div style={cardStyle}>
              <div
                onClick={() => { setContextOpen(o => !o); if (!contextOpen) loadMyOrders(); }}
                style={{ ...cardHead("#2a2a1e"), cursor: "pointer", justifyContent: "space-between" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={dot(methodInfo || clientMaterialsSummary ? "#a8e060" : "#666")} />
                  <div style={labelStyle}>Контекст роботи (необов'язково): мова, методичка, матеріали клієнта</div>
                </div>
                <div style={{ color: "#888", fontSize: 12 }}>{contextOpen ? "▲" : "▼"}</div>
              </div>
              {contextOpen && (
                <div style={cardBody}>
                  <div style={{ fontSize: 11, color: "#888", marginBottom: 10, lineHeight: 1.6 }}>
                    Мова впливає на всі виправлення (заборона змішування скриптів). Методичка/матеріали клієнта підтягуються лише для правок, де це доречно — оформлення, цитування, розрахунки.
                  </div>

                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, color: "#aaa", marginBottom: 6, letterSpacing: 0.5 }}>МОВА РОБОТИ</div>
                    <select
                      value={lang}
                      onChange={e => setLang(e.target.value)}
                      style={{ width: "100%", fontSize: 13, padding: "8px 10px", borderRadius: 6, border: "1px solid #d4cfc4", background: "#f5f2ea", color: "#2a2a1e", fontFamily: "inherit" }}
                    >
                      {LANG_OPTIONS.map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
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
                      <div style={{ fontSize: 11, color: "#6a9000", marginTop: 6 }}>✓ Дані методички, матеріалів і мови підтягнуто із замовлення</div>
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
                      Знайдено правок: {tasks.length} ({annotations.highlights.length} виділень, {annotations.comments.length} коментарів{(annotations.colorNotes || []).length ? `, ${annotations.colorNotes.length} нотаток кольором шрифту` : ""}{tasks.some(t => t.kind === "citation_pages") ? ", сторінки в цитатах" : ""}{tasks.some(t => t.kind === "sources_restructure") ? ", перебудова джерел" : ""}{tasks.some(t => t.kind === "manual") ? `, ${tasks.filter(t => t.kind === "manual").length} вручну` : ""})
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
                      <TaskRow task={task} isChecked={checked[task.id] !== false} onToggle={val => setChecked(prev => ({ ...prev, [task.id]: val }))} hasConflict={conflictTaskIds.has(task.id)} />
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
                    placeholder={"Вставте зауваження від викладача...\nНаприклад: «Висновки надто короткі. Додай ще одне джерело про X. Прибери застаріле джерело Іванова.»"}
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

            {/* Історія правок у цій сесії */}
            {correctionHistory.length > 0 && (
              <div style={{ ...cardStyle, marginTop: 14 }}>
                <div style={cardHead()}>
                  <div style={labelStyle}>Історія правок ({correctionHistory.length})</div>
                </div>
                <div style={{ background: "#faf8f3" }}>
                  {[...correctionHistory].reverse().map((entry, i) => (
                    <div key={i} style={{ padding: "10px 16px", borderBottom: i < correctionHistory.length - 1 ? "1px solid #e8e4dc" : "none", display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, color: "#2a2a1e" }}>Застосовано: {entry.appliedCount}{entry.failedCount ? `, не вдалось: ${entry.failedCount}` : ""}</div>
                        {entry.labels?.length > 0 && (
                          <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 4 }}>
                            {entry.labels.map((l, j) => (
                              <span key={j} style={{ fontSize: 10, background: "#e8f4d8", color: "#3a6010", borderRadius: 4, padding: "2px 7px" }}>{l}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: "#aaa", whiteSpace: "nowrap" }}>{new Date(entry.clientTimestamp).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button onClick={resetFile} style={{ background: "none", border: "none", color: "#aaa", fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: "4px 0", marginTop: 8 }}>
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
                    ? <>Виправляю... ({applyProgress} з {checkedCount}){currentBatchLabel ? <> — <strong>{currentBatchLabel}</strong></> : ""}</>
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

            {applyMessages.length > 0 && (
              <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                {applyMessages.map((msg, i) => (
                  <div key={i} style={{ border: `1.5px solid ${msg.type === "error" ? "#c04020" : "#4a6a00"}`, borderRadius: 8, padding: "11px 16px", background: msg.type === "error" ? "#2a1410" : "#1a2a00", display: "flex", gap: 10 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", marginTop: 4, background: msg.type === "error" ? "#e07050" : "#a8e060", flexShrink: 0 }} />
                    <div style={{ fontSize: 12.5, lineHeight: 1.6, color: "#f5f2eb" }}>{msg.text}</div>
                  </div>
                ))}
              </div>
            )}

            {appliedChanges.length > 0 && (
              <div style={{ ...cardStyle, border: "1.5px solid #4a6a00", marginTop: 14 }}>
                <div style={cardHead("#1a2a00")}>
                  <div style={dot("#a8e060")} />
                  <div style={labelStyle}>Приклади застосованих правок ({appliedChanges.length})</div>
                </div>
                <div style={{ background: "#faf8f3", maxHeight: 320, overflowY: "auto" }}>
                  {appliedChanges.map((c, i) => (
                    <div key={i} style={{ padding: "12px 16px", borderBottom: i < appliedChanges.length - 1 ? "1px solid #e8e4dc" : "none" }}>
                      <div style={{ fontSize: 11, color: "#7a5a2a", fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{c.label}</div>
                      <div style={{ fontSize: 12, color: "#c04020", marginBottom: 3 }}>
                        <span style={{ fontWeight: 600 }}>Було:</span> «{(c.original || "").slice(0, 160)}{(c.original || "").length > 160 ? "..." : ""}»
                      </div>
                      <div style={{ fontSize: 12, color: "#3a6010" }}>
                        <span style={{ fontWeight: 600 }}>Стало:</span> {c.replacement ? `«${c.replacement.slice(0, 160)}${c.replacement.length > 160 ? "..." : ""}»` : "(фрагмент видалено)"}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

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
                onClick={() => { setStep(1); setApplyProgress(0); setCorrectedText(""); setFailedTasks([]); setApplyMessages([]); setAppliedChanges([]); }}
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
