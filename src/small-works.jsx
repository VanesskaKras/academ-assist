import { useState, useRef, useEffect } from "react";
import { db } from "./firebase";
import { useAuth } from "./AuthContext";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { MODEL, MODEL_FAST, callClaude, callGemini } from "./lib/api.js";
import { buildSYS } from "./lib/prompts.js";
import { searchSourcesForSection, buildSemanticKeywords, generateSearchPhrases, lookupDoiMetadata, paperToCitation } from "./lib/sourcesSearch.js";
import { serializeForFirestore } from "./lib/firestoreUtils.js";
import { playDoneSound } from "./lib/audio.js";
import { SpinDot, Shimmer } from "./components/SpinDot.jsx";
import { FieldBox, Heading, NavBtn, PrimaryBtn, GreenBtn, SaveIndicator } from "./components/Buttons.jsx";
import { DropZone } from "./components/DropZone.jsx";
import { parsePagesAvg, exportSimpleDocx, TA, TA_WHITE, SHARED_STYLES } from "./shared.jsx";
import { ChecklistStage } from "./components/stages/ChecklistStage.jsx";

// ─────────────────────────────────────────────
// Конфіг типів робіт
// ─────────────────────────────────────────────
const WORK_TYPES = {
  referat: {
    label: "Реферат",
    icon: "📄",
    hasplan: true,
    stages: ["Дані", "План", "Текст", "Готово", "Чек-лист"],
    stageKeys: ["input", "plan", "writing", "done", "checklist"],
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
    stages: ["Дані", "Генерація", "Готово", "Чек-лист"],
    stageKeys: ["input", "writing", "done", "checklist"],
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
  const [tezyPapers, setTezyPapers] = useState([]);         // знайдені папери
  const [selectedTezyIds, setSelectedTezyIds] = useState([]); // обрані id
  const [tezySearchLoading, setTezySearchLoading] = useState(false);
  const [tezyCitations, setTezyCitations] = useState([]);    // відформатовані рядки джерел
  const [tezyPage, setTezyPage] = useState(1);               // поточна сторінка джерел

  // Реферат — секції з текстом
  const [sections, setSections] = useState([]); // [{id, label, text}]
  const [genIdx, setGenIdx] = useState(0);
  const [maxStageIdx, setMaxStageIdx] = useState(0);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);

  // Прості роботи — один блок тексту або слайди
  const [result, setResult] = useState(""); // для тез/статті/есе
  const [slides, setSlides] = useState([]); // [{title, content}] для презентації

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
          if (d.materialText) setMaterialText(d.materialText);
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

  // ── Автозапуск пошуку джерел для тез/статті/есе ──
  useEffect(() => {
    if (["tezy", "stattia", "ese"].includes(workType) && stage === "sources" && tezyPapers.length === 0 && !tezySearchLoading && info?.topic) {
      doSearchTezyPapers();
    }
  }, [workType, stage, info?.topic]);

  // ── Авто-збереження вибраних джерел ──
  useEffect(() => {
    if (!["tezy", "stattia", "ese"].includes(workType) || stage !== "sources") return;
    const t = setTimeout(() => {
      saveToFirestore({ selectedTezyIds });
    }, 1000);
    return () => clearTimeout(t);
  }, [selectedTezyIds]);

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
        uid: user.uid, mode: "small", workType,
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
      const tezyFields = isTezy ? `,"needsSources":true,"sourceCount":3,"authorFormat":"center","bodyStructure":"linear","needsEmail":false,"needsUDK":false,"needsFigures":false,"figureCount":0` : "";
      const simpleFields = isSimpleWithSources ? `,"sourceCount":${workType === "stattia" ? 5 : 3},"citStyle":"ДСТУ","needsFigures":false,"figureCount":0,"sortAlpha":false` : "";
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

      const materialHint = ((isTezy || isSimpleWithSources) && materialText.trim())
        ? `\nМАТЕРІАЛ (фрагмент для розуміння теми):\n${materialText.trim().slice(0, 1500)}`
        : "";

      const prompt = `Проаналізуй замовлення на ${WORK_TYPES[workType]?.label || workType}.

ШАБЛОН:
${tplText}
${comment ? `\nКОМЕНТАР: ${comment}` : ""}${materialHint}

Поверни ТІЛЬКИ JSON (без markdown):
{"type":"${WORK_TYPES[workType]?.label || workType}","pages":"","topic":"","subject":"","direction":"","uniqueness":"","language":"Українська","deadline":"","requirements":""${tezyFields}${simpleFields}}

requirements — якщо є рекомендації у файлах, стисло опиши ключові вимоги до структури та оформлення.${tezyHints}${simpleHints}`;

      const msgs = [{ role: "user", content: [...fileContext, ...matFileContext, { type: "text", text: prompt }] }];
      // Для тез/статті/есе з файлами — Sonnet (краще читає зображення), інакше Haiku
      const model = ((isTezy || isSimpleWithSources) && (files.length > 0 || materialFiles.length > 0)) ? MODEL : MODEL_FAST;
      const raw = await callClaude(msgs, null, "Respond only with valid JSON. No markdown.", 1500, null, model);
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      const newInfo = { ...parsed, workType };
      setInfo(newInfo);

      if (workType === "referat") {
        await saveToFirestore({ tplText, comment, clientPlan, info: newInfo, stage: "plan", status: "new" });
        setStage("plan");
      } else if (isTezy && newInfo.needsSources !== false) {
        await saveToFirestore({ tplText, comment, materialText, authorData, info: newInfo, stage: "sources", status: "new" });
        setStage("sources");
      } else if (isSimpleWithSources) {
        await saveToFirestore({ tplText, comment, materialText, info: newInfo, stage: "sources", status: "new" });
        setStage("sources");
      } else {
        await saveToFirestore({ tplText, comment, materialText, authorData, info: newInfo, stage: "writing", status: "new" });
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

      const [phrases, ukKw] = await Promise.all([
        generateSearchPhrases(topic, topic, direction, subject),
        Promise.resolve(buildSemanticKeywords(topic, topic, direction, subject)),
      ]);

      const { flat } = await searchSourcesForSection(ukKw, [], needed + 6, topic, topic, 1, [], [], phrases);
      const papers = (flat || []).slice(0, 10);
      setTezyPapers(papers);
      setTezyPage(1);
      setSelectedTezyIds([]);
      await saveToFirestore({ tezyPapers: papers, selectedTezyIds: [] });
    } catch (e) {
      setError(e.message);
    }
    setTezySearchLoading(false);
  };

  // ── Підтвердження вибраних джерел ──
  const doConfirmTezyPapers = async () => {
    setRunning(true); setLoadMsg("Оформлюю джерела...");
    try {
      const selected = tezyPapers.filter(p => selectedTezyIds.includes(p.id));
      const enriched = await Promise.all(selected.map(async p => {
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
      const rawCitations = enriched.map(paperToCitation).filter(Boolean);

      setLoadMsg("Форматую джерела...");
      let citations = rawCitations;
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
Збережи номери. Поверни ТІЛЬКИ список без заголовка.
КРИТИЧНО: НЕ перекладай і НЕ транслітеруй прізвища та назви.

${refLines}`
          : `СТИЛЬ: ДСТУ 8302:2015. СУВОРО дотримуйся ДСТУ.
Правила:
- Стаття: Прізвище І. І. Назва статті. *Назва журналу*. рік. № номер. С. xx–xx.
- Онлайн: Прізвище І. І. Назва. URL (дата звернення: ${accessDate}).
- Ініціали ПІСЛЯ прізвища без ком.
- КУРСИВ: назву журналу обгортай в *зірочки*.
- Назви ВЕЛИКИМИ ЛІТЕРАМИ переводь у sentence case (перша велика, решта малі).
Збережи номери. Поверни ТІЛЬКИ список без заголовка.
КРИТИЧНО: НЕ перекладай і НЕ транслітеруй прізвища та назви.

${refLines}`;
        const sysPrompt = isApa
          ? "Ти — асистент з бібліографічного форматування APA 7th edition. Повертай тільки відформатований список."
          : "Ти — асистент з бібліографічного форматування ДСТУ 8302:2015. Назви повністю ВЕЛИКИМИ ЛІТЕРАМИ переводь у sentence case. Повертай тільки відформатований список.";
        const fmtResult = await callGemini(
          [{ role: "user", content: fmtPrompt }], null, sysPrompt, 4000
        );
        const formatted = fmtResult.split("\n").filter(Boolean).map(l => l.replace(/^\d+\.\s*/, ""));
        if (formatted.length === rawCitations.length) citations = formatted;
      } catch { /* fallback to raw */ }

      if (info?.sortAlpha) {
        citations.sort((a, b) => a.localeCompare(b, "uk"));
      }

      setTezyCitations(citations);
      await saveToFirestore({ tezyCitations: citations, stage: "writing", status: "sources_done" });
      setStage("writing");
      if (workType === "tezy") {
        await doGenerateTezy(citations);
      } else {
        await doGenerateSimple(citations);
      }
    } catch (e) { setError(e.message); }
    setRunning(false); setLoadMsg("");
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
    const sourcesContext = hasSources
      ? `\nДЖЕРЕЛА — використай у тексті з посиланнями [N]:\n${activeCitations.map((s, i) => `[${i + 1}] ${s}`).join("\n")}`
      : "";

    const structureInstr = info?.bodyStructure === "structured"
      ? "Структура за замовчуванням: Преамбула (2-3 речення: актуальність і новизна) → Тези (5-7 речень: ключові ідеї, власна позиція) → Аргументація (4-6 речень: обґрунтування, посилання на джерела) → Демонстрація (4-6 речень: ілюстрація прикладами) → Результати (2-4 речення: висновки, теоретична/практична цінність). Якщо у наданих матеріалах або методичці вказана інша структура тез — використай її замість цієї."
      : "Структура за замовчуванням: Актуальність (1-2 абзаци) → Мета та завдання (1 абзац) → Матеріали і методи (1 абзац) → Результати та обговорення (2-3 абзаци з посиланнями [N]) → Висновки (пиши слово \"Висновки.\" жирним inline, потім текст). Якщо у наданих матеріалах або методичці вказана інша структура тез — використай її замість цієї.";

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

    const prompt = `Напиши тези наукової доповіді на тему "${info?.topic}". Галузь: ${[info?.subject, info?.direction].filter(Boolean).join(", ")}.
${materialContext}
БЛОК АВТОРА (${authorFormat === "right" ? "вирівняти по правому краю" : "вирівняти по центру"}):
${authorBlockLines}

${info?.needsUDK ? "Перший рядок документу: УДК [відповідний код для теми]" : ""}
Назва доповіді: "${info?.topic}" — ВЕЛИКИМИ ЛІТЕРАМИ, по центру.

${structureInstr}
${sourcesContext}
${figureInstr}

Обсяг: ~${totalPages} сторінки. Мова: ${lang}.
${info?.requirements ? `Вимоги конференції: ${info.requirements}` : ""}
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
      const text = await callClaude(msgs, null, buildSYS(lang), 6000);
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

    try {
      let newSections = [];

      if (clientPlan?.trim()) {
        // Парсимо план клієнта
        const lines = clientPlan.split("\n").map(l => l.trim()).filter(Boolean);
        const chapSecs = lines
          .filter(l => /^(розділ|chapter|\d+\.?\s+[А-ЯҐЄІЇа-яґєії])/i.test(l))
          .map((l, i) => ({ id: `ch${i + 1}`, label: l, text: "" }));
        if (chapSecs.length > 0) {
          newSections = [
            { id: "intro", label: "ВСТУП", text: "" },
            ...chapSecs,
            { id: "conclusions", label: "ВИСНОВКИ", text: "" },
            { id: "sources", label: "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", text: "" },
          ];
        }
      }

      if (newSections.length === 0) {
        // Генеруємо план через API
        const prompt = `Склади план реферату на тему: "${info?.topic}". Галузь: ${info?.subject || ""}. Обсяг: ${totalPages} стор.
К-сть розділів: ${chapCount}.
${info?.requirements ? `Вимоги: ${info.requirements}` : ""}

Поверни ТІЛЬКИ JSON:
{"sections":[
  {"id":"intro","label":"ВСТУП"},
  {"id":"ch1","label":"РОЗДІЛ 1. Назва"},
  {"id":"ch2","label":"РОЗДІЛ 2. Назва"},
  {"id":"conclusions","label":"ВИСНОВКИ"},
  {"id":"sources","label":"СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ"}
]}`;
        const raw = await callClaude([{ role: "user", content: prompt }], null, "Respond only with valid JSON.", 1000, null, MODEL_FAST);
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
      const sourceCount = totalPages;
      const autoSources = `Список використаних джерел формується за кількістю сторінок (${sourceCount} джерел). Додайте джерела вручну.`;
      setSections(p => p.map((s, i) => i === genIdx ? { ...s, text: autoSources } : s));
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
    const pagesPerSec = sec.id === "intro" || sec.id === "conclusions"
      ? Math.max(1, Math.round(totalPages * 0.07))
      : Math.max(2, Math.round(totalPages * 0.8 / chapCount));
    const approxParas = Math.max(3, Math.round(pagesPerSec * 3));

    let instruction = "";
    if (sec.id === "intro") {
      instruction = `Напиши ВСТУП для реферату на тему "${info?.topic}".
Структура: актуальність теми, мета роботи, завдання, структура реферату.
${info?.requirements ? `Вимоги: ${info.requirements}` : ""}
Обсяг: ~${approxParas} абзаців. Без посилань. Без жирного.`;
    } else if (sec.id === "conclusions") {
      instruction = `Напиши ВИСНОВКИ для реферату на тему "${info?.topic}".
Підсумуй основні результати по кожному розділу. Конкретні висновки без загальних фраз.
Обсяг: ~${approxParas} абзаців. Без посилань. Без жирного. Без нумерації. Пиши суцільними абзацами.`;
    } else {
      instruction = `Напиши розділ "${sec.label}" для реферату на тему "${info?.topic}". Галузь: ${info?.subject || ""}.
${info?.requirements ? `Вимоги до оформлення: ${info.requirements}` : ""}
Обсяг: ~${approxParas} абзаців (~${pagesPerSec} стор.).
Без посилань у тексті. Без жирного. Завершуй підсумковим реченням.`;
    }

    try {
      const result = await callClaude([{ role: "user", content: instruction }], null, buildSYS(lang), 6000);
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
    const sourcesContext = hasSources
      ? `\nДЖЕРЕЛА — використай у тексті з посиланнями [N]:\n${activeCitations.map((s, i) => `[${i + 1}] ${s}`).join("\n")}`
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

    const typePrompts = {
      stattia: `Напиши НАУКОВУ СТАТТЮ.
Назва: "${info?.topic}" — ВЕЛИКИМИ ЛІТЕРАМИ, по центру.
Галузь: ${[info?.subject, info?.direction].filter(Boolean).join(", ")}.
Структура: Вступ (актуальність, мета), Матеріали і методи, Результати та обговорення, Висновки.
Обсяг: ~${totalPages} сторінок. Академічний стиль. Без жирного.`,
      ese: `Напиши ЕСЕ.
Назва: "${info?.topic}".
Структура: теза, аргументи з прикладами (3-4 абзаци), контраргумент, висновок.
Обсяг: ~${totalPages} сторінок. Аналітичний стиль. Без жирного.`,
    };

    const prompt = `${typePrompts[workType] || `Напиши роботу на тему "${info?.topic}".`}
${materialContext}
${info?.requirements ? `\nВИМОГИ: ${info.requirements}` : ""}
${info?.uniqueness ? `Унікальність: ${info.uniqueness}.` : ""}
Мова: ${lang}.
${sourcesContext}
${figureInstr}
${sourcesList ? `\nПісля основного тексту додай (зберігай форматування *курсив* у джерелах без змін):\n${sourcesList}` : ""}`;

    try {
      const msgs = [{ role: "user", content: [...matFileContext, ...fileContext, { type: "text", text: prompt }] }];
      const text = await callClaude(msgs, null, buildSYS(lang), 6000);
      setResult(text);
      playDoneSound();
      await saveToFirestore({ result: text, tezyCitations: activeCitations, stage: "done", status: "done" });
      setStage("done");
    } catch (e) { setError(e.message); }
    setRunning(false); setLoadMsg("");
  };

  // ── Генерація презентації ──
  const doGeneratePresentation = async () => {
    setRunning(true); setLoadMsg("Генерую презентацію...");
    const lang = info?.language || "Українська";
    const totalSlides = Math.max(10, Math.min(20, parsePagesAvg(info?.pages || "15")));

    const fileContext = files.length > 0
      ? files.map(f => ({ type: f.type.startsWith("image/") ? "image" : "document", source: { type: "base64", media_type: f.type, data: f.b64 } }))
      : [];

    const prompt = `Створи презентацію на тему "${info?.topic}". Галузь: ${info?.subject || ""}.
К-сть слайдів: ${totalSlides}.
${info?.requirements ? `Вимоги: ${info.requirements}` : ""}

Поверни ТІЛЬКИ JSON:
{"slides":[
  {"title":"Назва слайду","content":"Текст слайду (2-5 коротких тез, кожна з нового рядка через \\n)"},
  ...
]}

Перший слайд — титульний (тема + автор), останній — висновки/дякую.
Мова: ${lang}.`;

    try {
      const msgs = [{ role: "user", content: [...fileContext, { type: "text", text: prompt }] }];
      const raw = await callClaude(msgs, null, buildSYS(lang), 4000, null, MODEL_FAST);
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      const newSlides = parsed.slides || [];
      setSlides(newSlides);
      playDoneSound();
      await saveToFirestore({ slides: newSlides, stage: "done", status: "done" });
      setStage("done");
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
      <div style={{ background: "#1a1a14", color: "#f5f2eb", padding: "15px 32px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        {onBack && (
          <button onClick={onBack} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "5px 14px", cursor: "pointer", fontFamily: "inherit", fontSize: 12, marginRight: 4 }}>
            ← Замовлення
          </button>
        )}
        <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 19, letterSpacing: 5, color: "#e8ff47" }}>ACADEM</div>
        <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 19, letterSpacing: 5 }}>SMALL</div>
        {cfg && <div style={{ fontSize: 12, color: "#888", marginLeft: 4 }}>{cfg.icon} {cfg.label}</div>}
        {info?.topic && <div style={{ fontSize: 12, color: "#555", flex: 1, minWidth: 0 }}>{info.topic}</div>}
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
                placeholder={`Тема - ...\nСторінок - ...\nДедлайн - ...\nВимоги - ...`}
                style={{ ...TA, minHeight: 160 }} />
            </FieldBox>

            {workType === "referat" && (
              <FieldBox label="Готовий план від клієнта (необов'язково)">
                <textarea value={clientPlan} onChange={e => setClientPlan(e.target.value)}
                  placeholder={"Розділ 1. Назва\nРозділ 2. Назва\n..."}
                  style={{ ...TA, minHeight: 80 }} />
              </FieldBox>
            )}

            {workType !== "tezy" && (
              <FieldBox label="Коментар">
                <textarea value={comment} onChange={e => setComment(e.target.value)}
                  placeholder="Додаткові вимоги..." style={{ ...TA, minHeight: 70 }} />
              </FieldBox>
            )}

            {workType !== "tezy" && (
              <FieldBox label={
                ["stattia", "ese"].includes(workType)
                  ? "Методичка (необов'язково)"
                  : `Рекомендації / методичка / скріни (до 3 файлів)${workType !== "referat" ? " — необов'язково" : ""}`
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

            {/* Матеріал для роботи — для тез, статті, есе */}
            {["tezy", "stattia", "ese"].includes(workType) && (
              <FieldBox label={`Матеріал для роботи — текст або файли/фото до ${["stattia", "ese"].includes(workType) ? 8 : 6} (необов'язково)`}>
                <textarea
                  value={materialText}
                  onChange={e => setMaterialText(e.target.value)}
                  placeholder="Вставте текст, конспект, реферат або будь-який матеріал для аналізу..."
                  style={{ ...TA, minHeight: 100 }}
                />
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                  {materialFiles.map((f, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", background: "#eef5e4", borderRadius: 6, fontSize: 13 }}>
                      <span>{f.type.startsWith("image/") ? "🖼" : "📄"} {f.name}</span>
                      <button onClick={() => setMaterialFiles(p => p.filter((_, j) => j !== i))} style={{ marginLeft: "auto", background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 14 }}>✕</button>
                    </div>
                  ))}
                  {materialFiles.length < (["stattia", "ese"].includes(workType) ? 8 : 6) && (
                    <DropZone fileLabel={null} onFile={(name, b64, type) => { const lim = ["stattia", "ese"].includes(workType) ? 8 : 6; setMaterialFiles(p => p.length >= lim ? [...p.slice(1), { name, b64, type }] : [...p, { name, b64, type }]); }} accept=".pdf,.docx,.jpg,.jpeg,.png" />
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
                <p style={{ fontSize: 13, color: "#888", marginBottom: 20 }}>
                  {clientPlan?.trim() ? "Використовується план клієнта." : "Автоматично згенерую план."}
                </p>
                <PrimaryBtn onClick={doGenPlan} loading={running} msg={loadMsg} label="Згенерувати план →" />
              </>
            ) : (
              <>
                <p style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>Перевірте та відредагуйте план. Після підтвердження — генерація тексту.</p>
                <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 20 }}>
                  {sections.map((sec, i) => (
                    <div key={sec.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", borderBottom: i < sections.length - 1 ? "1px solid #e4dfd4" : "none", background: ["intro", "conclusions", "sources"].includes(sec.id) ? "#ede9e0" : "#faf8f3" }}>
                      <span style={{ fontSize: 11, color: "#bbb", width: 20 }}>{i + 1}</span>
                      <input value={sec.label} onChange={e => setSections(p => p.map((s, j) => j === i ? { ...s, label: e.target.value } : s))}
                        style={{ flex: 1, background: "transparent", border: "none", fontSize: 13, fontFamily: "'Spectral',serif", color: "#1a1a14" }} />
                      <button onClick={() => setSections(p => p.filter((_, j) => j !== i))}
                        style={{ background: "none", border: "none", color: "#ccc", cursor: "pointer", fontSize: 14 }}
                        onMouseEnter={e => e.currentTarget.style.color = "#c00"}
                        onMouseLeave={e => e.currentTarget.style.color = "#ccc"}>✕</button>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <NavBtn onClick={() => setSections([])}>Перегенерувати</NavBtn>
                  <PrimaryBtn onClick={() => { setStage("writing"); saveToFirestore({ sections, stage: "writing" }); }} label="Розпочати написання →" />
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
        {["tezy", "stattia", "ese"].includes(workType) && stage === "sources" && (
          <div className="fade">
            <Heading>📚 Джерела</Heading>
            <p style={{ fontSize: 13, color: "#888", marginBottom: 20 }}>
              Оберіть {info?.sourceCount || (workType === "stattia" ? 5 : 3)}–{(info?.sourceCount || (workType === "stattia" ? 5 : 3)) + 3} джерела зі знайдених.
              Їх буде передано Claude для написання з посиланнями [N].
            </p>

            {tezyPapers.length === 0 && !tezySearchLoading && (
              <div style={{ textAlign: "center", padding: "30px 0" }}>
                <PrimaryBtn onClick={doSearchTezyPapers} loading={tezySearchLoading} msg="Шукаю джерела..." label="Знайти джерела →" />
                <p style={{ marginTop: 16, fontSize: 12, color: "#aaa" }}>Пошук займе 10–20 секунд</p>
              </div>
            )}

            {tezySearchLoading && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 0", color: "#888", fontSize: 13 }}>
                <SpinDot /> Шукаю в наукових базах...
              </div>
            )}

            {tezyPapers.length > 0 && (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div style={{ fontSize: 12, color: "#888" }}>Знайдено: {tezyPapers.length} · Обрано: {selectedTezyIds.length}</div>
                  <button onClick={doSearchTezyPapers} disabled={tezySearchLoading}
                    style={{ background: "transparent", border: "1px solid #ccc", borderRadius: 6, padding: "4px 12px", fontSize: 11, cursor: "pointer", color: "#666" }}>
                    ↺ Шукати ще
                  </button>
                </div>

                {(() => {
                  const PAGE_SIZE = 5;
                  const totalPages = Math.ceil(tezyPapers.length / PAGE_SIZE);
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
                            <label key={paper.id} style={{
                              display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer",
                              padding: "10px 12px", borderRadius: 7,
                              background: isChecked ? "#f0f8e8" : "#faf8f3",
                              border: `1.5px solid ${isChecked ? "#8cc84b" : "#e0ddd5"}`,
                              transition: "all 0.15s",
                            }}>
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
                      {totalPages > 1 && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20 }}>
                          <button
                            onClick={() => setTezyPage(p => Math.max(1, p - 1))}
                            disabled={tezyPage === 1}
                            style={{ background: "transparent", border: "1px solid #d4cfc4", borderRadius: 6, padding: "4px 12px", fontSize: 12, cursor: tezyPage === 1 ? "default" : "pointer", color: tezyPage === 1 ? "#ccc" : "#555" }}
                          >←</button>
                          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                            <button key={p} onClick={() => setTezyPage(p)}
                              style={{ background: p === tezyPage ? "#1a1a14" : "transparent", border: "1px solid #d4cfc4", borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer", color: p === tezyPage ? "#e8ff47" : "#555", fontWeight: p === tezyPage ? 600 : 400 }}
                            >{p}</button>
                          ))}
                          <button
                            onClick={() => setTezyPage(p => Math.min(totalPages, p + 1))}
                            disabled={tezyPage === totalPages}
                            style={{ background: "transparent", border: "1px solid #d4cfc4", borderRadius: 6, padding: "4px 12px", fontSize: 12, cursor: tezyPage === totalPages ? "default" : "pointer", color: tezyPage === totalPages ? "#ccc" : "#555" }}
                          >→</button>
                          <span style={{ fontSize: 11, color: "#aaa", marginLeft: 4 }}>{tezyPage} / {totalPages}</span>
                        </div>
                      )}
                    </>
                  );
                })()}

                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <NavBtn onClick={() => { setTezyCitations([]); saveToFirestore({ stage: "writing", status: "new" }); setStage("writing"); workType === "tezy" ? doGenerateTezy([]) : doGenerateSimple([]); }}>
                    Пропустити без джерел →
                  </NavBtn>
                  <PrimaryBtn
                    onClick={doConfirmTezyPapers}
                    disabled={selectedTezyIds.length === 0}
                    loading={running}
                    msg={loadMsg}
                    label={`Підтвердити ${selectedTezyIds.length} джерел → Генерація`}
                  />
                </div>
              </>
            )}
          </div>
        )}

        {/* ══ ГЕНЕРАЦІЯ тез ══ */}
        {workType === "tezy" && stage === "writing" && (
          <div className="fade">
            <Heading>📝 Генерація тез</Heading>
            {result ? (
              <>
                <div style={{ border: "1.5px solid #aaa49a", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
                  <div style={{ background: "#1a1a14", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 13, color: "#f5f2eb", fontWeight: 600 }}>Тези: {info?.topic}</span>
                    <button onClick={() => navigator.clipboard.writeText(result)} style={{ background: "transparent", border: "1px solid #555", color: "#999", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer" }}>COPY</button>
                  </div>
                  <div style={{ padding: "16px 20px", fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", whiteSpace: "pre-wrap", maxHeight: 400, overflowY: "auto", background: "#faf8f3" }}>{result}</div>
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
                    <span style={{ fontSize: 13, color: "#f5f2eb", fontWeight: 600 }}>{cfg.label}: {info?.topic}</span>
                    <button onClick={() => navigator.clipboard.writeText(result)} style={{ background: "transparent", border: "1px solid #555", color: "#999", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer" }}>COPY</button>
                  </div>
                  <div style={{ padding: "16px 20px", fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", whiteSpace: "pre-wrap", maxHeight: 400, overflowY: "auto", background: "#faf8f3" }}>{result}</div>
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
              <div style={{ textAlign: "center", padding: "40px 0" }}>
                <p style={{ fontSize: 14, color: "#888", marginBottom: 24 }}>
                  {files.length > 0 ? `Завантажено ${files.length} файл(ів). ` : ""}
                  Генеруватиму структуру та текст для кожного слайду.
                </p>
                <PrimaryBtn onClick={doGeneratePresentation} loading={running} msg={loadMsg} label="Генерувати презентацію →" />
              </div>
            ) : (
              <>
                <p style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>{slides.length} слайдів згенеровано.</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
                  {slides.map((slide, i) => (
                    <div key={i} style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden" }}>
                      <div style={{ background: "#1a1a14", padding: "9px 16px", display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 11, color: "#e8ff47", background: "#2a2a1a", padding: "1px 8px", borderRadius: 10 }}>{i + 1}</span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "#f5f2eb", flex: 1 }}>{slide.title}</span>
                      </div>
                      <div style={{ padding: "12px 16px", fontSize: 13, color: "#444", lineHeight: "1.7", whiteSpace: "pre-wrap", background: "#faf8f3" }}>{slide.content}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <NavBtn onClick={() => setSlides([])}>Перегенерувати</NavBtn>
                  <button onClick={() => navigator.clipboard.writeText(slides.map((s, i) => `СЛАЙД ${i + 1}: ${s.title}\n${s.content}`).join("\n\n"))}
                    style={{ background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, padding: "11px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: "pointer" }}>
                    Скопіювати все
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
                {sections.filter(s => s.text).map(sec => (
                  <div key={sec.id} style={{ border: "1.5px solid #aaa49a", borderRadius: 8, marginBottom: 10, overflow: "hidden" }}>
                    <div style={{ background: "#1a1a14", padding: "10px 16px", display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#e8ff47" }} />
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "#f5f2eb" }}>{sec.label}</div>
                      <button onClick={() => navigator.clipboard.writeText(sec.text)} style={{ background: "transparent", border: "1px solid #555", color: "#999", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer" }}>COPY</button>
                    </div>
                    <div style={{ padding: "14px 18px", fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", whiteSpace: "pre-wrap", maxHeight: 260, overflowY: "auto", background: "#faf8f3" }}>{sec.text}</div>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 20 }}>
                  <button onClick={() => navigator.clipboard.writeText(sections.map(s => s.label + "\n\n" + s.text).join("\n\n" + "─".repeat(50) + "\n\n"))}
                    style={{ background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, padding: "11px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: "pointer" }}>
                    Скопіювати все
                  </button>
                  <button disabled={docxLoading} onClick={async () => {
                    setDocxLoading(true);
                    try {
                      await exportSimpleDocx({ title: info?.topic, sections: sections.map(s => ({ label: s.label, text: s.text })), info });
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
                    <span style={{ fontSize: 13, color: "#f5f2eb", fontWeight: 600 }}>{cfg.label}: {info?.topic}</span>
                    <button onClick={() => navigator.clipboard.writeText(result)} style={{ background: "transparent", border: "1px solid #555", color: "#999", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer" }}>COPY</button>
                  </div>
                  <div style={{ padding: "16px 20px", fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", whiteSpace: "pre-wrap", maxHeight: 400, overflowY: "auto", background: "#faf8f3" }}>{result}</div>
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
                      await exportSimpleDocx({ title: info?.topic, sections: [{ label: cfg.label.toUpperCase(), text: result }], info, citations: workType === "tezy" ? tezyCitations : undefined });
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
                  {slides.map((slide, i) => (
                    <div key={i} style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden" }}>
                      <div style={{ background: "#1a1a14", padding: "9px 16px", display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 11, color: "#e8ff47", background: "#2a2a1a", padding: "1px 8px", borderRadius: 10 }}>{i + 1}</span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "#f5f2eb", flex: 1 }}>{slide.title}</span>
                      </div>
                      <div style={{ padding: "12px 16px", fontSize: 13, color: "#444", lineHeight: "1.7", whiteSpace: "pre-wrap", background: "#faf8f3" }}>{slide.content}</div>
                    </div>
                  ))}
                </div>
                <button onClick={() => navigator.clipboard.writeText(slides.map((s, i) => `СЛАЙД ${i + 1}: ${s.title}\n${s.content}`).join("\n\n"))}
                  style={{ background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, padding: "11px 24px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: "pointer" }}>
                  Скопіювати все
                </button>
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
