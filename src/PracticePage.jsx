import { useState, useRef, useEffect, useCallback } from "react";
import { db } from "./firebase";
import { useAuth } from "./AuthContext";
import { doc, getDoc, setDoc, addDoc, collection } from "firebase/firestore";
import {
  callClaude, callGemini, MODEL, MODEL_FAST,
} from "./lib/api.js";
import {
  buildSYS, SYS_JSON, SYS_JSON_SHORT, STRUCTURE_READING_PROMPT,
  buildMethodologyReadingPrompt,
  buildPracticePlanPrompt, buildPracticeWritingPrompt,
  buildPracticeDiaryPrompt, buildPracticeSourcesKeywordsPrompt,
} from "./lib/prompts.js";
import { serializeForFirestore } from "./lib/firestoreUtils.js";
import { playDoneSound } from "./lib/audio.js";
import {
  generateSearchPhrases, buildSemanticKeywords,
  searchSourcesForSection, lookupDoiMetadata, lookupDOIByBiblio, paperToCitation,
} from "./lib/sourcesSearch.js";
import { exportToDocx } from "./lib/exportDocx.js";
import { SpinDot } from "./components/SpinDot.jsx";
import { DropZone } from "./components/DropZone.jsx";
import { ClientMaterialsZone } from "./components/ClientMaterialsZone.jsx";
import { FieldBox, Heading, NavBtn, PrimaryBtn, GreenBtn, SaveIndicator } from "./components/Buttons.jsx";
import { TA, TA_WHITE, SHARED_STYLES } from "./shared.jsx";

// ─── Конфіг кроків ───────────────────────────────────────────────────────────
const STAGE_LABELS = ["Дані", "Структура", "Джерела", "Написання", "Щоденник", "Готово"];
const STAGE_KEYS   = ["input", "plan", "sources", "writing", "diary", "done"];

const PRACTICE_TYPES = ["Навчальна", "Виробнича", "Переддипломна"];
const LANGUAGES = ["Українська", "Англійська", "Польська"];

const PRACTICE_CATEGORIES = [
  { key: "economy",    label: "Економіка / Менеджмент", icon: "📊" },
  { key: "pedagogy",   label: "Педагогічна",             icon: "📚" },
  { key: "psychology", label: "Психологічна",            icon: "🧠" },
  { key: "law",        label: "Юридична",                icon: "⚖️" },
  { key: "it",         label: "ІТ / Технічна",           icon: "💻" },
  { key: "medicine",   label: "Медична / Фарм.",         icon: "🏥" },
  { key: "other",      label: "Інший напрям",            icon: "📋" },
];

// ─── Render markdown tables ───────────────────────────────────────────────────
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
    if (seg.type === "text") return <span key={si} style={{ whiteSpace: "pre-wrap" }}>{seg.content}</span>;
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

// ─── Компонент пілюль ─────────────────────────────────────────────────────────
function StagePills({ stage, maxStageIdx, onNavigate }) {
  const cur = STAGE_KEYS.indexOf(stage);
  return (
    <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
      {STAGE_LABELS.map((l, i) => {
        const visited = i <= maxStageIdx;
        const clickable = i !== cur && visited && onNavigate;
        return (
          <div key={i}
            onClick={clickable ? () => onNavigate(STAGE_KEYS[i]) : undefined}
            style={{
              padding: "4px 12px", borderRadius: 20, fontSize: 11, letterSpacing: "1px",
              cursor: clickable ? "pointer" : "default",
              background: i === cur ? "#e8ff47" : visited ? "#1e2a00" : "transparent",
              color: i === cur ? "#111" : visited ? "#6a9000" : "#555",
              border: `1px solid ${i === cur ? "#e8ff47" : visited ? "#3a5000" : "#444"}`,
            }}>
            {visited && i !== cur ? "✓ " : ""}{l}
          </div>
        );
      })}
    </div>
  );
}

// ─── Головний компонент ───────────────────────────────────────────────────────
export default function PracticePage({ orderId, onOrderCreated, onBack }) {
  const { user } = useAuth();

  // Стадія
  const [stage, setStage] = useState("input");
  const [maxStageIdx, setMaxStageIdx] = useState(0);
  const maxStageIdxRef = useRef(0);

  // Форма
  const [practiceCategory, setPracticeCategory] = useState("economy");
  const [practiceText, setPracticeText] = useState("");
  const [pages, setPages] = useState("30");
  const [language, setLanguage] = useState("Українська");
  const [deadline, setDeadline] = useState("");

  // Методичка (PDF)
  const [fileLabel, setFileLabel] = useState("");
  const [fileB64, setFileB64] = useState(null);
  const [fileType, setFileType] = useState(null);
  const [methodInfo, setMethodInfo] = useState(null);

  // Матеріали клієнта
  const [clientMaterials, setClientMaterials] = useState([]);
  const [clientMaterialsText, setClientMaterialsText] = useState("");
  const [clientMaterialsSummary, setClientMaterialsSummary] = useState(null);

  // Структура (план)
  const [sections, setSections] = useState([]);

  // Контент секцій
  const [content, setContent] = useState({});
  const [genIdx, setGenIdx] = useState(0);

  // Щоденник
  const [diaryContent, setDiaryContent] = useState("");

  // Джерела
  const [citInputs, setCitInputs] = useState({});
  const [refList, setRefList] = useState("");
  const [refSecPapers, setRefSecPapers] = useState({});
  const [refSecPhrases, setRefSecPhrases] = useState({});
  const [refSecLoading, setRefSecLoading] = useState({});
  const [refSecSelected, setRefSecSelected] = useState({});
  const [refSecOpen, setRefSecOpen] = useState({});

  // UI стан
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const savedTimerRef = useRef(null);
  const [error, setError] = useState("");
  const [dbLoading, setDbLoading] = useState(false);
  const [regenId, setRegenId] = useState(null);
  const [regenPrompt, setRegenPrompt] = useState("");
  const [regenLoading, setRegenLoading] = useState(false);
  const [docxLoading, setDocxLoading] = useState(false);

  const currentIdRef = useRef(orderId || null);
  const tokenAccRef = useRef({ inTok: 0, outTok: 0, costUsd: 0 });

  // Збираємо токени
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

  // Info-об'єкт для промптів
  const getPracticeInfo = useCallback(() => ({
    practiceCategory, practiceText, pages, language, deadline,
    topic: "Звіт із практики",
    type: "Звіт із практики",
  }), [practiceCategory, practiceText, pages, language, deadline]);

  // ── Збереження в Firestore ──────────────────────────────────────────────────
  const saveToFirestore = useCallback(async (patch = {}) => {
    setSaving(true);
    try {
      const isNew = !currentIdRef.current;
      if (isNew) {
        const newRef = await addDoc(collection(db, "orders"), { createdAt: new Date().toISOString() });
        currentIdRef.current = newRef.id;
        onOrderCreated?.(newRef.id);
      }
      const ref = doc(db, "orders", currentIdRef.current);
      const info = getPracticeInfo();
      const base = {
        uid: user.uid,
        mode: "practice",
        type: "practice",
        topic: info.topic,
        pages: info.pages,
        deadline: info.deadline,
        language: info.language,
        updatedAt: new Date().toISOString(),
        totalInTok: tokenAccRef.current.inTok,
        totalOutTok: tokenAccRef.current.outTok,
        totalCostUsd: tokenAccRef.current.costUsd,
      };
      const data = serializeForFirestore({ ...base, ...patch });
      await setDoc(ref, data, { merge: true });
      setSaved(true);
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 3000);
    } catch (e) { console.error("Save error:", e); }
    setSaving(false);
  }, [user, getPracticeInfo, onOrderCreated]);

  // ── Завантаження існуючого замовлення ──────────────────────────────────────
  useEffect(() => {
    if (!orderId || !user) return;
    const load = async () => {
      setDbLoading(true);
      try {
        const snap = await getDoc(doc(db, "orders", orderId));
        if (snap.exists()) {
          const d = snap.data();
          currentIdRef.current = orderId;
          const i = d.info || {};
          if (i.practiceCategory) setPracticeCategory(i.practiceCategory);
          if (i.practiceText) setPracticeText(i.practiceText);
          if (i.pages) setPages(i.pages);
          if (i.language) setLanguage(i.language);
          if (i.deadline) setDeadline(i.deadline);
          if (d.fileLabel) setFileLabel(d.fileLabel);
          if (d.methodInfo) setMethodInfo(d.methodInfo);
          if (d.clientMaterialsSummary) setClientMaterialsSummary(d.clientMaterialsSummary);
          if (d.clientMaterialsText) setClientMaterialsText(d.clientMaterialsText);
          if (d.sections?.length) setSections(d.sections);
          if (d.content) setContent(d.content);
          if (d.diaryContent) setDiaryContent(d.diaryContent);
          if (d.citInputs) setCitInputs(d.citInputs);
          if (d.refList) setRefList(d.refList);
          if (d.refSecPapers) setRefSecPapers(d.refSecPapers);
          if (d.refSecPhrases) setRefSecPhrases(d.refSecPhrases);
          if (d.stage) {
            setStage(d.stage);
            const idx = STAGE_KEYS.indexOf(d.stage);
            const mi = Math.max(idx, d.maxStageIdx || 0);
            setMaxStageIdx(mi);
            maxStageIdxRef.current = mi;
          }
          if (d.genIdx != null) setGenIdx(d.genIdx);
        }
      } catch (e) { console.error(e); }
      setDbLoading(false);
    };
    load();
  }, [orderId, user]);

  const goToStage = (s) => {
    const idx = STAGE_KEYS.indexOf(s);
    setStage(s);
    if (idx > maxStageIdxRef.current) { maxStageIdxRef.current = idx; setMaxStageIdx(idx); }
  };

  // ── Крок 1: Аналіз PDF методички + матеріали ───────────────────────────────
  const doAnalyze = async () => {
    if (!practiceText.trim()) { setError("Введіть дані про практику"); return; }
    setError("");
    setRunning(true); runningRef.current = true;
    const info = getPracticeInfo();

    // Методичка
    let parsedMethodInfo = methodInfo;
    if (fileB64) {
      setLoadMsg("Читаю методичку...");
      await new Promise(r => setTimeout(r, 1500));
      const docPart = { type: "document", source: { type: "base64", media_type: fileType || "application/pdf", data: fileB64 } };
      try {
        setLoadMsg("Читаю методичку... крок 1/2");
        const structMsgs = [docPart, { type: "text", text: STRUCTURE_READING_PROMPT }];
        const structRaw = await callGemini([{ role: "user", content: structMsgs }], null, SYS_JSON_SHORT, 2000, null, "gemini-2.5-flash", true);
        const structMatch = structRaw.match(/\{[\s\S]*\}/);
        let structureInfo = null;
        try { structureInfo = structMatch ? JSON.parse(structMatch[0]) : null; } catch {}

        await new Promise(r => setTimeout(r, 1500));
        setLoadMsg("Читаю методичку... крок 2/2");
        const methodMsgs = [docPart, { type: "text", text: buildMethodologyReadingPrompt(structureInfo) }];
        const raw = await callGemini([{ role: "user", content: methodMsgs }], null, SYS_JSON_SHORT, 8000, (s) => setLoadMsg(`Читаю методичку... зачекайте ${s}с`), "gemini-2.5-flash", true);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        parsedMethodInfo = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
        if (structureInfo) {
          if (structureInfo.chaptersCount != null) parsedMethodInfo.chaptersCount = structureInfo.chaptersCount;
          if (structureInfo.totalPages != null) parsedMethodInfo.totalPages = structureInfo.totalPages;
        }
        setMethodInfo(parsedMethodInfo);
      } catch (e) {
        console.warn("methodInfo failed:", e.message);
      }
    }

    // Матеріали клієнта
    const combinedText = [
      ...clientMaterials.map(m => `=== ${m.name} ===\n${m.text}`),
      clientMaterialsText?.trim() || "",
    ].filter(Boolean).join("\n\n");

    let summary = null;
    if (combinedText.trim()) {
      summary = { rawText: combinedText };
      setClientMaterialsSummary(summary);
    }

    // Генерація плану
    setLoadMsg("Генерую структуру звіту...");
    try {
      const prompt = buildPracticePlanPrompt(info);
      const raw = await callClaude([{ role: "user", content: prompt }], null, "Respond only with valid JSON. No markdown.", 1500, null, MODEL_FAST);
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      if (parsed.sections?.length) setSections(parsed.sections);
      await saveToFirestore({
        info,
        fileLabel: fileLabel || null,
        methodInfo: parsedMethodInfo || null,
        clientMaterialsSummary: summary || null,
        clientMaterialsText: clientMaterialsText?.trim() || null,
        sections: parsed.sections,
        stage: "plan",
        status: "new",
      });
      goToStage("plan");
    } catch (e) {
      setError("Помилка генерації структури: " + e.message);
    }
    setRunning(false); runningRef.current = false; setLoadMsg("");
  };

  // ── Джерела: пошук для секції ───────────────────────────────────────────────
  const doSearchForSection = async (secId, secLabel) => {
    setRefSecLoading(prev => ({ ...prev, [secId]: true }));
    try {
      const info = getPracticeInfo();
      const topic = info.topic;
      const [allPhrases, ukKw] = await Promise.all([
        generateSearchPhrases(secLabel, topic, info.specialty, info.companyProfile),
        Promise.resolve(buildSemanticKeywords(secLabel, topic, info.specialty, info.companyProfile)),
      ]);
      const ukPhrases = allPhrases.length ? allPhrases.slice(0, 4) : ukKw.slice(0, 4);
      const enPhrases = allPhrases.slice(4, 8);
      const displayPhrases = allPhrases.length ? allPhrases : ukKw.slice(0, 6);
      const mainSecs = sections.filter(s => s.id !== "sources");
      const needed = Math.ceil(15 / Math.max(mainSecs.length, 1)) + 4;
      const { flat } = await searchSourcesForSection(ukKw, enPhrases, needed, secLabel, topic, 1, [], [], ukPhrases);
      const papers = (flat || []).slice(0, 15);
      setRefSecPapers(prev => { const next = { ...prev, [secId]: papers }; saveToFirestore({ refSecPapers: next }); return next; });
      setRefSecPhrases(prev => { const next = { ...prev, [secId]: displayPhrases }; saveToFirestore({ refSecPhrases: next }); return next; });
      setRefSecOpen(prev => ({ ...prev, [secId]: true }));
      setRefSecSelected(prev => ({ ...prev, [secId]: [] }));
    } catch (e) { setError(e.message); }
    setRefSecLoading(prev => ({ ...prev, [secId]: false }));
  };

  // ── Джерела: додати вибрані до секції ──────────────────────────────────────
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

  // ── Джерела: форматувати список ─────────────────────────────────────────────
  const doFormatSources = async () => {
    const allRaw = sections
      .filter(s => s.id !== "sources")
      .flatMap(s => (citInputs[s.id] || "").split("\n").map(l => l.trim()).filter(Boolean));
    const unique = [...new Set(allRaw)];
    if (!unique.length) return;
    setRunning(true); setLoadMsg("Форматую список літератури...");
    try {
      const methodStyle = methodInfo?.sourcesStyle || "ДСТУ";
      const isApa = methodStyle.toUpperCase().includes("APA");
      const today = new Date();
      const accessDate = `${String(today.getDate()).padStart(2, "0")}.${String(today.getMonth() + 1).padStart(2, "0")}.${today.getFullYear()}`;
      const refLines = unique.map((r, i) => `${i + 1}. ${r}`).join("\n");

      const fmtPrompt = isApa
        ? `СТИЛЬ: APA 7th edition. ${refLines}`
        : `СТИЛЬ: ДСТУ 8302:2015.\n- Ініціали ЗАВЖДИ після прізвища.\n- Назви журналів в *зірочках*.\n- Зберігай URL.\n- Sentence case для ВЕЛИКИХ назв.\nДата звернення: ${accessDate}.\n${refLines}`;

      const sysPrompt = isApa
        ? "Ти — асистент з бібліографічного форматування APA 7th edition. Повертай тільки відформатований список."
        : "Ти — асистент з бібліографічного форматування ДСТУ 8302:2015. Повертай тільки відформатований список.";

      const fmtResult = await callGemini([{ role: "user", content: fmtPrompt }], null, sysPrompt, 4000);
      const formatted = fmtResult.split("\n").filter(Boolean).map(l => l.replace(/^\d+\.\s*/, ""));
      const list = formatted.length === unique.length ? formatted : unique;
      const formattedText = list.map((c, i) => `${i + 1}. ${c}`).join("\n");
      setRefList(formattedText);
      await saveToFirestore({ citInputs, refList: formattedText });
    } catch (e) { setError(e.message); }
    setRunning(false); setLoadMsg("");
  };

  // ── Написання: генерація всіх секцій ───────────────────────────────────────
  const doWrite = async (startIdx = 0) => {
    const writableSecs = sections.filter(s => s.id !== "sources");
    if (!writableSecs.length) return;
    setRunning(true); runningRef.current = true;
    const lang = language;
    const info = getPracticeInfo();

    let idx = startIdx;
    while (idx < writableSecs.length && runningRef.current) {
      const sec = writableSecs[idx];
      setGenIdx(idx);
      setLoadMsg(`Генерую: ${sec.label}...`);
      const instruction = buildPracticeWritingPrompt(sec, info, methodInfo, clientMaterialsSummary, citInputs);
      try {
        const maxTok = Math.min(30000, Math.max(6000, Math.round(sec.pages * 1800)));
        const text = await callClaude(
          [{ role: "user", content: instruction }],
          null,
          buildSYS(lang, methodInfo),
          maxTok,
        );
        setContent(prev => {
          const next = { ...prev, [sec.id]: text };
          saveToFirestore({ content: next, genIdx: idx + 1 });
          return next;
        });
      } catch (e) {
        setError(e.message);
        break;
      }
      idx++;
    }

    if (idx >= writableSecs.length && runningRef.current) {
      playDoneSound();
      await saveToFirestore({ status: "writing", genIdx: idx });
    }
    setRunning(false); runningRef.current = false; setLoadMsg("");
  };

  // ── Написання: перегенерація однієї секції ──────────────────────────────────
  const doRegenSection = async (secId) => {
    const sec = sections.find(s => s.id === secId);
    if (!sec) return;
    setRegenLoading(true);
    const info = getPracticeInfo();
    let instruction = buildPracticeWritingPrompt(sec, info, methodInfo, clientMaterialsSummary, citInputs);
    if (regenPrompt.trim()) instruction += `\n\nДОДАТКОВІ ВИМОГИ: ${regenPrompt.trim()}`;
    try {
      const maxTok = Math.min(30000, Math.max(6000, Math.round(sec.pages * 1800)));
      const text = await callClaude([{ role: "user", content: instruction }], null, buildSYS(language, methodInfo), maxTok);
      setContent(prev => {
        const next = { ...prev, [secId]: text };
        saveToFirestore({ content: next });
        return next;
      });
      setRegenId(null); setRegenPrompt("");
    } catch (e) { setError(e.message); }
    setRegenLoading(false);
  };

  // ── Щоденник ────────────────────────────────────────────────────────────────
  const doGenerateDiary = async () => {
    setRunning(true); runningRef.current = true; setLoadMsg("Генерую щоденник практики...");
    const info = getPracticeInfo();
    try {
      const prompt = buildPracticeDiaryPrompt(info);
      const text = await callClaude([{ role: "user", content: prompt }], null, buildSYS(language, methodInfo), 8000);
      setDiaryContent(text);
      await saveToFirestore({ diaryContent: text, stage: "diary", status: "writing" });
      goToStage("diary");
      playDoneSound();
    } catch (e) { setError(e.message); }
    setRunning(false); runningRef.current = false; setLoadMsg("");
  };

  // ── Експорт у .docx ──────────────────────────────────────────────────────────
  const doExportDocx = async () => {
    setDocxLoading(true);
    try {
      const info = getPracticeInfo();
      const displayOrder = [
        ...sections.filter(s => s.id !== "sources"),
        ...(diaryContent ? [{ id: "diary", label: "ЩОДЕННИК ПРАКТИКИ", pages: 0 }] : []),
        ...(refList ? [{ id: "sources", label: "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", pages: 0 }] : []),
      ];
      const fullContent = {
        ...content,
        ...(diaryContent ? { diary: diaryContent } : {}),
        ...(refList ? { sources: refList } : {}),
      };
      await exportToDocx({
        content: fullContent,
        info: {
          topic: info.topic,
          type: info.type,
          language: info.language,
          pages: info.pages,
        },
        displayOrder,
        methodInfo,
        orderId: currentIdRef.current,
      });
    } catch (e) { setError(e.message); }
    setDocxLoading(false);
  };

  // ── Копіювати текст ───────────────────────────────────────────────────────────
  const doCopyAll = () => {
    const writableSecs = sections.filter(s => s.id !== "sources");
    const parts = writableSecs.map(s => `${s.label}\n\n${content[s.id] || ""}`);
    if (diaryContent) parts.push(`ЩОДЕННИК ПРАКТИКИ\n\n${diaryContent}`);
    if (refList) parts.push(`СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ\n\n${refList}`);
    navigator.clipboard.writeText(parts.join("\n\n---\n\n"));
  };

  // ─── РЕНДЕР: шапка ──────────────────────────────────────────────────────────
  const renderHeader = () => (
    <div style={{ background: "#1a1a14", color: "#f5f2eb", padding: "14px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} style={{ background: "transparent", border: "none", color: "#888", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>←</button>
        <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 14, letterSpacing: 3, color: "#e8ff47" }}>ПРАКТИКА</div>
        <SaveIndicator saving={saving} saved={saved} />
      </div>
      <StagePills stage={stage} maxStageIdx={maxStageIdx} onNavigate={running ? null : (s) => setStage(s)} />
    </div>
  );

  // ─── РЕНДЕР: крок 1 — Дані ───────────────────────────────────────────────────
  const renderInput = () => (
    <div className="fade">
      <Heading>Дані практики</Heading>

      <FieldBox label="Напрям практики">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
          {PRACTICE_CATEGORIES.map(c => (
            <button key={c.key} onClick={() => setPracticeCategory(c.key)}
              style={{
                padding: "8px 12px", borderRadius: 8, fontSize: 12, cursor: "pointer", textAlign: "left",
                background: practiceCategory === c.key ? "#1a1a14" : "#f0ece2",
                color: practiceCategory === c.key ? "#e8ff47" : "#333",
                border: `1.5px solid ${practiceCategory === c.key ? "#1a1a14" : "#d4cfc4"}`,
                display: "flex", alignItems: "center", gap: 6,
              }}>
              <span>{c.icon}</span><span>{c.label}</span>
            </button>
          ))}
        </div>
      </FieldBox>

      <FieldBox label="Дані практики" tooltip="Вставте будь-який текст — бланк завдання, опис підприємства, вимоги викладача. AI сам витягне всю потрібну інформацію.">
        <textarea
          value={practiceText}
          onChange={e => setPracticeText(e.target.value)}
          placeholder={`Вставте або введіть дані про практику — бланк завдання, опис підприємства, вимоги тощо.

Наприклад:
Місце практики: ТОВ «Назва», м. Київ
Строки: 01.06.2025 – 28.06.2025
Студент: Іваненко І. І., 3 курс, група ФБС-31
Спеціальність: 072 Фінанси
Керівник від підприємства: Петренко П. П., директор
Керівник від університету: Сидоренко С. С., доцент
Індивідуальне завдання: ...`}
          style={{ ...TA_WHITE, minHeight: 200 }}
        />
      </FieldBox>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 20px" }}>
        <FieldBox label="К-сть сторінок">
          <input value={pages} onChange={e => setPages(e.target.value)} placeholder="30" style={inputStyle} />
        </FieldBox>
        <FieldBox label="Мова">
          <select value={language} onChange={e => setLanguage(e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
            {LANGUAGES.map(l => <option key={l}>{l}</option>)}
          </select>
        </FieldBox>
        <FieldBox label="Дедлайн">
          <input value={deadline} onChange={e => setDeadline(e.target.value)} placeholder="дд.мм.рррр" style={inputStyle} />
        </FieldBox>
      </div>

      <FieldBox label="Методичка (PDF)" tooltip="Завантажте методичні вказівки — програма врахує всі вимоги до оформлення та структури">
        <DropZone fileLabel={fileLabel} onFile={(name, b64, type) => { setFileLabel(name); setFileB64(b64); setFileType(type); }} />
      </FieldBox>

      <FieldBox label="Матеріали клієнта" tooltip="Завантажте звіти, таблиці, описи — вони будуть використані при написанні">
        <ClientMaterialsZone
          materials={clientMaterials}
          onAdd={m => setClientMaterials(prev => [...prev, m])}
          onRemove={i => setClientMaterials(prev => prev.filter((_, idx) => idx !== i))}
          manualText={clientMaterialsText}
          onManualText={setClientMaterialsText}
        />
      </FieldBox>

      {error && <div style={{ color: "#c55", fontSize: 13, marginBottom: 12 }}>{error}</div>}

      <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
        <NavBtn onClick={onBack}>← Назад</NavBtn>
        <PrimaryBtn
          onClick={doAnalyze}
          disabled={running}
          loading={running}
          msg={loadMsg || "Аналізую..."}
          label="Далі →"
        />
      </div>
    </div>
  );

  // ─── РЕНДЕР: крок 2 — Структура ─────────────────────────────────────────────
  const renderPlan = () => {
    const writableSecs = sections.filter(s => s.id !== "sources");
    const totalP = writableSecs.reduce((a, s) => a + (parseInt(s.pages) || 0), 0);

    const updateSec = (id, field, val) => {
      setSections(prev => {
        const next = prev.map(s => s.id === id ? { ...s, [field]: field === "pages" ? parseInt(val) || 0 : val } : s);
        saveToFirestore({ sections: next });
        return next;
      });
    };
    const addSec = () => {
      const newSec = { id: `ch${Date.now()}`, label: "Новий розділ", pages: 5 };
      setSections(prev => {
        const insertBefore = prev.findIndex(s => s.id === "conclusions");
        const next = insertBefore >= 0
          ? [...prev.slice(0, insertBefore), newSec, ...prev.slice(insertBefore)]
          : [...prev, newSec];
        saveToFirestore({ sections: next });
        return next;
      });
    };
    const delSec = (id) => {
      if (["intro", "conclusions", "sources"].includes(id)) return;
      setSections(prev => { const next = prev.filter(s => s.id !== id); saveToFirestore({ sections: next }); return next; });
    };

    return (
      <div className="fade">
        <Heading>Структура звіту</Heading>
        <div style={{ background: "#fff", borderRadius: 10, overflow: "hidden", boxShadow: "0 2px 8px rgba(0,0,0,0.06)", marginBottom: 20 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f0ece2" }}>
                <th style={thStyle}>#</th>
                <th style={{ ...thStyle, textAlign: "left" }}>Назва розділу</th>
                <th style={thStyle}>Стор.</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {sections.map((s, i) => (
                <tr key={s.id} style={{ borderBottom: "1px solid #f0ece2" }}>
                  <td style={{ ...tdStyle, color: "#aaa", textAlign: "center" }}>{i + 1}</td>
                  <td style={tdStyle}>
                    <input value={s.label} onChange={e => updateSec(s.id, "label", e.target.value)}
                      style={{ width: "100%", border: "none", background: "transparent", fontSize: 13, fontFamily: "'Spectral',serif", color: "#1a1a14", outline: "none" }} />
                  </td>
                  <td style={{ ...tdStyle, textAlign: "center" }}>
                    {s.id === "sources" ? "—" : (
                      <input type="number" value={s.pages} min={0} max={99} onChange={e => updateSec(s.id, "pages", e.target.value)}
                        style={{ width: 50, border: "1px solid #e0ddd4", borderRadius: 4, textAlign: "center", padding: "3px 4px", fontSize: 13, fontFamily: "'Spectral',serif" }} />
                    )}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "center" }}>
                    {!["intro", "conclusions", "sources"].includes(s.id) && (
                      <button onClick={() => delSec(s.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#ccc", fontSize: 16 }}
                        onMouseEnter={e => e.currentTarget.style.color = "#c55"}
                        onMouseLeave={e => e.currentTarget.style.color = "#ccc"}>✕</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <button onClick={addSec} style={{ background: "transparent", border: "1.5px dashed #aaa", color: "#888", borderRadius: 7, padding: "7px 16px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
            + Додати розділ
          </button>
          <div style={{ fontSize: 12, color: "#888" }}>Разом: {totalP} стор. (без джерел)</div>
        </div>

        {error && <div style={{ color: "#c55", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <div style={{ display: "flex", gap: 12 }}>
          <NavBtn onClick={() => setStage("input")}>← Назад</NavBtn>
          <PrimaryBtn
            onClick={() => { saveToFirestore({ sections, stage: "sources", status: "new" }); goToStage("sources"); }}
            disabled={running}
            label="Далі → Джерела"
          />
        </div>
      </div>
    );
  };

  // ─── РЕНДЕР: крок 3 — Джерела ───────────────────────────────────────────────
  const renderSources = () => {
    const mainSecs = sections.filter(s => s.id !== "sources");

    return (
      <div className="fade">
        <Heading>Джерела</Heading>
        <p style={{ fontSize: 13, color: "#888", marginBottom: 20 }}>
          Введіть джерела для кожного розділу або знайдіть їх автоматично. Після введення — сформуйте список літератури.
        </p>

        {mainSecs.map(sec => (
          <div key={sec.id} style={{ marginBottom: 24, background: "#fff", borderRadius: 10, padding: "16px 18px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#1a1a14" }}>{sec.label}</div>
              <button
                onClick={() => doSearchForSection(sec.id, sec.label)}
                disabled={refSecLoading[sec.id]}
                style={{ background: "#e8f0ff", border: "1.5px solid #4a9ade44", color: "#1a5a8a", borderRadius: 6, padding: "5px 12px", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
                {refSecLoading[sec.id] ? <><SpinDot /> Шукаю...</> : "Ключові слова"}
              </button>
            </div>

            {refSecPhrases[sec.id]?.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 10, color: "#aaa", marginBottom: 4 }}>Пошукові фрази (Google Scholar):</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {refSecPhrases[sec.id].map((ph, i) => (
                    <span key={i} style={{ background: "#f0e8ff", color: "#5a1a8a", borderRadius: 4, padding: "2px 8px", fontSize: 11 }}>{ph}</span>
                  ))}
                </div>
              </div>
            )}

            {refSecOpen[sec.id] && refSecPapers[sec.id]?.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: "#aaa", marginBottom: 6 }}>Знайдені публікації:</div>
                {refSecPapers[sec.id].map(p => (
                  <div key={p.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 5 }}>
                    <input type="checkbox"
                      checked={(refSecSelected[sec.id] || []).includes(p.id)}
                      onChange={e => setRefSecSelected(prev => ({
                        ...prev,
                        [sec.id]: e.target.checked
                          ? [...(prev[sec.id] || []), p.id]
                          : (prev[sec.id] || []).filter(id => id !== p.id),
                      }))}
                      style={{ marginTop: 2 }} />
                    <div style={{ fontSize: 12, lineHeight: 1.5 }}>
                      <span style={{ fontWeight: 600 }}>{p.authors?.[0] || ""}</span> {p.year ? `(${p.year}) ` : ""}
                      {p.title} {p.venue ? `— ${p.venue}` : ""}
                    </div>
                  </div>
                ))}
                {(refSecSelected[sec.id] || []).length > 0 && (
                  <button onClick={() => doAddForSection(sec.id)} disabled={running}
                    style={{ marginTop: 6, background: "#2a3a1a", color: "#a8d060", border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
                    {running ? "..." : `Додати вибрані (${(refSecSelected[sec.id] || []).length})`}
                  </button>
                )}
              </div>
            )}

            <textarea
              value={citInputs[sec.id] || ""}
              onChange={e => setCitInputs(prev => { const next = { ...prev, [sec.id]: e.target.value }; saveToFirestore({ citInputs: next }); return next; })}
              placeholder="Введіть джерела — кожне з нового рядка"
              style={{ ...TA_WHITE, minHeight: 80, width: "100%" }}
            />
          </div>
        ))}

        {error && <div style={{ color: "#c55", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 20 }}>
          <GreenBtn
            onClick={doFormatSources}
            disabled={running}
            loading={running}
            msg={loadMsg || "Форматую..."}
            label="Сформувати список літератури"
          />
        </div>

        {refList && (
          <div style={{ background: "#fff", borderRadius: 10, padding: "16px 18px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)", marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#1a1a14", marginBottom: 8 }}>Список використаних джерел:</div>
            <div style={{ fontSize: 12, whiteSpace: "pre-wrap", color: "#333", lineHeight: 1.7 }}>{refList}</div>
          </div>
        )}

        <div style={{ display: "flex", gap: 12 }}>
          <NavBtn onClick={() => setStage("plan")}>← Назад</NavBtn>
          <PrimaryBtn
            onClick={() => {
              saveToFirestore({ citInputs, refList, stage: "writing", status: "plan_approved" });
              goToStage("writing");
              doWrite(0);
            }}
            disabled={running}
            loading={running}
            msg={loadMsg || "Генерую..."}
            label="Далі → Генерувати текст"
          />
        </div>
      </div>
    );
  };

  // ─── РЕНДЕР: крок 4 — Написання ─────────────────────────────────────────────
  const renderWriting = () => {
    const writableSecs = sections.filter(s => s.id !== "sources");
    const doneCount = writableSecs.filter(s => content[s.id]).length;
    const progress = writableSecs.length ? Math.round(doneCount / writableSecs.length * 100) : 0;
    const allDone = doneCount === writableSecs.length;

    return (
      <div className="fade">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
          <Heading style={{ marginBottom: 0 }}>Написання</Heading>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {running ? (
              <button onClick={() => { runningRef.current = false; setRunning(false); setLoadMsg(""); }}
                style={{ background: "#c55", color: "#fff", border: "none", borderRadius: 6, padding: "7px 16px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                Зупинити
              </button>
            ) : !allDone ? (
              <GreenBtn onClick={() => doWrite(genIdx)} disabled={running} label="Продовжити генерацію →" />
            ) : null}
          </div>
        </div>

        {/* Прогрес-бар */}
        <div style={{ background: "#e0ddd4", borderRadius: 6, height: 8, marginBottom: 20, overflow: "hidden" }}>
          <div style={{ height: "100%", background: "#8ac040", borderRadius: 6, width: `${progress}%`, transition: "width 0.5s" }} />
        </div>
        {running && loadMsg && (
          <div style={{ fontSize: 12, color: "#888", marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}><SpinDot />{loadMsg}</div>
        )}
        {error && <div style={{ color: "#c55", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        {writableSecs.map((sec, idx) => {
          const secContent = content[sec.id];
          const isGenerating = running && genIdx === idx;
          const isRegen = regenId === sec.id;
          return (
            <div key={sec.id} style={{ marginBottom: 20, background: "#fff", borderRadius: 10, padding: "16px 18px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#1a1a14" }}>{sec.label}</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {secContent && (
                    <>
                      <button onClick={() => navigator.clipboard.writeText(secContent)}
                        style={{ background: "#f0ece2", border: "none", borderRadius: 5, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>
                        Копіювати
                      </button>
                      <button onClick={() => setRegenId(isRegen ? null : sec.id)}
                        style={{ background: "#e8f0ff", border: "1.5px solid #4a9ade44", color: "#1a5a8a", borderRadius: 5, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>
                        Перегенерувати
                      </button>
                    </>
                  )}
                  {isGenerating && <span style={{ fontSize: 11, color: "#888", display: "flex", alignItems: "center", gap: 5 }}><SpinDot />Генерую...</span>}
                </div>
              </div>

              {isRegen && (
                <div style={{ marginBottom: 10 }}>
                  <textarea value={regenPrompt} onChange={e => setRegenPrompt(e.target.value)}
                    placeholder="Додаткові вимоги (необов'язково)..."
                    style={{ ...TA_WHITE, minHeight: 50, width: "100%", marginBottom: 6 }} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <GreenBtn onClick={() => doRegenSection(sec.id)} disabled={regenLoading} loading={regenLoading} msg="Генерую..." label="Перегенерувати" />
                    <NavBtn onClick={() => { setRegenId(null); setRegenPrompt(""); }}>Скасувати</NavBtn>
                  </div>
                </div>
              )}

              {secContent ? (
                <textarea value={secContent}
                  onChange={e => setContent(prev => { const next = { ...prev, [sec.id]: e.target.value }; saveToFirestore({ content: next }); return next; })}
                  style={{ ...TA_WHITE, minHeight: 200, width: "100%" }} />
              ) : (
                <div style={{ fontSize: 12, color: "#aaa", padding: "20px 0", textAlign: "center" }}>
                  {isGenerating ? "Генерується..." : "Ще не згенеровано"}
                </div>
              )}
            </div>
          );
        })}

        {allDone && (
          <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
            <NavBtn onClick={() => setStage("sources")}>← Назад</NavBtn>
            <PrimaryBtn
              onClick={() => {
                saveToFirestore({ content, stage: "diary", status: "writing" });
                goToStage("diary");
              }}
              label="Далі → Щоденник"
            />
          </div>
        )}
      </div>
    );
  };

  // ─── РЕНДЕР: крок 5 — Щоденник ──────────────────────────────────────────────
  const renderDiary = () => (
    <div className="fade">
      <Heading>Щоденник практики</Heading>
      <p style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>
        Щоденник автоматично формується по робочих днях у межах вказаних строків практики.
      </p>

      {error && <div style={{ color: "#c55", fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {running && loadMsg && (
        <div style={{ fontSize: 12, color: "#888", marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}><SpinDot />{loadMsg}</div>
      )}

      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <GreenBtn onClick={doGenerateDiary} disabled={running} loading={running} msg="Генерую..." label="Згенерувати щоденник" />
        {diaryContent && (
          <button onClick={() => navigator.clipboard.writeText(diaryContent)}
            style={{ background: "#f0ece2", border: "1.5px solid #d4cfc4", color: "#555", borderRadius: 7, padding: "9px 16px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
            Копіювати
          </button>
        )}
      </div>

      {diaryContent && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ background: "#fff", borderRadius: 10, padding: "14px 16px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)", marginBottom: 10, fontSize: 13, lineHeight: 1.7 }}>
            {renderWithTables(diaryContent)}
          </div>
          <FieldBox label="Редагувати щоденник">
            <textarea value={diaryContent}
              onChange={e => { setDiaryContent(e.target.value); saveToFirestore({ diaryContent: e.target.value }); }}
              style={{ ...TA_WHITE, minHeight: 300, width: "100%", fontSize: 12 }} />
          </FieldBox>
        </div>
      )}

      <div style={{ display: "flex", gap: 12 }}>
        <NavBtn onClick={() => setStage("writing")}>← Назад</NavBtn>
        <PrimaryBtn
          onClick={() => { saveToFirestore({ diaryContent, stage: "done", status: "done" }); goToStage("done"); }}
          disabled={!diaryContent}
          label="Далі → Готово"
        />
      </div>
    </div>
  );

  // ─── РЕНДЕР: крок 6 — Готово ─────────────────────────────────────────────────
  const renderDone = () => {
    const writableSecs = sections.filter(s => s.id !== "sources");
    return (
      <div className="fade">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
          <Heading style={{ marginBottom: 0 }}>Готово</Heading>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={doCopyAll}
              style={{ background: "#f0ece2", border: "1.5px solid #d4cfc4", color: "#555", borderRadius: 7, padding: "9px 16px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
              Копіювати текст
            </button>
            <GreenBtn onClick={doExportDocx} disabled={docxLoading} loading={docxLoading} msg="Завантажую..." label="Завантажити .docx" />
          </div>
        </div>

        {error && <div style={{ color: "#c55", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        {writableSecs.map(sec => (
          <div key={sec.id} style={{ marginBottom: 16, background: "#fff", borderRadius: 10, padding: "16px 18px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>{sec.label}</div>
            <textarea
              value={content[sec.id] || ""}
              onChange={e => setContent(prev => { const next = { ...prev, [sec.id]: e.target.value }; saveToFirestore({ content: next }); return next; })}
              style={{ ...TA_WHITE, minHeight: 160, width: "100%" }}
            />
          </div>
        ))}

        {diaryContent && (
          <div style={{ marginBottom: 16, background: "#fff", borderRadius: 10, padding: "16px 18px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>Щоденник практики</div>
            <div style={{ fontSize: 13, lineHeight: 1.7 }}>{renderWithTables(diaryContent)}</div>
          </div>
        )}

        {refList && (
          <div style={{ marginBottom: 16, background: "#fff", borderRadius: 10, padding: "16px 18px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>Список використаних джерел</div>
            <div style={{ fontSize: 12, whiteSpace: "pre-wrap", lineHeight: 1.7 }}>{refList}</div>
          </div>
        )}
      </div>
    );
  };

  // ─── Спільні стилі ────────────────────────────────────────────────────────────
  const inputStyle = {
    width: "100%", padding: "9px 12px", border: "1.5px solid #d4cfc4", borderRadius: 6,
    fontSize: 13, fontFamily: "'Spectral',Georgia,serif", background: "#fff", color: "#1a1a14", outline: "none",
  };
  const thStyle = { padding: "10px 12px", fontSize: 11, color: "#888", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" };
  const tdStyle = { padding: "10px 12px", fontSize: 13, verticalAlign: "middle" };

  // ─── Головний рендер ─────────────────────────────────────────────────────────
  if (dbLoading) {
    return (
      <div style={{ minHeight: "100vh", background: "#f5f2eb", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <SpinDot />
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f5f2eb", fontFamily: "'Spectral',Georgia,serif" }}>
      <style>{`${SHARED_STYLES} @import url('https://fonts.googleapis.com/css2?family=Spectral:wght@400;600&family=Spectral+SC:wght@600&display=swap');*{box-sizing:border-box;margin:0;padding:0}.fade{animation:fd .25s ease}`}</style>
      {renderHeader()}
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px clamp(16px,3vw,40px)" }}>
        {stage === "input"   && renderInput()}
        {stage === "plan"    && renderPlan()}
        {stage === "sources" && renderSources()}
        {stage === "writing" && renderWriting()}
        {stage === "diary"   && renderDiary()}
        {stage === "done"    && renderDone()}
      </div>
    </div>
  );
}
