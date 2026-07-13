import { useState, useRef, useEffect, useCallback, Fragment } from "react";
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
  buildTemplateAnalysisPrompt, buildPracticeDetailsPrompt,
} from "./lib/prompts.js";
import { parseTemplate } from "./lib/planUtils.js";
import { detectSpecialty } from "./lib/academicDefaults.js";
import {
  CATEGORY_LABELS, PRACTICE_TYPES, getPracticeGuidance, detectPracticeType,
  parsePracticeDetails, buildPracticeTitlePageLines,
} from "./lib/practiceDefaults.js";
import { serializeForFirestore } from "./lib/firestoreUtils.js";
import { playDoneSound } from "./lib/audio.js";
import {
  generateSearchPhrases, buildSemanticKeywords,
  searchSourcesForSection, lookupDoiMetadata, lookupDOIByBiblio, paperToCitation,
  filterSourcesWithGemini,
} from "./lib/sourcesSearch.js";
import { exportToDocx, exportPracticePlanToDocx } from "./lib/exportDocx.js";
import { remapAndFormatCitations, applyCitationRemap } from "./lib/citationFormatting.js";
import { SpinDot } from "./components/SpinDot.jsx";
import { DropZone } from "./components/DropZone.jsx";
import { ClientMaterialsZone } from "./components/ClientMaterialsZone.jsx";
import { ExampleFileZone } from "./components/ExampleFileZone.jsx";
import { FieldBox, Heading, NavBtn, PrimaryBtn, GreenBtn, SaveIndicator } from "./components/Buttons.jsx";
import { TA, TA_WHITE, SHARED_STYLES } from "./shared.jsx";

// ─── Конфіг кроків ───────────────────────────────────────────────────────────
const STAGE_LABELS = ["Дані", "Перевірка", "Структура", "Джерела", "Написання", "Щоденник", "Готово"];
const STAGE_KEYS   = ["input", "parsed", "plan", "sources", "writing", "diary", "done"];

const LANGUAGES = ["Українська", "Англійська", "Польська"];

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

// ─── Текстове представлення структури (для копіювання) ───────────────────────
const PLAN_FIXED_IDS = ["intro", "conclusions", "sources"];
function buildPracticePlanText(sections) {
  const lines = [];
  sections.forEach((s, i) => {
    const isSub = !PLAN_FIXED_IDS.includes(s.id) && /^\d+\.\d+/.test(String(s.id));
    if (!isSub && i > 0) lines.push("");
    lines.push(isSub ? `    ${s.label}` : s.label);
  });
  return lines.join("\n");
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
  const [practiceCategory, setPracticeCategory] = useState("other");
  const [practiceType, setPracticeType] = useState("vyrobnycha");
  const categoryManualRef = useRef(false);
  const typeManualRef = useRef(false);
  const [practiceText, setPracticeText] = useState("");
  const [pages, setPages] = useState("30");
  const [language, setLanguage] = useState("Українська");

  // Дані з аналізу шаблону замовлення
  const [orderNumber, setOrderNumber] = useState("");
  const [orderType, setOrderType] = useState("");
  const [topic, setTopic] = useState("");
  const [deadline, setDeadline] = useState("");
  const [direction, setDirection] = useState("");
  const [subject, setSubject] = useState("");
  const [uniqueness, setUniqueness] = useState("");
  const [course, setCourse] = useState("");
  const [extras, setExtras] = useState("");

  // Деталі практики (місце, керівники, дати, індивідуальне завдання)
  const [companyName, setCompanyName] = useState("");
  const [supervisorCompany, setSupervisorCompany] = useState("");
  const [supervisorUniversity, setSupervisorUniversity] = useState("");
  const [individualTask, setIndividualTask] = useState("");
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");
  const [sourceCountExplicit, setSourceCountExplicit] = useState(null);

  // Дані для титульної сторінки
  const [studentName, setStudentName] = useState("");
  const [studentGroup, setStudentGroup] = useState("");
  const [university, setUniversity] = useState("");
  const [faculty, setFaculty] = useState("");
  const [city, setCity] = useState("");

  // Методичка (PDF)
  const [fileLabel, setFileLabel] = useState("");
  const [fileB64, setFileB64] = useState(null);
  const [fileType, setFileType] = useState(null);
  const [methodInfo, setMethodInfo] = useState(null);

  // Зразки-приклади (docx/pdf → текст витягується одразу при завантаженні)
  const [structureExampleName, setStructureExampleName] = useState("");
  const [structureExampleText, setStructureExampleText] = useState("");
  const [diaryExampleName, setDiaryExampleName] = useState("");
  const [diaryExampleText, setDiaryExampleText] = useState("");

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
  const [citStructured, setCitStructured] = useState({});
  const [citStyle, setCitStyle] = useState("ДСТУ 8302:2015");
  const [sourcesOrder, setSourcesOrder] = useState("alphabetical");
  const [refList, setRefList] = useState("");
  const [refSecPapers, setRefSecPapers] = useState({});
  const [refSecPhrases, setRefSecPhrases] = useState({});
  const [refSecLoading, setRefSecLoading] = useState({});
  const [refSecSelected, setRefSecSelected] = useState({});
  const [refSecOpen, setRefSecOpen] = useState({});
  const [searchingAll, setSearchingAll] = useState(false);

  // UI стан
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const savedTimerRef = useRef(null);
  const [error, setError] = useState("");
  const [dbLoading, setDbLoading] = useState(false);
  const [regenId, setRegenId] = useState(null);
  const [regenPrompt, setRegenPrompt] = useState("");
  const [regenLoading, setRegenLoading] = useState(false);
  const [docxLoading, setDocxLoading] = useState(false);
  const [planDocxLoading, setPlanDocxLoading] = useState(false);
  const [planCopied, setPlanCopied] = useState(false);
  const [diaryDocxLoading, setDiaryDocxLoading] = useState(false);
  const [namingId, setNamingId] = useState(null);
  const [namingAllLoading, setNamingAllLoading] = useState(false);

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
    practiceCategory, practiceType, practiceText, pages, language,
    topic: topic || "Звіт із практики",
    type: "Звіт із практики",
    orderNumber, orderType, deadline, direction, subject, uniqueness, course, extras,
    companyName, supervisorCompany, supervisorUniversity, individualTask, dateStart, dateEnd,
    sourceCountExplicit,
    studentName, studentGroup, university, faculty, city,
    practiceGuidance: getPracticeGuidance(practiceCategory, practiceType),
  }), [
    practiceCategory, practiceType, practiceText, pages, language, topic,
    orderNumber, orderType, deadline, direction, subject, uniqueness, course, extras,
    companyName, supervisorCompany, supervisorUniversity, individualTask, dateStart, dateEnd,
    sourceCountExplicit, studentName, studentGroup, university, faculty, city,
  ]);

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
      setSaveError("");
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      console.error("Save error:", e);
      const isSizeError = /maximum size|exceeds|too large|1048576|longer than/i.test(e.message || "");
      setSaveError(isSizeError
        ? "запис завеликий — видаліть частину матеріалів клієнта"
        : "помилка збереження");
    }
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
          if (i.practiceCategory) {
            const cat = CATEGORY_LABELS[i.practiceCategory]
              ? i.practiceCategory
              : (detectSpecialty(`${i.direction || ""} ${i.subject || ""} ${i.practiceText || ""}`) || "other");
            setPracticeCategory(cat);
          }
          if (i.practiceType) setPracticeType(i.practiceType);
          if (i.practiceText) setPracticeText(i.practiceText);
          if (i.pages) setPages(i.pages);
          if (i.language) setLanguage(i.language);
          if (i.topic) setTopic(i.topic);
          if (i.orderNumber) setOrderNumber(i.orderNumber);
          if (i.orderType) setOrderType(i.orderType);
          if (i.deadline) setDeadline(i.deadline);
          if (i.direction) setDirection(i.direction);
          if (i.subject) setSubject(i.subject);
          if (i.uniqueness) setUniqueness(i.uniqueness);
          if (i.course) setCourse(i.course);
          if (i.extras) setExtras(i.extras);
          if (i.companyName) setCompanyName(i.companyName);
          if (i.supervisorCompany) setSupervisorCompany(i.supervisorCompany);
          if (i.supervisorUniversity) setSupervisorUniversity(i.supervisorUniversity);
          if (i.individualTask) setIndividualTask(i.individualTask);
          if (i.dateStart) setDateStart(i.dateStart);
          if (i.dateEnd) setDateEnd(i.dateEnd);
          if (i.sourceCountExplicit) setSourceCountExplicit(i.sourceCountExplicit);
          if (i.studentName) setStudentName(i.studentName);
          if (i.studentGroup) setStudentGroup(i.studentGroup);
          if (i.university) setUniversity(i.university);
          if (i.faculty) setFaculty(i.faculty);
          if (i.city) setCity(i.city);
          if (d.fileLabel) setFileLabel(d.fileLabel);
          if (d.methodInfo) setMethodInfo(d.methodInfo);
          if (d.structureExampleName) setStructureExampleName(d.structureExampleName);
          if (d.structureExampleText) setStructureExampleText(d.structureExampleText);
          if (d.diaryExampleName) setDiaryExampleName(d.diaryExampleName);
          if (d.diaryExampleText) setDiaryExampleText(d.diaryExampleText);
          if (d.clientMaterialsSummary) setClientMaterialsSummary(d.clientMaterialsSummary);
          if (d.clientMaterialsText) setClientMaterialsText(d.clientMaterialsText);
          if (d.sections?.length) setSections(d.sections);
          if (d.content) setContent(d.content);
          if (d.diaryContent) setDiaryContent(d.diaryContent);
          if (d.citInputs) setCitInputs(d.citInputs);
          if (d.citStructured) setCitStructured(d.citStructured);
          if (d.citStyle) setCitStyle(d.citStyle);
          if (d.sourcesOrder) setSourcesOrder(d.sourcesOrder);
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
        const methodMsgs = [docPart, { type: "text", text: buildMethodologyReadingPrompt(structureInfo, true) }];
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

    // Аналіз шаблону замовлення: regex-парсинг як база + LLM для гнучкості (шаблон може змінюватись)
    setLoadMsg("Аналізую шаблон замовлення...");
    let tpl = parseTemplate(practiceText);
    try {
      const tplRaw = await callClaude([{ role: "user", content: buildTemplateAnalysisPrompt(practiceText, combinedText) }], null, SYS_JSON, 1000, null, MODEL_FAST);
      const tplParsed = JSON.parse(tplRaw.match(/\{[\s\S]*\}/)?.[0] || "{}");
      tpl = { ...tpl, ...Object.fromEntries(Object.entries(tplParsed).filter(([, v]) => v != null && v !== "")) };
    } catch (e) {
      console.warn("template analysis fallback to regex:", e.message);
    }

    if (tpl.pages) { setPages(String(tpl.pages)); info.pages = String(tpl.pages); }
    if (tpl.language) { setLanguage(tpl.language); info.language = tpl.language; }
    if (tpl.topic) { setTopic(tpl.topic); info.topic = tpl.topic; }
    if (tpl.orderNumber) { setOrderNumber(tpl.orderNumber); info.orderNumber = tpl.orderNumber; }
    if (tpl.type) { setOrderType(tpl.type); info.orderType = tpl.type; }
    if (tpl.deadline) { setDeadline(tpl.deadline); info.deadline = tpl.deadline; }
    if (tpl.direction) { setDirection(tpl.direction); info.direction = tpl.direction; }
    if (tpl.subject) { setSubject(tpl.subject); info.subject = tpl.subject; }
    if (tpl.uniqueness) { setUniqueness(tpl.uniqueness); info.uniqueness = tpl.uniqueness; }
    if (tpl.course) { setCourse(String(tpl.course)); info.course = String(tpl.course); }
    if (tpl.extras) { setExtras(tpl.extras); info.extras = tpl.extras; }

    // Напрям практики: автовизначення з напряму/тематики/тексту (+ матеріали клієнта), якщо не обрано вручну
    if (!categoryManualRef.current) {
      const detected = detectSpecialty(`${tpl.direction || ""} ${tpl.subject || ""} ${practiceText} ${combinedText}`);
      if (detected && CATEGORY_LABELS[detected]) { setPracticeCategory(detected); info.practiceCategory = detected; }
    }
    // Вид практики: автопідказка з курсу/типу, якщо користувач не обрав вручну
    if (!typeManualRef.current) {
      const suggestedType = detectPracticeType(tpl.course, tpl.type);
      if (suggestedType) { setPracticeType(suggestedType); info.practiceType = suggestedType; }
    }
    info.practiceGuidance = getPracticeGuidance(info.practiceCategory, info.practiceType);

    // Деталі практики: місце, керівники, дати, індивідуальне завдання (regex-фолбек + LLM)
    setLoadMsg("Витягую деталі практики...");
    let details = parsePracticeDetails(`${practiceText}\n${combinedText}`);
    try {
      const detRaw = await callClaude([{ role: "user", content: buildPracticeDetailsPrompt(practiceText, combinedText) }], null, SYS_JSON, 500, null, MODEL_FAST);
      const detParsed = JSON.parse(detRaw.match(/\{[\s\S]*\}/)?.[0] || "{}");
      details = { ...details, ...Object.fromEntries(Object.entries(detParsed).filter(([, v]) => v != null && v !== "")) };
    } catch (e) {
      console.warn("practice details fallback to regex:", e.message);
    }
    // Методичка часто містить розклад/базу практики, спільну для всієї групи (не вигадка,
    // а реальні дані курсу) — використовуємо як фолбек лише для полів, які з тексту/матеріалів
    // клієнта витягнути не вдалось.
    if (parsedMethodInfo) {
      const methodFallback = {
        companyName: parsedMethodInfo.practiceCompanyName,
        supervisorCompany: parsedMethodInfo.practiceSupervisorCompany,
        supervisorUniversity: parsedMethodInfo.practiceSupervisorUniversity,
        dateStart: parsedMethodInfo.practiceDateStart,
        dateEnd: parsedMethodInfo.practiceDateEnd,
        university: parsedMethodInfo.practiceUniversity,
        faculty: parsedMethodInfo.practiceFaculty,
        city: parsedMethodInfo.practiceCity,
      };
      Object.entries(methodFallback).forEach(([k, v]) => { if (!details[k] && v) details[k] = v; });
    }
    if (!companyName && details.companyName) { setCompanyName(details.companyName); info.companyName = details.companyName; }
    if (!supervisorCompany && details.supervisorCompany) { setSupervisorCompany(details.supervisorCompany); info.supervisorCompany = details.supervisorCompany; }
    if (!supervisorUniversity && details.supervisorUniversity) { setSupervisorUniversity(details.supervisorUniversity); info.supervisorUniversity = details.supervisorUniversity; }
    if (!individualTask && details.individualTask) { setIndividualTask(details.individualTask); info.individualTask = details.individualTask; }
    if (!dateStart && details.dateStart) { setDateStart(details.dateStart); info.dateStart = details.dateStart; }
    if (!dateEnd && details.dateEnd) { setDateEnd(details.dateEnd); info.dateEnd = details.dateEnd; }
    if (!sourceCountExplicit && details.sourceCount) {
      const nums = String(details.sourceCount).match(/\d+/g);
      if (nums) {
        const avg = Math.round(nums.reduce((a, b) => a + parseInt(b), 0) / nums.length);
        setSourceCountExplicit(avg);
        info.sourceCountExplicit = avg;
      }
    }
    if (!studentName && details.studentName) { setStudentName(details.studentName); info.studentName = details.studentName; }
    if (!studentGroup && details.studentGroup) { setStudentGroup(details.studentGroup); info.studentGroup = details.studentGroup; }
    if (!university && details.university) { setUniversity(details.university); info.university = details.university; }
    if (!faculty && details.faculty) { setFaculty(details.faculty); info.faculty = details.faculty; }
    if (!city && details.city) { setCity(details.city); info.city = details.city; }

    await saveToFirestore({
      info,
      fileLabel: fileLabel || null,
      methodInfo: parsedMethodInfo || null,
      clientMaterialsSummary: summary || null,
      clientMaterialsText: clientMaterialsText?.trim() || null,
      stage: "parsed",
      status: "new",
    });
    goToStage("parsed");
    setRunning(false); runningRef.current = false; setLoadMsg("");
  };

  // ── Крок 2: Перевірка → генерація структури звіту ──────────────────────────
  const doGenPlan = async () => {
    setRunning(true); runningRef.current = true; setLoadMsg("Генерую структуру звіту...");
    const info = getPracticeInfo();
    try {
      const prompt = buildPracticePlanPrompt(info, methodInfo, structureExampleText);
      const raw = await callClaude([{ role: "user", content: prompt }], null, "Respond only with valid JSON. No markdown.", 1500, null, MODEL_FAST);
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      if (parsed.sections?.length) setSections(parsed.sections);
      await saveToFirestore({ info, sections: parsed.sections, stage: "plan", status: "new" });
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
      const mainSecs = sections.filter(s => !["sources", "intro", "conclusions"].includes(s.id));
      const sourceTarget = calcSourceTarget(mainSecs);
      const sourceDist = calcSourceDist(mainSecs, sourceTarget);
      const needed = sourceDist[secId] || Math.ceil(15 / Math.max(mainSecs.length, 1)) + 4;
      const { flat } = await searchSourcesForSection(ukKw, enPhrases, needed, secLabel, topic, 1, [], [], ukPhrases);
      const candidates = (flat || []).slice(0, 15);
      const filtered = await filterSourcesWithGemini(candidates, secLabel, topic, 15);
      // Ліміт 30% іноземних джерел (як у великих роботах)
      const maxForeign = Math.max(1, Math.round(needed * 0.3));
      const ukPapers = filtered.filter(p => p.lang === "uk");
      const foreignPapers = filtered.filter(p => p.lang !== "uk").slice(0, maxForeign);
      const papers = [...ukPapers, ...foreignPapers];
      setRefSecPapers(prev => { const next = { ...prev, [secId]: papers }; saveToFirestore({ refSecPapers: next }); return next; });
      setRefSecPhrases(prev => { const next = { ...prev, [secId]: displayPhrases }; saveToFirestore({ refSecPhrases: next }); return next; });
      setRefSecOpen(prev => ({ ...prev, [secId]: true }));
      setRefSecSelected(prev => ({ ...prev, [secId]: [] }));
    } catch (e) { setError(e.message); }
    setRefSecLoading(prev => ({ ...prev, [secId]: false }));
  };

  // ── Джерела: пошук одразу для всіх розділів ─────────────────────────────────
  const doSearchAllSections = async () => {
    setSearchingAll(true);
    const mainSecs = sections.filter(s => s.id !== "sources");
    for (const sec of mainSecs) {
      await doSearchForSection(sec.id, sec.label);
    }
    setSearchingAll(false);
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
      setCitStructured(prev => {
        const next = { ...prev, [secId]: [...(prev[secId] || []), ...enriched] };
        saveToFirestore({ citStructured: next });
        return next;
      });
      setRefSecSelected(prev => ({ ...prev, [secId]: [] }));
    } catch (e) { setError(e.message); }
    setRunning(false); setLoadMsg("");
  };

  // ── Джерела: форматувати список ─────────────────────────────────────────────
  // Нормалізація рядка джерела для дедуплікації (як у великих роботах)
  const normalizeRef = (s) => s.toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/дата звернення[^)]*\)?/gi, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();

  // Цільова к-сть джерел: явно вказана клієнтом, інакше — з обсягу звіту (як calcSourceDist у великих роботах)
  const calcSourceTarget = (mainSecs) => {
    if (sourceCountExplicit) return sourceCountExplicit;
    return Math.max(mainSecs.length * 2, parseInt(pages) || mainSecs.length * 3);
  };
  // Розподіл цільової к-сті по розділах пропорційно їхньому обсягу в сторінках
  const calcSourceDist = (mainSecs, total) => {
    const pagesSum = mainSecs.reduce((a, s) => a + (parseInt(s.pages) || 0), 0) || 1;
    const minPerSec = Math.max(1, Math.floor(total / Math.max(mainSecs.length, 1) / 2));
    const dist = {}; let assigned = 0;
    mainSecs.forEach((s, i) => {
      if (i === mainSecs.length - 1) { dist[s.id] = Math.max(minPerSec, total - assigned); }
      else { const share = Math.max(minPerSec, Math.round((parseInt(s.pages) || 0) / pagesSum * total)); dist[s.id] = share; assigned += share; }
    });
    return dist;
  };

  const doFinalizeSources = async (contentOverride) => {
    const baseContent = contentOverride || content;
    const mainSecs = sections.filter(s => s.id !== "sources");
    setRunning(true); setLoadMsg("Формую список літератури...");
    try {
      // 1. Дедуплікація по всіх розділах → глобальний список (порядок першої появи) + мапа локальний→сирий номер
      const secLocalToRaw = {};
      const rawRefs = [];
      const seen = new Map();
      mainSecs.forEach(sec => {
        const lines = (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
        secLocalToRaw[sec.id] = {};
        lines.forEach((line, i) => {
          const localN = i + 1;
          const key = normalizeRef(line);
          let rawIdx = seen.get(key);
          if (rawIdx == null) {
            rawIdx = rawRefs.length;
            rawRefs.push(line);
            seen.set(key, rawIdx);
          }
          secLocalToRaw[sec.id][localN] = rawIdx + 1;
        });
      });

      if (!rawRefs.length) { setRunning(false); setLoadMsg(""); return; }

      const flatStructured = mainSecs.flatMap(sec => citStructured[sec.id] || []);
      const info = getPracticeInfo();

      // 2. Сортування + форматування стилю (спільна функція, як у великих роботах)
      const { refList: fmtList, oldToNew, refCiteText, pageRanges } = await remapAndFormatCitations({
        citations: rawRefs,
        citStructured: flatStructured,
        citStyle,
        language: info.language,
        sourcesOrder,
        citFootnotes: false,
        callClaude,
      });

      // 3. Переписати [N] (і [N, с. X]) у тексті кожного розділу на нові глобальні номери —
      // через спільну applyCitationRemap, яка ще й підставляє сторінки з pageRanges.
      const nextContent = { ...baseContent };
      mainSecs.forEach(sec => {
        const text = nextContent[sec.id] || "";
        if (!text) return;
        const localMap = secLocalToRaw[sec.id] || {};
        const sectionOldToNew = {};
        Object.entries(localMap).forEach(([localN, rawIdx]) => { sectionOldToNew[localN] = oldToNew[rawIdx]; });
        nextContent[sec.id] = applyCitationRemap(text, sectionOldToNew, refCiteText, { pageRanges });
      });

      const formattedText = fmtList.map((c, i) => `${i + 1}. ${c}`).join("\n");
      setContent(nextContent);
      setRefList(formattedText);
      await saveToFirestore({ content: nextContent, citInputs, citStructured, citStyle, sourcesOrder, refList: formattedText });
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
    let finalContent = { ...content };

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
        finalContent = { ...finalContent, [sec.id]: text };
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
      // Передаємо свіжий вміст явно — content-стейт міг ще не встигнути оновитись
      // у замиканні цього виклику doWrite (React стейт оновлюється асинхронно).
      await doFinalizeSources(finalContent);
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
      const prompt = buildPracticeDiaryPrompt(info, diaryExampleText);
      const text = await callClaude([{ role: "user", content: prompt }], null, buildSYS(language, methodInfo), 8000);
      setDiaryContent(text);
      await saveToFirestore({ diaryContent: text, stage: "diary", status: "writing" });
      goToStage("diary");
      playDoneSound();
    } catch (e) { setError(e.message); }
    setRunning(false); runningRef.current = false; setLoadMsg("");
  };

  // ── Експорт звіту у .docx (без щоденника) ────────────────────────────────────
  const doExportMain = async () => {
    setDocxLoading(true);
    try {
      const info = getPracticeInfo();
      const displayOrder = [
        ...sections.filter(s => s.id !== "sources"),
        ...(refList ? [{ id: "sources", label: "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", pages: 0 }] : []),
      ];
      const exportContent = {
        ...content,
        ...(refList ? { sources: refList } : {}),
      };
      // Титульна сторінка: пріоритет — зразок із методички, інакше складаємо з витягнутих даних практики
      const titlePageLines = methodInfo?.titlePageTemplate?.length
        ? methodInfo.titlePageTemplate
        : buildPracticeTitlePageLines(info);
      await exportToDocx({
        content: exportContent,
        info: { topic: info.topic, type: info.type, language: info.language, pages: info.pages },
        displayOrder,
        titlePage: null,
        titlePageLines,
        methodInfo,
        orderId: currentIdRef.current,
      });
    } catch (e) { setError(e.message); }
    setDocxLoading(false);
  };

  // ── Експорт щоденника у окремий .docx ────────────────────────────────────────
  const doExportDiary = async () => {
    if (!diaryContent) return;
    setDiaryDocxLoading(true);
    try {
      const info = getPracticeInfo();
      await exportToDocx({
        content: { diary: diaryContent },
        info: { topic: "Щоденник практики", type: "Щоденник", language: info.language, pages: "5" },
        displayOrder: [{ id: "diary", label: "ЩОДЕННИК ПРАКТИКИ", pages: 0 }],
        methodInfo,
        orderId: currentIdRef.current ? `${currentIdRef.current}_diary` : null,
      });
    } catch (e) { setError(e.message); }
    setDiaryDocxLoading(false);
  };

  // ── Копіювати текст ───────────────────────────────────────────────────────────
  const doCopyAll = () => {
    const writableSecs = sections.filter(s => s.id !== "sources");
    const parts = writableSecs.map(s => `${s.label}\n\n${content[s.id] || ""}`);
    if (diaryContent) parts.push(`ЩОДЕННИК ПРАКТИКИ\n\n${diaryContent}`);
    if (refList) parts.push(`СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ\n\n${refList}`);
    navigator.clipboard.writeText(parts.join("\n\n---\n\n"));
  };

  // ── Переміщення секцій ────────────────────────────────────────────────────────
  const FIXED = ["intro", "conclusions", "sources"];
  const movableFilter = s => !FIXED.includes(s.id);

  const moveSectionUp = (id) => {
    setSections(prev => {
      const movable = prev.filter(movableFilter);
      const idx = movable.findIndex(s => s.id === id);
      if (idx <= 0) return prev;
      const fullIdx = prev.findIndex(s => s.id === id);
      const prevMovIdx = prev.findIndex(s => s.id === movable[idx - 1].id);
      const next = [...prev];
      [next[prevMovIdx], next[fullIdx]] = [next[fullIdx], next[prevMovIdx]];
      saveToFirestore({ sections: next });
      return next;
    });
  };

  const moveSectionDown = (id) => {
    setSections(prev => {
      const movable = prev.filter(movableFilter);
      const idx = movable.findIndex(s => s.id === id);
      if (idx >= movable.length - 1) return prev;
      const fullIdx = prev.findIndex(s => s.id === id);
      const nextMovIdx = prev.findIndex(s => s.id === movable[idx + 1].id);
      const next = [...prev];
      [next[fullIdx], next[nextMovIdx]] = [next[nextMovIdx], next[fullIdx]];
      saveToFirestore({ sections: next });
      return next;
    });
  };

  const recalcPages = () => {
    const target = parseInt(pages) || 30;
    setSections(prev => {
      const movable = prev.filter(movableFilter);
      const fixed = prev.filter(s => ["intro", "conclusions"].includes(s.id));
      const fixedP = fixed.reduce((a, s) => a + (s.pages || 0), 0);
      const mainP = target - fixedP;
      const perSec = Math.max(2, Math.round(mainP / Math.max(movable.length, 1)));
      const next = prev.map(s => movableFilter(s) ? { ...s, pages: perSec } : s);
      saveToFirestore({ sections: next });
      return next;
    });
  };

  const doNameSingle = async (id) => {
    const sec = sections.find(s => s.id === id);
    if (!sec) return;
    setNamingId(id);
    try {
      const prompt = `Придумай конкретну назву розділу звіту з практики замість заглушки.
Контекст практики: ${practiceText.slice(0, 500)}
Заглушка: "${sec.label}"
Інші розділи: ${sections.filter(s => !FIXED.includes(s.id) && s.id !== id).map(s => s.label).join("; ")}
Поверни ТІЛЬКИ нову назву розділу (без лапок, без пояснень).`;
      const name = (await callClaude([{ role: "user", content: prompt }], null, null, 200, null, MODEL_FAST)).trim();
      setSections(prev => {
        const next = prev.map(s => s.id === id ? { ...s, label: name } : s);
        saveToFirestore({ sections: next });
        return next;
      });
    } catch (e) { console.warn(e); }
    setNamingId(null);
  };

  const doNameAllPlaceholders = async () => {
    const placeholders = sections.filter(s => !FIXED.includes(s.id) && /\[|новий/i.test(s.label));
    if (!placeholders.length) return;
    setNamingAllLoading(true);
    try {
      const list = placeholders.map(s => `"${s.id}": "${s.label}"`).join(", ");
      const others = sections.filter(s => !FIXED.includes(s.id) && !/\[|новий/i.test(s.label)).map(s => s.label).join("; ");
      const prompt = `Придумай конкретні назви розділів звіту з практики замість заглушок.
Контекст практики: ${practiceText.slice(0, 500)}
Інші розділи вже мають назви: ${others}
Заглушки: ${list}
Поверни ТІЛЬКИ JSON: {"id":"нова назва",...}`;
      const raw = await callClaude([{ role: "user", content: prompt }], null, null, 500, null, MODEL_FAST);
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");
      setSections(prev => {
        const next = prev.map(s => parsed[s.id] ? { ...s, label: parsed[s.id] } : s);
        saveToFirestore({ sections: next });
        return next;
      });
    } catch (e) { console.warn(e); }
    setNamingAllLoading(false);
  };

  // ─── РЕНДЕР: шапка ──────────────────────────────────────────────────────────
  const renderHeader = () => (
    <div style={{ background: "#1a1a14", color: "#f5f2eb", padding: "14px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} style={{ background: "transparent", border: "none", color: "#888", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>←</button>
        <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 14, letterSpacing: 3, color: "#e8ff47" }}>ПРАКТИКА</div>
        <SaveIndicator saving={saving} saved={saved} error={saveError} />
      </div>
      <StagePills stage={stage} maxStageIdx={maxStageIdx} onNavigate={running ? null : (s) => setStage(s)} />
      <button
        onClick={() => { maxStageIdxRef.current = STAGE_KEYS.length - 1; setMaxStageIdx(STAGE_KEYS.length - 1); }}
        style={{ background: "transparent", border: "1px solid #555", color: "#888", fontSize: 10, letterSpacing: 1, padding: "4px 10px", borderRadius: 20, cursor: "pointer" }}>
        🔓 Розблокувати всі кроки
      </button>
    </div>
  );

  // ─── РЕНДЕР: крок 1 — Дані ───────────────────────────────────────────────────
  const renderInput = () => (
    <div className="fade">
      <Heading>Дані практики</Heading>

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

      <FieldBox label="Місце практики та керівники" tooltip="Підтягнеться автоматично з тексту вище після натискання «Далі», якщо там є ці дані. Можна заповнити вручну заздалегідь.">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
          <input value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Місце практики (підприємство/установа)" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
          <input value={supervisorCompany} onChange={e => setSupervisorCompany(e.target.value)} placeholder="Керівник від підприємства" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
          <input value={supervisorUniversity} onChange={e => setSupervisorUniversity(e.target.value)} placeholder="Керівник від університету" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
        </div>
      </FieldBox>

      <FieldBox label="Дати практики" tooltip="Потрібні для щоденника — без них дати доведеться вигадувати. Підтягнуться автоматично, якщо є в тексті.">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8 }}>
          <input value={dateStart} onChange={e => setDateStart(e.target.value)} placeholder="Дата початку (дд.мм.рррр)" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
          <input value={dateEnd} onChange={e => setDateEnd(e.target.value)} placeholder="Дата закінчення (дд.мм.рррр)" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
        </div>
      </FieldBox>

      <FieldBox label="Дані для титульної сторінки" tooltip="Підтягнеться автоматично з тексту вище або з методички (якщо там є зразок титулки). Можна заповнити вручну.">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
          <input value={studentName} onChange={e => setStudentName(e.target.value)} placeholder="ПІБ студента" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
          <input value={studentGroup} onChange={e => setStudentGroup(e.target.value)} placeholder="Група" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
          <input value={university} onChange={e => setUniversity(e.target.value)} placeholder="Назва університету" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
          <input value={faculty} onChange={e => setFaculty(e.target.value)} placeholder="Факультет / кафедра" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
          <input value={city} onChange={e => setCity(e.target.value)} placeholder="Місто" style={{ ...TA_WHITE, minHeight: "auto", padding: "9px 10px", fontSize: 13 }} />
        </div>
      </FieldBox>

      <FieldBox label="Індивідуальне завдання" tooltip="Персональне завдання від керівника, окреме від загальної програми практики. Якщо прийшло файлом/сканом — завантажте його нижче в «Матеріали клієнта» замість цього поля.">
        <textarea
          value={individualTask}
          onChange={e => setIndividualTask(e.target.value)}
          placeholder="Текст індивідуального завдання, якщо воно є окремим текстом..."
          style={{ ...TA_WHITE, minHeight: 70 }}
        />
      </FieldBox>

      <FieldBox label="Вид практики" tooltip="Підказується автоматично з курсу після натискання «Далі», але можна обрати вручну заздалегідь або виправити після аналізу.">
        <div style={{ display: "flex", gap: 8 }}>
          {PRACTICE_TYPES.map(t => (
            <button key={t.key} type="button"
              onClick={() => { typeManualRef.current = true; setPracticeType(t.key); }}
              style={{
                padding: "8px 14px", borderRadius: 8, fontSize: 12, cursor: "pointer",
                background: practiceType === t.key ? "#1a1a14" : "#f0ece2",
                color: practiceType === t.key ? "#e8ff47" : "#333",
                border: `1.5px solid ${practiceType === t.key ? "#1a1a14" : "#d4cfc4"}`,
              }}>
              {t.label}
            </button>
          ))}
        </div>
      </FieldBox>

      <FieldBox label="Методичка (PDF)" tooltip="Завантажте методичні вказівки — програма врахує всі вимоги до оформлення та структури">
        <DropZone fileLabel={fileLabel} onFile={(name, b64, type) => { setFileLabel(name); setFileB64(b64); setFileType(type); }} />
      </FieldBox>

      <FieldBox label="Зразок структури звіту (необов'язково)" tooltip="Приклад готового звіту — план розділів згенерується за його реальною структурою. Приймається .docx та .pdf; якщо файл .doc — спершу збережіть його як .pdf.">
        <ExampleFileZone
          fileName={structureExampleName}
          hint="Перетягніть або клікніть — .docx, .pdf (.doc спершу збережіть як .pdf)"
          onExtracted={(name, text) => {
            setStructureExampleName(name); setStructureExampleText(text);
            saveToFirestore({ structureExampleName: name, structureExampleText: text });
          }}
        />
      </FieldBox>

      <FieldBox label="Приклад щоденника практики (необов'язково)" tooltip="Зразок заповненого щоденника — згенерований щоденник повторить його формат і рівень деталізації. Приймається .docx та .pdf; якщо файл .doc — спершу збережіть його як .pdf.">
        <ExampleFileZone
          fileName={diaryExampleName}
          hint="Перетягніть або клікніть — .docx, .pdf (.doc спершу збережіть як .pdf)"
          onExtracted={(name, text) => {
            setDiaryExampleName(name); setDiaryExampleText(text);
            saveToFirestore({ diaryExampleName: name, diaryExampleText: text });
          }}
        />
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

  // ─── РЕНДЕР: крок 1.5 — Перевірка ────────────────────────────────────────────
  const renderParsed = () => {
    const courseMissing = !String(course || "").trim();
    const recommendedMissing = [
      !(dateStart && dateEnd) && "дати практики",
      !companyName && "місце практики",
      !individualTask && "індивідуальне завдання",
      !studentName && "ПІБ студента (для титульної)",
      !university && "університет (для титульної)",
    ].filter(Boolean);
    const hasExtras = !!extras?.trim();

    const row = (label, value, onChange, opts = {}) => (
      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", borderBottom: "1px solid #e4dfd4" }}>
        <div style={{ padding: "10px 14px", fontSize: 11, letterSpacing: "1px", textTransform: "uppercase", color: "#888", background: "#f0ece2", display: "flex", alignItems: "center" }}>{label}</div>
        <div style={{ padding: "6px 10px", display: "flex", alignItems: "center" }}>
          {opts.readOnly
            ? <span style={{ fontSize: 13, color: "#1a1a14" }}>{value || "—"}</span>
            : opts.textarea
            ? <textarea value={value} onChange={onChange} style={{ ...TA_WHITE, minHeight: 60, border: "none", background: "transparent", padding: "4px 0", width: "100%" }} />
            : <input value={value} onChange={onChange} style={{ border: "none", background: "transparent", fontSize: 13, fontFamily: "'Spectral',serif", padding: "4px 0", width: "100%", outline: "none" }} />}
        </div>
      </div>
    );

    return (
      <div className="fade">
        <Heading>Перевірка даних</Heading>
        <p style={{ fontSize: 13, color: "#888", marginBottom: 14 }}>Клікніть на значення, щоб змінити. Перевірте дані перед генерацією структури звіту.</p>

        <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
          {row("Номер замовлення", orderNumber, e => setOrderNumber(e.target.value))}
          {row("Тип", orderType, e => setOrderType(e.target.value))}
          <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", borderBottom: "1px solid #e4dfd4" }}>
            <div style={{ padding: "10px 14px", fontSize: 11, letterSpacing: "1px", textTransform: "uppercase", color: "#888", background: "#f0ece2", display: "flex", alignItems: "center" }}>Напрям практики</div>
            <div style={{ padding: "6px 10px", display: "flex", alignItems: "center" }}>
              <select value={practiceCategory} onChange={e => { categoryManualRef.current = true; setPracticeCategory(e.target.value); }}
                style={{ border: "none", background: "transparent", fontSize: 13, fontFamily: "'Spectral',serif", padding: "4px 0", width: "100%", outline: "none" }}>
                {Object.entries(CATEGORY_LABELS).map(([key, c]) => (
                  <option key={key} value={key}>{c.icon} {c.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", borderBottom: "1px solid #e4dfd4" }}>
            <div style={{ padding: "10px 14px", fontSize: 11, letterSpacing: "1px", textTransform: "uppercase", color: "#888", background: "#f0ece2", display: "flex", alignItems: "center" }}>Вид практики</div>
            <div style={{ padding: "6px 10px", display: "flex", gap: 6, alignItems: "center" }}>
              {PRACTICE_TYPES.map(t => (
                <button key={t.key} type="button"
                  onClick={() => { typeManualRef.current = true; setPracticeType(t.key); }}
                  style={{
                    padding: "5px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer",
                    background: practiceType === t.key ? "#1a1a14" : "#f0ece2",
                    color: practiceType === t.key ? "#e8ff47" : "#333",
                    border: `1px solid ${practiceType === t.key ? "#1a1a14" : "#d4cfc4"}`,
                  }}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          {row("Курс", course, e => setCourse(e.target.value))}
          {row("Тема", topic, e => setTopic(e.target.value))}
          {row("Тематика / предмет", subject, e => setSubject(e.target.value))}
          {row("Галузь / напрям", direction, e => setDirection(e.target.value))}
          {row("К-сть сторінок", pages, e => setPages(e.target.value))}
          {row("Мова роботи", language, e => setLanguage(e.target.value))}
          {row("Дедлайн", deadline, e => setDeadline(e.target.value))}
          {row("Унікальність", uniqueness, e => setUniqueness(e.target.value))}
          {row("Додаткові матеріали", extras, e => setExtras(e.target.value))}
          {row("Місце практики", companyName, e => setCompanyName(e.target.value))}
          {row("Керівник від підприємства", supervisorCompany, e => setSupervisorCompany(e.target.value))}
          {row("Керівник від університету", supervisorUniversity, e => setSupervisorUniversity(e.target.value))}
          {row("Дата початку", dateStart, e => setDateStart(e.target.value))}
          {row("Дата закінчення", dateEnd, e => setDateEnd(e.target.value))}
          {row("Індивідуальне завдання", individualTask, e => setIndividualTask(e.target.value), { textarea: true })}
          {row("ПІБ студента", studentName, e => setStudentName(e.target.value))}
          {row("Група", studentGroup, e => setStudentGroup(e.target.value))}
          {row("Університет", university, e => setUniversity(e.target.value))}
          {row("Факультет / кафедра", faculty, e => setFaculty(e.target.value))}
          {row("Місто", city, e => setCity(e.target.value))}
          {row("Методичка", fileLabel || (methodInfo ? "прочитано" : "не завантажено"), null, { readOnly: true })}
        </div>

        {courseMissing && <div style={{ fontSize: 12, color: "#8a1a1a", marginBottom: 6 }}>⚠ Вкажіть курс, щоб продовжити</div>}
        {recommendedMissing.length > 0 && (
          <div style={{ fontSize: 12, color: "#8a6a1a", marginBottom: 6 }}>⚠ Рекомендується заповнити: {recommendedMissing.join(", ")}</div>
        )}
        {hasExtras && (
          <div style={{ fontSize: 12, color: "#8a6a1a", marginBottom: 6 }}>⚠ Презентація/доповідь та подібні додаткові матеріали виконуються окремо в «Малих роботах» — практика їх не генерує</div>
        )}

        {error && <div style={{ color: "#c55", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
          <NavBtn onClick={() => goToStage("input")}>← Назад</NavBtn>
          <PrimaryBtn
            onClick={doGenPlan}
            disabled={running || courseMissing}
            loading={running}
            msg={loadMsg || "Генерую..."}
            label="Генерувати структуру →"
          />
        </div>
      </div>
    );
  };

  // ─── РЕНДЕР: крок 2 — Структура ─────────────────────────────────────────────
  const renderPlan = () => {
    const targetPages = parseInt(pages) || 30;
    const totalP = sections.reduce((a, s) => s.id !== "sources" ? a + (parseInt(s.pages) || 0) : a, 0);
    const pagesOk = totalP === targetPages;
    const movable = sections.filter(s => !FIXED.includes(s.id));
    const hasPlaceholders = sections.some(s => !FIXED.includes(s.id) && /\[|новий/i.test(s.label));

    const updateSec = (id, field, val) => setSections(prev => {
      const next = prev.map(s => s.id === id ? { ...s, [field]: field === "pages" ? parseInt(val) || 0 : val } : s);
      saveToFirestore({ sections: next });
      return next;
    });

    const addChapter = () => {
      const chNums = sections.filter(s => !FIXED.includes(s.id)).map(s => parseInt(s.id.replace(/\D/g, "")) || 0);
      const newNum = (Math.max(0, ...chNums) + 1);
      const newSec = { id: `ch${newNum}`, label: `[Новий розділ ${newNum}]`, pages: Math.max(3, Math.round(targetPages * 0.12)) };
      setSections(prev => {
        const idx = prev.findIndex(s => s.id === "conclusions");
        const next = idx >= 0 ? [...prev.slice(0, idx), newSec, ...prev.slice(idx)] : [...prev, newSec];
        saveToFirestore({ sections: next });
        return next;
      });
    };

    const addSubsection = () => {
      const lastMovable = movable[movable.length - 1];
      const parentLabel = lastMovable?.label?.replace(/^\[|\]$/g, "") || "розділу";
      const subId = `sub${Date.now()}`;
      const newSec = { id: subId, label: `[Підрозділ до: ${parentLabel.slice(0, 30)}]`, pages: Math.max(2, Math.round(targetPages * 0.07)) };
      setSections(prev => {
        const idx = prev.findIndex(s => s.id === "conclusions");
        const next = idx >= 0 ? [...prev.slice(0, idx), newSec, ...prev.slice(idx)] : [...prev, newSec];
        saveToFirestore({ sections: next });
        return next;
      });
    };

    const delSec = (id) => {
      if (FIXED.includes(id)) return;
      setSections(prev => { const next = prev.filter(s => s.id !== id); saveToFirestore({ sections: next }); return next; });
    };

    const COL = "36px 1fr 68px 68px 72px 36px";

    return (
      <div className="fade">
        <Heading>Структура звіту</Heading>
        <p style={{ fontSize: 13, color: "#888", marginBottom: 14 }}>Відредагуйте назви та кількість сторінок. Затвердіть структуру перед переходом до джерел.</p>

        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button
            onClick={() => {
              navigator.clipboard.writeText(buildPracticePlanText(sections));
              setPlanCopied(true);
              setTimeout(() => setPlanCopied(false), 2000);
            }}
            style={{ background: "transparent", border: "1.5px solid #c4bfb4", color: "#666", borderRadius: 6, padding: "6px 16px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer", letterSpacing: "0.5px" }}>
            {planCopied ? "✓ Скопійовано" : "COPY"}
          </button>
          <button
            disabled={planDocxLoading}
            onClick={async () => {
              setPlanDocxLoading(true);
              try { await exportPracticePlanToDocx({ sections, info: getPracticeInfo(), methodInfo }); } catch (e) { setError("Помилка експорту: " + e.message); }
              setPlanDocxLoading(false);
            }}
            style={{ background: "transparent", border: "1.5px solid #8ab060", color: planDocxLoading ? "#aaa" : "#6a9030", borderRadius: 6, padding: "6px 16px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: planDocxLoading ? "wait" : "pointer", letterSpacing: "0.5px", display: "inline-flex", alignItems: "center", gap: 6 }}>
            {planDocxLoading ? <><SpinDot />...</> : "⬇ .docx"}
          </button>
        </div>

        {/* Таблиця */}
        <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
          {/* Шапка */}
          <div style={{ display: "grid", gridTemplateColumns: COL, background: "#1a1a14", color: "#e8ff47", padding: "9px 14px", fontSize: 11, letterSpacing: "1.5px", textTransform: "uppercase" }}>
            <div>#</div><div>Назва розділу</div><div style={{ textAlign: "center" }}>Стор.</div><div style={{ textAlign: "center" }}>Перем.</div><div /><div />
          </div>

          {sections.map((s, i) => {
            const isFixed = FIXED.includes(s.id);
            const movIdx = movable.findIndex(x => x.id === s.id);
            const canUp = !isFixed && movIdx > 0;
            const canDown = !isFixed && movIdx < movable.length - 1;
            const isPlaceholder = !isFixed && /\[|новий|підрозділ/i.test(s.label);
            const isNaming = namingId === s.id;
            const showChapterDivider = s.sectionTitle && s.sectionTitle !== sections[i - 1]?.sectionTitle;

            return (
              <Fragment key={s.id}>
              {showChapterDivider && (
                <div style={{ gridColumn: "1 / -1", padding: "6px 14px", background: "#e4dfd4", fontSize: 11, fontWeight: "bold", letterSpacing: "0.5px", color: "#555" }}>
                  {s.sectionTitle}
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: COL, borderBottom: i < sections.length - 1 ? "1px solid #e4dfd4" : "none", background: isFixed ? "#ede9e0" : i % 2 === 0 ? "#f5f2eb" : "#f0ece2", alignItems: "center" }}>
                <div style={{ padding: "9px 10px", fontSize: 12, color: "#bbb" }}>{i + 1}</div>

                {/* Назва + ✨ */}
                <div style={{ display: "flex", alignItems: "center", overflow: "hidden" }}>
                  <input
                    value={s.label}
                    onChange={e => updateSec(s.id, "label", e.target.value)}
                    style={{ background: "transparent", border: "none", fontSize: 13, padding: "9px 8px", color: isFixed ? "#888" : "#1a1a14", fontStyle: isFixed ? "italic" : "normal", flex: 1, minWidth: 0, fontFamily: "'Spectral',serif", outline: "none" }}
                  />
                  {isPlaceholder && (
                    <button onClick={() => doNameSingle(s.id)} disabled={isNaming} title="Згенерувати назву"
                      style={{ background: "transparent", border: "none", fontSize: 14, cursor: isNaming ? "wait" : "pointer", padding: "2px 6px", color: isNaming ? "#ccc" : "#b8a020", flexShrink: 0 }}>
                      {isNaming ? "…" : "✨"}
                    </button>
                  )}
                </div>

                {/* Сторінки */}
                <div style={{ textAlign: "center", padding: "4px 6px" }}>
                  {s.id === "sources" ? <span style={{ color: "#aaa" }}>—</span> : (
                    <input type="number" value={s.pages} min={0} max={99} onChange={e => updateSec(s.id, "pages", e.target.value)}
                      style={{ width: 52, border: "1px solid #e0ddd4", borderRadius: 4, textAlign: "center", padding: "4px", fontSize: 13, fontFamily: "'Spectral',serif" }} />
                  )}
                </div>

                {/* ↑↓ */}
                <div style={{ display: "flex", justifyContent: "center", gap: 2 }}>
                  {!isFixed && (<>
                    <button onClick={() => moveSectionUp(s.id)} disabled={!canUp} style={{ background: "transparent", border: "none", fontSize: 13, cursor: canUp ? "pointer" : "default", color: canUp ? "#555" : "#ddd", padding: "2px 4px" }}>↑</button>
                    <button onClick={() => moveSectionDown(s.id)} disabled={!canDown} style={{ background: "transparent", border: "none", fontSize: 13, cursor: canDown ? "pointer" : "default", color: canDown ? "#555" : "#ddd", padding: "2px 4px" }}>↓</button>
                  </>)}
                </div>

                <div />

                {/* ✕ */}
                <div style={{ display: "flex", justifyContent: "center" }}>
                  {!isFixed && (
                    <button onClick={() => delSec(s.id)}
                      style={{ background: "transparent", border: "none", color: "#ccc", fontSize: 15, cursor: "pointer", padding: "2px 4px" }}
                      onMouseEnter={e => e.currentTarget.style.color = "#c55"}
                      onMouseLeave={e => e.currentTarget.style.color = "#ccc"}>✕</button>
                  )}
                </div>
              </div>
              </Fragment>
            );
          })}

          {/* Нижня панель */}
          <div style={{ padding: "10px 14px", background: "#f5f2eb", borderTop: "1px solid #e4dfd4", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, fontFamily: "'Spectral',serif", color: pagesOk ? "#5a8a2a" : "#c03030", fontWeight: "bold", marginRight: 4 }}>
              {totalP} / {targetPages} стор. {pagesOk ? "✓" : "⚠"}
            </span>
            <button onClick={addChapter}
              style={{ background: "transparent", border: "1.5px dashed #8ab060", color: "#6a9030", borderRadius: 6, padding: "6px 16px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer", letterSpacing: "0.5px" }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "#3a6010"; e.currentTarget.style.color = "#3a6010"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "#8ab060"; e.currentTarget.style.color = "#6a9030"; }}>
              + Розділ
            </button>
            <button onClick={addSubsection}
              style={{ background: "transparent", border: "1.5px dashed #bbb4a0", color: "#888", borderRadius: 6, padding: "6px 16px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer", letterSpacing: "0.5px" }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "#1a1a14"; e.currentTarget.style.color = "#1a1a14"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "#bbb4a0"; e.currentTarget.style.color = "#888"; }}>
              + Підрозділ
            </button>
            <button onClick={recalcPages}
              style={{ background: "transparent", border: "1.5px dashed #a0a0a0", color: "#888", borderRadius: 6, padding: "6px 12px", fontFamily: "'Spectral',serif", fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "#555"; e.currentTarget.style.color = "#555"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "#a0a0a0"; e.currentTarget.style.color = "#888"; }}>
              ⟳ стор.
            </button>
          </div>
        </div>

        {/* Кнопка назв для заглушок */}
        {hasPlaceholders && (
          <div style={{ marginBottom: 14 }}>
            <GreenBtn onClick={doNameAllPlaceholders} disabled={namingAllLoading} loading={namingAllLoading} msg="Генерую назви..." label="✨ Придумати назви для заглушок" />
          </div>
        )}

        {error && <div style={{ color: "#c55", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <div style={{ display: "flex", gap: 12 }}>
          <NavBtn onClick={() => setStage("parsed")}>← Назад</NavBtn>
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
    const mainSecs = sections.filter(s => !["sources", "intro", "conclusions"].includes(s.id));
    const totalRefsCount = (() => {
      const seen = new Set();
      mainSecs.forEach(sec => (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean).forEach(l => seen.add(normalizeRef(l))));
      return seen.size;
    })();
    const sourceTarget = calcSourceTarget(mainSecs);
    const sourceDist = calcSourceDist(mainSecs, sourceTarget);
    const scholarUrl = `https://scholar.google.com/scholar?q=${encodeURIComponent(getPracticeInfo().topic || "")}`;
    const styleBtn = (label, val, cur, setter) => (
      <button key={label} type="button" onClick={() => setter(val)}
        style={{
          padding: "4px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer",
          background: cur === val ? "#1a1a14" : "#f0ece2",
          color: cur === val ? "#e8ff47" : "#333",
          border: `1px solid ${cur === val ? "#1a1a14" : "#d4cfc4"}`,
        }}>
        {label}
      </button>
    );

    return (
      <div className="fade">
        <Heading>Джерела</Heading>
        <p style={{ fontSize: 13, color: "#888", marginBottom: 12 }}>
          Введіть джерела для кожного розділу або знайдіть їх автоматично. Після введення — сформуйте список літератури.
        </p>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: "#555" }}>
            Джерел додано: <b>{totalRefsCount}</b> / {sourceTarget}
            {sourceCountExplicit ? " (вказано клієнтом)" : " (орієнтовно, за обсягом звіту)"}
          </div>
          <button
            onClick={doSearchAllSections}
            disabled={searchingAll || mainSecs.some(sec => refSecLoading[sec.id])}
            style={{ background: "#1a3a10", border: "none", color: "#a8d060", borderRadius: 6, padding: "8px 16px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
            {searchingAll ? <><SpinDot /> Шукаю для всіх розділів...</> : "Знайти джерела для всіх розділів →"}
          </button>
        </div>

        <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, padding: "10px 14px", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12, fontSize: 12 }}>
          <span style={{ color: "#888" }}>Оформлення:</span>
          <span style={{ color: "#888" }}>Стиль</span>
          {styleBtn("ДСТУ 8302:2015", "ДСТУ 8302:2015", citStyle, setCitStyle)}
          {styleBtn("APA", "APA", citStyle, setCitStyle)}
          {styleBtn("MLA", "MLA", citStyle, setCitStyle)}
          <span style={{ color: "#888", marginLeft: 8 }}>Порядок</span>
          {styleBtn("Алфавіт", "alphabetical", sourcesOrder, setSourcesOrder)}
          {styleBtn("За порядком", "appearance", sourcesOrder, setSourcesOrder)}
        </div>

        <div style={{ background: "#f5f8ee", border: "1px solid #d8e4c0", borderRadius: 8, padding: "12px 16px", fontSize: 12, color: "#3a4a2a", marginBottom: 20, lineHeight: 1.6 }}>
          <b>Як це працює:</b> Натисніть "Знайти джерела для всіх розділів" — програма знайде відповідні джерела для кожного розділу. Виберіть потрібні галочкою та натисніть "Додати вибрані". Після заповнення натисніть "Сформувати список літератури".
          <br />
          Обмеження: іноземних джерел не більше 30% від загальної кількості. Російські та білоруські джерела заборонені.
          <div style={{ marginTop: 10 }}>
            <a href={scholarUrl} target="_blank" rel="noreferrer"
              style={{
                display: "inline-block", background: "#e8f0ff", border: "1.5px solid #4a9ade44", color: "#1a5a8a",
                borderRadius: 6, padding: "6px 12px", fontSize: 12, textDecoration: "none", fontFamily: "inherit",
              }}>
              🎓 Шукати додатково на Google Scholar →
            </a>
          </div>
        </div>

        {mainSecs.map((sec, idx) => (
          <Fragment key={sec.id}>
          {sec.sectionTitle && sec.sectionTitle !== mainSecs[idx - 1]?.sectionTitle && (
            <div style={{ fontSize: 12, fontWeight: "bold", letterSpacing: "0.5px", color: "#555", margin: "18px 0 8px" }}>{sec.sectionTitle}</div>
          )}
          <div style={{ marginBottom: 24, background: "#fff", borderRadius: 10, padding: "16px 18px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#1a1a14" }}>
                {sec.label}
                <span style={{ fontWeight: 400, fontSize: 11, color: "#999", marginLeft: 8 }}>(рекомендовано ~{sourceDist[sec.id] || 0} джерел)</span>
              </div>
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
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <div style={{ fontSize: 10, color: "#aaa" }}>Знайдені публікації:</div>
                  <button
                    onClick={() => setRefSecSelected(prev => {
                      const all = refSecPapers[sec.id].map(p => p.id);
                      const isAllSelected = (prev[sec.id] || []).length === all.length;
                      return { ...prev, [sec.id]: isAllSelected ? [] : all };
                    })}
                    style={{ background: "transparent", border: "none", color: "#4a9ade", fontSize: 11, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>
                    {(refSecSelected[sec.id] || []).length === refSecPapers[sec.id].length ? "Зняти всі" : "Вибрати всі"}
                  </button>
                </div>
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
          </Fragment>
        ))}

        {error && <div style={{ color: "#c55", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        <p style={{ fontSize: 12, color: "#999", marginBottom: 12 }}>
          Список літератури формується автоматично одразу після написання всіх розділів — тоді ж посилання [N] у тексті розставляються за фінальними номерами.
        </p>

        <div style={{ display: "flex", gap: 12 }}>
          <NavBtn onClick={() => setStage("plan")}>← Назад</NavBtn>
          <PrimaryBtn
            onClick={() => {
              saveToFirestore({ citInputs, stage: "writing", status: "plan_approved" });
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
          const showChapterDivider = sec.sectionTitle && sec.sectionTitle !== writableSecs[idx - 1]?.sectionTitle;
          return (
            <Fragment key={sec.id}>
            {showChapterDivider && (
              <div style={{ fontSize: 12, fontWeight: "bold", letterSpacing: "0.5px", color: "#555", margin: "18px 0 8px" }}>{sec.sectionTitle}</div>
            )}
            <div style={{ marginBottom: 20, background: "#fff", borderRadius: 10, padding: "16px 18px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
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
            </Fragment>
          );
        })}

        {allDone && (
          <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, padding: "10px 14px", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 16, marginBottom: 10, fontSize: 12 }}>
            <span style={{ color: "#888" }}>Оформлення:</span>
            <span style={{ color: "#888" }}>Стиль</span>
            {["ДСТУ 8302:2015", "APA", "MLA"].map(s => (
              <button key={s} type="button" onClick={() => setCitStyle(s)}
                style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer", background: citStyle === s ? "#1a1a14" : "#f0ece2", color: citStyle === s ? "#e8ff47" : "#333", border: `1px solid ${citStyle === s ? "#1a1a14" : "#d4cfc4"}` }}>
                {s}
              </button>
            ))}
            <span style={{ color: "#888", marginLeft: 8 }}>Порядок</span>
            {[{ key: "alphabetical", label: "Алфавіт" }, { key: "appearance", label: "За порядком" }].map(o => (
              <button key={o.key} type="button" onClick={() => setSourcesOrder(o.key)}
                style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer", background: sourcesOrder === o.key ? "#1a1a14" : "#f0ece2", color: sourcesOrder === o.key ? "#e8ff47" : "#333", border: `1px solid ${sourcesOrder === o.key ? "#1a1a14" : "#d4cfc4"}` }}>
                {o.label}
              </button>
            ))}
            <GreenBtn onClick={() => doFinalizeSources()} disabled={running} loading={running} msg={loadMsg || "Формую..."} label="Переформувати список літератури" />
          </div>
        )}

        {refList && (
          <div style={{ background: "#fff", borderRadius: 10, padding: "16px 18px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)", marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#1a1a14", marginBottom: 8 }}>Список використаних джерел:</div>
            <div style={{ fontSize: 12, whiteSpace: "pre-wrap", color: "#333", lineHeight: 1.7 }}>{refList}</div>
          </div>
        )}

        {/* Кнопка завантаження доступна як тільки є хоч одна секція */}
        {Object.keys(content).length > 0 && (
          <div style={{ display: "flex", gap: 10, marginTop: 16, padding: "14px 18px", background: "#f0f5e8", border: "1.5px solid #c8dfa0", borderRadius: 8 }}>
            <GreenBtn onClick={doExportMain} disabled={docxLoading} loading={docxLoading} msg="Завантажую..." label="⬇ Завантажити звіт .docx" />
          </div>
        )}

        {allDone && (
          <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
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

      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <GreenBtn onClick={doGenerateDiary} disabled={running} loading={running} msg="Генерую..." label="Згенерувати щоденник" />
        {diaryContent && (<>
          <button onClick={() => navigator.clipboard.writeText(diaryContent)}
            style={{ background: "#f0ece2", border: "1.5px solid #d4cfc4", color: "#555", borderRadius: 7, padding: "9px 16px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
            Копіювати
          </button>
          <GreenBtn onClick={doExportDiary} disabled={diaryDocxLoading} loading={diaryDocxLoading} msg="Завантажую..." label="⬇ Щоденник .docx" />
        </>)}
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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={doCopyAll}
              style={{ background: "#f0ece2", border: "1.5px solid #d4cfc4", color: "#555", borderRadius: 7, padding: "9px 16px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
              Копіювати текст
            </button>
            <GreenBtn onClick={doExportMain} disabled={docxLoading} loading={docxLoading} msg="Завантажую..." label="⬇ Звіт .docx" />
            {diaryContent && (
              <GreenBtn onClick={doExportDiary} disabled={diaryDocxLoading} loading={diaryDocxLoading} msg="Завантажую..." label="⬇ Щоденник .docx" />
            )}
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
        {stage === "parsed"  && renderParsed()}
        {stage === "plan"    && renderPlan()}
        {stage === "sources" && renderSources()}
        {stage === "writing" && renderWriting()}
        {stage === "diary"   && renderDiary()}
        {stage === "done"    && renderDone()}
      </div>
    </div>
  );
}
