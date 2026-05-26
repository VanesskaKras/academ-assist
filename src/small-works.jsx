import { useState, useRef, useEffect } from "react";
import { db } from "./firebase";
import { useAuth } from "./AuthContext";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { MODEL, MODEL_FAST, callClaude, callGemini } from "./lib/api.js";
import { buildSYSSmall } from "./lib/prompts.js";
import { searchSourcesForSection, buildSemanticKeywords, generateSearchPhrases, lookupDoiMetadata, paperToCitation, lookupDOIByBiblio } from "./lib/sourcesSearch.js";
import { serializeForFirestore } from "./lib/firestoreUtils.js";
import { playDoneSound } from "./lib/audio.js";
import { SpinDot, Shimmer } from "./components/SpinDot.jsx";
import { FieldBox, Heading, NavBtn, PrimaryBtn, GreenBtn, SaveIndicator } from "./components/Buttons.jsx";
import { DropZone } from "./components/DropZone.jsx";
import { parsePagesAvg, exportSimpleDocx, TA, TA_WHITE, SHARED_STYLES } from "./shared.jsx";
import { exportToDocx } from "./lib/exportDocx.js";
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

  const currentIdRef = useRef(orderId || null);
  const tokenAccRef = useRef({ inTok: 0, outTok: 0, costUsd: 0 });

  useEffect(() => {
    const handler = (e) => {
      tokenAccRef.current = {
        inTok: tokenAccRef.current.inTok + (e.detail.inTok || 0),
        outTok: tokenAccRef.current.outTok + (e.detail.outTok || 0),
        costUsd: tokenAccRef.current.costUsd + (e.detail.cost || 0),
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
          if (d.searchPhrases?.length) setSearchPhrases(d.searchPhrases);
          if (d.materialText) setMaterialText(d.materialText);
          if (d.sourcesFormatted) setSourcesFormatted(d.sourcesFormatted);
          if (d.methodInfo) setMethodInfo(d.methodInfo);
          if (d.methodRequirements) setMethodRequirements(d.methodRequirements);
          if (d.refSecPapers) setRefSecPapers(d.refSecPapers);
          if (d.refSecPhrases) setRefSecPhrases(d.refSecPhrases);
          if (d.totalInTok !== undefined) {
            tokenAccRef.current = { inTok: d.totalInTok || 0, outTok: d.totalOutTok || 0, costUsd: d.totalCostUsd || 0 };
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
        await saveToFirestore({ tplText, comment, materialText, info: newInfo, ...(extractedMethodReqs ? { methodRequirements: extractedMethodReqs } : {}), stage: "sources", status: "new" });
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
      const papers = (flat || []).slice(0, 10);
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
      const papers = (flat || []).slice(0, 15);
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
      setRefSecSelected(prev => ({ ...prev, [secId]: [] }));
    } catch (e) { setError(e.message); }
    setRunning(false); setLoadMsg("");
  };

  // ── Форматування списку джерел через Gemini (ДСТУ або APA) ──
  const formatCitationsList = async (rawCitations) => {
    if (!rawCitations.length) return rawCitations;
    const citStyle = info?.citStyle || "ДСТУ";
    const isApa = citStyle.toUpperCase().includes("APA");
    try {
      const today = new Date();
      const accessDate = `${String(today.getDate()).padStart(2, "0")}.${String(today.getMonth() + 1).padStart(2, "0")}.${today.getFullYear()}`;
      const refLines = rawCitations.map((r, i) => `${i + 1}. ${r}`).join("\n");
      const fmtPrompt = isApa
        ? `СТИЛЬ: APA 7th edition. СУВОРО дотримуйся APA.
Правила:
- Книга: Прізвище, І. І. (рік). Назва книги. Видавець.
- Стаття: Прізвище, І. І. (рік). Назва статті. Назва журналу курсивом, том(номер), сторінки. https://doi.org/...
- Онлайн: Прізвище, І. І. (рік). Назва. URL
КРИТИЧНО: якщо у вхідному рядку є посилання (http:// або https://) — ОБОВ'ЯЗКОВО збережи його в кінці відформатованого запису.
Збережи номери. Поверни ТІЛЬКИ список без заголовка.
КРИТИЧНО: НЕ перекладай і НЕ транслітеруй прізвища та назви.

${refLines}`
        : `СТИЛЬ: ДСТУ 8302:2015. СУВОРО дотримуйся ДСТУ.
Правила:
- Стаття: Прізвище І. І. Назва статті. *Назва журналу*. рік. № номер. С. xx–xx. URL (якщо є).
- Онлайн: Прізвище І. І. Назва. URL (дата звернення: ${accessDate}).
- КАТЕГОРИЧНО ЗАБОРОНЕНО ставити ініціали ПЕРЕД прізвищем. НЕ "В. Андріяш" — лише "Андріяш В.". Ініціали ЗАВЖДИ після прізвища.
- Між ініціалами — пробіл: "М. В." а не "М.В.".
- КУРСИВ: назву журналу обгортай в *зірочки*.
- Назви ВЕЛИКИМИ ЛІТЕРАМИ переводь у sentence case (перша велика, решта малі).
КРИТИЧНО: якщо у вхідному рядку є посилання (http:// або https://) — ОБОВ'ЯЗКОВО збережи його в кінці відформатованого запису.
Збережи номери. Поверни ТІЛЬКИ список без заголовка.
КРИТИЧНО: НЕ перекладай і НЕ транслітеруй прізвища та назви.

${refLines}`;
      const sysPrompt = isApa
        ? "Ти — асистент з бібліографічного форматування APA 7th edition. Повертай тільки відформатований список."
        : "Ти — асистент з бібліографічного форматування ДСТУ 8302:2015. Назви повністю ВЕЛИКИМИ ЛІТЕРАМИ переводь у sentence case. Повертай тільки відформатований список.";
      const fmtResult = await callGemini([{ role: "user", content: fmtPrompt }], null, sysPrompt, 4000);
      const formatted = fmtResult.split("\n").filter(Boolean).map(l => l.replace(/^\d+\.\s*/, ""));
      if (formatted.length === rawCitations.length) return formatted;
    } catch { /* fallback to raw */ }
    return rawCitations;
  };

  // ── Генерація із текстового поля джерел ──
  const doGenerateFromCitText = async () => {
    let citations = citText.split("\n").map(s => s.trim()).filter(Boolean);
    if (info?.sortAlpha) citations.sort((a, b) => a.localeCompare(b, "uk"));
    setTezyCitations(citations);
    await saveToFirestore({ tezyCitations: citations, citText, stage: "writing", status: "sources_done" });
    setStage("writing");
    if (workType === "tezy") await doGenerateTezy(citations);
    else if (workType === "prezentatsiya") await doGeneratePresentation(citations);
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

  // ── Форматування та фіналізація списку джерел (після генерації тексту) ──
  const doFormatSources = async () => {
    if (!tezyCitations.length) return;
    setRunning(true); setLoadMsg("Форматую список джерел...");
    try {
      const formatted = await formatCitationsList(tezyCitations);
      // Оновлюємо citInputs — замінюємо сирі рядки на відформатовані (зберігаємо прив'язку до секцій)
      const newCitInputs = {};
      sections.filter(s => s.id !== "sources").forEach(s => {
        const secRaw = (citInputs[s.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
        const secFormatted = secRaw.map(r => {
          const idx = tezyCitations.indexOf(r);
          return idx >= 0 ? (formatted[idx] || r) : r;
        });
        if (secFormatted.length) newCitInputs[s.id] = secFormatted.join("\n");
      });
      // Оновлюємо секцію sources у sections
      const sourcesText = formatted.map((c, i) => `${i + 1}. ${c}`).join("\n");
      const updatedSections = sections.map(s => s.id === "sources" ? { ...s, text: sourcesText } : s);
      setSections(updatedSections);
      setCitInputs(newCitInputs);
      setTezyCitations(formatted);
      setSourcesFormatted(true);
      await saveToFirestore({ tezyCitations: formatted, citInputs: newCitInputs, sections: updatedSections, sourcesFormatted: true });
    } catch (e) { setError(e.message); }
    setRunning(false); setLoadMsg("");
  };

  const doConfirmTezyPapers = () => {
    const selected = tezyPapers.filter(p => selectedTezyIds.includes(p.id));
    const rawCitations = selected.map(paperToCitation).filter(Boolean);
    setCitText(prev => {
      const existing = prev.trim();
      const toAdd = rawCitations.filter(c => !existing.includes(c.slice(0, 40)));
      const next = existing ? existing + "\n" + toAdd.join("\n") : toAdd.join("\n");
      saveToFirestore({ citText: next });
      return next;
    });
    setSelectedTezyIds([]);
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
      // ── КРОК 1: Генерація змісту ──
      setLoadMsg("Аналізую матеріали та генерую зміст...");
      const step1Prompt = `Ти готуєш презентацію на тему "${info?.topic}". Галузь: ${info?.subject || ""}. Мова: ${lang}.
${reqBlock}${materialContext}${commentBlock}${sourcesBlock}
Створи детальний план змісту для ${totalSlides} слайдів (включно з титульним і завершальним "Дякую за увагу!").

Для КОЖНОГО слайду напиши:
— Назву слайду
— Повний текст/зміст (2-5 речень або пунктів з конкретними фактами з матеріалів)
— Тип подачі: список / порівняння / статистика / кроки / текст

Перший слайд — титульний з назвою теми.
Останній — "Дякую за увагу!"
Використовуй конкретні дані, цифри та факти з наданих матеріалів — не загальні фрази.`;

      const step1Msgs = [{ role: "user", content: [...fileContext, ...matFileContext, { type: "text", text: step1Prompt }] }];
      const contentPlan = await callClaude(step1Msgs, null, `You are a presentation content expert. Write in ${lang}.`, 3000, null, MODEL);

      // ── КРОК 2: Форматування в JSON ──
      setLoadMsg("Оформлюю слайди...");
      const step2Prompt = `Перетвори цей план презентації у JSON структуру для рендерингу. Точно ${totalSlides} слайдів.

ПЛАН ЗМІСТУ:
${contentPlan}

Поверни ТІЛЬКИ JSON без markdown:
{"slides":[
  {"layout":"hero","title":"Назва теми","subtitle":"підзаголовок якщо є"},
  {"layout":"icon_list","title":"Мета та завдання","visual":{"items":[{"icon":"🎯","header":"Мета","text":"..."},{"icon":"📋","header":"Завдання","text":"..."}]}},
  {"layout":"highlight_box","title":"Назва розділу","content":"Теза 1\\nТеза 2\\nТеза 3"},
  {"layout":"two_column","title":"...","left":"Текст ліворуч","right":"Ключовий факт"},
  {"layout":"numbered_steps","title":"Методологія","visual":{"items":[{"num":"1","title":"Крок","text":"..."}]}},
  {"layout":"stat_callout","title":"Результати","visual":{"stats":[{"value":"72%","label":"опис"}]}},
  {"layout":"hero","title":"Висновки","subtitle":"підсумок"},
  {"layout":"hero","title":"Дякую за увагу!","subtitle":""}
]}

Правила вибору layout:
- hero — тільки для 1-го слайду, завершального, та слайдів-розділювачів
- icon_list — перелік 3-5 пунктів (мета, особливості, висновки)
- numbered_steps — процес або методологія (3-4 кроки)
- two_column — порівняння або два аспекти
- stat_callout — є конкретні числа/відсотки
- highlight_box — основний текст (default для більшості слайдів)
НЕ додавай слайд джерел. Слайд 1: hero. Останній: hero, title="Дякую за увагу!".`;

      const step2Raw = await callClaude([{ role: "user", content: step2Prompt }], null, "Respond only with valid JSON. No markdown.", 4000, null, MODEL_FAST);
      const parsed = JSON.parse(step2Raw.match(/\{[\s\S]*\}/)?.[0] || step2Raw);
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
        {info?.orderNumber && <div style={{ fontSize: 11, color: "#888", whiteSpace: "nowrap", flexShrink: 0 }}>#{info.orderNumber}</div>}
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

            <FieldBox label="Шаблон замовлення *">
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
                  {materialFiles.length < (["stattia", "ese", "referat"].includes(workType) ? 8 : workType === "prezentatsiya" ? 3 : 6) && (
                    <DropZone fileLabel={null} onFile={(name, b64, type) => { const lim = ["stattia", "ese", "referat"].includes(workType) ? 8 : workType === "prezentatsiya" ? 3 : 6; setMaterialFiles(p => p.length >= lim ? [...p.slice(1), { name, b64, type }] : [...p, { name, b64, type }]); }} accept=".pdf,.docx,.jpg,.jpeg,.png" />
                  )}
                </div>
                {(materialText.trim() || materialFiles.length > 0) && (
                  <div style={{ fontSize: 11, color: "#5a8a2a", marginTop: 6 }}>
                    ✓ {[materialText.trim() ? `${materialText.trim().split(/\s+/).length} сл.` : null, materialFiles.length ? `${materialFiles.length} файл(и)` : null].filter(Boolean).join(" + ")} — буде передано ШІ
                  </div>
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
                            <PrimaryBtn onClick={doConfirmTezyPapers}
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
                  else if (workType === "prezentatsiya") doGeneratePresentation([]);
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
                    <button onClick={doFormatSources} disabled={running}
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
