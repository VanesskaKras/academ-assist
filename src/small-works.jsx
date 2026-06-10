import { useState, useRef, useEffect } from "react";
import { db } from "./firebase";
import { useAuth } from "./AuthContext";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { MODEL, MODEL_FAST, callClaude, callGemini } from "./lib/api.js";
import { buildSYSSmall } from "./lib/prompts.js";
import { searchSourcesForSection, buildSemanticKeywords, generateSearchPhrases, lookupDoiMetadata, paperToCitation, lookupDOIByBiblio, filterSourcesWithGemini } from "./lib/sourcesSearch.js";
import { remapAndFormatCitations, applyCitationRemap } from "./lib/citationFormatting.js";
import { serializeForFirestore } from "./lib/firestoreUtils.js";
import { playDoneSound } from "./lib/audio.js";
import { SpinDot, Shimmer } from "./components/SpinDot.jsx";
import { FieldBox, Heading, NavBtn, PrimaryBtn, GreenBtn, SaveIndicator } from "./components/Buttons.jsx";
import { DropZone } from "./components/DropZone.jsx";
import { parsePagesAvg, exportSimpleDocx, TA, TA_WHITE, SHARED_STYLES } from "./shared.jsx";
import mammoth from "mammoth";
import { exportToDocx, exportSpeechToDocx } from "./lib/exportDocx.js";
import { SYS_JSON_SHORT } from "./lib/prompts.js";
import { exportToPptxFile } from "./lib/exportPptx.js";
import { ChecklistStage } from "./components/stages/ChecklistStage.jsx";

// ── Рендер тексту з markdown-таблицями ──
function renderWithTables(text) {
  if (!text) return null;
  const lines = text.split("\n");
  const segments = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\s*\|/.test(lines[i])) {
      const tableLines = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { tableLines.push(lines[i]); i++; }
      segments.push({ type: "table", lines: tableLines });
    } else {
      const textLines = [];
      while (i < lines.length && !/^\s*\|/.test(lines[i])) { textLines.push(lines[i]); i++; }
      segments.push({ type: "text", content: textLines.join("\n") });
    }
  }
  return segments.map((seg, si) => {
    if (seg.type === "text") {
      return <span key={si} style={{ whiteSpace: "pre-wrap" }}>{seg.content}</span>;
    }
    const dataLines = seg.lines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l));
    const rows = dataLines.map(l => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim()));
    if (!rows.length) return null;
    return (
      <div key={si} style={{ overflowX: "auto", margin: "6px 0" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12, fontFamily: "'Spectral',serif" }}>
          <tbody>
            {rows.map((cells, ri) => (
              <tr key={ri}>
                {cells.map((cell, ci) => ri === 0
                  ? <th key={ci} style={{ border: "1px solid #c4bfb4", padding: "5px 8px", textAlign: "center", background: "#ede9e0", fontWeight: 600 }}>{cell}</th>
                  : <td key={ci} style={{ border: "1px solid #c4bfb4", padding: "5px 8px", textAlign: "left" }}>{cell}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  });
}

// ─────────────────────────────────────────────
// Конфіг типів робіт
// ─────────────────────────────────────────────
const WORK_TYPES = {
  referat: {
    label: "Реферат",
    icon: "📄",
    hasplan: true,
    stages: ["Дані", "План", "Джерела", "Генерація", "Готово", "Чек-лист"],
    stageKeys: ["input", "plan", "sources", "writing", "done", "checklist"],
    color: "#1a5a8a",
    bg: "#e4f0ff",
  },
  tezy: {
    label: "Тези",
    icon: "📝",
    hasplan: false,
    stages: ["Дані", "Джерела", "Генерація", "Готово", "Чек-лист"],
    stageKeys: ["input", "sources", "writing", "done", "checklist"],
    color: "#5a1a8a",
    bg: "#f0e4ff",
  },
  stattia: {
    label: "Стаття",
    icon: "📰",
    hasplan: false,
    stages: ["Дані", "Джерела", "Генерація", "Готово", "Чек-лист"],
    stageKeys: ["input", "sources", "writing", "done", "checklist"],
    color: "#1a6a1a",
    bg: "#e4ffe4",
  },
  ese: {
    label: "Есе",
    icon: "✍️",
    hasplan: false,
    stages: ["Дані", "Джерела", "Генерація", "Готово", "Чек-лист"],
    stageKeys: ["input", "sources", "writing", "done", "checklist"],
    color: "#8a5a1a",
    bg: "#fff5e4",
  },
  prezentatsiya: {
    label: "Презентація",
    icon: "🎞️",
    hasplan: false,
    stages: ["Дані", "Джерела", "Генерація", "Готово", "Чек-лист"],
    stageKeys: ["input", "sources", "writing", "done", "checklist"],
    color: "#8a1a1a",
    bg: "#ffe4e4",
  },
  dopovid: {
    label: "Доповідь та презентація",
    icon: "🎤",
    hasplan: false,
    stages: ["Дані", "Готово"],
    stageKeys: ["input", "done"],
    color: "#6a1a8a",
    bg: "#f5e4ff",
  },
};

// ─────────────────────────────────────────────
// StagePills для малих робіт (динамічні)
// ─────────────────────────────────────────────
function StagePills({ stage, workType, onNavigate, maxStageIdx = 0 }) {
  const cfg = WORK_TYPES[workType] || WORK_TYPES.tezy;
  const cur = cfg.stageKeys.indexOf(stage);
  return (
    <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
      {cfg.stages.map((l, i) => {
        const visited = i <= maxStageIdx;
        const clickable = i !== cur && visited && onNavigate;
        return (
          <div key={i}
            onClick={clickable ? () => onNavigate(cfg.stageKeys[i]) : undefined}
            style={{ padding: "4px 12px", borderRadius: 20, fontSize: 11, letterSpacing: "1px", cursor: clickable ? "pointer" : "default", background: i === cur ? "#e8ff47" : visited ? "#1e2a00" : "transparent", color: i === cur ? "#111" : visited ? "#6a9000" : "#555", border: `1px solid ${i === cur ? "#e8ff47" : visited ? "#3a5000" : "#444"}` }}>
            {visited && i !== cur ? "✓ " : ""}{l}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────
// Вибір типу роботи
// ─────────────────────────────────────────────
function WorkTypeSelector({ onSelect }) {
  return (
    <div className="fade">
      <Heading>Оберіть тип роботи</Heading>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 }}>
        {Object.entries(WORK_TYPES).map(([key, cfg]) => (
          <div key={key} onClick={() => onSelect(key)}
            style={{ border: `1.5px solid ${cfg.color}33`, borderRadius: 10, padding: "20px 16px", textAlign: "center", cursor: "pointer", background: cfg.bg, transition: "all .15s" }}
            onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.10)"; }}
            onMouseLeave={e => { e.currentTarget.style.transform = ""; e.currentTarget.style.boxShadow = ""; }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>{cfg.icon}</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: cfg.color }}>{cfg.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Головний компонент
// ─────────────────────────────────────────────
export default function SmallWorks({ orderId, onOrderCreated, onBack }) {
  const { user } = useAuth();

  // ── Стан ──
  const [workType, setWorkType] = useState(null);
  const [stage, setStage] = useState("input");
  const [tplText, setTplText] = useState("");
  const [comment, setComment] = useState("");
  const [clientPlan, setClientPlan] = useState("");
  const [info, setInfo] = useState(null);

  // Файли (рекомендації/скріни) — до 3 штук (до 10 для тез)
  const [files, setFiles] = useState([]); // [{name, b64, type}]

  // Тези — матеріал для роботи (текст + файли що аналізуються при генерації)
  const [materialText, setMaterialText] = useState("");
  const [materialFiles, setMaterialFiles] = useState([]); // [{name, b64, type}]
  const [instrFiles, setInstrFiles] = useState([]); // презентація — файли з інструкціями оформлення

  // Тези — дані автора
  const [authorData, setAuthorData] = useState({ authorName: "", supervisor: "", university: "", faculty: "", role: "", email: "" });
  const [authorDataOpen, setAuthorDataOpen] = useState(false);

  // Тези — джерела
  const [tezyPapers, setTezyPapers] = useState([]);
  const [selectedTezyIds, setSelectedTezyIds] = useState([]);
  const [tezySearchLoading, setTezySearchLoading] = useState(false);
  const [tezyCitations, setTezyCitations] = useState([]);
  const [tezyPage, setTezyPage] = useState(1);
  const [citText, setCitText] = useState("");        // текстове поле джерел (tezy/stattia/ese)
  const [citInputs, setCitInputs] = useState({});   // { secId: "cite1\ncite2" } — для реферату
  const [citStructured, setCitStructured] = useState({}); // { secId: paper[] } — структуровані дані джерел (для форматування); "_main" — для tezy/stattia/ese/prezentatsiya
  const [activeSecId, setActiveSecId] = useState(null); // активна секція на кроці джерел (реферат)
  const [searchPhrases, setSearchPhrases] = useState([]); // фрази для Google Scholar

  // Реферат — секції з текстом
  const [sections, setSections] = useState([]); // [{id, label, text}]
  const [genIdx, setGenIdx] = useState(0);
  const [maxStageIdx, setMaxStageIdx] = useState(0);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);

  // Прості роботи — один блок тексту або слайди
  const [result, setResult] = useState(""); // для тез/статті/есе
  const [slides, setSlides] = useState([]); // [{title, content}] для презентації
  const [presTheme, setPresTheme] = useState(""); // тема дизайну презентації

  const [sourcesFormatted, setSourcesFormatted] = useState(false);
  const [methodInfo, setMethodInfo] = useState(null);
  const [methodRequirements, setMethodRequirements] = useState("");
  // Per-section джерела для реферату
  const [refSecPapers, setRefSecPapers] = useState({});
  const [refSecPhrases, setRefSecPhrases] = useState({});
  const [refSecLoading, setRefSecLoading] = useState({});
  const [refSecSelected, setRefSecSelected] = useState({});
  const [refSecOpen, setRefSecOpen] = useState({});

  const [loadMsg, setLoadMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dbLoading, setDbLoading] = useState(false);
  const [docxLoading, setDocxLoading] = useState(false);
  const [error, setError] = useState("");

  // ── Презентація + доповідь (малі роботи) ──
  const [presLoading, setPresLoading] = useState(false);
  const [presMsg, setPresMsg] = useState("");
  const [presReady, setPresReady] = useState(false);
  const [presSlideJson, setPresSlideJson] = useState(null);
  const [presComment, setPresComment] = useState("");
  const [dopOrderNumber, setDopOrderNumber] = useState("");
  const [presFile, setPresFile] = useState(null); // { name, b64, type }
  const [speechWithLoading, setSpeechWithLoading] = useState(false);
  const [speechWithText, setSpeechWithText] = useState("");
  const [speechLoading, setSpeechLoading] = useState(false);
  const [speechText, setSpeechText] = useState("");

  const currentIdRef = useRef(orderId || null);
  const tokenAccRef = useRef({ inTok: 0, outTok: 0, costUsd: 0, claudeInTok: 0, claudeOutTok: 0, claudeCostUsd: 0, geminiInTok: 0, geminiOutTok: 0, geminiCostUsd: 0 });

  useEffect(() => {
    const handler = (e) => {
      const isGemini = (e.detail.model || "").startsWith("gemini");
      const dIn = e.detail.inTok || 0, dOut = e.detail.outTok || 0, dCost = e.detail.cost || 0;
      const t = tokenAccRef.current;
      tokenAccRef.current = {
        inTok: t.inTok + dIn, outTok: t.outTok + dOut, costUsd: t.costUsd + dCost,
        claudeInTok:  t.claudeInTok  + (isGemini ? 0 : dIn),
        claudeOutTok: t.claudeOutTok + (isGemini ? 0 : dOut),
        claudeCostUsd: t.claudeCostUsd + (isGemini ? 0 : dCost),
        geminiInTok:  t.geminiInTok  + (isGemini ? dIn  : 0),
        geminiOutTok: t.geminiOutTok + (isGemini ? dOut : 0),
        geminiCostUsd: t.geminiCostUsd + (isGemini ? dCost : 0),
      };
    };
    window.addEventListener("apicost", handler);
    return () => window.removeEventListener("apicost", handler);
  }, []);

  // ── Завантаження існуючого замовлення ──
  useEffect(() => {
    if (!orderId || !user) return;
    const load = async () => {
      setDbLoading(true);
      try {
        const snap = await getDoc(doc(db, "orders", orderId));
        if (snap.exists()) {
          const d = snap.data();
          if (d.workType) setWorkType(d.workType);
          if (d.tplText) setTplText(d.tplText);
          if (d.comment) setComment(d.comment);
          if (d.clientPlan) setClientPlan(d.clientPlan);
          if (d.info) setInfo(d.info);
          if (d.sections?.length) setSections(d.sections);
          if (d.result) setResult(d.result);
          if (d.slides?.length) setSlides(d.slides);
          if (d.stage) {
            setStage(d.stage);
            const loadedCfg = WORK_TYPES[d.workType] || WORK_TYPES.tezy;
            setMaxStageIdx(loadedCfg.stageKeys.indexOf(d.stage));
          }
          if (d.genIdx !== undefined) setGenIdx(d.genIdx);
          if (d.authorData) setAuthorData(d.authorData);
          if (d.tezyCitations?.length) setTezyCitations(d.tezyCitations);
          if (d.tezyPapers?.length) setTezyPapers(d.tezyPapers);
          if (d.selectedTezyIds?.length) setSelectedTezyIds(d.selectedTezyIds);
          if (d.citText) setCitText(d.citText);
          if (d.citInputs) setCitInputs(d.citInputs);
          if (d.citStructured) setCitStructured(d.citStructured);
          if (d.searchPhrases?.length) setSearchPhrases(d.searchPhrases);
          if (d.materialText) setMaterialText(d.materialText);
          if (d.instrFiles?.length) setInstrFiles(d.instrFiles);
          if (d.sourcesFormatted) setSourcesFormatted(d.sourcesFormatted);
          if (d.methodInfo) setMethodInfo(d.methodInfo);
          if (d.methodRequirements) setMethodRequirements(d.methodRequirements);
          if (d.refSecPapers) setRefSecPapers(d.refSecPapers);
          if (d.refSecPhrases) setRefSecPhrases(d.refSecPhrases);
          if (d.presReady) setPresReady(d.presReady);
          if (d.presSlideJson) setPresSlideJson(d.presSlideJson);
          if (d.speechWithText) setSpeechWithText(d.speechWithText);
          if (d.speechText) setSpeechText(d.speechText);
          if (d.presComment) setPresComment(d.presComment);
          if (d.info?.orderNumber) setDopOrderNumber(d.info.orderNumber);
          if (d.totalInTok !== undefined) {
            tokenAccRef.current = {
              inTok: d.totalInTok || 0, outTok: d.totalOutTok || 0, costUsd: d.totalCostUsd || 0,
              claudeInTok: d.claudeInTok || 0, claudeOutTok: d.claudeOutTok || 0, claudeCostUsd: d.claudeCostUsd || 0,
              geminiInTok: d.geminiInTok || 0, geminiOutTok: d.geminiOutTok || 0, geminiCostUsd: d.geminiCostUsd || 0,
            };
          }
        }
      } catch (e) { console.error(e); }
      setDbLoading(false);
    };
    load();
  }, [orderId, user]);

  // ── Оновлення максимального досягнутого індексу стадії ──
  useEffect(() => {
    if (!workType) return;
    const cfg = WORK_TYPES[workType];
    if (!cfg) return;
    const idx = cfg.stageKeys.indexOf(stage);
    setMaxStageIdx(prev => Math.max(prev, idx));
  }, [stage, workType]);

  // ── Автозапуск пошуку джерел для тез/статті/есе/презентації ──
  useEffect(() => {
    if (["tezy", "stattia", "ese", "prezentatsiya"].includes(workType) && stage === "sources" && tezyPapers.length === 0 && !tezySearchLoading && info?.topic) {
      doSearchTezyPapers();
    }
  }, [workType, stage, info?.topic]);

  // ── Автозапуск пошуку джерел для кожного розділу реферату (не вступ/висновки) ──
  useEffect(() => {
    if (workType !== "referat" || stage !== "sources" || !info?.topic) return;
    const chapSecs = sections.filter(s => !["intro", "conclusions", "sources"].includes(s.id));
    for (const sec of chapSecs) {
      if (!refSecPapers[sec.id] && !refSecLoading[sec.id]) {
        doSearchForSection(sec.id, sec.label);
      }
    }
  }, [workType, stage, info?.topic, sections.length]);

  // ── Авто-збереження вибраних джерел ──
  useEffect(() => {
    if (!["tezy", "stattia", "ese", "referat", "prezentatsiya"].includes(workType) || stage !== "sources") return;
    const t = setTimeout(() => {
      saveToFirestore({ selectedTezyIds });
    }, 1000);
    return () => clearTimeout(t);
  }, [selectedTezyIds]);

  // ── Авто-збереження текстового поля джерел ──
  useEffect(() => {
    if (!["tezy", "stattia", "ese", "referat", "prezentatsiya"].includes(workType) || stage !== "sources") return;
    const t = setTimeout(() => {
      saveToFirestore({ citText });
    }, 1500);
    return () => clearTimeout(t);
  }, [citText]);

  // ── Авто-збереження citInputs (реферат) ──
  useEffect(() => {
    if (workType !== "referat" || stage !== "sources") return;
    const t = setTimeout(() => {
      saveToFirestore({ citInputs });
    }, 1500);
    return () => clearTimeout(t);
  }, [citInputs]);

  // ── Ініціалізація активної секції при переході на джерела (реферат) ──
  useEffect(() => {
    if (workType !== "referat" || stage !== "sources") return;
    if (!activeSecId && sections.length > 0) {
      const first = sections.find(s => s.id !== "sources");
      if (first) setActiveSecId(first.id);
    }
  }, [workType, stage, sections]);

  // ── Збереження ──
  const saveToFirestore = async (patch) => {
    if (!user) return;
    setSaving(true); setSaved(false);
    try {
      const isNew = !currentIdRef.current;
      const id = currentIdRef.current || `${user.uid}_${Date.now()}`;
      if (isNew) { currentIdRef.current = id; onOrderCreated?.(id); }
      const ref = doc(db, "orders", id);
      const base = {
        ...(isNew ? { uid: user.uid } : {}), mode: "small", workType,
        updatedAt: new Date().toISOString(),
        topic: patch.info?.topic || info?.topic || "",
        type: patch.info?.type || info?.type || workType || "",
        pages: patch.info?.pages || info?.pages || "",
        deadline: patch.info?.deadline || info?.deadline || "",
        totalInTok: tokenAccRef.current.inTok,
        totalOutTok: tokenAccRef.current.outTok,
        totalCostUsd: tokenAccRef.current.costUsd,
        claudeInTok: tokenAccRef.current.claudeInTok,
        claudeOutTok: tokenAccRef.current.claudeOutTok,
        claudeCostUsd: tokenAccRef.current.claudeCostUsd,
        geminiInTok: tokenAccRef.current.geminiInTok,
        geminiOutTok: tokenAccRef.current.geminiOutTok,
        geminiCostUsd: tokenAccRef.current.geminiCostUsd,
        ...(patch.status === "done" ? { completedAt: new Date().toISOString() } : {}),
      };
      await setDoc(ref, serializeForFirestore({ ...base, ...patch, ...(isNew ? { createdAt: new Date().toISOString() } : {}) }), { merge: true });
      setSaved(true); setTimeout(() => setSaved(false), 3000);
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  // ── Аналіз шаблону ──
  const doAnalyze = async () => {
    setRunning(true); setLoadMsg("Аналізую замовлення...");
    try {
      const toClaudeFile = f => ({ type: f.type.startsWith("image/") ? "image" : "document", source: { type: "base64", media_type: f.type, data: f.b64 } });
      const fileContext = files.map(toClaudeFile);
      const matFileContext = materialFiles.length > 0
        ? [{ type: "text", text: "Матеріал, методичка та вимоги (файли):" }, ...materialFiles.map(toClaudeFile)]
        : [];

      const isTezy = workType === "tezy";
      const isSimpleWithSources = ["stattia", "ese"].includes(workType);
      const isReferat = workType === "referat";
      const tezyFields = isTezy ? `,"needsSources":true,"sourceCount":3,"authorFormat":"center","bodyStructure":"linear","needsEmail":false,"needsUDK":false,"needsFigures":false,"figureCount":0` : "";
      const simpleFields = isSimpleWithSources ? `,"sourceCount":${workType === "stattia" ? 5 : 3},"citStyle":"ДСТУ","needsFigures":false,"figureCount":0,"sortAlpha":false` : "";
      const referatFields = isReferat ? `,"sourceCount":10,"sortAlpha":true,"citStyle":"ДСТУ","titlePageInfo":null,"introStructure":null` : "";
      const tezyHints = isTezy ? `
needsSources — чи конференція вимагає список джерел (true/false).
sourceCount — скільки джерел (число, зазвичай 3-5).
authorFormat — вирівнювання блоку автора: "center" або "right".
bodyStructure — "linear" (Актуальність→Мета→Результати→Висновки) або "structured" (Преамбула→Тези→Аргументація→Демонстрація→Результати).
needsEmail — чи треба email автора (true/false).
needsUDK — чи треба УДК (true/false).
needsFigures — чи потрібні рисунки/схеми у тезах за методичкою або матеріалом (true/false).
figureCount — скільки рисунків (зазвичай 1-2).` : "";
      const simpleHints = isSimpleWithSources ? `
sourceCount — скільки джерел потрібно (число, зазвичай 5-10 для статті, 3-5 для есе).
citStyle — стиль цитування: "ДСТУ" або "APA" або інший зазначений у вимогах.
needsFigures — чи потрібні рисунки/схеми (true/false).
figureCount — скільки рисунків (зазвичай 1-3).
sortAlpha — чи сортувати список літератури за алфавітом (true/false).` : "";
      const referatHints = isReferat ? `
sourceCount — мінімальна кількість джерел (зазвичай = кількість сторінок; якщо вказано у методичці — бери звідти).
sortAlpha — чи сортувати список літератури за алфавітом (true/false).
citStyle — стиль цитування: "ДСТУ" або "APA" або інший зазначений у вимогах. Якщо не вказано — "ДСТУ".
titlePageInfo — якщо у файлах (фото або PDF) знайдено титульну сторінку — витягни дані у вигляді JSON-обʼєкта: {"university":"...","faculty":"...","discipline":"...","student":"...","supervisor":"...","year":"...","city":""}. Якщо університет, студент або керівник не вказані — залиш поле порожнім рядком. Якщо титульної сторінки немає — null.
introStructure — якщо у методичці явно вказана структура вступу (перелік обовʼязкових елементів: актуальність, мета, обʼєкт, предмет тощо) — скопіюй вимоги одним рядком. Якщо не вказано — null.` : "";

      const materialHint = ((isTezy || isSimpleWithSources || isReferat || workType === "prezentatsiya") && materialText.trim())
        ? `\nМАТЕРІАЛ (фрагмент для розуміння теми):\n${materialText.trim().slice(0, 1500)}`
        : "";

      const prompt = `Проаналізуй замовлення на ${WORK_TYPES[workType]?.label || workType}.

ШАБЛОН:
${tplText}
${comment ? `\nКОМЕНТАР: ${comment}` : ""}${materialHint}

Поверни ТІЛЬКИ JSON (без markdown):
{"type":"${WORK_TYPES[workType]?.label || workType}","pages":"","topic":"","subject":"","direction":"","uniqueness":"","language":"Українська","deadline":"","orderNumber":"","requirements":"","formatting":{"left":null,"right":null,"top":null,"bottom":null}${tezyFields}${simpleFields}${referatFields}}

orderNumber — номер замовлення якщо є (наприклад "37808.2"), інакше порожній рядок.
requirements — якщо є рекомендації у файлах, стисло опиши ключові вимоги до структури та оформлення.
formatting — поля сторінки в мм якщо явно вказані у файлах або коментарі: left (ліве), right (праве), top (верхнє), bottom (нижнє). Якщо написано "зі всіх сторін X см" — постав X*10 у всі чотири поля. null для кожного поля якщо не вказано.${tezyHints}${simpleHints}${referatHints}`;

      const msgs = [{ role: "user", content: [...fileContext, ...matFileContext, { type: "text", text: prompt }] }];
      // Для тез/статті/есе/реферату з файлами — Sonnet (краще читає зображення), інакше Haiku
      const model = ((isTezy || isSimpleWithSources || isReferat || workType === "prezentatsiya") && (files.length > 0 || materialFiles.length > 0)) ? MODEL : MODEL_FAST;
      const raw = await callClaude(msgs, null, "Respond only with valid JSON. No markdown.", 1500, null, model);
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      const extractedFormatting = parsed.formatting;
      delete parsed.formatting;
      if (!parsed.orderNumber) {
        const m = tplText.match(/№\s*замовлення\s*[-–—:]\s*(\S+)/i);
        if (m) parsed.orderNumber = m[1].trim();
      }
      const newInfo = { ...parsed, workType };
      setInfo(newInfo);
      if (extractedFormatting?.left || extractedFormatting?.right || extractedFormatting?.top || extractedFormatting?.bottom) {
        const toNum = v => (v != null && v !== "" ? Number(v) : null);
        setMethodInfo(prev => ({ ...(prev || {}), formatting: { ...(prev?.formatting || {}), margins: { left: toNum(extractedFormatting.left), right: toNum(extractedFormatting.right), top: toNum(extractedFormatting.top), bottom: toNum(extractedFormatting.bottom) } } }));
      }

      // Читаємо повні вимоги з файлів методички якщо вони є
      let extractedMethodReqs = "";
      if (fileContext.length > 0) {
        setLoadMsg("Читаю вимоги методички...");
        try {
          const reqMsgs = [{ role: "user", content: [...fileContext, { type: "text", text: `Уважно прочитай ці вимоги/методичку до написання ${WORK_TYPES[workType]?.label || "роботи"}. Витягни ВСІ вимоги: структуру роботи, обсяг кожного розділу, форматування (шрифт, поля, інтервал), вимоги до джерел та цитування, стиль написання, особливі умови конференції/викладача. Поверни лише текст вимог — повно але без зайвих коментарів. Відповідай мовою документу.` }] }];
          extractedMethodReqs = (await callClaude(reqMsgs, null, "You are a helpful assistant. Extract requirements from the provided documents.", 2000, null, MODEL)).trim();
          setMethodRequirements(extractedMethodReqs);
        } catch (e) {
          console.warn("methodRequirements extraction failed:", e.message);
        }
      }

      if (workType === "referat") {
        await saveToFirestore({ tplText, comment, clientPlan, materialText, info: newInfo, ...(extractedMethodReqs ? { methodRequirements: extractedMethodReqs } : {}), stage: "plan", status: "new" });
        setStage("plan");
      } else if (isTezy && newInfo.needsSources !== false) {
        await saveToFirestore({ tplText, comment, materialText, authorData, info: newInfo, ...(extractedMethodReqs ? { methodRequirements: extractedMethodReqs } : {}), stage: "sources", status: "new" });
        setStage("sources");
      } else if (isSimpleWithSources) {
        await saveToFirestore({ tplText, comment, materialText, info: newInfo, ...(extractedMethodReqs ? { methodRequirements: extractedMethodReqs } : {}), stage: "sources", status: "new" });
        setStage("sources");
      } else if (workType === "prezentatsiya") {
        await saveToFirestore({ tplText, comment, materialText, instrFiles, info: newInfo, ...(extractedMethodReqs ? { methodRequirements: extractedMethodReqs } : {}), stage: "sources", status: "new" });
        setStage("sources");
      } else {
        await saveToFirestore({ tplText, comment, materialText, authorData, info: newInfo, ...(extractedMethodReqs ? { methodRequirements: extractedMethodReqs } : {}), stage: "writing", status: "new" });
        setStage("writing");
      }
    } catch (e) {
      setError(e.message);
    }
    setRunning(false); setLoadMsg("");
  };

  // ── Пошук джерел для тез ──
  const doSearchTezyPapers = async () => {
    setTezySearchLoading(true);
    try {
      const topic = info?.topic || tplText.slice(0, 120);
      const direction = info?.direction || "";
      const subject = info?.subject || "";
      const needed = info?.sourceCount || (workType === "stattia" ? 5 : 3);

      const [allPhrases, ukKw] = await Promise.all([
        generateSearchPhrases(topic, topic, direction, subject),
        Promise.resolve(buildSemanticKeywords(topic, topic, direction, subject)),
      ]);

      // Перші 4 — українські, наступні 4 — англійські
      const ukPhrases = allPhrases.length ? allPhrases.slice(0, 4) : ukKw.slice(0, 4);
      const enPhrases = allPhrases.slice(4, 8);
      // Fallback: якщо generateSearchPhrases не повернув нічого — беремо семантичні ключові слова
      const displayPhrases = allPhrases.length ? allPhrases : ukKw.slice(0, 6);

      const { flat } = await searchSourcesForSection(ukKw, enPhrases, needed + 6, topic, topic, 1, [], [], ukPhrases);
      const filtered = await filterSourcesWithGemini(flat || [], topic, topic, 10);
      const papers = (filtered.length ? filtered : (flat || [])).slice(0, 10);
      setTezyPapers(papers);
      setTezyPage(1);
      setSelectedTezyIds([]);
      setSearchPhrases(displayPhrases);
      await saveToFirestore({ tezyPapers: papers, selectedTezyIds: [], searchPhrases: displayPhrases });
    } catch (e) {
      setError(e.message);
    }
    setTezySearchLoading(false);
  };

  // ── Пошук джерел для конкретної секції реферату ──
  const doSearchForSection = async (secId, secLabel) => {
    setRefSecLoading(prev => ({ ...prev, [secId]: true }));
    try {
      const topic = info?.topic || tplText.slice(0, 120);
      const direction = info?.direction || "";
      const subject = info?.subject || "";
      const refSecs = sections.filter(s => s.id !== "sources");
      const needed = Math.ceil((info?.sourceCount || parsePagesAvg(info?.pages || "15")) / Math.max(refSecs.length, 1)) + 4;
      const [allPhrases, ukKw] = await Promise.all([
        generateSearchPhrases(secLabel, topic, direction, subject),
        Promise.resolve(buildSemanticKeywords(secLabel, topic, direction, subject)),
      ]);
      const ukPhrases = allPhrases.length ? allPhrases.slice(0, 4) : ukKw.slice(0, 4);
      const enPhrases = allPhrases.slice(4, 8);
      const displayPhrases = allPhrases.length ? allPhrases : ukKw.slice(0, 6);
      const { flat } = await searchSourcesForSection(ukKw, enPhrases, needed, secLabel, topic, 1, [], [], ukPhrases);
      const filtered = await filterSourcesWithGemini(flat || [], secLabel, topic, 15);
      const papers = (filtered.length ? filtered : (flat || [])).slice(0, 15);
      setRefSecPapers(prev => {
        const next = { ...prev, [secId]: papers };
        saveToFirestore({ refSecPapers: next });
        return next;
      });
      setRefSecPhrases(prev => {
        const next = { ...prev, [secId]: displayPhrases };
        saveToFirestore({ refSecPhrases: next });
        return next;
      });
      setRefSecOpen(prev => ({ ...prev, [secId]: true }));
      setRefSecSelected(prev => ({ ...prev, [secId]: [] }));
    } catch (e) { setError(e.message); }
    setRefSecLoading(prev => ({ ...prev, [secId]: false }));
  };

  // ── Додавання вибраних джерел для секції реферату ──
  const doAddForSection = async (secId) => {
    const selected = (refSecPapers[secId] || []).filter(p => (refSecSelected[secId] || []).includes(p.id));
    if (!selected.length) return;
    setRunning(true); setLoadMsg("Оформлюю джерела...");
    try {
      const afterDoi = await Promise.all(selected.map(async p => {
        if (!p.doi) return p;
        const meta = await lookupDoiMetadata(p.doi);
        if (!meta) return p;
        return {
          ...p,
          ...(meta.authorsStructured?.length ? { authorsStructured: meta.authorsStructured } : {}),
          ...(meta.authors?.length ? { authors: meta.authors } : {}),
          ...(meta.pages && !p.pages ? { pages: meta.pages } : {}),
          ...(meta.volume ? { volume: meta.volume } : {}),
          ...(meta.issue ? { issue: meta.issue } : {}),
          ...(meta.journal && (!p.venue || /^[\w.-]+\.[a-zA-Z]{2,}$/.test(p.venue.trim())) ? { venue: meta.journal } : {}),
        };
      }));
      // Для паперів без doi і url — шукаємо DOI в CrossRef за назвою+автором
      const enriched = await Promise.all(afterDoi.map(p => lookupDOIByBiblio(p)));
      const rawCitations = enriched.map(paperToCitation).filter(Boolean);
      setCitInputs(prev => {
        const existing = (prev[secId] || "").trim();
        const toAdd = rawCitations.filter(c => !existing.includes(c.slice(0, 40)));
        const next = { ...prev, [secId]: existing ? existing + "\n" + toAdd.join("\n") : toAdd.join("\n") };
        saveToFirestore({ citInputs: next });
        return next;
      });
      setCitStructured(prev => {
        const existing = prev[secId] || [];
        const existingTitles = new Set(existing.map(p => (p.title || "").toLowerCase().slice(0, 60)));
        const toAdd = enriched.filter(p => p.title && !existingTitles.has(p.title.toLowerCase().slice(0, 60)));
        const next = { ...prev, [secId]: [...existing, ...toAdd] };
        saveToFirestore({ citStructured: next });
        return next;
      });
      setRefSecSelected(prev => ({ ...prev, [secId]: [] }));
    } catch (e) { setError(e.message); }
    setRunning(false); setLoadMsg("");
  };

  // ── Генерація із текстового поля джерел ──
  const doGenerateFromCitText = async () => {
    let citations = citText.split("\n").map(s => s.trim()).filter(Boolean);
    if (info?.sortAlpha) citations.sort((a, b) => a.localeCompare(b, "uk"));
    setTezyCitations(citations);
    await saveToFirestore({ tezyCitations: citations, citText, stage: "writing", status: "sources_done" });
    setStage("writing");
    if (workType === "tezy") await doGenerateTezy(citations);
    else if (workType === "prezentatsiya") { /* user picks theme first, then clicks generate manually */ }
    else if (workType !== "referat") await doGenerateSimple(citations);
  };

  // ── Генерація реферату із посекційних полів джерел ──
  // Джерела зберігаються сирими — форматування відбувається окремим кроком після генерації тексту
  const doGenerateFromCitInputs = async () => {
    const raw = [];
    sections.filter(s => s.id !== "sources").forEach(s => {
      (citInputs[s.id] || "").split("\n").map(l => l.trim()).filter(Boolean).forEach(l => {
        if (!raw.includes(l)) raw.push(l);
      });
    });
    if (info?.sortAlpha) raw.sort((a, b) => a.localeCompare(b, "uk"));
    setTezyCitations(raw);
    setSourcesFormatted(false);
    await saveToFirestore({ tezyCitations: raw, citInputs, stage: "writing", status: "sources_done", sourcesFormatted: false });
    setStage("writing");
  };

  // ── Форматування списку джерел за стилем + перестановка посилань [N] у тексті (всі типи робіт) ──
  const doFormatAndRemapCitations = async () => {
    if (!tezyCitations.length) return;
    setRunning(true); setLoadMsg("Форматую та розставляю джерела...");
    try {
      const allStructured = Object.values(citStructured).flat();
      const { refList, oldToNew, refCiteText } = await remapAndFormatCitations({
        citations: tezyCitations,
        citStructured: allStructured,
        citStyle: info?.citStyle,
        language: info?.language,
        sourcesOrder: methodInfo?.sourcesOrder,
        sourcesGrouping: methodInfo?.sourcesGrouping,
        sourcesFormatRules: methodInfo?.sourcesFormatRules,
        callClaude,
      });
      if (!refList.length) { setRunning(false); setLoadMsg(""); return; }
      const refBlock = refList.map((c, i) => `${i + 1}. ${c}`).join("\n");

      if (workType === "referat") {
        const updatedSections = sections.map(s => s.id === "sources"
          ? { ...s, text: refBlock }
          : { ...s, text: applyCitationRemap(s.text, oldToNew, refCiteText) });
        // Оновлюємо citInputs — замінюємо сирі рядки на відформатовані відповідно до нового порядку
        const newCitInputs = {};
        sections.filter(s => s.id !== "sources").forEach(s => {
          const secRaw = (citInputs[s.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
          const secFormatted = secRaw.map(r => {
            const newIdx = oldToNew[tezyCitations.indexOf(r) + 1];
            return newIdx ? (refList[newIdx - 1] || r) : r;
          });
          if (secFormatted.length) newCitInputs[s.id] = secFormatted.join("\n");
        });
        setSections(updatedSections);
        setCitInputs(newCitInputs);
        setTezyCitations(refList);
        setSourcesFormatted(true);
        await saveToFirestore({ tezyCitations: refList, citInputs: newCitInputs, sections: updatedSections, sourcesFormatted: true });
      } else if (workType === "prezentatsiya") {
        const updatedSlides = slides.map(sl => /Список використаних джерел/i.test(sl.title || "")
          ? { ...sl, content: refBlock }
          : { ...sl, content: applyCitationRemap(sl.content, oldToNew, refCiteText) });
        setSlides(updatedSlides);
        setTezyCitations(refList);
        setSourcesFormatted(true);
        await saveToFirestore({ tezyCitations: refList, slides: updatedSlides, sourcesFormatted: true });
      } else {
        const bibMatch = result.match(/\n\s*Список використаних джерел[^\n]*\n([\s\S]*)$/i);
        const body = bibMatch ? result.slice(0, bibMatch.index) : result;
        const remappedBody = applyCitationRemap(body, oldToNew, refCiteText);
        const newResult = `${remappedBody}\n\nСписок використаних джерел:\n${refBlock}`;
        setResult(newResult);
        setTezyCitations(refList);
        setSourcesFormatted(true);
        await saveToFirestore({ tezyCitations: refList, result: newResult, sourcesFormatted: true });
      }
    } catch (e) { setError(e.message); }
    setRunning(false); setLoadMsg("");
  };

  const doConfirmTezyPapers = async () => {
    const selected = tezyPapers.filter(p => selectedTezyIds.includes(p.id));
    if (!selected.length) return;
    setRunning(true); setLoadMsg("Оформлюю джерела...");
    try {
      const afterDoi = await Promise.all(selected.map(async p => {
        if (!p.doi) return p;
        const meta = await lookupDoiMetadata(p.doi);
        if (!meta) return p;
        return {
          ...p,
          ...(meta.authorsStructured?.length ? { authorsStructured: meta.authorsStructured } : {}),
          ...(meta.authors?.length ? { authors: meta.authors } : {}),
          ...(meta.pages && !p.pages ? { pages: meta.pages } : {}),
          ...(meta.volume ? { volume: meta.volume } : {}),
          ...(meta.issue ? { issue: meta.issue } : {}),
          ...(meta.journal && (!p.venue || /^[\w.-]+\.[a-zA-Z]{2,}$/.test(p.venue.trim())) ? { venue: meta.journal } : {}),
        };
      }));
      // Для паперів без doi і url — шукаємо DOI в CrossRef за назвою+автором
      const enriched = await Promise.all(afterDoi.map(p => lookupDOIByBiblio(p)));
      const rawCitations = enriched.map(paperToCitation).filter(Boolean);
      setCitText(prev => {
        const existing = prev.trim();
        const toAdd = rawCitations.filter(c => !existing.includes(c.slice(0, 40)));
        const next = existing ? existing + "\n" + toAdd.join("\n") : toAdd.join("\n");
        saveToFirestore({ citText: next });
        return next;
      });
      setCitStructured(prev => {
        const existing = prev["_main"] || [];
        const existingTitles = new Set(existing.map(p => (p.title || "").toLowerCase().slice(0, 60)));
        const toAdd = enriched.filter(p => p.title && !existingTitles.has(p.title.toLowerCase().slice(0, 60)));
        const next = { ...prev, _main: [...existing, ...toAdd] };
        saveToFirestore({ citStructured: next });
        return next;
      });
      setSelectedTezyIds([]);
    } catch (e) { setError(e.message); }
    setRunning(false); setLoadMsg("");
  };

  // Будує карту формату посилань: { 1: "[1, с. 45]" або "[1]", ... }
  const buildCiteMap = (citations) => {
    const map = {};
    citations.forEach((ref, i) => {
      const n = i + 1;
      const articlePageMatch = ref.match(/[Сс]\.\s*(\d+)\s*[–\-—]/);
      const singlePageMatch = !articlePageMatch && ref.match(/[Сс]\.\s*(\d+)(?!\d*\s*с\.)/);
      const engPageMatch = ref.match(/pp?\.\s*(\d+)/i);
      const startPage = articlePageMatch?.[1] || singlePageMatch?.[1] || engPageMatch?.[1];
      map[n] = startPage ? `[${n}, с. ${startPage}]` : `[${n}]`;
    });
    return map;
  };

  // ── Генерація тез ──
  const doGenerateTezy = async (citationsOverride) => {
    setRunning(true); setLoadMsg("Генерую тези...");
    const lang = info?.language || "Українська";
    const totalPages = parsePagesAvg(info?.pages || "3");

    const ad = authorData;
    const authorName = ad.authorName?.trim() || "[ПІБ автора]";
    const supervisor = ad.supervisor?.trim() || "[Науковий керівник]";
    const university = ad.university?.trim() || "[Університет]";
    const faculty = ad.faculty?.trim() || "";
    const role = ad.role?.trim() || "";
    const email = (info?.needsEmail && ad.email?.trim()) ? ad.email.trim() : null;

    const authorFormat = info?.authorFormat || "center";
    const authorBlockLines = [
      authorName + (role ? `, ${role}` : ""),
      supervisor,
      university + (faculty ? `, ${faculty}` : ""),
      email,
    ].filter(Boolean).join("\n");

    const activeCitations = citationsOverride ?? tezyCitations;
    const hasSources = activeCitations.length > 0;
    const citeMap = buildCiteMap(activeCitations);
    const sourcesContext = hasSources
      ? `\nДЖЕРЕЛА — вставляй посилання ВИКЛЮЧНО у форматі [N] або [N, с. PAGE] (де N — номер джерела). ЗАБОРОНЕНО формат (Автор, рік). ТОЧНО у форматі перед кожним джерелом:\n${activeCitations.map((s, i) => `${citeMap[i + 1]} ${s}`).join("\n")}`
      : "";

    const structureInstr = info?.bodyStructure === "structured"
      ? "Структура за замовчуванням: Преамбула (2-3 речення: актуальність і новизна) → Тези (5-7 речень: ключові ідеї, власна позиція) → Аргументація (4-6 речень: обґрунтування, посилання на джерела) → Демонстрація (4-6 речень: ілюстрація прикладами) → Результати (2-4 речення: висновки, теоретична/практична цінність). Якщо у наданих матеріалах або методичці вказана інша структура тез — використай її замість цієї."
      : "Структура за замовчуванням: Актуальність (1-2 абзаци) → Мета та завдання (1 абзац) → Матеріали і методи (1 абзац) → Результати та обговорення (2-3 абзаци з посиланнями на джерела) → Висновки (пиши слово \"Висновки.\" жирним inline, потім текст). Якщо у наданих матеріалах або методичці вказана інша структура тез — використай її замість цієї.";

    const sourcesList = hasSources
      ? `\nСписок використаних джерел:\n${activeCitations.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
      : "";
    const supervisorBlock = `Науковий керівник: ${supervisor}`;

    const materialContext = materialText.trim()
      ? `\nМАТЕРІАЛ ДЛЯ РОБОТИ (проаналізуй і використай як основу при написанні тез):\n${materialText.trim()}\n`
      : "";

    const figureInstr = (info?.needsFigures && (info?.figureCount || 0) > 0)
      ? `\nРИСУНКИ (${info.figureCount} шт.): Постав рисунки у текст там де доречно. Для кожного рисунку:
– у реченні зроби посилання: (рис. N)
– після абзацу з посиланням окремим рядком маркер пошуку: [🔍 Рисунок N: "конкретний пошуковий запит для Google Images"]
– наступний рядок — підпис: Рис. N — Назва рисунку`
      : "";

    const hasUploadedFiles = files.length > 0 || materialFiles.length > 0;
    const prompt = `Напиши тези наукової доповіді на тему "${info?.topic}". Галузь: ${[info?.subject, info?.direction].filter(Boolean).join(", ")}.
${materialContext}${comment?.trim() ? `\nКОМЕНТАР ЗАМОВНИКА (виконай обов'язково): ${comment.trim()}\n` : ""}
${hasUploadedFiles ? "НЕ додавай слово «ТЕЗИ» як окремий заголовок-рядок на початку документу.\n" : ""}БЛОК АВТОРА (${authorFormat === "right" ? "вирівняти по правому краю" : "вирівняти по центру"}):
${authorBlockLines}

${info?.needsUDK ? "Перший рядок документу: УДК [відповідний код для теми]" : ""}
Назва доповіді: "${info?.topic}" — ВЕЛИКИМИ ЛІТЕРАМИ, по центру.

${structureInstr}
${sourcesContext}
${figureInstr}

Обсяг: ~${totalPages} сторінки. Мова: ${lang}.
${methodRequirements?.trim() ? `ВИМОГИ ДО РОБОТИ (ОБОВ'ЯЗКОВО дотримуватись):\n${methodRequirements}` : (info?.requirements ? `Вимоги конференції: ${info.requirements}` : "")}
${info?.uniqueness ? `Унікальність: ${info.uniqueness}.` : ""}
Без посилань у форматі footnotes. Без markdown заголовків (#, ##). Без зайвих жирних виділень у тексті.
${sourcesList ? `\nПісля основного тексту додай блок (зберігай форматування *курсив* у джерелах без змін):\n${sourcesList}` : "\nСписок літератури НЕ потрібен — конференція не вимагає."}
\nПісля списку літератури (або після основного тексту) додай блок (${authorFormat === "right" ? "по правому краю" : "по центру"}, жирним):
${supervisorBlock}`;

    const toClaudeFile = f => ({ type: f.type.startsWith("image/") ? "image" : "document", source: { type: "base64", media_type: f.type, data: f.b64 } });
    const fileContext = files.map(toClaudeFile);
    const matFileContext = materialFiles.length > 0
      ? [{ type: "text", text: "Матеріал, методичка та вимоги (файли — проаналізуй і використай):" }, ...materialFiles.map(toClaudeFile)]
      : [];

    try {
      const msgs = [{ role: "user", content: [...fileContext, ...matFileContext, { type: "text", text: prompt }] }];
      const tezyMaxTokens = Math.min(30000, Math.max(6000, Math.round(totalPages * 3000)));
      const text = await callClaude(msgs, null, buildSYSSmall(lang), tezyMaxTokens);
      setResult(text);
      playDoneSound();
      await saveToFirestore({ result: text, authorData, tezyCitations: activeCitations, stage: "done", status: "done" });
      setStage("done");
    } catch (e) { setError(e.message); }
    setRunning(false); setLoadMsg("");
  };

  // ── Генерація плану реферату ──
  const doGenPlan = async () => {
    setRunning(true); setLoadMsg("Генерую план...");
    const totalPages = parsePagesAvg(info?.pages);
    const chapCount = totalPages < 10 ? 2 : 3;
    const pagesPerChap = Math.max(2, Math.round((totalPages - 2) / chapCount));

    try {
      let newSections = [];

      if (clientPlan?.trim()) {
        const lines = clientPlan.split("\n").map(l => l.trim()).filter(Boolean);
        const chapSecs = lines
          .filter(l => /^(розділ|chapter|\d+\.?\s+[А-ЯҐЄІЇа-яґєії])/i.test(l))
          .map((l, i) => ({ id: `ch${i + 1}`, label: l, text: "", pages: pagesPerChap }));
        if (chapSecs.length > 0) {
          newSections = [
            { id: "intro", label: "ВСТУП", text: "", pages: 1 },
            ...chapSecs,
            { id: "conclusions", label: "ВИСНОВКИ", text: "", pages: 1 },
            { id: "sources", label: "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", text: "", pages: 0 },
          ];
        }
      }

      if (newSections.length === 0) {
        const toClaudeFile = f => ({ type: f.type.startsWith("image/") ? "image" : "document", source: { type: "base64", media_type: f.type, data: f.b64 } });
        const fileContext = files.map(toClaudeFile);

        const chapEntries = Array.from({ length: chapCount }, (_, i) =>
          `  {"id":"ch${i + 1}","label":"РОЗДІЛ ${i + 1}. Назва","pages":${pagesPerChap}}`
        ).join(",\n");

        const prompt = `Склади план реферату.
Тема: "${info?.topic}". Галузь: ${info?.subject || ""}. Обсяг: ${totalPages} стор.
Кількість основних розділів: ${chapCount}.
${info?.requirements ? `Вимоги методички: ${info.requirements}` : ""}

Назви розділів мають відповідати темі. Якщо у методичці є конкретна структура — використай її.

Поверни ТІЛЬКИ JSON:
{"sections":[
  {"id":"intro","label":"ВСТУП","pages":1},
${chapEntries},
  {"id":"conclusions","label":"ВИСНОВКИ","pages":1},
  {"id":"sources","label":"СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ","pages":0}
]}`;

        const msgs = fileContext.length > 0
          ? [{ role: "user", content: [...fileContext, { type: "text", text: prompt }] }]
          : [{ role: "user", content: prompt }];
        const model = fileContext.length > 0 ? MODEL : MODEL_FAST;
        const raw = await callClaude(msgs, null, "Respond only with valid JSON. No markdown.", 1200, null, model);
        const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
        newSections = (parsed.sections || []).map(s => ({ ...s, text: "" }));
      }

      setSections(newSections);
      await saveToFirestore({ sections: newSections, stage: "plan", status: "plan_ready", clientPlan });
    } catch (e) { setError(e.message); }
    setRunning(false); setLoadMsg("");
  };

  // ── Генерація тексту реферату (по секціях) ──
  useEffect(() => {
    if (workType !== "referat" || stage !== "writing" || running) return;
    if (runningRef.current) return;
    if (genIdx >= sections.length) {
      playDoneSound();
      saveToFirestore({ sections, stage: "done", status: "done" });
      setStage("done");
      return;
    }
    const sec = sections[genIdx];
    if (sec.text) { setGenIdx(g => g + 1); return; }
    if (sec.id === "sources") {
      const totalPages = parsePagesAvg(info?.pages);
      // Збираємо всі унікальні джерела: пріоритет — tezyCitations (вже скомпільовані), потім citInputs
      let compiledCitations = tezyCitations;
      if (compiledCitations.length === 0 && Object.keys(citInputs).length > 0) {
        const all = [];
        sections.filter(s => s.id !== "sources").forEach(s => {
          (citInputs[s.id] || "").split("\n").map(l => l.trim()).filter(Boolean).forEach(l => {
            if (!all.includes(l)) all.push(l);
          });
        });
        compiledCitations = all;
      }
      const sourcesText = compiledCitations.length > 0
        ? compiledCitations.map((c, i) => `${i + 1}. ${c}`).join("\n")
        : citText.trim() || `Список використаних джерел формується за кількістю сторінок (${totalPages} джерел). Додайте джерела вручну.`;
      setSections(p => p.map((s, i) => i === genIdx ? { ...s, text: sourcesText } : s));
      setGenIdx(g => g + 1);
      return;
    }
    runSection(sec);
  }, [workType, stage, genIdx, running, sections]);

  const runSection = async (sec) => {
    runningRef.current = true; setRunning(true);
    setLoadMsg(`Генерую: ${sec.label}...`);
    const lang = info?.language || "Українська";
    const totalPages = parsePagesAvg(info?.pages);
    const chapCount = sections.filter(s => !["intro", "conclusions", "sources"].includes(s.id)).length;
    const pagesPerSec = sec.pages != null
      ? sec.pages
      : (sec.id === "intro" || sec.id === "conclusions"
          ? Math.max(1, Math.round(totalPages * 0.07))
          : Math.max(2, Math.round(totalPages * 0.8 / chapCount)));
    const approxParas = Math.max(3, Math.round(pagesPerSec * 3));

    // ── Джерела ──
    // Для реферату — беремо тільки джерела цієї секції, але з глобальними номерами
    const isReferat = workType === "referat";
    const secCitations = isReferat && citInputs[sec.id]
      ? citInputs[sec.id].split("\n").map(s => s.trim()).filter(Boolean)
      : tezyCitations;
    const hasSources = secCitations.length > 0;

    let citeMap;
    if (isReferat && tezyCitations.length > 0 && secCitations.length > 0) {
      citeMap = {};
      secCitations.forEach(c => {
        const n = tezyCitations.indexOf(c) + 1;
        if (n > 0) {
          const articlePageMatch = c.match(/[Сс]\.\s*(\d+)\s*[–\-—]/);
          const singlePageMatch = !articlePageMatch && c.match(/[Сс]\.\s*(\d+)(?!\d*\s*с\.)/);
          const engPageMatch = c.match(/pp?\.\s*(\d+)/i);
          const startPage = articlePageMatch?.[1] || singlePageMatch?.[1] || engPageMatch?.[1];
          citeMap[n] = startPage ? `[${n}, с. ${startPage}]` : `[${n}]`;
        }
      });
    } else {
      citeMap = buildCiteMap(secCitations);
    }

    const firstCiteRef = isReferat && tezyCitations.length > 0
      ? (citeMap[Object.keys(citeMap)[0]] || "[1]")
      : (citeMap[1] || "[1]");

    const sourcesBlock = hasSources
      ? isReferat && tezyCitations.length > 0
        ? `\nДЖЕРЕЛА ДЛЯ РОБОТИ (${secCitations.length} шт.) — спирайся на них, вставляй посилання у тексті ТОЧНО у форматі вказаному перед кожним джерелом:\n${secCitations.map(c => {
            const n = tezyCitations.indexOf(c) + 1;
            return `${citeMap[n] || `[${n}]`} ${c}`;
          }).join("\n")}\n`
        : `\nДЖЕРЕЛА ДЛЯ РОБОТИ (${secCitations.length} шт.) — спирайся на них, вставляй посилання у тексті ТОЧНО у форматі вказаному перед кожним джерелом:\n${secCitations.map((s, i) => `${citeMap[i + 1]} ${s}`).join("\n")}\n`
      : "";
    const citNote = hasSources
      ? `Вставляй посилання у текст після тверджень, що спираються на джерела, точно у форматі з таблиці вище. Безособові конструкції: 'встановлено ${firstCiteRef}', 'зазначається ${firstCiteRef}'. ЗАБОРОНЕНО об'єднувати джерела через кому — ставь кожне окремо.`
      : "Без посилань на джерела.";

    // ── Матеріал ──
    const materialContext = materialText.trim()
      ? `\nМАТЕРІАЛ ДЛЯ РОБОТИ (використай як основу для змісту):\n${materialText.trim()}\n`
      : "";

    const methodReqBlock = methodRequirements?.trim()
      ? `\nВИМОГИ ДО РОБОТИ (ОБОВ'ЯЗКОВО дотримуватись):\n${methodRequirements}\n`
      : "";

    const toClaudeFile = f => ({ type: f.type.startsWith("image/") ? "image" : "document", source: { type: "base64", media_type: f.type, data: f.b64 } });
    const matFileContext = materialFiles.length > 0
      ? [{ type: "text", text: "Матеріал для роботи (файли):" }, ...materialFiles.map(toClaudeFile)]
      : [];
    const refFileContext = files.map(toClaudeFile);

    // Номер розділу (для нумерації таблиць/рисунків X.Y)
    const chapNum = sec.id.match(/^ch(\d+)/)?.[1] || null;
    const commentBlock = comment?.trim() ? `\nКОМЕНТАР ДО РОБОТИ: ${comment.trim()}\n` : "";

    let instruction = "";
    if (sec.id === "intro") {
      // Якщо методичка явно вказала структуру вступу — використовуємо її
      const hasMethodIntroReq = info?.introStructure || (info?.requirements && /вступ.*(?:актуальн|мет[аи]|об.єкт|предмет)/i.test(info.requirements));
      const introStructure = hasMethodIntroReq
        ? `Структура вступу відповідно до вимог: ${info.introStructure || info.requirements}`
        : `Структура вступу (СТРОГО: кожен елемент — один окремий абзац, мітка і текст на ОДНОМУ рядку):
Абзац 1 — починай рядок зі слів "Актуальність теми:" і одразу на тому ж рядку пиши 95-110 слів актуальності (без переносу рядка між міткою і текстом).
Абзац 2 — починай рядок зі слів "Об'єкт дослідження:" і одразу на тому ж рядку — одне речення про що досліджується.
Абзац 3 — починай рядок зі слів "Предмет дослідження:" і одразу на тому ж рядку — конкретний аспект об'єкту.
Абзац 4 — починай рядок зі слів "Мета роботи:" і одразу на тому ж рядку — одне речення.
Абзац 5 — починай рядок зі слів "Завдання дослідження:" і одразу на тому ж рядку — 3-4 завдання через крапку з комою АБО кожне з нового рядка як продовження абзацу.
ЗАБОРОНЕНО: НЕ пиши мітку окремим рядком а текст нижче — мітка і текст завжди разом на одному рядку.`;
      instruction = `Напиши ВСТУП для реферату на тему "${info?.topic}".
${materialContext}${methodReqBlock}${commentBlock}${introStructure}
${!methodReqBlock && info?.requirements ? `\nДодаткові вимоги: ${info.requirements}` : ""}
Обсяг: ~${approxParas} абзаців (~${pagesPerSec} стор.). Без цитат на джерела. Починай одразу з тексту — не пиши слово "Вступ" на початку.`;
    } else if (sec.id === "conclusions") {
      instruction = `Напиши ВИСНОВКИ для реферату на тему "${info?.topic}".
${materialContext}${methodReqBlock}${commentBlock}Підсумуй основні результати по кожному розділу. Конкретні висновки без загальних фраз.
${!methodReqBlock && info?.requirements ? `Вимоги: ${info.requirements}\n` : ""}Обсяг: ~${approxParas} абзаців (~${pagesPerSec} стор.). Без цитат. Без жирного. Без нумерації. Пиши суцільними абзацами.`;
    } else {
      const tableNumInstr = chapNum
        ? `Таблиці нумеруй: Таблиця ${chapNum}.Y – Назва (Y — порядковий номер у цьому розділі, починаючи з 1). Рисунки нумеруй: Рис. ${chapNum}.Y – Назва.`
        : "";
      instruction = `Напиши розділ "${sec.label}" для реферату на тему "${info?.topic}". Галузь: ${info?.subject || ""}.
${materialContext}${methodReqBlock}${commentBlock}${sourcesBlock}${!methodReqBlock && info?.requirements ? `Вимоги до оформлення: ${info.requirements}\n` : ""}${tableNumInstr ? tableNumInstr + "\n" : ""}Обсяг: ~${approxParas} абзаців (~${pagesPerSec} стор.). ${citNote} Без жирного. Завершуй підсумковим реченням.
НЕ включай заголовок розділу у відповідь — починай одразу з тексту.`;
    }

    const allFileContext = [...refFileContext, ...matFileContext];
    const msgs = allFileContext.length > 0
      ? [{ role: "user", content: [...allFileContext, { type: "text", text: instruction }] }]
      : [{ role: "user", content: instruction }];

    try {
      const secMaxTokens = Math.min(30000, Math.max(6000, Math.round(pagesPerSec * 3000)));
      const result = await callClaude(msgs, null, buildSYSSmall(lang), secMaxTokens);
      setSections(p => {
        const next = p.map((s, i) => i === genIdx ? { ...s, text: result } : s);
        saveToFirestore({ sections: next, stage: "writing", status: "writing", genIdx: genIdx + 1 });
        return next;
      });
      await new Promise(r => setTimeout(r, 2000));
      setGenIdx(g => g + 1);
    } catch (e) {
      setError(e.message);
    }
    runningRef.current = false; setRunning(false); setLoadMsg("");
  };

  // ── Генерація статті/есе ──
  const doGenerateSimple = async (citationsOverride) => {
    setRunning(true); setLoadMsg("Генерую...");
    const lang = info?.language || "Українська";
    const totalPages = parsePagesAvg(info?.pages || "5");

    const toClaudeFile = f => ({ type: f.type.startsWith("image/") ? "image" : "document", source: { type: "base64", media_type: f.type, data: f.b64 } });
    const fileContext = files.map(toClaudeFile);
    const matFileContext = materialFiles.length > 0
      ? [{ type: "text", text: "Матеріал для роботи (файли — проаналізуй і використай):" }, ...materialFiles.map(toClaudeFile)]
      : [];

    const activeCitations = citationsOverride ?? tezyCitations;
    const hasSources = activeCitations.length > 0;
    const citeMap = buildCiteMap(activeCitations);
    const sourcesContext = hasSources
      ? `\nДЖЕРЕЛА — вставляй посилання ВИКЛЮЧНО у форматі [N] або [N, с. PAGE] (де N — номер джерела). ЗАБОРОНЕНО формат (Автор, рік). ТОЧНО у форматі перед кожним джерелом:\n${activeCitations.map((s, i) => `${citeMap[i + 1]} ${s}`).join("\n")}`
      : "";
    const sourcesList = hasSources
      ? `\nСписок використаних джерел:\n${activeCitations.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
      : "";

    const materialContext = materialText.trim()
      ? `\nМАТЕРІАЛ ДЛЯ РОБОТИ (проаналізуй і використай як основу):\n${materialText.trim()}\n`
      : "";

    const figureInstr = (info?.needsFigures && (info?.figureCount || 0) > 0)
      ? `\nРИСУНКИ (${info.figureCount} шт.): Постав рисунки у текст там де доречно. Для кожного рисунку:
– у реченні зроби посилання: (рис. N)
– після абзацу з посиланням окремим рядком маркер пошуку: [🔍 Рисунок N: "конкретний пошуковий запит для Google Images"]
– наступний рядок — підпис: Рис. N — Назва рисунку`
      : "";

    const isEnglishLang = /англ|english/i.test(lang);
    const typePrompts = {
      stattia: isEnglishLang
        ? `Write an ACADEMIC ARTICLE.
Title: "${info?.topic}" — in CAPITALS, centered.
Field: ${[info?.subject, info?.direction].filter(Boolean).join(", ")}.
Structure: Introduction (relevance, aim), Materials and Methods, Results and Discussion, Conclusions.
Length: ~${totalPages} pages. Academic style. No bold.`
        : `Напиши НАУКОВУ СТАТТЮ.
Назва: "${info?.topic}" — ВЕЛИКИМИ ЛІТЕРАМИ, по центру.
Галузь: ${[info?.subject, info?.direction].filter(Boolean).join(", ")}.
Структура: Вступ (актуальність, мета), Матеріали і методи, Результати та обговорення, Висновки.
Обсяг: ~${totalPages} сторінок. Академічний стиль. Без жирного.`,
      ese: isEnglishLang
        ? `Write an ESSAY.
Title: "${info?.topic}".
Structure: thesis, arguments with examples (3-4 paragraphs), counter-argument, conclusion.
Length: ~${totalPages} pages. Analytical style. No bold.`
        : `Напиши ЕСЕ.
Назва: "${info?.topic}".
Структура: теза, аргументи з прикладами (3-4 абзаци), контраргумент, висновок.
Обсяг: ~${totalPages} сторінок. Аналітичний стиль. Без жирного.`,
    };

    const prompt = `${typePrompts[workType] || `Напиши роботу на тему "${info?.topic}".`}
${materialContext}
${comment?.trim() ? `\nКОМЕНТАР ЗАМОВНИКА (виконай обов'язково): ${comment.trim()}\n` : ""}${methodRequirements?.trim() ? `\nВИМОГИ ДО РОБОТИ (ОБОВ'ЯЗКОВО дотримуватись):\n${methodRequirements}` : (info?.requirements ? `\nВИМОГИ: ${info.requirements}` : "")}
${info?.uniqueness ? `Унікальність: ${info.uniqueness}.` : ""}
Мова: ${lang}.
${sourcesContext}
${figureInstr}
${sourcesList ? `\nПісля основного тексту додай (зберігай форматування *курсив* у джерелах без змін):\n${sourcesList}` : ""}`;

    try {
      const msgs = [{ role: "user", content: [...matFileContext, ...fileContext, { type: "text", text: prompt }] }];
      const articleMaxTokens = Math.min(60000, Math.max(8000, Math.round(totalPages * 3000)));
      const text = await callClaude(msgs, null, buildSYSSmall(lang), articleMaxTokens);
      setResult(text);
      playDoneSound();
      await saveToFirestore({ result: text, tezyCitations: activeCitations, stage: "done", status: "done" });
      setStage("done");
    } catch (e) { setError(e.message); }
    setRunning(false); setLoadMsg("");
  };

  // ── Допоміжна: текст роботи для прези/доповіді ──
  const getWorkFullText = () => {
    if (workType === "dopovid") return "";
    if (workType === "referat") {
      return sections.filter(s => s.text).map(s => `### ${s.label}\n${s.text}`).join("\n\n");
    }
    return result || "";
  };

  // ── Допоміжна: fileContent для dopovid ──
  // DOCX → витягуємо текст через mammoth; PDF/зображення → передаємо як файл
  const getDopovIdFileContent = async () => {
    if (!presFile) return { fileContent: [], extractedText: "" };
    const isDocx = presFile.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      || presFile.name?.toLowerCase().endsWith(".docx")
      || presFile.name?.toLowerCase().endsWith(".doc");
    if (isDocx) {
      try {
        const bytes = Uint8Array.from(atob(presFile.b64), c => c.charCodeAt(0));
        const result = await mammoth.extractRawText({ arrayBuffer: bytes.buffer });
        return { fileContent: [], extractedText: result.value.trim() };
      } catch { return { fileContent: [], extractedText: "" }; }
    }
    return {
      fileContent: [{ type: presFile.type.startsWith("image/") ? "image" : "document", source: { type: "base64", media_type: presFile.type, data: presFile.b64 } }],
      extractedText: "",
    };
  };

  // ── Презентація для малих робіт (один Claude виклик) ──
  const generateSmallPresentation = async () => {
    setPresLoading(true);
    setPresMsg("Генерую презентацію...");
    try {
      const lang = info?.language || "Українська";
      const fullText = getWorkFullText();
      const isDopovid = workType === "dopovid";
      const commentBlock = presComment.trim() ? `\nКОМЕНТАР ЗАМОВНИКА (виконай обов'язково): ${presComment.trim()}\n` : "";
      const { fileContent, extractedText } = isDopovid
        ? await getDopovIdFileContent()
        : { fileContent: presFile ? [{ type: presFile.type.startsWith("image/") ? "image" : "document", source: { type: "base64", media_type: presFile.type, data: presFile.b64 } }] : [], extractedText: "" };
      const workText = fullText || extractedText;
      const speechBlock = speechText.trim()
        ? `\nТЕКСТ ДОПОВІДІ ДЛЯ ЗАХИСТУ (слайди ОБОВ'ЯЗКОВО мають покривати КОЖЕН пункт, завдання, стратегію, модель, етап тощо, перелічені в доповіді — з ТІЄЮ Ж кількістю елементів; нічого не пропускай і не додавай зайвого, аби виступ і слайди не розходились):\n${speechText.trim()}\n`
        : "";

      const claudePrompt = `Уважно прочитай роботу і згенеруй JSON для презентації захисту.
${workText ? `\nТЕКСТ РОБОТИ:\n${workText}\n` : ""}${speechBlock}${commentBlock}
КРИТИЧНІ ВИМОГИ ДО ТОЧНОСТІ:
- Копіюй всі числа, параметри, назви ДОСЛІВНО з тексту — НЕ перефразовуй
- ПІБ студента, керівника, назву закладу — точно як у роботі (якщо не знайдено — null, НЕ пиши "[Студент]" або плейсхолдери)
- Назви таблиць, заголовки колонок — точно як у тексті
- Всі рядки таблиць — повністю, нічого не скорочуй
${speechText.trim() ? "- Якщо в доповіді перелічено N пунктів (завдань, стратегій, моделей тощо) — відповідний слайд має містити всі N, навіть якщо доведеться розбити їх на кілька слайдів\n" : ""}

СТРУКТУРА (у такому порядку):
1. layout "title_slide" — тема, тип роботи, студент, керівник, заклад, рік
2. layout "two_column" — Актуальність
3. layout "two_column" або "highlight_box" — Об'єкт та предмет дослідження (тільки якщо явно сформульовані у тексті; якщо ні — пропусти цей слайд)
4. layout "icon_list" — Мета (🎯) та ВСІ завдання (→) дослівно як у тексті — порахуй їх точно; якщо разом із метою > 6 — розбий на 2 слайди
5. layout "numbered_steps" — Методи (якщо методів немає у тексті явно — пропусти)
6–N. ЗМІСТОВІ: для КОЖНОЇ таблиці → layout "table" з УСІМА рядками; для числових результатів → "stat_callout"; для решти → "highlight_box"
N-1. layout "icon_list" — Висновки (✅)
N. layout "hero" — "Дякую за увагу!", subtitle: ""

ПРАВИЛА JSON:
- Кількість слайдів: 12–20 залежно від обсягу роботи
- Мова: ${lang}
- title_slide: {title, work_type, student, supervisor, institution, year} — null якщо не знайдено
- two_column: {title, left, right_type:"text", right}
- icon_list: {title, visual:{items:[{icon,header,text}]}}
- numbered_steps: {title, visual:{items:[{num,title,text}]}}
- stat_callout: {title, visual:{stats:[{value,label}]}, content}
- highlight_box: {title, points:[], accent} (accent — реальний зміст або null; НІКОЛИ не пиши назви кольорів)
- table: {title, visual:{headers:[...], rows:[[...]]}, content:"підпис що показує таблиця"}
- hero: {title, subtitle:""}
- НІКОЛИ не додавай номери замовлень, ID або технічні ідентифікатори
- theme: "midnight" (техніка/інженерія), "forest" (природа/медицина/біологія), "coral" (соціальне/педагогіка), "slate" (економіка/фінанси), "warm" (решта)

Поверни ТІЛЬКИ валідний JSON без markdown:
{"theme":"...","slides":[...]}`;

      setPresMsg("Аналізую та генерую слайди...");
      const userContent = [
        ...fileContent,
        { type: "text", text: claudePrompt },
      ];
      const claudeRaw = await callClaude(
        [{ role: "user", content: userContent }], null,
        SYS_JSON_SHORT, 12000,
        (s) => setPresMsg(`Генерую... зачекайте ${s}с`), MODEL
      );

      let slideData;
      try {
        slideData = JSON.parse(claudeRaw.replace(/```json\n?|\n?```/g, "").trim());
      } catch { throw new Error("Claude повернув некоректний JSON слайдів"); }

      // ── Крок 3: Зберігаємо дані ДО експорту (щоб при помилці або оновленні сторінки не загубити) ──
      setPresSlideJson(slideData);
      setPresReady(true);
      await saveToFirestore({ presReady: true, presSlideJson: slideData });

      // ── Крок 4: Створюємо PPTX ──
      setPresMsg("Створюю файл...");
      await exportToPptxFile(slideData, info, currentIdRef.current);
    } catch (e) { alert("Помилка генерації презентації: " + e.message); }
    setPresLoading(false);
    setPresMsg("");
  };

  // ── Доповідь, розмічена по слайдах (мітки "Слайд N" над уже готовим текстом доповіді) ──
  const generateSpeechWith = async () => {
    if (!speechText.trim()) {
      alert("Спочатку згенеруйте доповідь.");
      return;
    }
    if (!presSlideJson?.slides?.length) {
      alert("Спочатку згенеруйте презентацію.");
      return;
    }
    setSpeechWithLoading(true);
    try {
      const lang = info?.language || "Українська";

      const LAYOUT_LABEL = {
        hero: "Титульний/фінальний", two_column: "Два стовпці", stat_callout: "Статистика",
        icon_list: "Список з іконками", highlight_box: "Виділені пункти", numbered_steps: "Кроки",
      };
      const slidesOutline = presSlideJson.slides
        .map((sl, i) => {
          const label = LAYOUT_LABEL[sl.layout] || sl.layout;
          const parts = [`Слайд ${i + 1} [${label}]: ${sl.title || ""}`];
          if (sl.subtitle) parts.push(`  Підзаголовок: ${sl.subtitle}`);
          if (sl.left) parts.push(`  Ліво: ${sl.left}`);
          if (sl.right) parts.push(`  Право: ${sl.right}`);
          if (sl.content) parts.push(`  Текст: ${sl.content}`);
          if (sl.accent) parts.push(`  Акцент: ${sl.accent}`);
          if (sl.visual?.stats?.length) parts.push(`  Статистика: ${sl.visual.stats.map(s => `${s.value} (${s.label})`).join(", ")}`);
          if (sl.visual?.items?.length) parts.push(`  Пункти: ${sl.visual.items.map(it => typeof it === "object" ? `${it.header || ""}: ${it.text || ""}` : it).join(" | ")}`);
          if (sl.points?.length) parts.push(`  Пункти: ${sl.points.join(" | ")}`);
          return parts.join("\n");
        })
        .join("\n\n");

      const prompt = `Розклади наведений нижче ГОТОВИЙ текст доповіді по слайдах презентації — встав мітку "Слайд N" окремим рядком перед фрагментом, який відповідає цьому слайду.

ГОТОВИЙ ТЕКСТ ДОПОВІДІ (використай ДОСЛІВНО — НЕ редагуй, НЕ перефразовуй, НЕ скорочуй і НЕ додавай нових речень, лише розбий його на фрагменти):
${speechText.trim()}

СТРУКТУРА ПРЕЗЕНТАЦІЇ (${presSlideJson.slides.length} слайдів, виступ має йти паралельно з ними):
${slidesOutline}

ВИМОГИ:
- Розбий наведений текст доповіді на фрагменти і встав перед кожним мітку "Слайд N" окремим рядком
- Якщо для якогось слайду немає відповідного фрагменту тексту — НЕ вставляй порожню мітку; об'єднай цей слайд з попереднім або наступним
- Мітка "Слайд N" має з'являтись ТІЛЬКИ якщо після неї є текст
- Збережи дослівний текст і його послідовність — це лише розмітка наявного тексту, а не новий текст
- Мова: ${lang}
- Без markdown, зірочок, жирного — тільки мітки "Слайд N" і незмінний текст доповіді`;

      const raw = await callGemini(
        [{ role: "user", content: prompt }], null,
        "You only segment and label the given text into slide-aligned fragments — you must not rewrite, paraphrase, shorten or add anything to it.", 5000,
        null, "gemini-2.5-flash"
      );

      const lines = raw
        .split("\n")
        .filter(line => {
          const t = line.trim();
          if (!t) return true;
          if (/^Слайд\s+\d+/i.test(t)) return true;
          if (/^#{1,6}\s/.test(t)) return false;
          return true;
        });

      // Видаляємо мітки "Слайд N" без тексту після них
      const cleaned = lines
        .filter((line, i) => {
          if (!/^Слайд\s+\d+/i.test(line.trim())) return true;
          const nextNonEmpty = lines.slice(i + 1).find(l => l.trim());
          return nextNonEmpty && !/^Слайд\s+\d+/i.test(nextNonEmpty.trim());
        })
        .join("\n")
        .replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");

      setSpeechWithText(cleaned);
      await saveToFirestore({ speechWithText: cleaned });
    } catch (e) { alert("Помилка розмітки доповіді: " + e.message); }
    setSpeechWithLoading(false);
  };

  // ── Доповідь без прив'язки до слайдів ──
  const generateSpeechWithout = async () => {
    setSpeechLoading(true);
    try {
      const lang = info?.language || "Українська";
      const sectionText = getWorkFullText();
      const isDopovid = workType === "dopovid";
      const { fileContent: dopFile, extractedText: dopText } = isDopovid ? await getDopovIdFileContent() : { fileContent: [], extractedText: "" };
      const workText = sectionText || dopText;

      const prompt = `Напиши текст доповіді для захисту ${info?.type || cfg?.label || "роботи"} на тему "${info?.topic}".
${workText ? `\nПОВНИЙ ТЕКСТ РОБОТИ (витягуй конкретні факти, методи, результати, числа):\n${workText}\n` : ""}
ВИМОГИ:
- Обсяг: 3-5 хвилин (2-3 сторінки)
- Структура: вступ → актуальність → мета і завдання → методи → результати → висновки → завершення
- Стиль: стриманий академічний усний
- ОБОВ'ЯЗКОВО: конкретні назви методів, числа, відсотки з роботи
- ЗАБОРОНЕНО: "тема є актуальною", "варто відмітити", "слід зазначити"
- БЕЗ міток "Слайд N" — суцільний академічний текст
- НЕ виводь назви розділів та їх номери
- НЕ вигадуй і НЕ виводь об'єкт, предмет, методи якщо вони не сформульовані явно у тексті роботи
- Мова: ${lang}
- Без markdown, зірочок, жирного`;

      const speechMsgsWithout = isDopovid && dopFile.length > 0
        ? [{ role: "user", content: [...dopFile, { type: "text", text: prompt }] }]
        : [{ role: "user", content: prompt }];
      const raw = await callGemini(
        speechMsgsWithout, null,
        "You are an expert academic writing assistant. Write a substantive, factual oral defense speech. Every sentence must state a concrete fact, method, result or conclusion — no filler phrases. No markdown formatting.", 5000,
        null, "gemini-2.5-flash"
      );

      const cleaned = raw
        .split("\n")
        .filter(line => {
          const t = line.trim();
          if (!t) return true;
          if (/^\d+(\.\d+)+[\s\.]/.test(t)) return false;
          if (/^#{1,6}\s/.test(t)) return false;
          return true;
        })
        .join("\n")
        .replace(/[ᄀ-ᇿ⺀-鿿ꀀ-꓿가-퟿豈-﫿]/g, "")
        .replace(/[„""]([^"„""]*)["""]/g, "«$1»")
        .replace(/"([^"]*)"/g, "«$1»")
        .replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");

      setSpeechText(cleaned);
      await saveToFirestore({ speechText: cleaned });
    } catch (e) { alert("Помилка генерації доповіді: " + e.message); }
    setSpeechLoading(false);
  };

  // ── Генерація презентації (2 кроки) ──
  const doGeneratePresentation = async (citationsOverride) => {
    setRunning(true);
    const lang = info?.language || "Українська";
    const totalSlides = Math.max(8, Math.min(20, parsePagesAvg(info?.pages || "15")));
    const activeCitations = citationsOverride ?? tezyCitations;
    const hasSources = activeCitations.length > 0;
    const citStyle = info?.citStyle || "ДСТУ 8302:2015";

    const toClaudeFile = f => ({ type: f.type.startsWith("image/") ? "image" : "document", source: { type: "base64", media_type: f.type, data: f.b64 } });
    const fileContext = files.map(toClaudeFile);
    const matFileContext = materialFiles.length > 0
      ? [{ type: "text", text: "Матеріал для презентації (проаналізуй і використай для наповнення слайдів):" }, ...materialFiles.map(toClaudeFile)]
      : [];
    const instrFileContext = instrFiles.length > 0
      ? [{ type: "text", text: "Інструкції з оформлення (уважно прочитай і виконай при побудові слайдів — структура, вимоги, приклади):" }, ...instrFiles.map(toClaudeFile)]
      : [];
    const materialContext = materialText.trim()
      ? `\nМАТЕРІАЛ (використай як основу змісту):\n${materialText.trim()}\n`
      : "";
    const reqBlock = methodRequirements?.trim()
      ? `\nВИМОГИ (дотримуватись):\n${methodRequirements}\n`
      : (info?.requirements ? `\nВимоги: ${info.requirements}\n` : "");
    const commentBlock = comment?.trim() ? `\nКОМЕНТАР ЗАМОВНИКА (виконай обов'язково): ${comment.trim()}\n` : "";
    const sourcesBlock = hasSources
      ? `\nДЖЕРЕЛА — використовуй посилання у тексті слайдів:\n${activeCitations.map((c, i) => `[${i + 1}] ${c}`).join("\n")}\n`
      : "";

    try {
      setLoadMsg("Аналізую матеріали та генерую презентацію...");
      const prompt = `Створи презентацію на тему "${info?.topic}". Галузь: ${info?.subject || ""}. Мова: ${lang}.
${reqBlock}${materialContext}${commentBlock}${sourcesBlock}
Поверни ТІЛЬКИ JSON без markdown — рівно ${totalSlides} слайдів:
{"slides":[...]}

СТРУКТУРА:
- Слайд 1: layout "hero", title = назва теми, subtitle = коротка підназва
- Слайди 2–${totalSlides - 1}: змістові слайди з конкретними фактами, цифрами, прикладами з матеріалів
- Слайд ${totalSlides}: layout "hero", title "Дякую за увагу!", subtitle ""

ТИПИ LAYOUT:
- "hero" — тільки 1-й, останній, великі розділювачі
- "icon_list" — перелік 3–5 рівнозначних пунктів. Поле: visual.items [{icon,header,text}]
- "numbered_steps" — послідовний процес, кроки (3–4 елементи). Поле: visual.items [{num,title,text}]
- "two_column" — порівняння або два аспекти. Поля: left, right (або right_type:"stat", right_value, right_label)
- "stat_callout" — конкретні числа/відсотки. Поле: visual.stats [{value,label}], content (текст нижче)
- "highlight_box" — основний текст (default). Поле: content (рядки через \\n), accent (виділений підсумок)
- "table" — таблиця з даними. Поле: visual.headers ["Кол1","Кол2"], visual.rows [["а","б"],["в","г"]]
- "chart" — графік. Поле: visual.type ("bar"|"line"|"pie"|"doughnut"), visual.series [{name,labels:[...],values:[...]}]
- "image_placeholder" — весь слайд займає виділений жовтий блок із підписом де має бути зображення. Поле: image "Назва/опис зображення"
- "two_column" з right_type:"image" — ліво текст, право виділений блок-заглушка. Поле: right "Назва зображення"

ШРИФТ: якщо інструкції вказують конкретний шрифт — додай поле "font":"Назва шрифту" в корінь JSON (поруч з "slides"). Стандартні системні шрифти: Arial, Calibri, Times New Roman, Georgia, Verdana.

ПРАВИЛА:
- Кожен слайд — 1 чітка ідея
- Конкретні дані з матеріалів, не загальні фрази
- Заголовки слайдів — 3–6 слів
- Текст у content — стислі тези, до 7 слів на рядок
- stat_callout тільки якщо є реальні числа з матеріалів
- table — коли потрібно порівняти кілька об'єктів по кількох параметрах
- chart — коли є числові дані для відображення динаміки або розподілу
- image_placeholder або two_column з right_type:"image" — коли за змістом має бути фото, схема, графік, діаграма, малюнок
НЕ додавай слайд джерел.`;

      const msgs = [{ role: "user", content: [...fileContext, ...matFileContext, ...instrFileContext, { type: "text", text: prompt }] }];
      const raw = await callClaude(msgs, null, `Ти експерт із презентацій. Відповідай ТІЛЬКИ валідним JSON без markdown. Мова контенту: ${lang}.`, 6000, null, MODEL);
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      let newSlides = parsed.slides || [];

      if (hasSources) {
        newSlides = [...newSlides, {
          layout: "highlight_box",
          title: `Список використаних джерел (${citStyle})`,
          content: activeCitations.map((c, i) => `${i + 1}. ${c}`).join("\n"),
        }];
      }

      setSlides(newSlides);
      playDoneSound();
      setStage("done");
      await saveToFirestore({ slides: newSlides, tezyCitations: activeCitations, stage: "done", status: "done" });
    } catch (e) { setError(e.message); }
    setRunning(false); setLoadMsg("");
  };

  const fileLimit = workType === "tezy" ? 10 : 3;
  const handleAddFile = (name, b64, type) => {
    if (files.length >= fileLimit) {
      setFiles(p => [...p.slice(1), { name, b64, type }]);
    } else {
      setFiles(p => [...p, { name, b64, type }]);
    }
  };

  const progress = sections.length
    ? Math.round(sections.filter(s => s.text).length / sections.length * 100)
    : 0;

  if (dbLoading) return (
    <div style={{ minHeight: "100vh", background: "#f5f2eb", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <SpinDot />
    </div>
  );

  const cfg = workType ? WORK_TYPES[workType] : null;

  return (
    <div style={{ minHeight: "100vh", background: "#f5f2eb", fontFamily: "'Spectral',Georgia,serif", color: "#1a1a14" }}>
      <style>{SHARED_STYLES}</style>

      {/* Header */}
      <div style={{ position: "sticky", top: 0, zIndex: 100, background: "#1a1a14", color: "#f5f2eb", padding: "15px 32px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        {onBack && (
          <button onClick={onBack} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "5px 14px", cursor: "pointer", fontFamily: "inherit", fontSize: 12, marginRight: 4 }}>
            ← Замовлення
          </button>
        )}
        <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 19, letterSpacing: 5, color: "#e8ff47" }}>ACADEM</div>
        <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 19, letterSpacing: 5 }}>SMALL</div>
        {cfg && <div style={{ fontSize: 12, color: "#888", marginLeft: 4 }}>{cfg.icon} {cfg.label}</div>}
        {(info?.orderNumber || dopOrderNumber.trim()) && <div style={{ fontSize: 11, color: "#888", whiteSpace: "nowrap", flexShrink: 0 }}>#{info?.orderNumber || dopOrderNumber.trim()}</div>}
        {info?.topic && <div style={{ fontSize: 12, color: "#555", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{info.topic}</div>}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          <SaveIndicator saving={saving} saved={saved} />
          {workType && <StagePills stage={stage} workType={workType} onNavigate={setStage} maxStageIdx={maxStageIdx} />}
        </div>
      </div>

      <div style={{ maxWidth: 860, margin: "0 auto", padding: "32px clamp(16px, 3vw, 48px)" }}>

        {/* Помилка */}
        {error && (
          <div style={{ background: "#fff0f0", border: "1px solid #ffcccc", borderRadius: 8, padding: "12px 16px", marginBottom: 20, color: "#c00", fontSize: 13, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>⚠ {error}</span>
            <button onClick={() => setError("")} style={{ background: "none", border: "none", color: "#c00", cursor: "pointer", fontSize: 16 }}>✕</button>
          </div>
        )}

        {/* ══ ВИБІР ТИПУ ══ */}
        {!workType && <WorkTypeSelector onSelect={t => { setWorkType(t); setStage("input"); }} />}

        {/* ══ КРОК 1: ДАНІ ══ */}
        {workType && stage === "input" && (
          <div className="fade">
            <Heading>{cfg.icon} {cfg.label} — Дані замовлення</Heading>

            {/* ── Тип "Доповідь та презентація" — спрощена форма ── */}
            {workType === "dopovid" && (
              <>
                <FieldBox label="Тема роботи *">
                  <textarea value={tplText} onChange={e => setTplText(e.target.value)}
                    placeholder={"Тема - ...\nДисципліна - ...\nТип роботи - (курсова, реферат, диплом...)\nАвтор - ...\nНауковий керівник - ..."}
                    style={{ ...TA, minHeight: 120 }} />
                </FieldBox>
<FieldBox label="Готова робота * (PDF, DOCX, зображення)">
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {presFile && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#eef5e4", borderRadius: 6, fontSize: 13 }}>
                        <span>📄 {presFile.name}</span>
                        <button onClick={() => setPresFile(null)} style={{ marginLeft: "auto", background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 14 }}>✕</button>
                      </div>
                    )}
                    {!presFile && (
                      <DropZone fileLabel={null} onFile={(name, b64, type) => setPresFile({ name, b64, type })} accept=".pdf,.docx,.doc,.jpg,.jpeg,.png" />
                    )}
                  </div>
                </FieldBox>
                <FieldBox label="Коментар (необов'язково)">
                  <textarea value={presComment} onChange={e => setPresComment(e.target.value)}
                    placeholder="Вимоги до оформлення, стиль, що врахувати при генерації..."
                    style={{ ...TA, minHeight: 70 }} />
                </FieldBox>
              </>
            )}

            {/* ── Інші типи робіт — стандартна форма ── */}
            {workType !== "dopovid" && (
            <><FieldBox label="Шаблон замовлення *">
              <textarea value={tplText} onChange={e => setTplText(e.target.value)}
                placeholder={workType === "prezentatsiya"
                  ? `Тема - ...\nК-сть слайдів - ...\nДедлайн - ...\nДисципліна - ...\nВимоги - ...`
                  : `Тема - ...\nСторінок - ...\nДедлайн - ...\nВимоги - ...`}
                style={{ ...TA, minHeight: 160 }} />
            </FieldBox>

            {workType === "referat" && (
              <FieldBox label="Готовий план від клієнта (необов'язково)">
                <textarea value={clientPlan} onChange={e => setClientPlan(e.target.value)}
                  placeholder={"Розділ 1. Назва\nРозділ 2. Назва\n..."}
                  style={{ ...TA, minHeight: 80 }} />
              </FieldBox>
            )}

            {workType !== "tezy" && workType !== "prezentatsiya" && (
              <FieldBox label="Коментар">
                <textarea value={comment} onChange={e => setComment(e.target.value)}
                  placeholder="Додаткові вимоги..." style={{ ...TA, minHeight: 70 }} />
              </FieldBox>
            )}

            {workType !== "tezy" && workType !== "prezentatsiya" && (
              <FieldBox label={
                ["stattia", "ese", "referat"].includes(workType)
                  ? "Методичка (необов'язково)"
                  : "Рекомендації / методичка / скріни (до 3 файлів) — необов'язково"
              }>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {files.map((f, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#eef5e4", borderRadius: 6, fontSize: 13 }}>
                      <span>📄 {f.name}</span>
                      <button onClick={() => setFiles(p => p.filter((_, j) => j !== i))} style={{ marginLeft: "auto", background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 14 }}>✕</button>
                    </div>
                  ))}
                  {files.length < fileLimit && (
                    <DropZone fileLabel={null} onFile={handleAddFile} accept=".pdf,.docx,.jpg,.jpeg,.png" />
                  )}
                </div>
              </FieldBox>
            )}

            {/* Матеріал для роботи — для тез, статті, есе, реферату, презентації */}
            {["tezy", "stattia", "ese", "referat", "prezentatsiya"].includes(workType) && (
              <FieldBox label={workType === "prezentatsiya" ? "Текст і файл для аналізу — основа змісту слайдів (необов'язково)" : `Матеріал для роботи — текст або файли/фото до ${["stattia", "ese", "referat"].includes(workType) ? 8 : 6} (необов'язково)`}>
                <textarea
                  value={materialText}
                  onChange={e => setMaterialText(e.target.value)}
                  placeholder={workType === "prezentatsiya"
                    ? "Вставте текст статті, конспект лекцій або нотатки — ШІ проаналізує і наповнить слайди конкретним змістом..."
                    : "Вставте текст, конспект або будь-який матеріал що має лягти в основу роботи..."}
                  style={{ ...TA, minHeight: 100 }}
                />
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                  {materialFiles.map((f, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", background: "#eef5e4", borderRadius: 6, fontSize: 13 }}>
                      <span>{f.type.startsWith("image/") ? "🖼" : "📄"} {f.name}</span>
                      <button onClick={() => setMaterialFiles(p => p.filter((_, j) => j !== i))} style={{ marginLeft: "auto", background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 14 }}>✕</button>
                    </div>
                  ))}
                  {materialFiles.length < (["stattia", "ese", "referat"].includes(workType) ? 8 : workType === "prezentatsiya" ? 20 : 6) && (
                    <DropZone fileLabel={null} multiple={workType === "prezentatsiya"} onFile={(name, b64, type) => { const lim = ["stattia", "ese", "referat"].includes(workType) ? 8 : workType === "prezentatsiya" ? 20 : 6; setMaterialFiles(p => p.length >= lim ? [...p.slice(1), { name, b64, type }] : [...p, { name, b64, type }]); }} accept=".pdf,.docx,.jpg,.jpeg,.png" />
                  )}
                </div>
                {(materialText.trim() || materialFiles.length > 0) && (
                  <div style={{ fontSize: 11, color: "#5a8a2a", marginTop: 6 }}>
                    ✓ {[materialText.trim() ? `${materialText.trim().split(/\s+/).length} сл.` : null, materialFiles.length ? `${materialFiles.length} файл(и)` : null].filter(Boolean).join(" + ")} — буде передано ШІ
                  </div>
                )}

                {workType === "prezentatsiya" && (
                  <>
                    <div style={{ borderTop: "1px dashed #d4cfc4", margin: "14px 0 10px" }} />
                    <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", color: "#888", marginBottom: 8 }}>
                      ІНСТРУКЦІЇ З ОФОРМЛЕННЯ (необов'язково)
                    </div>
                    <div style={{ fontSize: 12, color: "#999", marginBottom: 8 }}>
                      Скріни, PDF або фото з вимогами до структури — ШІ прочитає і виконає
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {instrFiles.map((f, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", background: "#f0eee8", borderRadius: 6, fontSize: 13 }}>
                          <span>{f.type.startsWith("image/") ? "🖼" : "📄"} {f.name}</span>
                          <button onClick={() => setInstrFiles(p => p.filter((_, j) => j !== i))} style={{ marginLeft: "auto", background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 14 }}>✕</button>
                        </div>
                      ))}
                      {instrFiles.length < 20 && (
                        <DropZone fileLabel={null} multiple onFile={(name, b64, type) => setInstrFiles(p => p.length >= 20 ? [...p.slice(1), { name, b64, type }] : [...p, { name, b64, type }])} accept=".pdf,.jpg,.jpeg,.png,.webp" />
                      )}
                    </div>
                    {instrFiles.length > 0 && (
                      <div style={{ fontSize: 11, color: "#5a8a2a", marginTop: 6 }}>
                        ✓ {instrFiles.length} файл(и) з інструкціями — буде передано ШІ
                      </div>
                    )}
                  </>
                )}
              </FieldBox>
            )}

            {/* Блок даних автора — тільки для тез */}
            {workType === "tezy" && (
              <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 8 }}>
                <button onClick={() => setAuthorDataOpen(o => !o)}
                  style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", background: "#f5f2eb", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 13, color: "#555" }}>
                  <span>Дані автора <span style={{ color: "#aaa", fontStyle: "italic" }}>(необов'язково — якщо є у шаблоні, ШІ витягне сам)</span></span>
                  <span style={{ fontSize: 11 }}>{authorDataOpen ? "▲" : "▼"}</span>
                </button>
                {authorDataOpen && (
                  <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: 10, background: "#faf8f3" }}>
                    {[
                      { key: "authorName", label: "ПІБ автора", placeholder: "Іваненко Іван Іванович" },
                      { key: "role", label: "Курс / посада", placeholder: "студент 3 курсу / аспірант / доцент" },
                      { key: "supervisor", label: "Науковий керівник", placeholder: "проф. Петренко П.П." },
                      { key: "university", label: "Університет", placeholder: "Київський національний університет..." },
                      { key: "faculty", label: "Факультет / кафедра", placeholder: "Факультет..." },
                    ].map(({ key, label, placeholder }) => (
                      <div key={key}>
                        <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>{label}</div>
                        <input value={authorData[key]} onChange={e => setAuthorData(d => ({ ...d, [key]: e.target.value }))}
                          placeholder={placeholder}
                          style={{ width: "100%", padding: "8px 10px", border: "1px solid #d4cfc4", borderRadius: 6, fontFamily: "inherit", fontSize: 13, background: "#fff", boxSizing: "border-box" }} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <PrimaryBtn
              onClick={doAnalyze}
              disabled={!tplText.trim()}
              loading={running}
              msg={loadMsg}
              label="Аналізувати →"
            />
            </>
            )}

            {/* Кнопка для dopovid */}
            {workType === "dopovid" && (
              <PrimaryBtn
                onClick={() => {
                  if (!tplText.trim()) { alert("Введіть тему роботи."); return; }
                  const lines = tplText.split("\n").map(l => l.trim()).filter(Boolean);
                  const topicLine = lines.find(l => /тема\s*[-–:]/i.test(l));
                  const SKIP = [/^[№#]\s*замовл/i, /^статус/i, /^дедлайн/i, /^менеджер/i, /^uid/i, /^date-/i, /^\d{4,}$/];
                  const topic = topicLine
                    ? topicLine.replace(/^.*тема\s*[-–:]\s*/i, "").trim()
                    : (lines.find(l => !SKIP.some(p => p.test(l)) && l.length > 8) || lines[0] || "").trim();
                  const extractedNum = lines.find(l => /^[№#]\s*замовл/i.test(l))?.match(/\d{3,}/)?.[0] || "";
                  const finalOrderNum = dopOrderNumber.trim() || extractedNum;
                  if (finalOrderNum && !dopOrderNumber.trim()) setDopOrderNumber(finalOrderNum);
                  const dopInfo = { topic, type: "Доповідь та презентація", ...(finalOrderNum && { orderNumber: finalOrderNum }) };
                  setInfo(dopInfo);
                  saveToFirestore({ tplText, presComment, info: dopInfo, stage: "done", status: "done" });
                  setStage("done");
                }}
                disabled={!tplText.trim()}
                label="Далі →"
              />
            )}
          </div>
        )}

        {/* ══ ПЛАН (тільки реферат) ══ */}
        {workType === "referat" && stage === "plan" && (
          <div className="fade">
            <Heading>📋 План реферату</Heading>

            {sections.length === 0 ? (
              <>
                <p style={{ fontSize: 13, color: "#888", marginBottom: 8 }}>
                  {clientPlan?.trim()
                    ? "Знайдено готовий план від клієнта — розберу його структуру."
                    : files.length > 0
                      ? "Є методичка — витягну структуру з неї."
                      : "Згенерую стандартний план за темою та кількістю сторінок."}
                </p>
                <p style={{ fontSize: 12, color: "#aaa", marginBottom: 20 }}>Стандарт: Вступ 1 стор. → Розділ 1 → Розділ 2 → Розділ 3 → Висновки 1 стор. → Список джерел</p>
                <PrimaryBtn onClick={doGenPlan} loading={running} msg={loadMsg} label="Згенерувати план →" />
              </>
            ) : (
              <>
                <p style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>Перевірте та відредагуйте план. Після підтвердження — збір джерел.</p>
                <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 20 }}>
                  {sections.map((sec, i) => (
                    <div key={sec.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", borderBottom: i < sections.length - 1 ? "1px solid #e4dfd4" : "none", background: ["intro", "conclusions", "sources"].includes(sec.id) ? "#ede9e0" : "#faf8f3" }}>
                      <span style={{ fontSize: 11, color: "#bbb", width: 20, flexShrink: 0 }}>{i + 1}</span>
                      <input value={sec.label} onChange={e => setSections(p => p.map((s, j) => j === i ? { ...s, label: e.target.value } : s))}
                        style={{ flex: 1, background: "transparent", border: "none", fontSize: 13, fontFamily: "'Spectral',serif", color: "#1a1a14", minWidth: 0 }} />
                      {sec.id !== "sources" ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                          <input
                            type="number" min="0.5" max="30" step="0.5"
                            value={sec.pages ?? 1}
                            onChange={e => setSections(p => p.map((s, j) => j === i ? { ...s, pages: parseFloat(e.target.value) || 1 } : s))}
                            style={{ width: 42, textAlign: "center", padding: "2px 4px", border: "1px solid #d4cfc4", borderRadius: 4, fontSize: 12, fontFamily: "'Spectral',serif", background: "#fff", color: "#555" }}
                          />
                          <span style={{ fontSize: 11, color: "#aaa" }}>стор.</span>
                        </div>
                      ) : (
                        <span style={{ fontSize: 11, color: "#aaa", whiteSpace: "nowrap", flexShrink: 0 }}>авто</span>
                      )}
                      {!["intro", "conclusions", "sources"].includes(sec.id) ? (
                        <button onClick={() => setSections(p => p.filter((_, j) => j !== i))}
                          style={{ background: "none", border: "none", color: "#ccc", cursor: "pointer", fontSize: 14, flexShrink: 0 }}
                          onMouseEnter={e => e.currentTarget.style.color = "#c00"}
                          onMouseLeave={e => e.currentTarget.style.color = "#ccc"}>✕</button>
                      ) : (
                        <span style={{ width: 18, flexShrink: 0 }} />
                      )}
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <NavBtn onClick={() => setSections([])}>Перегенерувати</NavBtn>
                  <PrimaryBtn onClick={() => { setStage("sources"); saveToFirestore({ sections, stage: "sources" }); }} label="До джерел →" />
                </div>
              </>
            )}
          </div>
        )}

        {/* ══ ГЕНЕРАЦІЯ (реферат — секції) ══ */}
        {workType === "referat" && stage === "writing" && (
          <div className="fade">
            <Heading>✍️ Генерація тексту</Heading>
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12, color: "#888" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                  {running && <SpinDot />}{running ? loadMsg : `${sections.filter(s => s.text).length} / ${sections.length} секцій готово`}
                </span>
                <span style={{ fontWeight: 600, color: "#1a1a14" }}>{progress}%</span>
              </div>
              <div style={{ height: 3, background: "#d4cfc4", borderRadius: 2 }}>
                <div style={{ height: "100%", width: progress + "%", background: "#1a1a14", borderRadius: 2, transition: "width .6s ease" }} />
              </div>
            </div>

            {sections.map((sec, i) => (
              <div key={sec.id} style={{ border: `1.5px solid ${sec.text ? "#aaa49a" : "#ddd9d0"}`, borderRadius: 8, marginBottom: 10, overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", background: sec.text ? "#1a1a14" : "#f0ece2" }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: sec.text ? "#e8ff47" : running && genIdx === i ? "#555" : "#ccc" }} />
                  <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: sec.text ? "#f5f2eb" : "#1a1a14" }}>{sec.label}</div>
                  {sec.text && <button onClick={() => navigator.clipboard.writeText(sec.text)} style={{ background: "transparent", border: "1px solid #555", color: "#999", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer" }}>COPY</button>}
                </div>
                {sec.text && <div style={{ padding: "14px 18px", fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", whiteSpace: "pre-wrap", maxHeight: 240, overflowY: "auto", background: "#faf8f3" }}>{sec.text}</div>}
                {running && genIdx === i && !sec.text && <div style={{ padding: "12px 18px", fontSize: 13, color: "#888", display: "flex", alignItems: "center", gap: 8, background: "#faf8f3" }}><SpinDot />Генерується...</div>}
              </div>
            ))}
          </div>
        )}

        {/* ══ ДЖЕРЕЛА ══ */}
        {["tezy", "stattia", "ese", "referat", "prezentatsiya"].includes(workType) && stage === "sources" && (() => {
          const isReferat = workType === "referat";
          const minSrc = workType === "prezentatsiya"
            ? (info?.sourceCount || 5)
            : (info?.sourceCount || parsePagesAvg(info?.pages || "3"));
          const citLines = citText.split("\n").map(s => s.trim()).filter(Boolean);
          const allRefCitations = isReferat
            ? [...new Set(sections.filter(s => s.id !== "sources").flatMap(s =>
                (citInputs[s.id] || "").split("\n").map(l => l.trim()).filter(Boolean)
              ))]
            : citLines;
          const totalCitCount = isReferat ? allRefCitations.length : citLines.length;

          // ── РЕФЕРАТ: per-section cards ──
          if (isReferat) {
            const refSections = sections.filter(s => s.id !== "sources");
            const chapSections = refSections.filter(s => !["intro", "conclusions"].includes(s.id));
            const perSec = Math.ceil(minSrc / Math.max(chapSections.length, 1));
            let runIdx = 0;
            return (
              <div className="fade">
                <Heading>📚 Джерела</Heading>
                {refSections.map(sec => {
                  const isStructural = sec.id === "intro" || sec.id === "conclusions";
                  const secLines = (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
                  const startIdx = runIdx + 1; runIdx += secLines.length;
                  const hasSources = secLines.length > 0;
                  const papers = refSecPapers[sec.id] || [];
                  const alreadyAdded = (citInputs[sec.id] || "").toLowerCase();
                  const filteredPapers = papers.filter(p => !alreadyAdded.includes((p.title || "").toLowerCase().slice(0, 60)));
                  const phrases = refSecPhrases[sec.id] || [];
                  const isLoadingSec = refSecLoading[sec.id] || false;
                  const isOpen = refSecOpen[sec.id] ?? filteredPapers.length > 0;
                  const selected = refSecSelected[sec.id] || [];
                  const ukCount = filteredPapers.filter(p => p.lang === "uk").length;
                  const scholarQuery = phrases[0] || `${sec.label} ${info?.topic || ""}`;
                  const scholarUrl = `https://scholar.google.com/scholar?hl=uk&as_sdt=0%2C5&as_ylo=2021&q=${encodeURIComponent(scholarQuery)}&btnG=`;
                  return (
                    <div key={sec.id} style={{ border: `1.5px solid ${hasSources ? "#d4cfc4" : isStructural ? "#d4cfc4" : "#e8a050"}`, borderRadius: 8, overflow: "hidden", marginBottom: 14 }}>
                      <div style={{ background: "#1a1a14", padding: "11px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: hasSources ? "#5ad060" : isStructural ? "#888" : "#e8a050", flexShrink: 0, display: "inline-block" }} />
                          <span style={{ fontSize: 13, fontWeight: 600, color: "#f5f2eb" }}>{sec.label}</span>
                        </div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          {secLines.length > 0 && <div style={{ fontSize: 11, color: "#888" }}>джерела [{startIdx}–{startIdx + secLines.length - 1}]</div>}
                          {!isStructural && <div style={{ fontSize: 12, color: "#e8ff47", background: "#2a2a1a", padding: "2px 10px", borderRadius: 10 }}>потрібно: {perSec} дж.</div>}
                        </div>
                      </div>
                      <div style={{ padding: "12px 16px", background: "#faf8f3" }}>
                        {isStructural ? (
                          <div style={{ fontSize: 12, color: "#888", marginBottom: 8, fontStyle: "italic" }}>
                            Джерела для вступу та висновків не потрібні — посилання беруться з розділів.
                          </div>
                        ) : (
                          <>
                            <div style={{ background: "#eef5e4", padding: "8px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", borderRadius: 6, marginBottom: 10 }}
                                 onClick={() => setRefSecOpen(prev => ({ ...prev, [sec.id]: !isOpen }))}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                {isLoadingSec
                                  ? <><SpinDot size={12} /><span style={{ fontSize: 12, color: "#5a8a2a" }}>Шукаю джерела...</span></>
                                  : <>
                                      <span style={{ fontSize: 12, fontWeight: 600, color: "#3a6010" }}>Знайдені джерела ({filteredPapers.length})</span>
                                      <span style={{ fontSize: 11, color: "#5a7a3a" }}>🇺🇦 {ukCount} укр.</span>
                                    </>
                                }
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <button onClick={e => { e.stopPropagation(); doSearchForSection(sec.id, sec.label); }} disabled={isLoadingSec}
                                  style={{ fontSize: 11, background: "#fff", border: "1px solid #b8dfa0", borderRadius: 5, padding: "2px 10px", cursor: isLoadingSec ? "default" : "pointer", color: "#3a6010" }}>
                                  ОНОВИТИ
                                </button>
                                <span style={{ fontSize: 12, color: "#888" }}>{isOpen ? "▲" : "▼"}</span>
                              </div>
                            </div>
                            {phrases.length > 0 && (
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10, alignItems: "center" }}>
                                {phrases.map((ph, i) => (
                                  <span key={i} onClick={() => navigator.clipboard.writeText(ph)} title="Клікни щоб скопіювати"
                                    style={{ fontSize: 11, background: "#eef5e4", color: "#3a6010", padding: "2px 9px", borderRadius: 10, border: "1px solid #c8dfa0", cursor: "pointer", userSelect: "none", display: "inline-flex", alignItems: "center", gap: 4 }}>
                                    🔍 {ph}
                                  </span>
                                ))}
                                <a href={scholarUrl} target="_blank" rel="noopener noreferrer"
                                  style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "#1a5a8a", textDecoration: "none", background: "#e4f0ff", padding: "2px 9px", borderRadius: 10, border: "1px solid #b0d0f0" }}>
                                  🎓 Google Scholar →
                                </a>
                              </div>
                            )}
                            {!phrases.length && (
                              <div style={{ marginBottom: 10 }}>
                                <a href={scholarUrl} target="_blank" rel="noopener noreferrer"
                                  style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#1a5a8a", textDecoration: "none", background: "#e4f0ff", padding: "6px 12px", borderRadius: 6, border: "1px solid #b0d0f0" }}>
                                  🎓 Шукати на Google Scholar →
                                </a>
                              </div>
                            )}
                            {isOpen && filteredPapers.length > 0 && (
                              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                                {filteredPapers.map(paper => {
                                  const isChecked = selected.includes(paper.id);
                                  const authorsList = Array.isArray(paper.authors) ? paper.authors : [];
                                  const authLine = authorsList.length > 2 ? `${authorsList.slice(0, 2).join(", ")} та ін.` : authorsList.join(", ") || "Автор невідомий";
                                  const isUk = paper.lang === "uk";
                                  return (
                                    <label key={paper.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer", padding: "9px 12px", borderRadius: 7, background: isChecked ? "#f0f8e8" : "#faf8f3", border: `1.5px solid ${isChecked ? "#8cc84b" : "#e0ddd5"}`, transition: "all 0.15s" }}>
                                      <input type="checkbox" checked={isChecked}
                                        onChange={() => setRefSecSelected(prev => ({ ...prev, [sec.id]: isChecked ? (prev[sec.id] || []).filter(id => id !== paper.id) : [...(prev[sec.id] || []), paper.id] }))}
                                        style={{ marginTop: 3, accentColor: "#5a9a1a", flexShrink: 0 }} />
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 2, alignItems: "center" }}>
                                          <span style={{ fontSize: 11, fontWeight: 600, color: "#3a6010" }}>{authLine}</span>
                                          {paper.year && <span style={{ fontSize: 11, color: "#888" }}>{paper.year}</span>}
                                          <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, background: isUk ? "#e8f5e0" : "#e8f0ff", color: isUk ? "#3a6010" : "#1a4a8a", border: `1px solid ${isUk ? "#b8dfa0" : "#b0c8f0"}` }}>
                                            {isUk ? "🇺🇦 укр." : "🌐 зарубіж."}
                                          </span>
                                        </div>
                                        <div style={{ fontSize: 12, color: "#1a1a14", lineHeight: "1.4" }}>
                                          {paper.title.length > 120 ? paper.title.slice(0, 120) + "…" : paper.title}
                                        </div>
                                        {paper.venue && <div style={{ fontSize: 11, color: "#777", fontStyle: "italic", marginTop: 2 }}>{paper.venue}</div>}
                                        {paper.url && <a href={paper.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ display: "inline-block", marginTop: 4, fontSize: 11, color: "#1a5a8a", textDecoration: "none" }}>🔗 Відкрити джерело →</a>}
                                      </div>
                                    </label>
                                  );
                                })}
                              </div>
                            )}
                            {isOpen && filteredPapers.length > 0 && (
                              <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
                                <button onClick={() => setRefSecSelected(prev => ({ ...prev, [sec.id]: (refSecPapers[sec.id] || []).map(p => p.id) }))}
                                  style={{ fontSize: 11, background: "#f5f3ef", border: "1px solid #d4cfc4", borderRadius: 5, padding: "4px 12px", cursor: "pointer", color: "#555" }}>
                                  вибрати всі
                                </button>
                                {selected.length > 0 && (
                                  <PrimaryBtn onClick={() => doAddForSection(sec.id)} loading={running} msg={loadMsg}
                                    label={`Додати вибрані (${selected.length}) →`} />
                                )}
                              </div>
                            )}
                          </>
                        )}
                        <div style={{ marginTop: 8 }}>
                          <div style={{ fontSize: 11, color: "#888", letterSpacing: "1px", textTransform: "uppercase", marginBottom: 5, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span>або додайте джерела вручну (кожне з нового рядка):</span>
                            {(citInputs[sec.id] || "").trim() && (
                              <button onClick={() => setCitInputs(prev => ({ ...prev, [sec.id]: "" }))}
                                style={{ fontSize: 11, background: "transparent", border: "1px solid #e0b0b0", color: "#a04040", borderRadius: 5, padding: "2px 8px", cursor: "pointer" }}>
                                × Очистити
                              </button>
                            )}
                          </div>
                          <textarea data-secid={sec.id} value={citInputs[sec.id] || ""}
                            onChange={e => setCitInputs(prev => ({ ...prev, [sec.id]: e.target.value }))}
                            placeholder="Петренко В.І. Психологія навчання. Київ: Наука, 2020. 245 с."
                            style={{ ...TA, width: "100%", minHeight: 80, resize: "vertical", boxSizing: "border-box", fontSize: 12, lineHeight: "1.7", fontFamily: "'Spectral',serif" }} />
                          {secLines.length > 0 && (
                            <div style={{ fontSize: 11, color: "#3a6010", marginTop: 4 }}>
                              ✓ {secLines.length} джерело(а) введено → [{startIdx}–{startIdx + secLines.length - 1}]
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div style={{ background: "#f0f8e8", border: "1px solid #c8dfa0", borderRadius: 8, padding: "12px 16px", marginBottom: 16, fontSize: 13, color: "#3a6010" }}>
                  <b>Загальна к-сть джерел: {totalCitCount}</b>
                  {" · "}
                  <span style={{ color: totalCitCount >= minSrc ? "#3a6010" : "#c07000" }}>
                    Мінімум: {minSrc} {totalCitCount < minSrc ? `(ще ${minSrc - totalCitCount})` : "✓"}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <NavBtn onClick={() => { setCitInputs({}); saveToFirestore({ citInputs: {}, stage: "writing", status: "new" }); setStage("writing"); }}>
                    Пропустити без джерел →
                  </NavBtn>
                  <PrimaryBtn onClick={doGenerateFromCitInputs} disabled={totalCitCount === 0} loading={running} msg={loadMsg}
                    label={`Генерувати (${totalCitCount} джерел) →`} />
                </div>
              </div>
            );
          }

          // ── ТЕЗИ / СТАТТЯ / ЕСЕ: існуючий UI ──
          const scholaUrl = `https://scholar.google.com/scholar?hl=uk&as_sdt=0%2C5&as_ylo=2021&q=${encodeURIComponent(info?.topic || "")}&btnG=`;
          return (
            <div className="fade">
              <Heading>📚 Джерела</Heading>

              {/* Інфо-блок */}
              <div style={{ background: "#f0f8e8", border: "1px solid #c8dfa0", borderRadius: 8, padding: "12px 16px", marginBottom: 18, fontSize: 13, color: "#3a6010" }}>
                <div style={{ marginBottom: 6 }}>
                  <b>Загальна к-сть джерел: {totalCitCount}</b>
                  {" · "}
                  <span style={{ color: totalCitCount >= minSrc ? "#3a6010" : "#c07000" }}>
                    Мінімум: {minSrc} {totalCitCount < minSrc ? `(ще ${minSrc - totalCitCount})` : "✓"}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "#555", marginBottom: 10 }}>
                  {"Натисніть «Знайти джерела автоматично» — програма згенерує ключові слова і знайде відповідні джерела. Виберіть потрібні галочкою та натисніть «Додати вибрані». Після заповнення натисніть «Генерувати»."}
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <GreenBtn onClick={doSearchTezyPapers} loading={tezySearchLoading} msg="Шукаю..." label="Знайти джерела автоматично →" />
                  <a href={scholaUrl} target="_blank" rel="noopener noreferrer"
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#1a5a8a", textDecoration: "none", background: "#e4f0ff", padding: "6px 12px", borderRadius: 6, border: "1px solid #b0d0f0" }}>
                    🎓 Шукати додатково на Google Scholar →
                  </a>
                </div>
                {searchPhrases.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 11, color: "#888", letterSpacing: "1px", textTransform: "uppercase", marginBottom: 5 }}>Шукайте за фразами:</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {searchPhrases.map((ph, i) => (
                        <span key={i} onClick={() => navigator.clipboard.writeText(ph)} title="Клікни щоб скопіювати"
                          style={{ fontSize: 11, background: "#eef5e4", color: "#3a6010", padding: "2px 9px", borderRadius: 10, border: "1px solid #c8dfa0", cursor: "pointer", userSelect: "none" }}>
                          {ph}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Список знайдених */}
              {tezySearchLoading && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 0", color: "#888", fontSize: 13 }}>
                  <SpinDot /> Шукаю в наукових базах...
                </div>
              )}

              {tezyPapers.length > 0 && (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <div style={{ fontSize: 12, color: "#888" }}>Знайдено: {tezyPapers.length} · Обрано: {selectedTezyIds.length}</div>
                    <button onClick={doSearchTezyPapers} disabled={tezySearchLoading}
                      style={{ background: "transparent", border: "1px solid #ccc", borderRadius: 6, padding: "4px 12px", fontSize: 11, cursor: "pointer", color: "#666" }}>
                      ↺ Шукати ще
                    </button>
                  </div>
                  {(() => {
                    const PAGE_SIZE = 5;
                    const totalPgs = Math.ceil(tezyPapers.length / PAGE_SIZE);
                    const pagePapers = tezyPapers.slice((tezyPage - 1) * PAGE_SIZE, tezyPage * PAGE_SIZE);
                    return (
                      <>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                          {pagePapers.map(paper => {
                            const authorsList = Array.isArray(paper.authors) ? paper.authors : [];
                            const authLine = authorsList.length > 2 ? `${authorsList.slice(0, 2).join(", ")} та ін.` : authorsList.join(", ") || "Автор невідомий";
                            const isUk = paper.lang === "uk";
                            const isChecked = selectedTezyIds.includes(paper.id);
                            return (
                              <label key={paper.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer", padding: "10px 12px", borderRadius: 7, background: isChecked ? "#f0f8e8" : "#faf8f3", border: `1.5px solid ${isChecked ? "#8cc84b" : "#e0ddd5"}`, transition: "all 0.15s" }}>
                                <input type="checkbox" checked={isChecked}
                                  onChange={() => setSelectedTezyIds(p => isChecked ? p.filter(id => id !== paper.id) : [...p, paper.id])}
                                  style={{ marginTop: 3, accentColor: "#5a9a1a", flexShrink: 0 }} />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 2, alignItems: "center" }}>
                                    <span style={{ fontSize: 11, fontWeight: 600, color: "#3a6010" }}>{authLine}</span>
                                    {paper.year && <span style={{ fontSize: 11, color: "#888" }}>{paper.year}</span>}
                                    <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, background: isUk ? "#e8f5e0" : "#e8f0ff", color: isUk ? "#3a6010" : "#1a4a8a", border: `1px solid ${isUk ? "#b8dfa0" : "#b0c8f0"}` }}>
                                      {isUk ? "🇺🇦 укр." : "🌐 зарубіж."}
                                    </span>
                                  </div>
                                  <div style={{ fontSize: 12, color: "#1a1a14", lineHeight: "1.4" }}>
                                    {paper.title.length > 120 ? paper.title.slice(0, 120) + "…" : paper.title}
                                  </div>
                                  {paper.venue && <div style={{ fontSize: 11, color: "#777", fontStyle: "italic", marginTop: 2 }}>{paper.venue}</div>}
                                </div>
                              </label>
                            );
                          })}
                        </div>
                        {totalPgs > 1 && (
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                            <button onClick={() => setTezyPage(p => Math.max(1, p - 1))} disabled={tezyPage === 1}
                              style={{ background: "transparent", border: "1px solid #d4cfc4", borderRadius: 6, padding: "4px 12px", fontSize: 12, cursor: tezyPage === 1 ? "default" : "pointer", color: tezyPage === 1 ? "#ccc" : "#555" }}>←</button>
                            {Array.from({ length: totalPgs }, (_, i) => i + 1).map(p => (
                              <button key={p} onClick={() => setTezyPage(p)}
                                style={{ background: p === tezyPage ? "#1a1a14" : "transparent", border: "1px solid #d4cfc4", borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer", color: p === tezyPage ? "#e8ff47" : "#555", fontWeight: p === tezyPage ? 600 : 400 }}>
                                {p}
                              </button>
                            ))}
                            <button onClick={() => setTezyPage(p => Math.min(totalPgs, p + 1))} disabled={tezyPage === totalPgs}
                              style={{ background: "transparent", border: "1px solid #d4cfc4", borderRadius: 6, padding: "4px 12px", fontSize: 12, cursor: tezyPage === totalPgs ? "default" : "pointer", color: tezyPage === totalPgs ? "#ccc" : "#555" }}>→</button>
                            <span style={{ fontSize: 11, color: "#aaa", marginLeft: 4 }}>{tezyPage} / {totalPgs}</span>
                          </div>
                        )}
                        {selectedTezyIds.length > 0 && (
                          <div style={{ marginBottom: 16 }}>
                            <PrimaryBtn onClick={doConfirmTezyPapers} disabled={running} loading={running} msg={loadMsg}
                              label={`Додати вибрані (${selectedTezyIds.length}) до списку →`} />
                          </div>
                        )}
                      </>
                    );
                  })()}
                </>
              )}

              {/* Текстове поле джерел */}
              <div style={{ marginTop: 16, marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ fontSize: 12, color: "#555", fontWeight: 600 }}>
                    Список джерел ({citLines.length} введено — кожне з нового рядка):
                  </div>
                  {citText.trim() && (
                    <button onClick={() => setCitText("")}
                      style={{ fontSize: 11, background: "transparent", border: "1px solid #e0b0b0", color: "#a04040", borderRadius: 5, padding: "2px 8px", cursor: "pointer" }}>
                      × Очистити
                    </button>
                  )}
                </div>
                <textarea
                  value={citText}
                  onChange={e => setCitText(e.target.value)}
                  placeholder={"Петренко В.І. Психологія навчання. Київ: Наука, 2020. 245 с.\nSmirnova O. Child development. Oxford: OUP, 2019."}
                  style={{ ...TA, width: "100%", minHeight: 120, resize: "vertical", boxSizing: "border-box", fontSize: 12, lineHeight: "1.7", fontFamily: "'Spectral',serif" }}
                />
                {info?.sortAlpha && citLines.length > 1 && (
                  <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>
                    ℹ Джерела буде відсортовано за алфавітом перед генерацією.
                  </div>
                )}
              </div>

              {/* Кнопки дій */}
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <NavBtn onClick={() => {
                  setCitText(""); setTezyCitations([]);
                  saveToFirestore({ citText: "", tezyCitations: [], stage: "writing", status: "new" });
                  setStage("writing");
                  if (workType === "tezy") doGenerateTezy([]);
                  else if (workType === "prezentatsiya") { /* user picks theme first */ }
                  else doGenerateSimple([]);
                }}>
                  Пропустити без джерел →
                </NavBtn>
                <PrimaryBtn
                  onClick={doGenerateFromCitText}
                  disabled={citLines.length === 0}
                  loading={running}
                  msg={loadMsg}
                  label={`Генерувати (${citLines.length} джерел) →`}
                />
              </div>
            </div>
          );
        })()}

        {/* ══ ГЕНЕРАЦІЯ тез ══ */}
        {workType === "tezy" && stage === "writing" && (
          <div className="fade">
            <Heading>📝 Генерація тез</Heading>
            {result ? (
              <>
                <div style={{ border: "1.5px solid #aaa49a", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
                  <div style={{ background: "#1a1a14", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 13, color: "#f5f2eb", fontWeight: 600 }}>{info?.topic}</span>
                    <button onClick={() => navigator.clipboard.writeText(result)} style={{ background: "transparent", border: "1px solid #555", color: "#999", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer" }}>COPY</button>
                  </div>
                  <div style={{ padding: "16px 20px", fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", maxHeight: 400, overflowY: "auto", background: "#faf8f3" }}>{renderWithTables(result)}</div>
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <NavBtn onClick={() => setResult("")}>Перегенерувати</NavBtn>
                  <PrimaryBtn onClick={() => setStage("done")} label="Готово →" />
                </div>
              </>
            ) : (
              <div style={{ textAlign: "center", padding: "40px 0" }}>
                <PrimaryBtn onClick={doGenerateTezy} loading={running} msg={loadMsg} label="Генерувати тези →" />
              </div>
            )}
          </div>
        )}

        {/* ══ ГЕНЕРАЦІЯ (стаття / есе) ══ */}
        {["stattia", "ese"].includes(workType) && stage === "writing" && (
          <div className="fade">
            <Heading>{cfg.icon} Генерація {cfg.label}</Heading>
            {!result ? (
              <div style={{ textAlign: "center", padding: "40px 0" }}>
                <p style={{ fontSize: 14, color: "#888", marginBottom: 24 }}>
                  {tezyCitations.length > 0 ? `${tezyCitations.length} джерел обрано. ` : ""}{(materialText.trim() || materialFiles.length > 0) ? "Матеріал для роботи є. " : ""}
                  Натисніть щоб розпочати генерацію.
                </p>
                <PrimaryBtn onClick={doGenerateSimple} loading={running} msg={loadMsg} label={`Генерувати ${cfg.label} →`} />
              </div>
            ) : (
              <>
                <div style={{ border: "1.5px solid #aaa49a", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
                  <div style={{ background: "#1a1a14", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 13, color: "#f5f2eb", fontWeight: 600 }}>{info?.topic}</span>
                    <button onClick={() => navigator.clipboard.writeText(result)} style={{ background: "transparent", border: "1px solid #555", color: "#999", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer" }}>COPY</button>
                  </div>
                  <div style={{ padding: "16px 20px", fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", maxHeight: 400, overflowY: "auto", background: "#faf8f3" }}>{renderWithTables(result)}</div>
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <NavBtn onClick={() => { setResult(""); }}>Перегенерувати</NavBtn>
                  <PrimaryBtn onClick={() => { saveToFirestore({ result, stage: "done", status: "done" }); setStage("done"); }} label="Завершити →" />
                </div>
              </>
            )}
          </div>
        )}

        {/* ══ ГЕНЕРАЦІЯ (презентація) ══ */}
        {workType === "prezentatsiya" && stage === "writing" && (
          <div className="fade">
            <Heading>🎞️ Генерація презентації</Heading>
            {slides.length === 0 ? (
              <div style={{ padding: "20px 0" }}>
                {/* Вибір теми дизайну */}
                <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, padding: "16px", marginBottom: 20, background: "#faf8f3" }}>
                  <div style={{ fontSize: 12, color: "#888", letterSpacing: "1px", textTransform: "uppercase", marginBottom: 10 }}>Тема дизайну</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {[
                      { key: "", label: "Авто", desc: "за галуззю", colors: ["#1E2761", "#0D1B3E"] },
                      { key: "midnight", label: "Midnight", desc: "синій (IT, техн.)", colors: ["#1E2761", "#CADCFC"] },
                      { key: "forest", label: "Forest", desc: "зелений (медицина, біол.)", colors: ["#2C5F2D", "#97BC62"] },
                      { key: "coral", label: "Coral", desc: "теракот (право, гуманіт.)", colors: ["#B85042", "#F5C6C0"] },
                      { key: "slate", label: "Slate", desc: "сірий (економіка, бізнес)", colors: ["#36454F", "#C8D8E4"] },
                      { key: "warm", label: "Warm", desc: "темно-синій", colors: ["#0D1B3E", "#4A7CBF"] },
                    ].map(({ key, label, desc, colors }) => (
                      <button key={key} onClick={() => setPresTheme(key)}
                        style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderRadius: 8, border: `2px solid ${presTheme === key ? "#e8ff47" : "#d4cfc4"}`, background: presTheme === key ? "#1a1a14" : "#fff", cursor: "pointer", fontFamily: "inherit" }}>
                        <div style={{ display: "flex", gap: 2 }}>
                          {colors.map((c, i) => <div key={i} style={{ width: 12, height: 22, borderRadius: 3, background: `#${c}` }} />)}
                        </div>
                        <div style={{ textAlign: "left" }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: presTheme === key ? "#e8ff47" : "#1a1a14" }}>{label}</div>
                          <div style={{ fontSize: 10, color: presTheme === key ? "#aaa" : "#888" }}>{desc}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
                <p style={{ fontSize: 14, color: "#888", marginBottom: 24 }}>
                  {tezyCitations.length > 0 ? `${tezyCitations.length} джерел. ` : ""}
                  {(materialText.trim() || materialFiles.length > 0) ? `Матеріал: ${[materialText.trim() ? "текст" : null, materialFiles.length > 0 ? `${materialFiles.length} файл(ів)` : null].filter(Boolean).join(" + ")}. ` : ""}
                  Генеруватиму структуру та текст для кожного слайду.
                </p>
                <PrimaryBtn onClick={doGeneratePresentation} loading={running} msg={loadMsg} label="Генерувати презентацію →" />
              </div>
            ) : (
              <>
                <p style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>{slides.length} слайдів згенеровано.</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
                  {slides.map((slide, i) => {
                    const slideText = `${slide.title}\n${slide.content || (slide.visual?.items ? slide.visual.items.map(it => `${it.icon || "•"} ${it.header ? it.header + ": " : ""}${it.text || ""}`).join("\n") : slide.subtitle || "")}`;
                    return (
                      <div key={i} style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden" }}>
                        <div style={{ background: "#1a1a14", padding: "9px 16px", display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{ fontSize: 11, color: "#e8ff47", background: "#2a2a1a", padding: "1px 8px", borderRadius: 10 }}>{i + 1}</span>
                          <span style={{ fontSize: 11, color: "#666", background: "#2a2a2a", padding: "1px 7px", borderRadius: 8, textTransform: "uppercase", letterSpacing: "0.5px" }}>{slide.layout || "slide"}</span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: "#f5f2eb", flex: 1 }}>{slide.title}</span>
                          <button onClick={() => navigator.clipboard.writeText(slideText)} style={{ background: "transparent", color: "#aaa", border: "1px solid #555", borderRadius: 5, padding: "2px 10px", fontSize: 11, cursor: "pointer", fontFamily: "'Spectral',serif" }}>COPY</button>
                        </div>
                        <div style={{ padding: "12px 16px", fontSize: 13, color: "#444", lineHeight: "1.7", whiteSpace: "pre-wrap", background: "#faf8f3" }}>
                          {slide.content || (slide.visual?.items ? slide.visual.items.map(it => `${it.icon || "•"} ${it.header ? it.header + ": " : ""}${it.text || ""}`).join("\n") : slide.subtitle || "")}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <NavBtn onClick={() => setSlides([])}>Перегенерувати</NavBtn>
                  <button onClick={() => navigator.clipboard.writeText(slides.map((s, i) => `СЛАЙД ${i + 1}: ${s.title}\n${s.content || ""}`).join("\n\n"))}
                    style={{ background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, padding: "11px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: "pointer" }}>
                    Скопіювати все
                  </button>
                  <button disabled={docxLoading} onClick={async () => {
                    setDocxLoading(true);
                    try { await exportToPptxFile({ slides, theme: presTheme || undefined }, info); }
                    catch (e) { setError(e.message); }
                    setDocxLoading(false);
                  }} style={{ background: docxLoading ? "#aaa" : "#1a4a1a", color: docxLoading ? "#eee" : "#a8e060", border: "none", borderRadius: 7, padding: "11px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: docxLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                    {docxLoading ? <><SpinDot light />Генерую...</> : "⬇ Завантажити .pptx"}
                  </button>
                  <PrimaryBtn onClick={() => { saveToFirestore({ slides, stage: "done", status: "done" }); setStage("done"); }} label="Завершити →" />
                </div>
              </>
            )}
          </div>
        )}

        {/* ══ ГОТОВО ══ */}
        {stage === "done" && (
          <div className="fade">
            <Heading>✓ Готово!</Heading>

            {/* ── Доповідь та презентація ── */}
            {workType === "dopovid" && (
              <div>
                <p style={{ fontSize: 13, color: "#888", marginBottom: 24 }}>
                  Завантажте матеріали та оберіть що генерувати.
                </p>

                {/* Інфо про завантажений файл */}
                {presFile ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "#eef5e4", borderRadius: 8, marginBottom: 20, fontSize: 13 }}>
                    <span style={{ color: "#2a6a2a" }}>✓</span>
                    <span style={{ color: "#2a4a1a", fontWeight: 600 }}>{presFile.name}</span>
                    <button onClick={() => setPresFile(null)} style={{ marginLeft: "auto", background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 14 }}>✕</button>
                  </div>
                ) : (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>Завантажте файл готової роботи (PDF, DOCX, зображення):</div>
                    <DropZone fileLabel={null} onFile={(name, b64, type) => setPresFile({ name, b64, type })} accept=".pdf,.docx,.doc,.jpg,.jpeg,.png" />
                  </div>
                )}

                {/* Коментар */}
                <div style={{ marginBottom: 24 }}>
                  <textarea
                    value={presComment}
                    onChange={e => setPresComment(e.target.value)}
                    placeholder="Коментар: вимоги до оформлення, стиль, що врахувати..."
                    style={{ width: "100%", minHeight: 54, fontSize: 12, lineHeight: "1.7", color: "#2a2a1e", background: "#f5f2ea", borderRadius: 6, padding: "9px 12px", border: "1px solid #d4cfc4", fontFamily: "'Spectral',serif", resize: "vertical", boxSizing: "border-box" }}
                  />
                </div>

                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>

                  {/* 1. Доповідь — генерується першою, з тексту роботи; джерело істини для презентації */}
                  <div style={{ flex: 1, minWidth: 200, border: "1.5px solid #d4cfc4", borderRadius: 8, padding: "16px 18px" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Доповідь (.docx)</div>
                    <div style={{ fontSize: 12, color: "#888", marginBottom: 14 }}>Суцільний текст виступу для захисту (3–5 хв)</div>
                    {!speechText ? (
                      <button onClick={generateSpeechWithout} disabled={speechLoading || !presFile}
                        style={{ background: (speechLoading || !presFile) ? "#aaa" : "#1a1a14", color: (speechLoading || !presFile) ? "#eee" : "#e8ff47", border: "none", borderRadius: 6, padding: "9px 20px", fontFamily: "'Spectral',serif", fontSize: 12, letterSpacing: "1px", cursor: (speechLoading || !presFile) ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                        {speechLoading ? <><SpinDot light />Генерую...</> : "Генерувати"}
                      </button>
                    ) : (
                      <div>
                        <div style={{ fontSize: 12, lineHeight: "1.8", color: "#444", maxHeight: 140, overflowY: "auto", background: "#f5f2ea", borderRadius: 6, padding: "10px 12px", marginBottom: 10, whiteSpace: "pre-wrap" }}>
                          {speechText.substring(0, 400)}...
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button onClick={async () => { setSpeechLoading(true); try { await exportSpeechToDocx(speechText, info, methodInfo, currentIdRef.current, "Доповідь"); } catch (e) { alert("Помилка: " + e.message); } setSpeechLoading(false); }} disabled={speechLoading}
                            style={{ background: speechLoading ? "#aaa" : "#1a4a1a", color: speechLoading ? "#eee" : "#a8e060", border: "none", borderRadius: 6, padding: "9px 18px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: speechLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                            {speechLoading ? <><SpinDot light />...</> : "⬇ Завантажити .docx"}
                          </button>
                          <button onClick={() => { setSpeechText(""); saveToFirestore({ speechText: "" }); }}
                            style={{ background: "transparent", border: "1.5px solid #d4cfc4", color: "#888", borderRadius: 6, padding: "9px 14px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer" }}>
                            Переробити
                          </button>
                        </div>
                      </div>
                    )}
                    {!presFile && !speechLoading && <div style={{ marginTop: 8, fontSize: 11, color: "#bbb" }}>Спочатку завантажте файл</div>}
                  </div>

                  {/* 2. Презентація — слайди мають покривати все, що перелічено в доповіді */}
                  <div style={{ flex: 1, minWidth: 200, border: "1.5px solid #d4cfc4", borderRadius: 8, padding: "16px 18px" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Презентація (.pptx)</div>
                    <div style={{ fontSize: 12, color: "#888", marginBottom: 14 }}>10–13 слайдів для захисту з дизайном</div>
                    <button
                      onClick={generateSmallPresentation}
                      disabled={presLoading || !presFile || !speechText}
                      style={{ background: (presLoading || !presFile || !speechText) ? "#aaa" : "#1a1a14", color: (presLoading || !presFile || !speechText) ? "#eee" : "#e8ff47", border: "none", borderRadius: 6, padding: "9px 20px", fontFamily: "'Spectral',serif", fontSize: 12, letterSpacing: "1px", cursor: (presLoading || !presFile || !speechText) ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {presLoading ? <><SpinDot light />{presMsg || "Генерую..."}</> : presReady ? "Генерувати знову" : "Генерувати"}
                    </button>
                    {!presFile && !presLoading && <div style={{ marginTop: 8, fontSize: 11, color: "#bbb" }}>Спочатку завантажте файл</div>}
                    {presFile && !speechText && !presLoading && <div style={{ marginTop: 8, fontSize: 11, color: "#bbb", lineHeight: 1.5 }}>Спочатку згенеруйте доповідь — слайди будуть побудовані так, щоб збігатись з нею</div>}
                    {presReady && !presLoading && (
                      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{ fontSize: 12, color: "#2a6a2a", display: "flex", alignItems: "center", gap: 6 }}>✓ Готово</div>
                        <button onClick={async () => {
                          setPresLoading(true); setPresMsg("Створюю файл...");
                          try { await exportToPptxFile(presSlideJson, info, currentIdRef.current); }
                          catch (e) { alert("Помилка: " + e.message); }
                          setPresLoading(false); setPresMsg("");
                        }} style={{ background: "#1a4a1a", color: "#a8e060", border: "none", borderRadius: 6, padding: "8px 16px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
                          ⬇ Завантажити .pptx
                        </button>
                      </div>
                    )}
                    {!presReady && !presLoading && presFile && speechText && (
                      <div style={{ marginTop: 10, fontSize: 11, color: "#aaa", lineHeight: 1.5 }}>Claude генерує слайди на основі тексту роботи й доповіді</div>
                    )}
                  </div>

                  {/* 3. Доповідь з мітками слайдів — той самий текст доповіді, лише розмічений по слайдах */}
                  <div style={{ flex: 1, minWidth: 200, border: "1.5px solid #d4cfc4", borderRadius: 8, padding: "16px 18px" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Доповідь з мітками слайдів (.docx)</div>
                    <div style={{ fontSize: 12, color: "#888", marginBottom: 14 }}>Той самий текст доповіді, розбитий по слайдах з мітками «Слайд N» (3–5 хв)</div>
                    {!speechWithText ? (
                      <button onClick={generateSpeechWith} disabled={speechWithLoading || !speechText || !presSlideJson?.slides?.length}
                        style={{ background: (speechWithLoading || !speechText || !presSlideJson?.slides?.length) ? "#aaa" : "#1a1a14", color: (speechWithLoading || !speechText || !presSlideJson?.slides?.length) ? "#eee" : "#e8ff47", border: "none", borderRadius: 6, padding: "9px 20px", fontFamily: "'Spectral',serif", fontSize: 12, letterSpacing: "1px", cursor: (speechWithLoading || !speechText || !presSlideJson?.slides?.length) ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                        {speechWithLoading ? <><SpinDot light />Генерую...</> : "Генерувати"}
                      </button>
                    ) : (
                      <div>
                        <div style={{ fontSize: 12, lineHeight: "1.8", color: "#444", maxHeight: 140, overflowY: "auto", background: "#f5f2ea", borderRadius: 6, padding: "10px 12px", marginBottom: 10, whiteSpace: "pre-wrap" }}>
                          {speechWithText.substring(0, 400)}...
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button onClick={async () => { setSpeechWithLoading(true); try { await exportSpeechToDocx(speechWithText, info, methodInfo, currentIdRef.current, "Доповідь з презентацією"); } catch (e) { alert("Помилка: " + e.message); } setSpeechWithLoading(false); }} disabled={speechWithLoading}
                            style={{ background: speechWithLoading ? "#aaa" : "#1a4a1a", color: speechWithLoading ? "#eee" : "#a8e060", border: "none", borderRadius: 6, padding: "9px 18px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: speechWithLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                            {speechWithLoading ? <><SpinDot light />...</> : "⬇ Завантажити .docx"}
                          </button>
                          <button onClick={() => { setSpeechWithText(""); saveToFirestore({ speechWithText: "" }); }}
                            style={{ background: "transparent", border: "1.5px solid #d4cfc4", color: "#888", borderRadius: 6, padding: "9px 14px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer" }}>
                            Переробити
                          </button>
                        </div>
                      </div>
                    )}
                    {!speechText && !speechWithLoading && (
                      <div style={{ marginTop: 8, fontSize: 11, color: "#bbb", lineHeight: 1.5 }}>Спочатку згенеруйте доповідь</div>
                    )}
                    {speechText && !presSlideJson?.slides?.length && !speechWithLoading && (
                      <div style={{ marginTop: 8, fontSize: 11, color: "#bbb", lineHeight: 1.5 }}>Спочатку згенеруйте презентацію</div>
                    )}
                  </div>

                </div>

                <div style={{ marginTop: 24 }}>
                  <NavBtn onClick={() => setStage("input")}>← Назад</NavBtn>
                </div>
              </div>
            )}

            {/* Реферат — всі секції */}
            {workType === "referat" && (
              <>
                {/* Блок з даними титулки якщо витягнуто */}
                {info?.titlePageInfo && (() => {
                  const tpi = info.titlePageInfo;
                  const fields = [
                    tpi.university && `Університет: ${tpi.university}`,
                    tpi.faculty && `Факультет: ${tpi.faculty}`,
                    tpi.discipline && `Дисципліна: ${tpi.discipline}`,
                    tpi.student && `Студент: ${tpi.student}`,
                    tpi.supervisor && `Науковий керівник: ${tpi.supervisor}`,
                    tpi.year && `Рік: ${tpi.year}`,
                  ].filter(Boolean);
                  if (!fields.length) return null;
                  return (
                    <div style={{ border: "1.5px solid #b0c8f0", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
                      <div style={{ background: "#1a3a6a", padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "#e4f0ff" }}>Титульна сторінка — витягнуто з файлу</span>
                        <span style={{ fontSize: 11, color: "#8ab0d0", marginLeft: 4 }}>· буде додано автоматично у .docx</span>
                      </div>
                      <div style={{ padding: "12px 16px", background: "#f0f5ff", fontSize: 13, color: "#1a3a6a", display: "flex", flexDirection: "column", gap: 4 }}>
                        {fields.map((f, i) => <div key={i}>{f}</div>)}
                        <div style={{ marginTop: 4, fontSize: 12, color: "#3a6aaa", fontStyle: "italic" }}>Тема: «{info?.topic}»</div>
                      </div>
                    </div>
                  );
                })()}

                {sections.filter(s => s.text).map(sec => (
                  <div key={sec.id} style={{ border: "1.5px solid #aaa49a", borderRadius: 8, marginBottom: 10, overflow: "hidden" }}>
                    <div style={{ background: "#1a1a14", padding: "10px 16px", display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#e8ff47" }} />
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "#f5f2eb" }}>{sec.label}</div>
                      <button onClick={() => navigator.clipboard.writeText(sec.text)} style={{ background: "transparent", border: "1px solid #555", color: "#999", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer" }}>COPY</button>
                    </div>
                    <div style={{ padding: "14px 18px", fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", whiteSpace: "pre-wrap", maxHeight: 260, overflowY: "auto", background: "#faf8f3" }}>{renderWithTables(sec.text)}</div>
                  </div>
                ))}

                {/* Кнопка форматування джерел */}
                {tezyCitations.length > 0 && !sourcesFormatted && (
                  <div style={{ border: "1.5px solid #e8c840", borderRadius: 8, padding: "14px 18px", marginTop: 12, marginBottom: 4, background: "#fffbf0" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#5a3a00", marginBottom: 6 }}>Список літератури ще не відформатовано</div>
                    <div style={{ fontSize: 12, color: "#7a5a20", marginBottom: 12 }}>
                      Натисніть щоб оформити список джерел ({tezyCitations.length} шт.) за стилем {info?.citStyle || "ДСТУ 8302:2015"} і розставити посилання у тексті.
                    </div>
                    <button onClick={doFormatAndRemapCitations} disabled={running}
                      style={{ background: running ? "#aaa" : "#3a2a00", color: running ? "#eee" : "#e8c840", border: "none", borderRadius: 7, padding: "10px 22px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: running ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {running ? <><SpinDot light />{loadMsg || "Форматую..."}</> : "📋 Сформувати список літератури і посилання →"}
                    </button>
                  </div>
                )}
                {sourcesFormatted && (
                  <div style={{ fontSize: 12, color: "#3a6010", marginTop: 4, marginBottom: 8 }}>✓ Список літератури відформатовано ({info?.citStyle || "ДСТУ 8302:2015"})</div>
                )}

                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
                  <button onClick={() => navigator.clipboard.writeText(sections.map(s => s.label + "\n\n" + s.text).join("\n\n" + "─".repeat(50) + "\n\n"))}
                    style={{ background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, padding: "11px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: "pointer" }}>
                    Скопіювати все
                  </button>
                  <button disabled={docxLoading} onClick={async () => {
                    setDocxLoading(true);
                    try {
                      const content = Object.fromEntries(sections.map(s => [s.id, s.text]));
                      const displayOrder = sections.map(s => ({
                        id: s.id,
                        label: s.label,
                        type: s.id === "intro" ? "intro"
                          : s.id === "conclusions" ? "conclusions"
                          : s.id === "sources" ? "sources"
                          : "body",
                      }));
                      // Будуємо titlePageLines з витягнутих даних титулки
                      const tpi = info?.titlePageInfo;
                      const refTitlePageLines = tpi ? (() => {
                        const yr = tpi.year || new Date().getFullYear();
                        const lines = [];
                        if (tpi.university) lines.push({ text: tpi.university.toUpperCase(), align: "center", bold: true, spaceBefore: 0 });
                        if (tpi.faculty) lines.push({ text: tpi.faculty, align: "center", bold: false, spaceBefore: 0 });
                        lines.push({ text: "", align: "center", spaceBefore: 960 });
                        lines.push({ text: (info?.type || "РЕФЕРАТ").toUpperCase(), align: "center", bold: true, spaceBefore: 0 });
                        if (tpi.discipline) lines.push({ text: `з дисципліни: ${tpi.discipline}`, align: "center", bold: false, spaceBefore: 0 });
                        lines.push({ text: `на тему: «[ТЕМА]»`, align: "center", bold: false, spaceBefore: 0 });
                        lines.push({ text: "", align: "center", spaceBefore: 2880 });
                        if (tpi.student) lines.push({ text: `Виконав(ла): ${tpi.student}`, align: "right", bold: false, spaceBefore: 0 });
                        if (tpi.supervisor) lines.push({ text: `Науковий керівник: ${tpi.supervisor}`, align: "right", bold: false, spaceBefore: 0 });
                        lines.push({ text: "", align: "center", spaceBefore: 3840 });
                        lines.push({ text: `${tpi.city || ""}${tpi.city ? " – " : ""}${yr}`, align: "center", bold: false, spaceBefore: 0 });
                        return lines;
                      })() : null;
                      await exportToDocx({ content, info, displayOrder, appendicesText: "", titlePage: null, titlePageLines: refTitlePageLines, methodInfo, orderId: currentIdRef.current });
                    } catch (e) { setError(e.message); }
                    setDocxLoading(false);
                  }} style={{ background: docxLoading ? "#aaa" : "#1a4a1a", color: docxLoading ? "#eee" : "#a8e060", border: "none", borderRadius: 7, padding: "11px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: docxLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                    {docxLoading ? <><SpinDot light />Генерую...</> : "⬇ Завантажити .docx"}
                  </button>
                </div>
              </>
            )}

            {/* Тези / Стаття / Есе */}
            {["tezy", "stattia", "ese"].includes(workType) && result && (
              <>
                <div style={{ border: "1.5px solid #aaa49a", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
                  <div style={{ background: "#1a1a14", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 13, color: "#f5f2eb", fontWeight: 600 }}>{info?.topic}</span>
                    <button onClick={() => navigator.clipboard.writeText(result)} style={{ background: "transparent", border: "1px solid #555", color: "#999", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer" }}>COPY</button>
                  </div>
                  <div style={{ padding: "16px 20px", fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", maxHeight: 400, overflowY: "auto", background: "#faf8f3" }}>{renderWithTables(result)}</div>
                </div>

                {/* Рекомендації щодо рисунків */}
                {workType === "tezy" && (() => {
                  const figRe = /\[🔍 Рисунок (\d+): "([^"]+)"\]/g;
                  const figures = [];
                  let m;
                  const text = result || "";
                  while ((m = figRe.exec(text)) !== null) figures.push({ num: m[1], query: m[2] });
                  if (!figures.length) return null;
                  return (
                    <div style={{ border: "1.5px solid #e8a840", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
                      <div style={{ background: "#3a2000", padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "#ffcc70" }}>Рисунки для вставки у роботу</span>
                        <span style={{ fontSize: 11, color: "#aa8040" }}>· знайдіть і вставте у Word замість маркерів [🔍]</span>
                      </div>
                      <div style={{ padding: "12px 16px", background: "#fffbf0", display: "flex", flexDirection: "column", gap: 10 }}>
                        {figures.map(({ num, query }) => (
                          <div key={num} style={{ padding: "10px 14px", background: "#fff8e8", border: "1px solid #e8c870", borderRadius: 7 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: "#5a3a00", marginBottom: 6 }}>Рис. {num} — пошуковий запит: <span style={{ fontStyle: "italic" }}>«{query}»</span></div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              {[
                                { label: "Google Зображення", url: `https://images.google.com/search?tbm=isch&q=${encodeURIComponent(query)}` },
                                { label: "Wikimedia Commons", url: `https://commons.wikimedia.org/w/index.php?search=${encodeURIComponent(query)}&ns6=1` },
                                { label: "Google Академія", url: `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}` },
                              ].map(({ label, url }) => (
                                <a key={label} href={url} target="_blank" rel="noopener noreferrer"
                                  style={{ fontSize: 11, color: "#1a5a8a", background: "#e4f0ff", padding: "3px 10px", borderRadius: 6, border: "1px solid #b0d0f0", textDecoration: "none" }}>
                                  🔍 {label}
                                </a>
                              ))}
                            </div>
                          </div>
                        ))}
                        <div style={{ fontSize: 11, color: "#8a6020", marginTop: 4 }}>
                          У файлі .docx маркери [🔍] не потрапляють — тільки підписи «Рис. N — ...» виділені помаранчевим.
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Кнопка форматування джерел */}
                {tezyCitations.length > 0 && !sourcesFormatted && (
                  <div style={{ border: "1.5px solid #e8c840", borderRadius: 8, padding: "14px 18px", marginTop: 4, marginBottom: 16, background: "#fffbf0" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#5a3a00", marginBottom: 6 }}>Список літератури ще не відформатовано</div>
                    <div style={{ fontSize: 12, color: "#7a5a20", marginBottom: 12 }}>
                      Натисніть щоб оформити список джерел ({tezyCitations.length} шт.) за стилем {info?.citStyle || "ДСТУ 8302:2015"} і розставити посилання у тексті.
                    </div>
                    <button onClick={doFormatAndRemapCitations} disabled={running}
                      style={{ background: running ? "#aaa" : "#3a2a00", color: running ? "#eee" : "#e8c840", border: "none", borderRadius: 7, padding: "10px 22px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: running ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {running ? <><SpinDot light />{loadMsg || "Форматую..."}</> : "📋 Сформувати список літератури і посилання →"}
                    </button>
                  </div>
                )}
                {sourcesFormatted && (
                  <div style={{ fontSize: 12, color: "#3a6010", marginTop: 4, marginBottom: 8 }}>✓ Список літератури відформатовано ({info?.citStyle || "ДСТУ 8302:2015"})</div>
                )}

                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <button disabled={docxLoading} onClick={async () => {
                    setDocxLoading(true);
                    try {
                      await exportSimpleDocx({ title: info?.topic, sections: [{ label: cfg.label.toUpperCase(), text: result }], info, citations: workType === "tezy" ? tezyCitations : undefined, orderId: currentIdRef.current, methodInfo });
                    } catch (e) { setError(e.message); }
                    setDocxLoading(false);
                  }} style={{ background: docxLoading ? "#aaa" : "#1a4a1a", color: docxLoading ? "#eee" : "#a8e060", border: "none", borderRadius: 7, padding: "11px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: docxLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                    {docxLoading ? <><SpinDot light />Генерую...</> : "⬇ Завантажити .docx"}
                  </button>
                </div>
              </>
            )}

            {/* Презентація */}
            {workType === "prezentatsiya" && slides.length > 0 && (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
                  {slides.map((slide, i) => {
                    const slideText = `${slide.title}\n${slide.content || (slide.visual?.items ? slide.visual.items.map(it => `${it.icon || "•"} ${it.header ? it.header + ": " : ""}${it.text || ""}`).join("\n") : slide.subtitle || "")}`;
                    return (
                      <div key={i} style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden" }}>
                        <div style={{ background: "#1a1a14", padding: "9px 16px", display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{ fontSize: 11, color: "#e8ff47", background: "#2a2a1a", padding: "1px 8px", borderRadius: 10 }}>{i + 1}</span>
                          {slide.layout && <span style={{ fontSize: 11, color: "#666", background: "#2a2a2a", padding: "1px 7px", borderRadius: 8, textTransform: "uppercase", letterSpacing: "0.5px" }}>{slide.layout}</span>}
                          <span style={{ fontSize: 13, fontWeight: 600, color: "#f5f2eb", flex: 1 }}>{slide.title}</span>
                          <button onClick={() => navigator.clipboard.writeText(slideText)} style={{ background: "transparent", color: "#aaa", border: "1px solid #555", borderRadius: 5, padding: "2px 10px", fontSize: 11, cursor: "pointer", fontFamily: "'Spectral',serif" }}>COPY</button>
                        </div>
                        <div style={{ padding: "12px 16px", fontSize: 13, color: "#444", lineHeight: "1.7", whiteSpace: "pre-wrap", background: "#faf8f3" }}>
                          {slide.content || (slide.visual?.items ? slide.visual.items.map(it => `${it.icon || "•"} ${it.header ? it.header + ": " : ""}${it.text || ""}`).join("\n") : slide.subtitle || "")}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {/* Кнопка форматування джерел */}
                {tezyCitations.length > 0 && !sourcesFormatted && (
                  <div style={{ border: "1.5px solid #e8c840", borderRadius: 8, padding: "14px 18px", marginTop: 4, marginBottom: 16, background: "#fffbf0" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#5a3a00", marginBottom: 6 }}>Список літератури ще не відформатовано</div>
                    <div style={{ fontSize: 12, color: "#7a5a20", marginBottom: 12 }}>
                      Натисніть щоб оформити список джерел ({tezyCitations.length} шт.) за стилем {info?.citStyle || "ДСТУ 8302:2015"} і розставити посилання у тексті.
                    </div>
                    <button onClick={doFormatAndRemapCitations} disabled={running}
                      style={{ background: running ? "#aaa" : "#3a2a00", color: running ? "#eee" : "#e8c840", border: "none", borderRadius: 7, padding: "10px 22px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: running ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {running ? <><SpinDot light />{loadMsg || "Форматую..."}</> : "📋 Сформувати список літератури і посилання →"}
                    </button>
                  </div>
                )}
                {sourcesFormatted && (
                  <div style={{ fontSize: 12, color: "#3a6010", marginTop: 4, marginBottom: 8 }}>✓ Список літератури відформатовано ({info?.citStyle || "ДСТУ 8302:2015"})</div>
                )}

                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <button onClick={() => navigator.clipboard.writeText(slides.map((s, i) => `СЛАЙД ${i + 1}: ${s.title}\n${s.content || ""}`).join("\n\n"))}
                    style={{ background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, padding: "11px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: "pointer" }}>
                    Скопіювати все
                  </button>
                  <button disabled={docxLoading} onClick={async () => {
                    setDocxLoading(true);
                    try { await exportToPptxFile({ slides, theme: presTheme || undefined }, info); }
                    catch (e) { setError(e.message); }
                    setDocxLoading(false);
                  }} style={{ background: docxLoading ? "#aaa" : "#1a4a1a", color: docxLoading ? "#eee" : "#a8e060", border: "none", borderRadius: 7, padding: "11px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: docxLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                    {docxLoading ? <><SpinDot light />Генерую...</> : "⬇ Завантажити .pptx"}
                  </button>
                </div>
              </>
            )}

            <div style={{ marginTop: 20, padding: "10px 14px", background: "#f0ece2", borderRadius: 6, fontSize: 12, color: "#888" }}>
              Word: Times New Roman 14, міжрядковий 1.5, поля ліво 3см / право 1.5см / верх-низ 2см.
            </div>
            <div style={{ marginTop: 20 }}>
              <button onClick={() => setStage("checklist")} style={{ background: "transparent", border: "1.5px solid #e8ff47", color: "#e8ff47", borderRadius: 7, padding: "11px 22px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: "pointer" }}>
                Чек-лист →
              </button>
            </div>
          </div>
        )}

        {stage === "checklist" && (
          <ChecklistStage info={info} setStage={setStage} mode="small" />
        )}

      </div>
    </div>
  );
}
