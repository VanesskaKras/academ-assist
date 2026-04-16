import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { db } from "./firebase";
import { useAuth } from "./AuthContext";
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp,
} from "firebase/firestore";

import { exportToDocx, exportPlanToDocx, exportAppendixToDocx, exportSpeechToDocx, renumberTablesAndFigures } from "./lib/exportDocx.js";
import { exportToPptxFile } from "./lib/exportPptx.js";
import { callClaude, callGemini, MODEL, MODEL_FAST } from "./lib/api.js";
import { playDoneSound } from "./lib/audio.js";
import { buildSYS, SYS_JSON, SYS_JSON_SHORT, SYS_JSON_ARRAY, METHODOLOGY_READING_PROMPT, buildTemplateAnalysisPrompt, buildCommentAnalysisPrompt } from "./lib/prompts.js";
import { FIELD_LABELS, isPsychoPed, isEcon, getEmpiricalSections, getEconSections, STAGES_TEXT_FIRST, STAGE_KEYS_TEXT_FIRST, STAGES_SOURCES_FIRST, STAGE_KEYS_SOURCES_FIRST, ORDER_STATUS, parsePagesAvg, parseTemplate, buildPlanText, buildPreviewStructure, calcSourceDist, buildWorkConfig, parseClientPlan } from "./lib/planUtils.js";
import { serializeForFirestore } from "./lib/firestoreUtils.js";
import { searchSourcesForSection } from "./lib/sourcesSearch.js";
import { SpinDot, Shimmer } from "./components/SpinDot.jsx";
import { StagePills } from "./components/StagePills.jsx";
import { FieldBox, Heading, NavBtn, PrimaryBtn, GreenBtn, SaveIndicator } from "./components/Buttons.jsx";
import { StructurePreview } from "./components/StructurePreview.jsx";
import { PlanLoadingSkeleton } from "./components/PlanLoadingSkeleton.jsx";
import { DropZone } from "./components/DropZone.jsx";
import { PhotoDropZone } from "./components/PhotoDropZone.jsx";
import { ClientPlanInput } from "./components/ClientPlanInput.jsx";
import { InputStage } from "./components/stages/InputStage.jsx";
import { ParsedStage } from "./components/stages/ParsedStage.jsx";
import { PlanStage } from "./components/stages/PlanStage.jsx";
import { WritingStage } from "./components/stages/WritingStage.jsx";
import { SourcesStage } from "./components/stages/SourcesStage.jsx";
import { DoneStage } from "./components/stages/DoneStage.jsx";

export default function AcademAssist({ orderId, onOrderCreated, onBack }) {
  const { user } = useAuth();

  const [scrolled, setScrolled] = useState(false);
  const [headerOpen, setHeaderOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [stage, setStage] = useState("input");
  const [maxStageIdx, setMaxStageIdx] = useState(0);
  const [workflowMode, setWorkflowMode] = useState("text-first"); // "text-first" | "sources-first"
  const [tplText, setTplText] = useState("");
  const [comment, setComment] = useState("");
  const [clientPlan, setClientPlan] = useState("");
  const [fileLabel, setFileLabel] = useState("");
  const [fileB64, setFileB64] = useState(null);
  const [fileType, setFileType] = useState(null);
  const [methodInfo, setMethodInfo] = useState(null); // структурна інфо з методички
  const [commentAnalysis, setCommentAnalysis] = useState(null); // {planHints, writingHints}
  const [photos, setPhotos] = useState([]); // [{name, b64, type}] — додаткові фото
  const [info, setInfo] = useState(null);
  const [sections, setSections] = useState([]);
  const [planDisplay, setPlanDisplay] = useState("");
  const [content, setContent] = useState({});
  const [genIdx, setGenIdx] = useState(0);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [planLoading, setPlanLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [paused, setPaused] = useState(false);
  const [sourceDist, setSourceDist] = useState({});
  const [sourceTotal, setSourceTotal] = useState(0);
  const [keywords, setKeywords] = useState({});
  const [kwLoading, setKwLoading] = useState(false);
  const [kwError, setKwError] = useState("");
  const [citInputs, setCitInputs] = useState({});
  const [docxLoading, setDocxLoading] = useState(false);
  const [planDocxLoading, setPlanDocxLoading] = useState(false);
  const [showManualPlanInput, setShowManualPlanInput] = useState(false);
  const [manualPlanText, setManualPlanText] = useState("");
  const [namingLoading, setNamingLoading] = useState(false);
  const [allCitLoading, setAllCitLoading] = useState(false);
  const [refList, setRefList] = useState([]);
  const [citInputsSnapshot, setCitInputsSnapshot] = useState(null);
  const [figureRefs, setFigureRefs] = useState({});
  const [figureKeywords, setFigureKeywords] = useState([]);
  const [figKwLoading, setFigKwLoading] = useState(false);
  const [figPanelOpen, setFigPanelOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dbLoading, setDbLoading] = useState(false);
  const [remapLoading, setRemapLoading] = useState(false);
  // For regenerating a single section
  const [regenId, setRegenId] = useState(null);
  const [regenPrompt, setRegenPrompt] = useState("");
  const [regenLoading, setRegenLoading] = useState(false);
  const [regenAllLoading, setRegenAllLoading] = useState(false);
  const regenAllAbortRef = useRef(null);
  const writingDoneRef = useRef(false);
  const [apiError, setApiError] = useState("");
  const [speechText, setSpeechText] = useState("");
  const [speechLoading, setSpeechLoading] = useState(false);
  const [slideJson, setSlideJson] = useState(null);
  const [presentationLoading, setPresentationLoading] = useState(false);
  const [presentationMsg, setPresentationMsg] = useState("");
  const [presentationReady, setPresentationReady] = useState(false);
  const [appendicesText, setAppendicesText] = useState("");
  const [appendicesLoading, setAppendicesLoading] = useState(false);
  const [appendicesCustomPrompt, setAppendicesCustomPrompt] = useState("");
  const [titlePage, setTitlePage] = useState("");
  const [titlePageLines, setTitlePageLines] = useState(null);
  const [showMissingSources, setShowMissingSources] = useState(false);
  const [suggestedSources, setSuggestedSources] = useState({});
  const [sourcesSearchLoading, setSourcesSearchLoading] = useState({});
  const [sourcesSearchError, setSourcesSearchError] = useState({});
  const [abstractsMap, setAbstractsMap] = useState({}); // { citationString: abstractSnippet }
  const [searchPageCount, setSearchPageCount] = useState({}); // лічильник натискань "оновити" на секцію
  const [sessionCost, setSessionCost] = useState(() => {
    try { return JSON.parse(localStorage.getItem("sessionCost")) || { claude: 0, gemini: 0 }; } catch { return { claude: 0, gemini: 0 }; }
  });
  useEffect(() => {
    const handler = (e) => {
      const isGemini = e.detail.model?.startsWith("gemini");
      setSessionCost(c => {
        const next = isGemini ? { ...c, gemini: c.gemini + e.detail.cost } : { ...c, claude: c.claude + e.detail.cost };
        localStorage.setItem("sessionCost", JSON.stringify(next));
        return next;
      });
    };
    window.addEventListener("apicost", handler);
    return () => window.removeEventListener("apicost", handler);
  }, []);

  // Зберігаємо актуальний id документа (може змінитись після першого збереження)
  const currentIdRef = useRef(orderId || null);
  const abortRef = useRef(null);
  const contentRef = useRef(content);
  const savedTimerRef = useRef(null);
  useEffect(() => { contentRef.current = content; }, [content]);
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      setScrolled(y > 300);
      if (y > 120) setHeaderOpen(false);
      else if (y < 10) setHeaderOpen(true);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    return () => clearTimeout(savedTimerRef.current);
  }, []);

  // ── Завантаження існуючого замовлення з Firestore ──
  useEffect(() => {
    if (!orderId || !user) return;
    const load = async () => {
      setDbLoading(true);
      try {
        const snap = await getDoc(doc(db, "orders", orderId));
        if (snap.exists()) {
          const d = snap.data();
          if (d.tplText) setTplText(d.tplText);
          if (d.comment) setComment(d.comment);
          if (d.clientPlan) setClientPlan(d.clientPlan);
          if (d.info) setInfo(d.info);
          if (d.sections?.length) {
            setSections(d.sections);
            setPlanDisplay(buildPlanText(d.sections));
            const { dist, total } = calcSourceDist(d.sections, parsePagesAvg(d.info?.pages));
            setSourceDist(dist); setSourceTotal(total);
          }
          if (d.methodInfo) setMethodInfo(d.methodInfo);
          if (d.fileLabel) setFileLabel(d.fileLabel);
          if (d.commentAnalysis) setCommentAnalysis(d.commentAnalysis);
          if (d.content) setContent(d.content);
          if (d.citInputs) setCitInputs(d.citInputs);
          if (d.abstractsMap) setAbstractsMap(d.abstractsMap);
          if (d.refList) setRefList(d.refList);
          if (d.speechText) setSpeechText(d.speechText);
          if (d.appendicesText) setAppendicesText(d.appendicesText);
          if (d.titlePage) setTitlePage(d.titlePage);
          if (d.titlePageLines) setTitlePageLines(d.titlePageLines);
          if (d.slideJson) setSlideJson(d.slideJson);
          if (d.presentationReady) setPresentationReady(true);
          if (d.workflowMode) setWorkflowMode(d.workflowMode);
          if (d.stage) {
            const keys = d.workflowMode === "sources-first" ? STAGE_KEYS_SOURCES_FIRST : STAGE_KEYS_TEXT_FIRST;
            setStage(d.stage); setMaxStageIdx(Math.max(0, keys.indexOf(d.stage)));
          }
          if (d.genIdx !== undefined) setGenIdx(d.genIdx);
        }
      } catch (e) { console.error("Load error:", e); }
      setDbLoading(false);
    };
    load();
  }, [orderId, user]);

  // Активні стейджі залежно від режиму
  const activeStageKeys = workflowMode === "sources-first" ? STAGE_KEYS_SOURCES_FIRST : STAGE_KEYS_TEXT_FIRST;
  const activeStages    = workflowMode === "sources-first" ? STAGES_SOURCES_FIRST    : STAGES_TEXT_FIRST;

  // Оновлюємо maxStageIdx коли просуваємось вперед
  useEffect(() => {
    const idx = activeStageKeys.indexOf(stage);
    if (idx >= 0) setMaxStageIdx(prev => Math.max(prev, idx));
  }, [stage, workflowMode]);

  // ── Авто-збереження citInputs на стейджі джерел ──
  const citSaveTimer = useRef(null);
  useEffect(() => {
    if (stage !== "sources") return;
    clearTimeout(citSaveTimer.current);
    citSaveTimer.current = setTimeout(() => {
      saveToFirestore({ citInputs, abstractsMap });
    }, 1500);
    return () => clearTimeout(citSaveTimer.current);
  }, [citInputs]); // eslint-disable-line

  // ── Збереження в Firestore ──
  const saveToFirestore = async (patch) => {
    if (!user) return;
    setSaving(true); setSaved(false);
    try {
      const id = currentIdRef.current || `${user.uid}_${Date.now()}`;
      if (!currentIdRef.current) {
        currentIdRef.current = id;
        onOrderCreated?.(id);
      }
      const ref = doc(db, "orders", id);
      const base = {
        uid: user.uid,
        updatedAt: new Date().toISOString(),
        topic: patch.info?.topic || info?.topic || "",
        type: patch.info?.type || info?.type || "",
        pages: patch.info?.pages || info?.pages || "",
        deadline: patch.info?.deadline || info?.deadline || "",
      };
      const data = serializeForFirestore({ ...base, ...patch });
      // merge:true — не потрібен getDoc перед записом, один запис замість двох
      await setDoc(ref, { ...data, createdAt: new Date().toISOString() }, { merge: true });
      setSaved(true);
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 3000);
    } catch (e) { console.error("Save error:", e); }
    setSaving(false);
  };

  const handleFile = useCallback((name, b64, type) => { setFileLabel(name); setFileB64(b64); setFileType(type); }, []);

  const handleNavigateMain = useCallback((s) => {
    if (running) return;
    setStage(s === "input" && info ? "parsed" : s);
  }, [running, info]);

  const handleNavigateHeader = useCallback((s) => {
    if (running) return;
    setStage(s === "input" && info ? "parsed" : s);
    setHeaderOpen(false);
  }, [running, info]);

  // ── Аналіз шаблону ──
  const doAnalyze = async () => {
    setRunning(true); runningRef.current = true; setLoadMsg("Аналізую шаблон...");

    // КРОК 1: Аналіз шаблону замовлення (тільки текст, без PDF)
    const msgs = [];
    msgs.push({ type: "text", text: buildTemplateAnalysisPrompt(tplText, comment) });
    let newInfo;
    try {
      const raw = await callClaude([{ role: "user", content: msgs }], null, SYS_JSON, 1000, null, MODEL_FAST);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
      newInfo = { ...parseTemplate(tplText), ...parsed };
    } catch (e) {
      console.warn("doAnalyze fallback:", e.message);
      newInfo = parseTemplate(tplText);
    }
    // Автодетект категорії напряму якщо не задано вручну
    if (!newInfo.workCategory) {
      const dir = ((newInfo.direction || "") + " " + (newInfo.subject || "")).toLowerCase();
      if (/економ|фінанс|менедж|облік|маркет|бізнес|бухгалт|аудит|логіст|підприємн|публічн.*управл|держ.*управл/.test(dir)) newInfo.workCategory = "Економічне";
      else if (/біолог|медицин|хімі|фізіол|екол|природн|ветеринар/.test(dir)) newInfo.workCategory = "Біологічне";
      else if (/техн|інформ|програм|комп|it\b|кібер|електр|машин|буд|архіт/.test(dir)) newInfo.workCategory = "Технічне";
      else newInfo.workCategory = "Гуманітарне";
    }
    setInfo(newInfo);

    // КРОК 2: Якщо є методичка — пауза між запитами щоб не перевищити rate limit
    if (fileB64) {
      setApiError("");
      setLoadMsg("Читаю методичку...");
      await new Promise(r => setTimeout(r, 2000)); // пауза між двома API-викликами
      const methodMsgs = [
        { type: "document", source: { type: "base64", media_type: fileType || "application/pdf", data: fileB64 } },
        { type: "text", text: METHODOLOGY_READING_PROMPT },
      ];
      try {
        const raw = await callGemini([{ role: "user", content: methodMsgs }], null, SYS_JSON_SHORT, 8000, (s) => setLoadMsg(`Читаю методичку... зачекайте ${s}с`), "gemini-2.5-flash-lite", true);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
        setMethodInfo(parsed);
        if (parsed.titlePageTemplate) {
          const currentYear = new Date().getFullYear().toString();
          const fillText = (t) => t
            .replace(/\[ТЕМА\]/g, newInfo?.topic || "[ТЕМА]")
            .replace(/\b20\d\d\b/g, currentYear)
            .replace(/\b20\d?\s*[_]+/g, currentYear);
          let filledLines = null;
          let filledText = "";
          if (Array.isArray(parsed.titlePageTemplate)) {
            filledLines = parsed.titlePageTemplate.map(item => ({ ...item, text: fillText(item.text) }));
            filledText = filledLines.map(item => item.text).join("\n");
          } else {
            filledText = fillText(parsed.titlePageTemplate);
          }
          setTitlePage(filledText);
          setTitlePageLines(filledLines);
          await saveToFirestore({ tplText, comment, clientPlan, info: newInfo, methodInfo: parsed, fileLabel, titlePage: filledText, titlePageLines: filledLines, stage: "parsed", status: "new" });
        } else {
          await saveToFirestore({ tplText, comment, clientPlan, info: newInfo, methodInfo: parsed, fileLabel, stage: "parsed", status: "new" });
        }
      } catch (e) {
        console.warn("methodInfo extract failed:", e.message);
        setApiError(e.message);
        if (!methodInfo) setMethodInfo(null);
        await saveToFirestore({ tplText, comment, clientPlan, info: newInfo, ...(methodInfo ? { methodInfo } : {}), stage: "parsed", status: "new" });
      }
    } else {
      // Якщо PDF не завантажено але methodInfo вже є (з попереднього аналізу) — залишаємо його
      if (!methodInfo) setMethodInfo(null);
      await saveToFirestore({ tplText, comment, clientPlan, info: newInfo, ...(methodInfo ? { methodInfo } : {}), stage: "parsed", status: "new" });
    }

    // КРОК 3: Аналіз коментаря клієнта (+ фото якщо є)
    if (comment?.trim() || photos.length > 0) {
      setLoadMsg("Аналізую коментар...");
      await new Promise(r => setTimeout(r, 1000));
      try {
        const caContent = [];
        // Додаємо фото перед текстом (Claude бачить їх перед запитом)
        for (const ph of photos) {
          caContent.push({ type: "image", source: { type: "base64", media_type: ph.type, data: ph.b64 } });
        }
        caContent.push({ type: "text", text: buildCommentAnalysisPrompt({ topic: newInfo?.topic, comment, photoCount: photos.length }) });
        const caRaw = await callClaude([{ role: "user", content: caContent }],
          null, SYS_JSON_SHORT, 600, null, MODEL_FAST);
        const caMatch = caRaw.match(/\{[\s\S]*\}/);
        const caParsed = JSON.parse(caMatch?.[0] || caRaw);
        setCommentAnalysis(caParsed);
        await saveToFirestore({ tplText, comment, clientPlan, info: newInfo, commentAnalysis: caParsed, stage: "parsed", status: "new" });
      } catch (e) {
        console.warn("commentAnalysis failed:", e.message);
        setCommentAnalysis(null);
      }
    } else {
      setCommentAnalysis(null);
    }

    setRunning(false); runningRef.current = false; setLoadMsg(""); setStage("parsed");
  };

  // ── Парсинг плану клієнта ──
  const buildDefaultPlan = (totalPages, lang = "Українська") => {
    const isEn = /англ|english/i.test(lang || "");
    const needThirdChapter = totalPages >= 40;
    const mainPages = Math.round(totalPages * 0.80);
    const chapCount = needThirdChapter ? 3 : 2;
    const pagesPerCh = Math.max(1, Math.round(mainPages / chapCount));
    const pagesPerSub = Math.max(1, Math.round(pagesPerCh / 3));
    const introPages = 2;
    const concPages = totalPages > 40 ? 3 : 2;
    const chapterNames = isEn
      ? [`CHAPTER 1. THEORETICAL FOUNDATIONS`, `CHAPTER 2. ANALYSIS AND PRACTICAL PART`, ...(needThirdChapter ? [`CHAPTER 3. RECOMMENDATIONS AND PROPOSALS`] : [])]
      : [`РОЗДІЛ 1. ТЕОРЕТИЧНІ ОСНОВИ ДОСЛІДЖЕННЯ`, `РОЗДІЛ 2. АНАЛІЗ ТА ПРАКТИЧНА ЧАСТИНА`, ...(needThirdChapter ? [`РОЗДІЛ 3. РЕКОМЕНДАЦІЇ ТА ПРОПОЗИЦІЇ`] : [])];
    const chTypes = ["theory", "analysis", "recommendations"];
    const sections = [];
    chapterNames.forEach((chName, ci) => {
      const chapNum = ci + 1;
      const subLabel = isEn ? `subsection ${chapNum}.` : `підрозділ ${chapNum}.`;
      for (let i = 1; i <= 3; i++) sections.push({ id: `${chapNum}.${i}`, label: `${chapNum}.${i} [${subLabel}${i}]`, sectionTitle: chName, pages: pagesPerSub, type: chTypes[ci] });
    });
    sections.push({ id: "intro", label: isEn ? "INTRODUCTION" : "ВСТУП", pages: introPages, type: "intro" });
    sections.push({ id: "conclusions", label: isEn ? "CONCLUSIONS" : "ВИСНОВКИ", pages: concPages, type: "conclusions" });
    sections.push({ id: "sources", label: isEn ? "REFERENCES" : "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", pages: 1, type: "sources" });
    return sections;
  };

  // ── Генерація плану ──
  const doGenPlan = async () => {
    setPlanLoading(true); setSections([]); setPlanDisplay(""); setStage("plan");
    const d = info; const totalPages = parsePagesAvg(d.pages);
    const wc = buildWorkConfig({ info: d, methodInfo, commentAnalysis });
    const introP = wc.introPages;
    const conclP = wc.conclusionsPages;
    const isEnglish = /англ|english/i.test(d?.language || "");
    const L = isEnglish
      ? { intro: "INTRODUCTION", conclusions: "CONCLUSIONS", sources: "REFERENCES", chapConclLabel: (n) => `Conclusions to Chapter ${n}`, chapterWord: "CHAPTER", subsWord: "subsection" }
      : { intro: "ВСТУП", conclusions: "ВИСНОВКИ", sources: "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", chapConclLabel: (n) => `Висновки до розділу ${n}`, chapterWord: "РОЗДІЛ", subsWord: "підрозділ" };

    const finalizeSections = async (secs) => {
      const withPrompts = secs.map(s => {
        // Якщо підрозділ не має номера на початку label — додаємо з id
        let label = s.label;
        if (s.id && /^\d+\.\d+$/.test(s.id) && !label.startsWith(s.id)) {
          label = `${s.id} ${label}`;
        }
        return { ...s, label, prompts: s.type === "sources" ? 0 : Math.max(1, Math.ceil((s.pages || 1) / 3)) };
      });
      setSections(withPrompts); setPlanDisplay(buildPlanText(withPrompts));
      const { dist, total } = calcSourceDist(withPrompts, parsePagesAvg(d?.pages));
      setSourceDist(dist); setSourceTotal(total);
      setInfo(p => p ? { ...p, sourceCount: String(total) } : p);
      await saveToFirestore({ sections: withPrompts, stage: "plan", status: "plan_ready", info: { ...d, sourceCount: String(total) } });
      setPlanLoading(false);
    };

    if (clientPlan?.trim()) {
      const parsed = parseClientPlan(clientPlan.trim(), totalPages);
      if (parsed?.length > 3) { await finalizeSections(parsed); return; }
    }

    // Якщо на фото є готовий план — використати його структуру як шаблон
    if (commentAnalysis?.photoTOC && typeof commentAnalysis.photoTOC === "string" && commentAnalysis.photoTOC.length > 20) {
      try {
        const toc = commentAnalysis.photoTOC;
        const subsMatches = toc.match(/^\s*\d+\.\d+/gm) || [];
        const totalSubsPhoto = subsMatches.length || 4;
        const chapConclCount = (toc.match(/висновк[^\s]*\s+до\s+|conclusions?\s+to\s+chapter/gi) || []).length;
        const pagesPerSub = Math.max(3, Math.round((totalPages - introP - conclP - chapConclCount) / totalSubsPhoto));
        const photoTplPrompt = `A client provided a READY PLAN from a photo. Use its EXACT structure (number of chapters, subsections per chapter, chapter conclusions if present) but create NEW titles matching the topic below. Do NOT copy titles from the plan.

TOPIC: "${d.topic}". Type: ${d.type}. Field: ${d.subject}. Pages: ${totalPages}.
Language of work: ${d.language || "Ukrainian"} — all labels (INTRODUCTION, CONCLUSIONS, chapter/section titles) must be in the work language.

PLAN FROM PHOTO (structure only, do not copy titles):
${toc}

PAGE DISTRIBUTION (total must equal ${totalPages}):
- ${L.intro}: ${introP} p.
- ${L.conclusions}: ${conclP} p.
- Chapter conclusions: 1 p. each (if present in photo plan)
- Each subsection: ~${pagesPerSub} p. (total subsections: ${totalSubsPhoto})

Return ONLY JSON without markdown:
{"sections":[{"id":"1.1","label":"1.1 Title","sectionTitle":"${L.chapterWord} 1. TITLE","pages":8,"type":"theory"},{"id":"intro","label":"${L.intro}","pages":2,"type":"intro"},{"id":"conclusions","label":"${L.conclusions}","pages":3,"type":"conclusions"},{"id":"sources","label":"${L.sources}","pages":2,"type":"sources"}]}`;
        const raw = await callGemini([{ role: "user", content: photoTplPrompt }], null, SYS_JSON_SHORT, 3000);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
        const secs = parsed.sections || parsed;
        if (Array.isArray(secs) && secs.length > 3) { await finalizeSections(secs); return; }
      } catch (e) { console.warn("photoTOC plan failed:", e.message); }
    }

    // Якщо коментар містить приклад структури плану — використати як шаблон, адаптувати назви під тему
    if (comment?.trim() && /розділ\s*\d+/i.test(comment)) {
      try {
        // Рахуємо розділи, підрозділи та висновки до розділів з прикладу
        const chapNums = [...new Set((comment.match(/розділ\s*(\d+)/gi) || []).map(m => m.match(/\d+/)[0]))];
        const chapCount = chapNums.length || 2;
        // Рахуємо підрозділи per chapter
        const chapSubsMap = {};
        for (const line of comment.split('\n')) {
          const m = line.trim().match(/^(\d+)\.(\d+)/);
          if (m) chapSubsMap[m[1]] = (chapSubsMap[m[1]] || 0) + 1;
        }
        const subsCount = Object.values(chapSubsMap).reduce((a, b) => a + b, 0) || 4;
        const chapStructure = chapNums.length
          ? chapNums.map(n => `Chapter ${n}: EXACTLY ${chapSubsMap[n] || 2} subsection(s)`).join('\n')
          : `Each chapter: EXACTLY 2 subsections`;
        const chapConclCount = (comment.match(/висновк[^\s]*\s+до\s+/gi) || []).length;
        const pagesForSubs = totalPages - introP - conclP - chapConclCount;
        const pagesPerSub = Math.max(3, Math.round(pagesForSubs / subsCount));
        const templatePrompt = `A client provided a STRUCTURE EXAMPLE. Use EXACTLY the structure below.

Do NOT copy titles from the example. Create NEW titles for the topic below.
MANDATORY STRUCTURE — you MUST follow this exactly:
- EXACTLY ${chapCount} chapter(s)
${chapStructure}
${chapConclCount > 0 ? `- Chapter conclusions after each chapter` : `- NO chapter conclusions`}

TOPIC: "${d.topic}". Type: ${d.type}. Field: ${d.subject}. Pages: ${totalPages}.
Language of work: ${d.language || "Ukrainian"} — all labels must be in this language.

EXAMPLE (structure only, do not copy titles):
${comment}

PAGE DISTRIBUTION (total must equal ${totalPages}):
- ${L.intro}: ${introP} p.
- ${L.conclusions}: ${conclP} p.
- Chapter conclusions: 1 p. each (if present)
- Each subsection: ${pagesPerSub} p. (total: ${subsCount})

Allowed type values: "theory" | "analysis" | "recommendations" | "chapter_conclusion" | "intro" | "conclusions" | "sources"
Chapter conclusion id format: "1.conclusions", "2.conclusions", "3.conclusions"

Return ONLY JSON without markdown:
{"sections":[
  {"id":"1.1","label":"1.1 Section title","sectionTitle":"${L.chapterWord} 1. CHAPTER TITLE","pages":8,"type":"theory"},
  ${chapConclCount > 0 ? `{"id":"1.conclusions","label":"${L.chapConclLabel(1)}","sectionTitle":"${L.chapterWord} 1. CHAPTER TITLE","pages":1,"type":"chapter_conclusion"},` : ""}
  {"id":"2.1","label":"2.1 Section title","sectionTitle":"${L.chapterWord} 2. CHAPTER TITLE","pages":8,"type":"analysis"},
  ${chapConclCount > 0 ? `{"id":"2.conclusions","label":"${L.chapConclLabel(2)}","sectionTitle":"${L.chapterWord} 2. CHAPTER TITLE","pages":1,"type":"chapter_conclusion"},` : ""}
  {"id":"intro","label":"${L.intro}","pages":3,"type":"intro"},
  {"id":"conclusions","label":"${L.conclusions}","pages":3,"type":"conclusions"},
  {"id":"sources","label":"${L.sources}","pages":2,"type":"sources"}
]}`;
        await new Promise(r => setTimeout(r, 1000));
        const raw = await callGemini([{ role: "user", content: templatePrompt }], null, SYS_JSON_SHORT, 3000);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
        const secs = parsed.sections || parsed;
        if (Array.isArray(secs) && secs.length > 3) { await finalizeSections(secs); return; }
      } catch (e) { console.warn("comment template plan failed:", e.message); }
    }

    const commentHasConcl = commentAnalysis?.planHints ? /висновк[^\s]*\s+до\s+/i.test(commentAnalysis.planHints) : false;

    if (methodInfo) {
      // Маємо готову структурну інфу з методички — генеруємо план без PDF
      const chapCount = methodInfo.chaptersCount || (totalPages >= 40 ? 3 : 2);
      const hasConcl = methodInfo.hasChapterConclusions === true || commentHasConcl || false;
      const chTypes = methodInfo.chapterTypes?.length ? methodInfo.chapterTypes : ["theory", "analysis", "recommendations"].slice(0, chapCount);
      const chapConclP = hasConcl ? chapCount : 0;

      const subsPerChapter = methodInfo.subsectionsPerChapter || 3;
      const totalSubsCount = chapCount * subsPerChapter;
      const pagesPerSub = Math.max(3, Math.round((totalPages - introP - conclP - chapConclP) / totalSubsCount));

      const planPrompt = `Create a plan for ${d.type} on topic: "${d.topic}". Field: ${d.subject}. Pages: ${totalPages}.
Language of work: ${d.language || "Ukrainian"} — all labels and titles must be in this language.
${commentAnalysis?.planHints ? `\nCLIENT HINTS:\n${commentAnalysis.planHints}\n` : ""}
GUIDE REQUIREMENTS:
- Chapters: ${chapCount}
- Subsections per chapter: ${subsPerChapter}
- Chapter conclusions: ${hasConcl ? "YES — add after last subsection of each chapter" : "NO — do not add"}
- Chapter types: ${chTypes.join(", ")}
${methodInfo.otherRequirements ? `- Other requirements: ${methodInfo.otherRequirements}` : ""}
${methodInfo.exampleTOC ? `\nFORMATTING EXAMPLE FROM GUIDE (headings style only — do NOT copy titles or use as structure):
${methodInfo.exampleTOC}` : ""}

PAGE DISTRIBUTION (must sum to exactly ${totalPages}):
- ${L.intro}: ${introP} p.
- ${L.conclusions}: ${conclP} p.
- Each subsection: ~${pagesPerSub} p. (total: ${totalSubsCount})
${hasConcl ? `- Chapter conclusions: 1 p. each (${chapCount} total)` : ""}

Allowed type values: "theory" | "analysis" | "recommendations" | "chapter_conclusion" | "intro" | "conclusions" | "sources"
Chapter conclusion id format: "1.conclusions", "2.conclusions" etc.
IMPORTANT: every subsection label MUST start with its numeric id (e.g. "1.1 ", "1.2 ", "2.3 "). Never omit the number prefix.

Return ONLY JSON without markdown:
{"sections":[
  {"id":"1.1","label":"1.1 Section title","sectionTitle":"${L.chapterWord} 1. CHAPTER TITLE","pages":8,"type":"theory"},
  {"id":"1.2","label":"1.2 Section title","sectionTitle":"${L.chapterWord} 1. CHAPTER TITLE","pages":7,"type":"theory"},${hasConcl ? `
  {"id":"1.conclusions","label":"${L.chapConclLabel(1)}","sectionTitle":"${L.chapterWord} 1. CHAPTER TITLE","pages":1,"type":"chapter_conclusion"},` : ""}
  {"id":"2.1","label":"2.1 Section title","sectionTitle":"${L.chapterWord} 2. CHAPTER TITLE","pages":8,"type":"analysis"},
  {"id":"2.2","label":"2.2 Section title","sectionTitle":"${L.chapterWord} 2. CHAPTER TITLE","pages":7,"type":"analysis"},${hasConcl ? `
  {"id":"2.conclusions","label":"${L.chapConclLabel(2)}","sectionTitle":"${L.chapterWord} 2. CHAPTER TITLE","pages":1,"type":"chapter_conclusion"},` : ""}
  {"id":"intro","label":"${L.intro}","pages":3,"type":"intro"},
  {"id":"conclusions","label":"${L.conclusions}","pages":3,"type":"conclusions"},
  {"id":"sources","label":"${L.sources}","pages":2,"type":"sources"}
]}
Order: subsections grouped by chapter, then intro, conclusions, sources.`;

      try {
        await new Promise(r => setTimeout(r, 3000)); // пауза після аналізу методички
        const raw = await callGemini([{ role: "user", content: planPrompt }], null, SYS_JSON, 3000);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
        const secs = parsed.sections || parsed;
        if (Array.isArray(secs) && secs.length > 3) { await finalizeSections(secs); return; }
        console.warn("methodInfo plan: unexpected shape", parsed);
      } catch (e) { console.error("methodInfo plan error:", e); }
    }

    const defaultSecs = buildDefaultPlan(totalPages, d?.language);
    // Для психології/педагогіки — перейменовуємо емпіричний розділ:
    // до 40 стор (2 розділи): емпіричне = розділ 2 (type "analysis")
    // від 40 стор (3 розділи): емпіричне = розділ 3 (type "recommendations")
    const hasThreeChapters = totalPages >= 40;
    const empiricalChapNum = hasThreeChapters ? 3 : 2;
    const planSecs = isPsychoPed(d)
      ? defaultSecs.map(s => {
        const chapNum = parseInt(s.id.split(".")[0]);
        if (!hasThreeChapters && s.type === "analysis" && chapNum === 2) {
          const title = isEnglish ? "CHAPTER 2. EMPIRICAL RESEARCH" : "РОЗДІЛ 2. ЕМПІРИЧНЕ ДОСЛІДЖЕННЯ";
          return { ...s, sectionTitle: title };
        }
        if (hasThreeChapters && s.type === "recommendations" && chapNum === 3) {
          const title = isEnglish ? "CHAPTER 3. EMPIRICAL RESEARCH" : "РОЗДІЛ 3. ЕМПІРИЧНЕ ДОСЛІДЖЕННЯ";
          return { ...s, sectionTitle: title };
        }
        return s;
      })
      : defaultSecs;
    const psychoPedNamingHint = isPsychoPed(d)
      ? `\nIMPORTANT for Chapter ${empiricalChapNum} (empirical research): subsections should cover: research methodology and sample description, questionnaire/survey instrument, results analysis and interpretation.`
      : "";
    const namingPrompt = `For ${d.type} on topic "${d.topic}" (field: ${d.subject}) create subsection titles.${commentAnalysis?.planHints ? `\nHINTS:\n${commentAnalysis.planHints}` : ""}${psychoPedNamingHint}\nFixed structure:\n${planSecs.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type)).map(s => `${s.id} [${s.sectionTitle}]`).join("\n")}\n\nReturn ONLY JSON without markdown:\n{"titles":{"1.1":"Title","1.2":"Title","2.1":"Title","2.2":"Title"}}`;
    try {
      await new Promise(r => setTimeout(r, 2000)); // пауза перед запитом
      const raw = await callClaude([{ role: "user", content: namingPrompt }], null, SYS_JSON, 1000, null, MODEL_FAST);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
      const namedSecs = planSecs.map(s => { const name = parsed.titles?.[s.id]; return name ? { ...s, label: `${s.id} ${name}` } : s; });
      await finalizeSections(namedSecs);
    } catch (e) {
      console.error("Naming error:", e);
      await finalizeSections(planSecs);
    }
  };

  // ── Перерахувати сторінки рівномірно ──
  const recalcPages = () => {
    const wc = buildWorkConfig({ info, methodInfo, commentAnalysis });
    const mainSubs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const chapConclCount = sections.filter(s => s.type === "chapter_conclusion").length;
    const pagesForMain = Math.max(mainSubs.length * 3,
      wc.totalPages - wc.introPages - wc.conclusionsPages - chapConclCount);
    const pagesPerSub = Math.max(3, Math.round(pagesForMain / Math.max(mainSubs.length, 1)));
    setSections(prev => {
      const next = prev.map(s => {
        if (s.type === "intro") return { ...s, pages: wc.introPages };
        if (s.type === "conclusions") return { ...s, pages: wc.conclusionsPages };
        if (s.type === "chapter_conclusion") return { ...s, pages: 1 };
        if (s.type === "sources") return s;
        const p = pagesPerSub;
        return { ...s, pages: p, prompts: Math.max(1, Math.ceil(p / 3)) };
      });
      setPlanDisplay(buildPlanText(next));
      return next;
    });
  };

  // ── Додати новий розділ (з підрозділами-заглушками) ──
  const addNewChapter = () => {
    const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const maxCh = mainSecs.reduce((m, s) => Math.max(m, parseInt(s.id.split(".")[0]) || 0), 0);
    const chapNum = maxCh + 1;
    const chTypes = ["theory", "analysis", "recommendations"];
    const chType = chTypes[Math.min(chapNum - 1, chTypes.length - 1)];
    const pagesPerSub = Math.max(3, Math.round(parsePagesAvg(info?.pages) * 0.10));
    const sectionTitle = `РОЗДІЛ ${chapNum}. [Назва розділу ${chapNum}]`;
    const newSubs = [1, 2, 3].map(i => ({
      id: `${chapNum}.${i}`,
      label: `${chapNum}.${i} [Новий підрозділ]`,
      sectionTitle,
      pages: pagesPerSub,
      prompts: Math.max(1, Math.ceil(pagesPerSub / 3)),
      type: chType,
    }));
    setSections(prev => {
      const introIdx = prev.findIndex(s => s.type === "intro");
      const next = introIdx >= 0
        ? [...prev.slice(0, introIdx), ...newSubs, ...prev.slice(introIdx)]
        : [...prev, ...newSubs];
      setPlanDisplay(buildPlanText(next));
      return next;
    });
  };

  // ── Придумати назви для заглушок ──
  const doNamePlaceholders = async () => {
    setNamingLoading(true);
    const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const placeholderSubs = mainSecs.filter(s => /\[|\bновий\b/i.test(s.label));
    // Розділи чиї sectionTitle ще заглушки
    const placeholderChapNums = [...new Set(
      mainSecs.filter(s => /\[Назва розділу/i.test(s.sectionTitle)).map(s => s.id.split(".")[0])
    )];
    if (!placeholderSubs.length && !placeholderChapNums.length) { setNamingLoading(false); return; }

    const planContext = mainSecs.map(s => `${s.id} — ${s.label}`).join("\n");
    const subIds = placeholderSubs.map(s => s.id);
    const chapIds = placeholderChapNums;

    const prompt = `Academic work. Topic: "${info?.topic}". Type: ${info?.type}. Field: ${info?.subject}.
Language: ${info?.language || "Ukrainian"} — all titles must be in this language.

CURRENT PLAN:
${planContext}

Generate titles for placeholder sections only. They must fit the topic and not repeat existing sections.

Return ONLY JSON without markdown:
{
  "subsections": {${subIds.map(id => `"${id}":"subsection title"`).join(",")}},
  "chapters": {${chapIds.map(id => `"${id}":"chapter title (without РОЗДІЛ N. prefix)"`).join(",")}}
}`;

    try {
      const raw = await callClaude([{ role: "user", content: prompt }], null, SYS_JSON_SHORT, 1200, null, MODEL_FAST);
      const match = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match?.[0] || raw);
      const subTitles = parsed.subsections || {};
      const chapTitles = parsed.chapters || {};

      setSections(prev => {
        const next = prev.map(s => {
          const chNum = s.id.split(".")[0];
          // Оновлюємо sectionTitle якщо є нова назва розділу
          const newSectionTitle = chapTitles[chNum]
            ? `РОЗДІЛ ${chNum}. ${chapTitles[chNum]}`
            : s.sectionTitle;
          // Оновлюємо label підрозділу якщо є нова назва
          const newLabel = subTitles[s.id]
            ? `${s.id} ${subTitles[s.id]}`
            : s.label;
          return { ...s, label: newLabel, sectionTitle: newSectionTitle };
        });
        setPlanDisplay(buildPlanText(next));
        return next;
      });
    } catch (e) {
      console.warn("naming failed:", e.message);
    }
    setNamingLoading(false);
  };

  const startGen = async (mode) => {
    const newMode = mode || workflowMode;
    setWorkflowMode(newMode);
    const ORDER = ["theory", "analysis", "recommendations", "chapter_conclusion", "intro", "conclusions", "sources"];
    setSections(prev => [...prev].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type)));
    setContent({}); setGenIdx(0); setPaused(false); writingDoneRef.current = false;
    // Генеруємо додатки перед текстом (якщо ще не згенеровані)
    if (!appendicesText) await doGenAppendices();
    // sources-first: спочатку збираємо джерела, потім пишемо
    const nextStage = newMode === "sources-first" ? "sources" : "writing";
    setStage(nextStage);
    saveToFirestore({ workflowMode: newMode, stage: nextStage, status: "writing" });
  };

  // ── Виявлення рисунків у тексті ──
  const scanFigures = (text) => {
    const FIG_RE = /(?:рис(?:унок)?\.?\s*\d+(?:\.\d+)*|fig(?:ure)?\.?\s*\d+(?:\.\d+)*)/gi;
    const results = [];
    const lines = text.split("\n");
    lines.forEach(line => {
      const matches = line.match(FIG_RE);
      if (matches) {
        const ctx = line.replace(/\s+/g, " ").trim().substring(0, 120);
        matches.forEach(m => results.push({ label: m, context: ctx }));
      }
    });
    // дедуплікація по label
    const seen = new Set();
    return results.filter(r => { if (seen.has(r.label.toLowerCase())) return false; seen.add(r.label.toLowerCase()); return true; });
  };

  const doScanAndGenFigures = async () => {
    setFigKwLoading(true);
    // 1. Сканування всіх підрозділів
    const newRefs = {};
    sections.forEach(sec => { if (content[sec.id]) newRefs[sec.id] = scanFigures(content[sec.id]); });
    setFigureRefs(newRefs);
    const allFigs = sections.flatMap(sec => (newRefs[sec.id] || []).map(f => ({ ...f, secLabel: sec.label })));
    if (!allFigs.length) { setFigKwLoading(false); return; }
    // 2. Генерація ключових слів для знайдених рисунків
    const topic = info?.topic || "";
    const prompt = `Ти допомагаєш студенту знайти ілюстрації для курсової/дипломної роботи на тему "${topic}".
Нижче список рисунків згаданих у роботі з контекстом. Для кожного рисунка дай:
1. Коротку назву що зображує рисунок (1 речення)
2. 3-4 ключових слова для пошуку зображення (краще англійською для Google Images/Unsplash/ResearchGate)

Відповідь — ТІЛЬКИ JSON масив:
[{"label":"Рис. 1","name":"Короткий опис","keywords":"ключові слова для пошуку"}]

Рисунки:
${allFigs.map((f, i) => `${i + 1}. ${f.label} (підрозділ: ${f.secLabel})\nКонтекст: ${f.context}`).join("\n\n")}`;
    try {
      const raw = await callClaude([{ role: "user", content: prompt }], null, SYS_JSON_ARRAY, 2000, null, MODEL_FAST);
      const parsed = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || "[]");
      setFigureKeywords(parsed);
    } catch (e) { console.error(e); }
    setFigKwLoading(false);
  };

  // ── Авто-сканування рисунків при переході на done ──
  useEffect(() => {
    if (stage !== "done") return;
    const newRefs = {};
    sections.forEach(sec => { if (content[sec.id]) newRefs[sec.id] = scanFigures(content[sec.id]); });
    setFigureRefs(newRefs);
  }, [stage, content]);

  // ── Генерація тексту ──
  useEffect(() => {
    if (stage !== "writing" || paused) return;
    if (runningRef.current) return;
    if (genIdx >= sections.length) {
      if (!writingDoneRef.current) {
        writingDoneRef.current = true;
        playDoneSound();
        if (workflowMode === "sources-first") {
          // Джерела зібрані, текст написаний — чекаємо на remapCitations
          saveToFirestore({ stage: "writing", status: "writing", content, citInputs });
        } else {
          setStage("sources"); saveToFirestore({ stage: "sources", status: "writing", content, citInputs });
        }
      }
      return;
    }
    const sec = sections[genIdx];
    if (contentRef.current[sec.id] !== undefined) { setGenIdx(g => g + 1); return; }
    if (sec.type === "sources") {
      setContent(p => ({ ...p, [sec.id]: "[Додайте джерела на кроці «Джерела»]" }));
      setGenIdx(g => g + 1); return;
    }
    runSection(sec);
  }, [stage, genIdx, paused, sections]);

  const runSection = async (sec) => {
    runningRef.current = true; setRunning(true); setLoadMsg("Генерую: " + sec.label + "...");
    const ctrl = new AbortController(); abortRef.current = ctrl;
    const d = info;
    const lang = d?.language || "Українська";
    // Для емпіричних підрозділів — широкий контекст усього розділу (до 2000 символів)
    const empSecsEarly = getEmpiricalSections(sections, d);
    const isCurrentEmpChapter = empSecsEarly.chapterSectionIds.includes(sec.id);
    const prevCtx = isCurrentEmpChapter
      ? (() => {
          const empIds = empSecsEarly.chapterSectionIds;
          const empCtx = empIds
            .filter(id => id !== sec.id && contentRef.current[id])
            .map(id => `[${id}]: ${contentRef.current[id].substring(0, 2000)}...`)
            .join("\n\n");
          const nonEmpPrev = Object.entries(contentRef.current)
            .filter(([k]) => !empIds.includes(k))
            .slice(-1)
            .map(([k, v]) => `[${k}]: ${v.substring(0, 500)}...`)
            .join("\n\n");
          return [nonEmpPrev, empCtx].filter(Boolean).join("\n\n");
        })()
      : Object.entries(contentRef.current).slice(-2).map(([k, v]) => `[${k}]: ${v.substring(0, 500)}...`).join("\n\n");
    const approxParas = Math.max(3, Math.round((sec.pages || 1) * 3.5));
    const planSummary = sections
      .filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type))
      .map(s => s.label)
      .join("\n");
    const typeHints = {
      theory: "теоретичний — визначення понять, аналіз літератури, огляд наукових підходів",
      analysis: "аналітично-практичний — аналіз даних, виявлення закономірностей, порівняння",
      recommendations: "рекомендаційний — практичні пропозиції, шляхи вирішення, прогнози",
    };
    let instruction = "";
    const totalPages = parsePagesAvg(d?.pages);
    const isLarge = totalPages > 40; // більше 40 стор — великий обсяг

    if (sec.type === "intro") {
      // Завдань — зазвичай стільки скільки підрозділів основної частини
      const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
      const tasksCount = Math.min(mainSecs.length, isLarge ? 8 : 5);

      // Будуємо список елементів вступу: стандартні + з методички
      const defaultComponents = ["актуальність теми", "мета дослідження", "завдання дослідження", "об'єкт дослідження", "предмет дослідження", "методи дослідження", "структура роботи"];
      const allComponents = methodInfo?.introComponents?.length
        ? methodInfo.introComponents
        : defaultComponents;

      // Формуємо рядки структури
      const componentLines = allComponents.map((comp, i) => {
        const label = comp.charAt(0).toUpperCase() + comp.slice(1);
        if (/актуальн/i.test(comp)) {
          return `${label} (2 абзаци): абзац починається словами "Актуальність теми." — далі одразу сильне речення про проблему. Покажи чому тема важлива сьогодні, стан дослідженості у вітчизняній та зарубіжній науці.`;
        }
        if (/мета/i.test(comp)) {
          return `${label}: абзац починається словами "Метою роботи є" — далі чітко сформульована мета, що відповідає темі "${d.topic}".`;
        }
        if (/завдання/i.test(comp)) {
          return `${label} (${tasksCount} завдань): абзац починається словами "Для досягнення мети поставлено такі завдання:" — далі нумерований перелік. Завдання відповідають підрозділам:\n${mainSecs.map((s, j) => `   ${j + 1}) "${s.label}"`).join("\n")}`;
        }
        if (/об.єкт/i.test(comp)) {
          return `${label}: абзац починається словами "Об'єктом дослідження є" — далі явище або процес, що досліджується.`;
        }
        if (/предмет/i.test(comp)) {
          return `${label}: абзац починається словами "Предметом дослідження є" — далі конкретний аспект об'єкта, який аналізується.`;
        }
        if (/метод/i.test(comp)) {
          return `${label}: абзац починається словами "Для вирішення поставлених завдань використано такі методи:" — далі перелік методів відповідно до теми.`;
        }
        if (/структура/i.test(comp)) {
          return `${label}: абзац починається словами "Робота складається з вступу," — далі к-сть розділів, висновки, список джерел, загальний обсяг сторінок.`;
        }
        return `${label}: абзац починається з природного формулювання (НЕ повторювати мітку "${label}" двічі) — зміст відповідно до теми "${d.topic}".`;
      });

      // Контекст основних розділів для вступу — щоб вибірка, методика і результати збігались
      const introMainCtx = mainSecs
        .map(s => contentRef.current[s.id]
          ? `[${s.label}]: ${contentRef.current[s.id].substring(0, 600)}...`
          : "")
        .filter(Boolean)
        .join("\n\n");

      instruction = `Напиши ВСТУП для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.

СТРУКТУРА ВСТУПУ (дотримуватись суворо, кожен елемент з нового абзацу):

${componentLines.map((l, i) => `${i + 1}. ${l}`).join("\n\n")}
${methodInfo?.otherRequirements ? `\nВИМОГИ МЕТОДИЧКИ: ${methodInfo.otherRequirements}` : ""}${commentAnalysis?.textStructureHints ? `\nПІДКАЗКИ ЩОДО СТРУКТУРИ (з коментаря клієнта): ${commentAnalysis.textStructureHints}` : ""}
${introMainCtx ? `\nЗМІСТ ОСНОВНИХ РОЗДІЛІВ (використай для точного формулювання методів, вибірки, об'єкта — все має збігатись з текстом роботи):\n${introMainCtx}` : ""}

ВАЖЛИВО: кожен абзац починається так, як вказано вище — НЕ писати окремо мітку ("Мета.") і потім знову те саме слово ("Метою роботи..."). Назви НЕ виділяй жирним. НЕ додавай посилань. Пиши суцільним текстом абзацами.`;

    } else if (sec.type === "conclusions") {
      const conclusionsParas = isLarge ? "10-12" : "7";
      const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
      // Для висновків: емпіричні підрозділи передаємо з широким контекстом (1800 символів),
      // решта — стисло (300 символів), щоб модель точно знала вибірку і методику
      const empSecsForConcl = getEmpiricalSections(sections, d);
      const empIdsSet = new Set(empSecsForConcl.chapterSectionIds);
      const allCtx = mainSecs.map(s => {
        const text = contentRef.current[s.id];
        if (!text) return "";
        const limit = empIdsSet.has(s.id) ? 1800 : 1000;
        return `[${s.label}]: ${text.substring(0, limit)}...`;
      }).filter(Boolean).join("\n\n");

      const conclReq = methodInfo?.conclusionsRequirements || "";

      instruction = `Напиши ВИСНОВКИ для ${d.type} на тему "${d.topic}".
${conclReq ? `ВИМОГИ МЕТОДИЧКИ: ${conclReq}\n` : ""}${commentAnalysis?.textStructureHints ? `ПІДКАЗКИ ЩОДО СТРУКТУРИ (з коментаря клієнта): ${commentAnalysis.textStructureHints}\n` : ""}
ПРАВИЛА:
- Обсяг: ${conclusionsParas} абзаців
- Кожен абзац = один конкретний результат або висновок дослідження
- Перший абзац — загальний підсумок мети і що вдалось досягти
- Далі — по одному абзацу на кожен виконаний підрозділ/завдання, конкретні результати
- Останній абзац — перспективи подальших досліджень
- НЕ повторювати те що сказано у вступі, НЕ вводити нову інформацію
- Без посилань. Без жирного. Без нумерації. Пиши суцільними абзацами, не використовуй жодних списків.

ЗМІСТ ПІДРОЗДІЛІВ (для формулювання конкретних висновків):
${allCtx || planSummary}`;

    } else if (sec.type === "chapter_conclusion") {
      // Беремо підрозділи цього розділу і їх тексти для контексту
      const chapNum = sec.chapterNum || sec.id.split(".")[0];
      const chapSubs = sections.filter(s => s.id.split(".")[0] === chapNum && s.type !== "chapter_conclusion");
      const chapCtx = chapSubs.map(s => contentRef.current[s.id] ? `[${s.label}]: ${contentRef.current[s.id].substring(0, 400)}...` : "").filter(Boolean).join("\n\n");
      const chapConclReq = methodInfo?.chapterConclusionRequirements || "стисло підсумуй основні думки підрозділів, кожен абзац = один підрозділ";
      instruction = `Напиши "Висновки до розділу ${chapNum}" для ${d.type} на тему "${d.topic}".
${methodInfo?.chapterConclusionRequirements ? `ВИМОГИ МЕТОДИЧКИ: ${methodInfo.chapterConclusionRequirements}` : ""}
Обсяг: 1 сторінка (~4-5 абзаців). ${chapConclReq}.
Без нової інформації. Без посилань. Без жирного. Без нумерації. Пиши суцільними абзацами.
${chapCtx ? "ЗМІСТ ПІДРОЗДІЛІВ РОЗДІЛУ:\n" + chapCtx : ""}`;
    } else {
      // Вимоги з методички для цього типу підрозділу
      const methodReqMap = {
        theory: methodInfo?.theoryRequirements,
        analysis: methodInfo?.analysisRequirements,
        recommendations: methodInfo?.analysisRequirements,
      };
      const methodReq = methodReqMap[sec.type] || methodInfo?.otherRequirements || "";

      const empSecs = getEmpiricalSections(sections, d);
      const isEmpChapter = empSecs.chapterSectionIds.includes(sec.id);
      const isEmpAnchor = empSecs.anchorId === sec.id;
      let empiricalBlock = "";

      // Економічний блок
      const econSecIds = getEconSections(sections, d);
      const isEconSec = econSecIds.includes(sec.id);
      let econBlock = "";
      if (isEconSec) {
        const secFormulas = (methodInfo?.requiredFormulas || []).filter(f => !f.section || f.section === sec.type);
        const secTables = (methodInfo?.requiredTables || []).filter(t => !t.section || t.section === sec.type);
        const formulasBlock = secFormulas.length
          ? `\nОБОВ'ЯЗКОВІ ФОРМУЛИ З МЕТОДИЧКИ (підстав реалістичні числові значення та підрахуй результат):\n${secFormulas.map(f =>
              `- ${f.name}: ${f.formula}\n  Змінні: ${f.variables}${f.interpretation ? `\n  Інтерпретація: ${f.interpretation}` : ""}`
            ).join("\n")}`
          : "";
        const tablesBlock = secTables.length
          ? `\nОБОВ'ЯЗКОВІ ТАБЛИЦІ З МЕТОДИЧКИ (відтвори структуру, заповни реалістичними даними під тему "${d.topic}"):\n${secTables.map(t =>
              `- ${t.name}\n  Структура: ${t.structure}\n  Що заповнювати: ${t.instructions}`
            ).join("\n")}`
          : "";
        const genericEcon = !secFormulas.length && !secTables.length
          ? `\nОБОВ'ЯЗКОВО для цього підрозділу (економічна/управлінська робота):
- Додай мінімум одну таблицю markdown (|---|---| формат) з конкретними числовими даними (показники за 2-3 роки або порівняння з нормою/конкурентами)
- Після таблиці — аналіз динаміки або відхилень, конкретні висновки з цифрами
- Якщо підрозділ рекомендаційний: додай таблицю прогнозних або планових показників після впровадження рекомендацій`
          : "";
        econBlock = `${formulasBlock}${tablesBlock}${genericEcon}`;
      }

      const appendixBlock = appendicesText
        ? `\nДОДАТОК А (вже згенерований — спирайся на нього точно):\n${appendicesText.substring(0, 3000)}\n`
        : "";

      if (isEmpChapter) {
        empiricalBlock = `

КОНТЕКСТ (психолого-педагогічне емпіричне дослідження):
${appendixBlock}Цей підрозділ є частиною емпіричного дослідження. Визнач за назвою підрозділу що саме писати:
- якщо підрозділ про організацію або методику дослідження: опиши вибірку (20-30 респондентів: вік, категорія, умови відбору), метод анкетування, мету та кількість запитань точно як в Додатку А, принцип проведення. Додай речення: "Анкета наведена у Додатку А."
- якщо підрозділ про аналіз або результати: подай результати у вигляді таблиці markdown (|---|---| формат) з відсотковими показниками по запитаннях з Додатку А, проаналізуй дані, зроби висновки
- якщо підрозділ про рекомендації або практичні висновки: спирайся на результати анкетування вже описані в попередніх підрозділах, не повторюй опис анкети та вибірки`;
      } else if (isEmpAnchor) {
        empiricalBlock = `

ОБОВ'ЯЗКОВО для цього підрозділу (психолого-педагогічне дослідження):
${appendixBlock}Цей підрозділ має містити емпіричне дослідження що відповідає Додатку А:
1. Вибірка: 25-30 респондентів (вік, категорія, умови відбору).
2. Метод: анкетування. Мета анкети, кількість запитань — точно як в Додатку А.
3. Принцип проведення: умови та порядок анкетування.
4. Результати: таблиця markdown (|---|---| формат) з відсотковими показниками по запитаннях з Додатку А.
5. Аналіз: інтерпретація результатів таблиці, зв'язок із темою.
6. В тексті додай: "Анкета наведена у Додатку А."`;
      }

      // sources-first: додаємо джерела як контекст для генерації
      const secSourceLines = workflowMode === "sources-first"
        ? (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean)
        : [];
      const sourcesBlock = secSourceLines.length > 0
        ? `\nДЖЕРЕЛА ДЛЯ ЦЬОГО ПІДРОЗДІЛУ (${secSourceLines.length} шт.) — спирайся на них при написанні, вставляй посилання [N] після відповідних тверджень:\n${secSourceLines.map((s, i) => {
            const snippet = abstractsMap[s];
            return snippet ? `[${i + 1}] ${s}\n    Зміст: ${snippet}` : `[${i + 1}] ${s}`;
          }).join("\n")}\n`
        : "";
      const citNote = secSourceLines.length > 0
        ? "Вставляй [N] у текст одразу після тверджень що спираються на джерело (де N — номер зі списку вище). ЗАБОРОНЕНО вигадувати імена авторів перед цитатою — не пиши 'Іванов А. стверджує...'. Використовуй безособові конструкції: 'у дослідженні зазначається [N]', 'науковці вказують [N]', 'встановлено [N]' тощо."
        : "Без посилань [1],[2].";

      instruction = `Напиши підрозділ "${sec.label}" для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.
Тип підрозділу: ${typeHints[sec.type] || "основний"}.
${methodReq ? `ВИМОГИ МЕТОДИЧКИ ДО ЦЬОГО РОЗДІЛУ: ${methodReq}` : ""}${empiricalBlock}${econBlock}${sourcesBlock}
ПЛАН РОБОТИ (для розуміння структури та уникнення повторів):
${planSummary}

${prevCtx ? `КОНТЕКСТ ПОПЕРЕДНІХ ПІДРОЗДІЛІВ:\n${prevCtx}\n` : ""}Обсяг: ~${approxParas} абзаців (~${sec.pages} стор.).
Не обривай текст. Завершуй підсумковим абзацом. ${citNote} Без жирного.
Абзаци мають різнитись за довжиною: чергуй короткі (2-3 речення) з довшими (5-7 речень).`;
    }
    if (commentAnalysis?.writingHints) instruction += `\n\nПІДКАЗКИ З КОМЕНТАРЯ КЛІЄНТА (врахуй при написанні):\n${commentAnalysis.writingHints}`;
    const sectionMaxTokens = Math.min(60000, Math.max(8000, Math.round((sec.pages || 1) * 3000)));
    try {
      const raw = await callClaude([{ role: "user", content: instruction }], ctrl.signal, buildSYS(lang, methodInfo), sectionMaxTokens, (s) => setLoadMsg(`Генерую: ${sec.label}... зачекайте ${s}с`));
      // Видаляємо довге тире на всякий випадок (модель іноді ігнорує заборону)
      const result = raw
        .replace(/ — /g, ", ").replace(/— /g, "").replace(/ —/g, "")
        .replace(/[\u1100-\u11FF\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7FF\uF900-\uFAFF]/g, "")
        .replace(/[„""]([^"„""]*)["""]/g, "«$1»")
        .replace(/"([^"]*)"/g, "«$1»");
      const newContent = { ...contentRef.current, [sec.id]: result };
      setContent(newContent);
      runningRef.current = false; setRunning(false); setLoadMsg("");
      await saveToFirestore({ content: newContent, stage: "writing", status: "writing", genIdx: genIdx + 1 });
      // Пауза між підрозділами щоб не вичерпати rate limit
      await new Promise(r => setTimeout(r, 2000));
      setGenIdx(g => g + 1);
    } catch (e) {
      if (e.name === "AbortError") {
        runningRef.current = false; setRunning(false); setPaused(true); setLoadMsg("");
      } else {
        console.error(e);
        runningRef.current = false; setRunning(false); setPaused(true);
        setApiError(e.message);
        setLoadMsg("⚠ " + e.message);
      }
    }
  };

  // ── Переписати один підрозділ ──
  const doRegenSection = async (sec) => {
    setRegenLoading(true);
    const d = info;
    const lang = d?.language || "Українська";
    const approxParas = Math.max(3, Math.round((sec.pages || 1) * 3.5));
    const customInstructions = regenPrompt ? `\nДОДАТКОВІ ВИМОГИ: ${regenPrompt}` : "";
    const originalText = contentRef.current[sec.id] || "";
    const origSnippet = originalText ? `ОРИГІНАЛЬНИЙ ТЕКСТ (збережи структуру, покращ стиль):\n${originalText.substring(0, 800)}...\n` : "";

    let instruction = "";
    const totalPages = parsePagesAvg(d?.pages);
    const isLarge = totalPages > 40;

    if (sec.type === "intro") {
      const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
      const tasksCount = Math.min(mainSecs.length, isLarge ? 8 : 5);
      const defaultComponents = ["актуальність теми", "мета дослідження", "завдання дослідження", "об'єкт дослідження", "предмет дослідження", "методи дослідження", "структура роботи"];
      const allComponents = methodInfo?.introComponents?.length ? methodInfo.introComponents : defaultComponents;
      const componentLines = allComponents.map((comp) => {
        const label = comp.charAt(0).toUpperCase() + comp.slice(1);
        if (/актуальн/i.test(comp)) return `${label} (2 абзаци): абзац починається словами "Актуальність теми." — далі одразу сильне речення про проблему.`;
        if (/мета/i.test(comp)) return `${label}: абзац починається словами "Метою роботи є" — далі чітко сформульована мета.`;
        if (/завдання/i.test(comp)) return `${label} (${tasksCount} завдань): абзац починається словами "Для досягнення мети поставлено такі завдання:" — далі нумерований перелік.`;
        if (/об.єкт/i.test(comp)) return `${label}: абзац починається словами "Об'єктом дослідження є" — далі явище або процес.`;
        if (/предмет/i.test(comp)) return `${label}: абзац починається словами "Предметом дослідження є" — далі конкретний аспект об'єкта.`;
        if (/метод/i.test(comp)) return `${label}: абзац починається словами "Для вирішення поставлених завдань використано такі методи:" — далі перелік.`;
        if (/структура/i.test(comp)) return `${label}: абзац починається словами "Робота складається з вступу," — далі к-сть розділів, висновки, список джерел.`;
        return `${label}: абзац починається з природного формулювання (НЕ повторювати мітку "${label}" двічі).`;
      });

      instruction = `Перепиши ВСТУП для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.
${origSnippet}
СТРУКТУРА ВСТУПУ (суворо дотримуватись):

${componentLines.map((l, i) => `${i + 1}. ${l}`).join("\n")}
${methodInfo?.otherRequirements ? `\nВИМОГИ МЕТОДИЧКИ: ${methodInfo.otherRequirements}` : ""}
ВАЖЛИВО: кожен абзац починається так, як вказано вище — НЕ писати окремо мітку ("Мета.") і потім знову те саме слово ("Метою роботи..."). Назви НЕ виділяй жирним. Без посилань. Без нумерації у тексті.${customInstructions}`;

    } else if (sec.type === "conclusions") {
      const conclusionsParas = isLarge ? "10-12" : "7";
      const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
      const allCtx = mainSecs.map(s => contentRef.current[s.id]
        ? `[${s.label}]: ${contentRef.current[s.id].substring(0, 300)}...` : "").filter(Boolean).join("\n\n");

      instruction = `Перепиши ВИСНОВКИ для ${d.type} на тему "${d.topic}".
${origSnippet}
${methodInfo?.conclusionsRequirements ? `ВИМОГИ МЕТОДИЧКИ: ${methodInfo.conclusionsRequirements}\n` : ""}
Обсяг: ${conclusionsParas} абзаців. Кожен абзац = один конкретний результат.
Перший — загальний підсумок. Далі по одному на кожен підрозділ. Останній — перспективи.
НЕ повторювати вступ. НЕ вводити нове. Без посилань. Без жирного. Без нумерації.
${allCtx ? `\nЗМІСТ ПІДРОЗДІЛІВ:\n${allCtx}` : ""}${customInstructions}`;
    } else {
      const empSecsRegen = getEmpiricalSections(sections, d);
      const isEmpChapterRegen = empSecsRegen.chapterSectionIds.includes(sec.id);
      const isEmpAnchorRegen = empSecsRegen.anchorId === sec.id;
      let empiricalBlockRegen = "";

      const econSecIdsRegen = getEconSections(sections, d);
      const isEconSecRegen = econSecIdsRegen.includes(sec.id);
      let econBlockRegen = "";
      if (isEconSecRegen) {
        const secFormulas = (methodInfo?.requiredFormulas || []).filter(f => !f.section || f.section === sec.type);
        const secTables = (methodInfo?.requiredTables || []).filter(t => !t.section || t.section === sec.type);
        const formulasBlock = secFormulas.length
          ? `\nОБОВ'ЯЗКОВІ ФОРМУЛИ З МЕТОДИЧКИ (підстав реалістичні числові значення та підрахуй результат):\n${secFormulas.map(f =>
              `- ${f.name}: ${f.formula}\n  Змінні: ${f.variables}${f.interpretation ? `\n  Інтерпретація: ${f.interpretation}` : ""}`
            ).join("\n")}`
          : "";
        const tablesBlock = secTables.length
          ? `\nОБОВ'ЯЗКОВІ ТАБЛИЦІ З МЕТОДИЧКИ (відтвори структуру, заповни реалістичними даними під тему "${d.topic}"):\n${secTables.map(t =>
              `- ${t.name}\n  Структура: ${t.structure}\n  Що заповнювати: ${t.instructions}`
            ).join("\n")}`
          : "";
        const genericEcon = !secFormulas.length && !secTables.length
          ? `\nОБОВ'ЯЗКОВО: мінімум одна таблиця markdown з числовими даними, аналіз динаміки з цифрами${sec.type === "recommendations" ? ", таблиця прогнозних показників після впровадження рекомендацій" : ""}`
          : "";
        econBlockRegen = `${formulasBlock}${tablesBlock}${genericEcon}`;
      }

      if (isEmpChapterRegen) {
        empiricalBlockRegen = `

КОНТЕКСТ (психолого-педагогічне емпіричне дослідження):
Визнач за назвою підрозділу що писати: організація/методика → вибірка 20-30 осіб + анкетування + "Анкета у Додатку А"; аналіз/результати → таблиці markdown + інтерпретація; рекомендації → на основі результатів без повтору опису анкети.`;
      } else if (isEmpAnchorRegen) {
        empiricalBlockRegen = `

ОБОВ'ЯЗКОВО: вибірка 25-30 осіб, метод анкетування, принцип проведення, таблиця результатів markdown, аналіз, "Анкета у Додатку А."`;
      }

      instruction = `Перепиши підрозділ "${sec.label}" для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.
${origSnippet}${empiricalBlockRegen}${econBlockRegen}
Обсяг: ~${approxParas} абзаців (~${sec.pages} стор.).
Не обривай текст. Завершуй підсумковим абзацом. Без посилань. Без жирного.${customInstructions}`;
    }
    const regenMaxTokens = Math.min(60000, Math.max(8000, Math.round((sec.pages || 1) * 3000)));
    try {
      const raw = await callClaude([{ role: "user", content: instruction }], null, buildSYS(lang, methodInfo), regenMaxTokens);
      const result = raw
        .replace(/ — /g, ", ").replace(/— /g, "").replace(/ —/g, "")
        .replace(/[\u1100-\u11FF\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7FF\uF900-\uFAFF]/g, "")
        .replace(/[„""]([^"„""]*)["""]/g, "«$1»")
        .replace(/"([^"]*)"/g, "«$1»");
      const newContent = { ...contentRef.current, [sec.id]: result };
      setContent(newContent);
      setRegenId(null); setRegenPrompt("");
      await saveToFirestore({ content: newContent });
    } catch (e) { console.error(e); }
    setRegenLoading(false);
  };

  const generateSpeech = async () => {
    setSpeechLoading(true);
    try {
      const lang = info?.language || "Українська";

      // ── Контекст 1: слайди презентації (якщо є) ──
      let slidesOutline = "";
      if (slideJson?.slides?.length) {
        const LAYOUT_LABEL = {
          hero: "Титульний/фінальний", two_column: "Два стовпці", stat_callout: "Статистика",
          icon_list: "Список з іконками", highlight_box: "Виділені пункти", numbered_steps: "Кроки",
        };
        slidesOutline = slideJson.slides
          .map((sl, i) => {
            const label = LAYOUT_LABEL[sl.layout] || sl.layout;
            const parts = [`Слайд ${i + 1} [${label}]: ${sl.title || ""}`];
            if (sl.subtitle) parts.push(`  Підзаголовок: ${sl.subtitle}`);
            if (sl.left) parts.push(`  Ліво: ${sl.left}`);
            if (sl.right) parts.push(`  Право: ${sl.right}`);
            if (sl.right_value) parts.push(`  Ключове число: ${sl.right_value} — ${sl.right_label || ""}`);
            if (sl.content) parts.push(`  Текст: ${sl.content}`);
            if (sl.accent) parts.push(`  Акцент: ${sl.accent}`);
            if (sl.visual?.stats?.length) parts.push(`  Статистика: ${sl.visual.stats.map(s => `${s.value} (${s.label})`).join(", ")}`);
            if (sl.visual?.items?.length) parts.push(`  Пункти: ${sl.visual.items.map(it => typeof it === "object" ? `${it.header || ""}: ${it.text || ""}` : it).join(" | ")}`);
            if (sl.points?.length) parts.push(`  Пункти: ${sl.points.join(" | ")}`);
            if (sl.steps?.length) parts.push(`  Кроки: ${sl.steps.map(st => `${st.num}. ${st.title} — ${st.text}`).join(" | ")}`);
            return parts.join("\n");
          })
          .join("\n\n");
      }

      // ── Контекст 2: секції роботи ──
      const sectionSummaries = sections
        .filter(s => s.type !== "sources")
        .map(s => { const txt = content[s.id] || ""; return txt ? `### ${s.label}\n${txt.substring(0, 600)}` : ""; })
        .filter(Boolean).join("\n\n");

      const prompt = `Напиши текст доповіді для захисту ${info?.type || "наукової роботи"} перед науковою комісією на тему "${info?.topic}".

${slidesOutline ? `СТРУКТУРА ПРЕЗЕНТАЦІЇ (виступ йде паралельно з нею):
${slidesOutline}

` : ""}ЗМІСТ РОБОТИ (звідси брати конкретні факти, методи, результати, цифри):
${sectionSummaries}

ВИМОГИ ДО ТЕКСТУ:
- Обсяг: 5-7 хвилин (2-3 сторінки), кожен слайд — 2-4 речення
- Перед кожним блоком постав мітку: "Слайд 1", "Слайд 2" і т.д. на окремому рядку
- Стиль: стриманий академічний усний — не читання реферату, але й не розмова. Науковець звітує перед комісією
- Конкретність: кожне речення має нести факт, метод, результат або висновок. Жодних загальних фраз типу "тема є актуальною", "у роботі розглядається", "слід зазначити"
- Якщо є числа, відсотки, назви методів — обов'язково вживай їх
- Переходи між слайдами — одне коротке речення: "Перейдемо до...", "Наступний слайд демонструє...", "Звернімось до результатів..."
- НЕ виводь назви розділів, підрозділів та їх номери
- Мова: ${lang}
- Без markdown, зірочок, жирного — тільки мітки "Слайд N" і звичайний текст`;

      const raw = await callGemini(
        [{ role: "user", content: prompt }], null,
        `You are an expert academic writing assistant. Write a concise, factual oral defense speech for a scientific committee. Every sentence must state a concrete fact, method, result or conclusion — no filler phrases. No markdown formatting.`, 4000,
        null, "gemini-2.5-flash-lite"
      );

      const result = raw
        .split("\n")
        .filter(line => {
          const t = line.trim();
          if (!t) return true;
          if (/^Слайд\s+\d+/i.test(t)) return true; // мітки слайдів — залишаємо
          if (/^\d+(\.\d+)+[\s\.]/.test(t)) return false; // "1.1 Назва", "2.3.1 ..."
          if (/^(ВСТУП|ВИСНОВКИ|РОЗДІЛ|ЗМІСТ|ДОДАТКИ?|СПИСОК\s+ЛІТЕРАТУРИ)$/i.test(t)) return false;
          if (/^#{1,6}\s/.test(t)) return false; // markdown заголовки
          return true;
        })
        .join("\n")
        .replace(/ — /g, ", ").replace(/— /g, "").replace(/ —/g, "")
        .replace(/[\u1100-\u11FF\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7FF\uF900-\uFAFF]/g, "")
        .replace(/[„""]([^"„""]*)["""]/g, "«$1»")
        .replace(/"([^"]*)"/g, "«$1»")
        .replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");

      setSpeechText(result);
      await saveToFirestore({ speechText: result });
    } catch (e) { alert("Помилка генерації доповіді: " + e.message); }
    setSpeechLoading(false);
  };

  const doGenAppendices = async () => {
    setAppendicesLoading(true);
    try {
      const lang = info?.language || "Українська";

      // План підрозділів для контексту (текст ще може бути не згенерований)
      const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
      const planBlock = mainSecs.length
        ? `СТРУКТУРА РОБОТИ:\n${mainSecs.map(s => `- ${s.label} (${s.type})`).join("\n")}`
        : "";

      const methodBlock = methodInfo?.theoryRequirements || methodInfo?.analysisRequirements || methodInfo?.otherRequirements
        ? `ВИМОГИ МЕТОДИЧКИ: ${[methodInfo.theoryRequirements, methodInfo.analysisRequirements, methodInfo.otherRequirements].filter(Boolean).join(". ")}`
        : "";

      const clientBlock = commentAnalysis?.writingHints
        ? `ПОБАЖАННЯ КЛІЄНТА: ${commentAnalysis.writingHints}`
        : "";

      const customBlock = appendicesCustomPrompt.trim()
        ? `\nДОДАТКОВІ ІНСТРУКЦІЇ: ${appendicesCustomPrompt.trim()}`
        : "";

      const empSecs = getEmpiricalSections(sections, info);
      const hasEmpChapter = empSecs.chapterSectionIds.length > 0 || empSecs.anchorId;

      const prompt = (isPsychoPed(info) || hasEmpChapter) && !appendicesCustomPrompt.trim()
        ? `Згенеруй Додаток А для ${info?.type || "наукової роботи"} на тему "${info?.topic}". Галузь: ${info?.subject}.
${planBlock}
${methodBlock}
${clientBlock}

Додаток А містить анкету для емпіричного дослідження відповідно до теми роботи.
Визнач об'єкт дослідження з теми (хто респонденти: учні, студенти, педагоги, батьки тощо).
Визнач що саме досліджується (рівень сформованості, ставлення, знання, мотивація тощо).

Вимоги до анкети:
- Перший рядок: ДОДАТОК А
- Другий рядок: назва анкети відповідно до теми та об'єкту дослідження
- Звернення до респондента та інструкція (2-3 речення)
- 12-15 запитань закритого типу з варіантами відповідей: а), б), в), г)
- Запитання логічно охоплюють різні аспекти теми — структура анкети має відповідати підрозділам розділу 2
- В кінці: "Дякуємо за участь у дослідженні!"
- Мова: ${lang}
- БЕЗ markdown, зірочок, жирного. Звичайний текст.`
        : `Згенеруй розділ "Додатки" для ${info?.type || "наукової роботи"} на тему "${info?.topic}". Галузь: ${info?.subject || ""}.
${planBlock}
${methodBlock}
${clientBlock}
${customBlock || `Включи один або два додатки що логічно доповнюють роботу відповідно до теми та структури (таблиці, схеми, зразки документів тощо).`}
Мова: ${lang}. БЕЗ markdown, зірочок, жирного. Кожен додаток починається з нового рядка: ДОДАТОК А, ДОДАТОК Б тощо.`;

      const raw = await callClaude(
        [{ role: "user", content: prompt }], null, buildSYS(lang, methodInfo), 6000, null, MODEL
      );
      const result = raw
        .replace(/ — /g, ", ").replace(/— /g, "").replace(/ —/g, "")
        .replace(/[\u1100-\u11FF\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7FF\uF900-\uFAFF]/g, "")
        .replace(/[„""]([^"„""]*)["""]/g, "«$1»")
        .replace(/"([^"]*)"/g, "«$1»");
      setAppendicesText(result);
      await saveToFirestore({ appendicesText: result });
    } catch (e) { alert("Помилка генерації додатків: " + e.message); }
    setAppendicesLoading(false);
  };

  const generatePresentation = async () => {
    setPresentationLoading(true);
    setPresentationMsg("Аналізую текст роботи...");
    try {
      const lang = info?.language || "Українська";

      // ── Крок 1: Gemini аналізує текст ──
      const fullText = sections
        .filter(s => s.type !== "sources")
        .map(s => { const txt = content[s.id] || ""; return txt ? `### ${s.label}\n${txt.substring(0, 1500)}` : ""; })
        .filter(Boolean).join("\n\n");

      const geminiPrompt = `Проаналізуй наукову роботу та витягни структуровані дані для презентації. Поверни ТІЛЬКИ валідний JSON без markdown:
{
  "problem": "головна наукова проблема або гіпотеза (1-2 речення)",
  "relevance": ["теза актуальності 1", "теза актуальності 2"],
  "methodology": {
    "object": "об'єкт дослідження",
    "subject": "предмет дослідження",
    "methods": ["метод 1", "метод 2", "метод 3"],
    "tools": ["інструмент або база 1", "інструмент 2"]
  },
  "literature_summary": ["що вже досліджено 1", "що вже досліджено 2"],
  "literature_gap": "прогалина або невирішена проблема (1 речення)",
  "results": [
    {"title": "назва першого результату", "points": ["пункт 1", "пункт 2"], "key_number": "число або % якщо є, інакше null"},
    {"title": "назва другого результату", "points": ["пункт 1", "пункт 2"], "key_number": null},
    {"title": "назва третього результату", "points": ["пункт 1", "пункт 2"], "key_number": null}
  ],
  "conclusions": ["висновок 1", "висновок 2", "висновок 3", "висновок 4", "висновок 5"],
  "practical_value": ["де застосувати 1", "де застосувати 2"],
  "field": "одне з: tech / medicine / social / economics / default"
}

ТЕКСТ РОБОТИ:
${fullText}`;

      const geminiRaw = await callGemini(
        [{ role: "user", content: geminiPrompt }], null,
        SYS_JSON_SHORT, 4000,
        (s) => setPresentationMsg(`Аналізую... зачекайте ${s}с`), "gemini-2.5-flash-lite"
      );

      let analysis;
      try {
        analysis = JSON.parse(geminiRaw.replace(/```json\n?|\n?```/g, "").trim());
      } catch { throw new Error("Gemini повернув некоректний JSON аналізу"); }

      // ── Крок 2: Claude генерує зміст слайдів ──
      setPresentationMsg("Генерую слайди...");

      const themeMap = { tech: "midnight", medicine: "forest", social: "coral", economics: "slate" };
      const defaultTheme = themeMap[analysis.field] || "warm";

      const claudePrompt = `На основі аналізу наукової роботи згенеруй зміст 13 слайдів презентації для захисту.

МЕТАДАНІ РОБОТИ:
- Тип: ${info?.type || "наукова робота"}
- Тема: ${info?.topic || ""}
- Галузь: ${info?.direction || info?.subject || ""}
- Мова виступу: ${lang}

АНАЛІЗ РОБОТИ (від Gemini):
${JSON.stringify(analysis, null, 2)}

СТРУКТУРА — рівно 13 слайдів, суворо в такому порядку:
1.  layout "hero"            — title: тема роботи, subtitle: тип · ${new Date().getFullYear()}
2.  layout "two_column"      — Актуальність: left=формулювання проблеми, right_type="text", right=чому це важливо
3.  layout "icon_list"       — Мета та завдання: visual.items з icon/header/text (мета + 3-4 завдання)
4.  layout "highlight_box"   — Стан питання: points=огляд літератури, accent=прогалина у дослідженнях
5.  layout "two_column"      — Методологія — об'єкт і предмет: left=опис, right_type="text", right=ключовий аспект
6.  layout "numbered_steps"  — Методи дослідження: visual.items [{"num":"1","title":"назва","text":"1 речення"}]
7.  layout "highlight_box"   — Інструментарій та база: points=перелік
8.  layout "stat_callout"    — Результати I: visual.stats=[{"value":"...","label":"..."}] + content=опис
9.  layout "two_column"      — Результати II: left=опис, right_type="stat"/"text" + right_value/right
10. layout "highlight_box"   — Результати III: points=пункти
11. layout "icon_list"       — Висновки: visual.items з icon/header/text (5 пунктів)
12. layout "two_column"      — Практичне значення: left=опис застосування, right_type="text", right=сфери впровадження
13. layout "hero"            — Фінальний: title="Дякую за увагу!", subtitle залиш порожнім

ПРАВИЛА:
- Мова всіх текстів: ${lang}
- Кожен пункт/item: 1-2 речення, конкретно, без «води»
- Якщо є числа або % — витягни у visual.stats: [{"value":"87%","label":"точність моделі"}]
- icon_list items: [{"icon":"🎯","header":"коротка назва","text":"1 речення деталей"}]
- numbered_steps items: [{"num":"1","title":"Назва методу","text":"1 речення опису"}]
- right_type: "stat" якщо є одне ключове число/% (≤6 символів), інакше "text"
- Якщо для слайду 8 (stat_callout) нема чисел — використай layout "highlight_box" замість нього
- Не додавай полів, яких нема у відповідному layout

Поверни ТІЛЬКИ валідний JSON без markdown:
{
  "theme": "${defaultTheme}",
  "slides": [ ... рівно 13 об'єктів ... ]
}`;

      const claudeRaw = await callClaude(
        [{ role: "user", content: claudePrompt }], null,
        SYS_JSON_SHORT, 5000,
        (s) => setPresentationMsg(`Генерую слайди... зачекайте ${s}с`), MODEL_FAST
      );

      let slideData;
      try {
        slideData = JSON.parse(claudeRaw.replace(/```json\n?|\n?```/g, "").trim());
      } catch { throw new Error("Claude повернув некоректний JSON слайдів"); }

      // ── Крок 3: Створюємо PPTX ──
      setPresentationMsg("Створюю файл...");
      await exportToPptxFile(slideData, info);

      setSlideJson(slideData);
      setPresentationReady(true);
      await saveToFirestore({ presentationReady: true, slideJson: slideData });
    } catch (e) { alert("Помилка генерації презентації: " + e.message); }
    setPresentationLoading(false);
    setPresentationMsg("");
  };

  const stopGen = () => { abortRef.current?.abort(); runningRef.current = false; setRunning(false); setPaused(true); setLoadMsg(""); };
  const resumeGen = () => { setApiError(""); setPaused(false); };

  // ── Переписати всю роботу з нуля (з урахуванням вже згенерованого контексту) ──
  const doRegenAll = async () => {
    if (!window.confirm("Переписати всю роботу повністю з нуля? Поточний текст буде замінено новим.")) return;
    const ctrl = new AbortController();
    regenAllAbortRef.current = ctrl;
    setRegenAllLoading(true);
    setApiError("");

    const d = info;
    const lang = d?.language || "Українська";
    const totalPages = parsePagesAvg(d?.pages);
    const isLarge = totalPages > 40;
    const secsToRegen = sections.filter(s => s.type !== "sources");
    const empSecs = getEmpiricalSections(sections, d);
    const empIdsSet = new Set(empSecs.chapterSectionIds);

    const buildFullCtx = (excludeId) =>
      sections
        .filter(s => s.id !== excludeId && contentRef.current[s.id] && s.type !== "sources")
        .map(s => {
          const limit = empIdsSet.has(s.id) ? 1800 : 1000;
          return `[${s.label}]: ${contentRef.current[s.id].substring(0, limit)}`;
        })
        .join("\n\n");

    for (let i = 0; i < secsToRegen.length; i++) {
      if (ctrl.signal.aborted) break;
      const sec = secsToRegen[i];
      setLoadMsg(`Переписую (${i + 1}/${secsToRegen.length}): ${sec.label}...`);

      const fullCtx = buildFullCtx(sec.id);
      const approxParas = Math.max(3, Math.round((sec.pages || 1) * 3.5));
      let instruction = "";

      if (sec.type === "intro") {
        const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
        const tasksCount = Math.min(mainSecs.length, isLarge ? 8 : 5);
        const defaultComponents = ["актуальність теми", "мета дослідження", "завдання дослідження", "об'єкт дослідження", "предмет дослідження", "методи дослідження", "структура роботи"];
        const allComponents = methodInfo?.introComponents?.length ? methodInfo.introComponents : defaultComponents;
        const componentLines = allComponents.map((comp) => {
          const label = comp.charAt(0).toUpperCase() + comp.slice(1);
          if (/актуальн/i.test(comp)) return `${label} (2 абзаци): починається "Актуальність теми."`;
          if (/мета/i.test(comp)) return `${label}: починається "Метою роботи є"`;
          if (/завдання/i.test(comp)) return `${label} (${tasksCount} завдань): починається "Для досягнення мети поставлено такі завдання:" — перелік відповідно до підрозділів:\n${mainSecs.map((s, j) => `  ${j + 1}) "${s.label}"`).join("\n")}`;
          if (/об.єкт/i.test(comp)) return `${label}: починається "Об'єктом дослідження є"`;
          if (/предмет/i.test(comp)) return `${label}: починається "Предметом дослідження є"`;
          if (/метод/i.test(comp)) return `${label}: починається "Для вирішення поставлених завдань використано такі методи:"`;
          if (/структура/i.test(comp)) return `${label}: починається "Робота складається з вступу,"`;
          return `${label}`;
        });
        instruction = `Напиши ВСТУП для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.
СТРУКТУРА ВСТУПУ (суворо, кожен елемент з нового абзацу):
${componentLines.map((l, idx) => `${idx + 1}. ${l}`).join("\n")}
${methodInfo?.otherRequirements ? `\nВИМОГИ МЕТОДИЧКИ: ${methodInfo.otherRequirements}` : ""}
${fullCtx ? `\nЗМІСТ РОЗДІЛІВ РОБОТИ (використай для точного формулювання вибірки, методів, результатів — все має збігатись):\n${fullCtx}` : ""}
НЕ виділяй жирним. НЕ додавай посилань. Пиши суцільним текстом абзацами.`;

      } else if (sec.type === "conclusions") {
        const conclusionsParas = isLarge ? "10-12" : "7";
        instruction = `Напиши ВИСНОВКИ для ${d.type} на тему "${d.topic}".
${methodInfo?.conclusionsRequirements ? `ВИМОГИ МЕТОДИЧКИ: ${methodInfo.conclusionsRequirements}\n` : ""}
Обсяг: ${conclusionsParas} абзаців. Перший — загальний підсумок мети і досягнутого. Далі по одному абзацу на кожен підрозділ з конкретними результатами. Останній — перспективи подальших досліджень.
Без посилань. Без жирного. Без нумерації. Суцільними абзацами.
${fullCtx ? `\nЗМІСТ РОЗДІЛІВ РОБОТИ:\n${fullCtx}` : ""}`;

      } else if (sec.type === "chapter_conclusion") {
        const chapNum = sec.chapterNum || sec.id.split(".")[0];
        instruction = `Напиши "Висновки до розділу ${chapNum}" для ${d.type} на тему "${d.topic}".
${methodInfo?.chapterConclusionRequirements ? `ВИМОГИ МЕТОДИЧКИ: ${methodInfo.chapterConclusionRequirements}` : ""}
Обсяг: ~4-5 абзаців. Без нової інформації. Без посилань. Без жирного. Без нумерації. Суцільними абзацами.
${fullCtx ? `\nКОНТЕКСТ РОБОТИ:\n${fullCtx}` : ""}`;

      } else {
        const typeHints = {
          theory: "теоретичний — визначення понять, аналіз літератури, огляд наукових підходів",
          analysis: "аналітично-практичний — аналіз даних, виявлення закономірностей, порівняння",
          recommendations: "рекомендаційний — практичні пропозиції, шляхи вирішення, прогнози",
        };
        const methodReq = methodInfo?.theoryRequirements && sec.type === "theory"
          ? methodInfo.theoryRequirements
          : (methodInfo?.analysisRequirements && ["analysis", "recommendations"].includes(sec.type) ? methodInfo.analysisRequirements : methodInfo?.otherRequirements || "");
        const isEmpChapter = empIdsSet.has(sec.id);
        const empiricalBlock = isEmpChapter ? `\n\nКОНТЕКСТ: цей підрозділ є частиною емпіричного дослідження. Визнач за назвою що писати:
- організація/методика дослідження: опиши вибірку, метод, структуру анкети. Додай: "Анкета наведена у Додатку А."
- аналіз/результати: таблиця markdown з відсотковими показниками, аналіз, висновки
- рекомендації: спирайся на результати попередніх підрозділів, не повторюй опис анкети` : "";

        instruction = `Напиши підрозділ "${sec.label}" для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.
Тип: ${typeHints[sec.type] || "основний"}.
${methodReq ? `ВИМОГИ МЕТОДИЧКИ: ${methodReq}` : ""}${empiricalBlock}

КОНТЕКСТ ВСІЄЇ РОБОТИ (для узгодженості вибірки, цифр, методики — дотримуйся цих даних точно):
${fullCtx}

Обсяг: ~${approxParas} абзаців (~${sec.pages} стор.).
Не обривай текст. Завершуй підсумковим абзацом. Без посилань [1],[2]. Без жирного.
Абзаци різняться за довжиною: чергуй короткі (2-3 речення) з довшими (5-7 речень).`;
      }

      const sectionMaxTokens = Math.min(60000, Math.max(8000, Math.round((sec.pages || 1) * 3000)));
      try {
        const raw = await callClaude([{ role: "user", content: instruction }], ctrl.signal, buildSYS(lang, methodInfo), sectionMaxTokens, null, MODEL);
        const result = raw
          .replace(/ — /g, ", ").replace(/— /g, "").replace(/ —/g, "")
          .replace(/[\u1100-\u11FF\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7FF\uF900-\uFAFF]/g, "")
          .replace(/[„""]([^"„""]*)["""]/g, "«$1»")
          .replace(/"([^"]*)"/g, "«$1»");
        const newContent = { ...contentRef.current, [sec.id]: result };
        setContent(newContent);
        await saveToFirestore({ content: newContent });
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        if (e.name === "AbortError") break;
        console.error(e);
        setApiError(e.message);
        setLoadMsg("⚠ " + e.message);
        break;
      }
    }

    regenAllAbortRef.current = null;
    setRegenAllLoading(false);
    setLoadMsg("");
  };

  // ── Автоматичний пошук джерел ──
  const doSearchSources = async (secId, kwList, sectionLabel = '') => {
    setSuggestedSources(prev => ({ ...prev, [secId]: [] })); // очищаємо перед пошуком
    setSourcesSearchLoading(prev => ({ ...prev, [secId]: true }));
    setSourcesSearchError(prev => ({ ...prev, [secId]: null }));
    // Інкрементуємо лічильник → різні сторінки результатів при повторному пошуку
    const nextCount = (searchPageCount[secId] || 0) + 1;
    setSearchPageCount(prev => ({ ...prev, [secId]: nextCount }));
    const page = ((nextCount - 1) % 3) + 1; // циклічно: 1 → 2 → 3 → 1 → ...
    try {
      const ukKw = (kwList || []).filter(k => /[іїєґІЇЄҐа-яА-Я]/.test(k));
      const enKw = (kwList || []).filter(k => !/[а-яА-ЯіїєґІЇЄҐ]/.test(k));
      const needed = sourceDist[secId] || 4;
      const topicCtx = [info?.topic, info?.direction, info?.subject].filter(Boolean).join(' ');
      const results = await searchSourcesForSection(ukKw, enKw, needed, sectionLabel, topicCtx, page);
      setSuggestedSources(prev => ({ ...prev, [secId]: results }));
    } catch (e) {
      console.error('Source search error:', e.message);
      setSourcesSearchError(prev => ({ ...prev, [secId]: e.message }));
    }
    setSourcesSearchLoading(prev => ({ ...prev, [secId]: false }));
  };

  // ── Ключові слова ──
  const doGenKeywords = async () => {
    setKwLoading(true);
    const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const secBlocks = mainSecs.map(s => {
      const txt = content[s.id]
        ? `\n${content[s.id].substring(0, 1200).replace(/["\\]/g, " ").replace(/\n+/g, " ")}`
        : "";
      return `### ${s.label} (потрібно ${sourceDist[s.id] || 3} джерела)${txt}`;
    }).join("\n\n");
    const domainCtx = [info?.direction, info?.subject].filter(Boolean).join(', ');
    const prompt = `Проаналізуй текст підрозділів академічної роботи на тему "${info?.topic}"${domainCtx ? ` (галузь: ${domainCtx})` : ''} і для кожного підрозділу визнач пошукові ключові слова для Google Scholar, Scopus, eLibrary Ukraine.\n\nВИМОГИ ДО КЛЮЧОВИХ СЛІВ:\n- Кожна фраза ОБОВ'ЯЗКОВО включає галузевий контекст (напр. "моделі інтерактивного навчання", НЕ просто "моделі").\n- Фрази мають відображати конкретні терміни та концепції підрозділу, а НЕ загальні структурні слова (не "аналіз", "методи", "форми" — тільки в поєднанні зі специфічним терміном).\n- Уникай загальних фраз без прив'язки до галузі/теми.\n\nПІДРОЗДІЛИ:\n${secBlocks}\n\nПоверни JSON об'єкт: {"keywords":{"1.1":["фраза укр","english phrase"],...}}`;
    try {
      const res = await fetch("/api/gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _model: "gemini-2.5-flash-lite",
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 3000, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data).slice(0, 200));
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const parsed = JSON.parse(raw);
      const kwRaw = parsed.keywords || {};
      const flattenKw = (v) => {
        if (Array.isArray(v)) return v.map(item => typeof item === "object" && item !== null ? Object.values(item).join(" ") : String(item)).filter(Boolean);
        if (typeof v === "object" && v !== null) return Object.values(v).flatMap(flattenKw);
        return String(v).split(/[,;]+/).map(s => s.trim()).filter(Boolean);
      };
      const kwNorm = Object.fromEntries(
        Object.entries(kwRaw).map(([k, v]) => {
          const normalizedKey = k.match(/^(\d+\.\d+)/)?.[1] || k;
          return [normalizedKey, flattenKw(v)];
        })
      );
      setKeywords(kwNorm);
      // Шукаємо джерела по черзі — один підрозділ за одним (видно прогрес)
      for (const s of mainSecs) {
        const normalKey = s.id.match(/^(\d+\.\d+)/)?.[1] || s.id;
        const kwList = kwNorm[normalKey] || kwNorm[s.id] || [];
        if (kwList.length) await doSearchSources(s.id, kwList, s.label || '');
      }
    } catch (e) { console.error(e); setKwError(e.message); }
    setKwLoading(false);
  };

  // ── Джерела ──
  const buildGlobalRefList = () => {
    const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const isAlphabetical = methodInfo?.sourcesOrder === "alphabetical";

    // Збираємо всі унікальні джерела з прив'язкою до секцій (за порядком появи)
    const rawRefs = [], secRefMapRaw = {}, seenRefs = new Map();
    mainSecs.forEach(sec => {
      const raw = citInputs[sec.id] || "";
      const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
      secRefMapRaw[sec.id] = [];
      lines.forEach(line => {
        const normalized = line.toLowerCase().replace(/\s*(url\s*:|https?:\/\/\S+|\(дата звернення[^)]*\))/gi, "").replace(/\s+/g, " ").replace(/[.,;:]/g, "").trim();
        const hasUrl = /https?:\/\/\S+/i.test(line);
        if (!seenRefs.has(normalized)) {
          rawRefs.push(line); seenRefs.set(normalized, rawRefs.length - 1);
        } else if (hasUrl && !/https?:\/\/\S+/i.test(rawRefs[seenRefs.get(normalized)])) {
          rawRefs[seenRefs.get(normalized)] = line; // заміна на варіант з URL
        }
        secRefMapRaw[sec.id].push(seenRefs.get(normalized));
      });
    });

    // Якщо алфавітний порядок — сортуємо і перебудовуємо індекси
    let allRefs, indexMap;
    if (isAlphabetical) {
      const langGroup = (s) => /^[А-ЯҐЄІЇа-яґєії]/i.test(s) ? 0 : 1;
      const sorted = [...rawRefs].sort((a, b) => {
        const ga = langGroup(a), gb = langGroup(b);
        if (ga !== gb) return ga - gb;
        return a.localeCompare(b, ga === 0 ? "uk" : "en");
      });
      indexMap = rawRefs.map(r => sorted.indexOf(r) + 1);
      allRefs = sorted;
    } else {
      allRefs = rawRefs;
      indexMap = rawRefs.map((_, i) => i + 1);
    }

    // Перебудовуємо secRefMap з фінальними номерами
    const secRefMap = {};
    mainSecs.forEach(sec => {
      secRefMap[sec.id] = (secRefMapRaw[sec.id] || []).map(rawIdx => indexMap[rawIdx]);
    });

    return { allRefs, secRefMap };
  };

  const globalRefData = useMemo(() => buildGlobalRefList(), [citInputs, sections]); // eslint-disable-line

  const doAddAllCitations = async () => {
    const { allRefs, secRefMap } = globalRefData;
    if (!allRefs.length) return;
    setAllCitLoading(true);
    const lang = info?.language || "Українська";
    const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const newContent = { ...content };

    // ── Визначаємо формат посилань за стилем ──
    const sourcesStyle = methodInfo?.sourcesStyle || "ДСТУ 8302:2015";
    const isAPA = /APA/i.test(sourcesStyle);
    const isMLA = /MLA/i.test(sourcesStyle);

    // ── СПОЧАТКУ: Форматування списку джерел (Gemini) ──
    const today = new Date();
    const accessDate = `${String(today.getDate()).padStart(2, "0")}.${String(today.getMonth() + 1).padStart(2, "0")}.${today.getFullYear()}`;
    const isAlphabeticalOrder = methodInfo?.sourcesOrder === "alphabetical";
    const isApaStyle = /APA/i.test(sourcesStyle);
    const isDstu = /ДСТУ/i.test(sourcesStyle);
    const sourcesOrder = (isAlphabeticalOrder || isDstu) ? "Список відсортований за алфавітом." : "Список у порядку першої появи у тексті.";
    const defaultGrouping = "спочатку законодавчі акти (закони, кодекси, постанови, накази тощо) за хронологією або номером; потім книги та журнальні статті кирилицею (українські та інші кириличні) за алфавітом; потім українські електронні джерела (сайти, онлайн-матеріали кирилицею) за алфавітом; наприкінці іноземні джерела (латиниця) за алфавітом";
    const sourcesGrouping = methodInfo?.sourcesGrouping
      ? `Групування: ${methodInfo.sourcesGrouping}.`
      : (isDstu || isAlphabeticalOrder) ? `Групування за ДСТУ 8302:2015: ${defaultGrouping}.` : "";
    const styleRules = isApaStyle
      ? `СТИЛЬ: APA 7th edition. СУВОРО дотримуйся APA — НЕ змішуй з ДСТУ чи іншими стилями.
Правила APA:
- Книга: Прізвище, І. І. (рік). Назва книги курсивом. Видавець.
- Стаття: Прізвище, І. І. (рік). Назва статті. Назва журналу курсивом, том(номер), сторінки. https://doi.org/...
- Розділ у збірнику: Прізвище, І. І. (рік). Назва розділу. В І. І. Редактор (Ред.), Назва збірника (сс. xx–xx). Видавець.
- Онлайн-ресурс: Прізвище, І. І. (рік). Назва. Назва сайту. URL
- НЕ використовуй двокрапку між містом і видавцем (це ДСТУ, не APA).
- НЕ пиши "Київ:" або "Oxford:" перед видавцем (APA не вказує місто для більшості джерел після 7-го вид.).
- НЕ додавай "Вип.", "Т.", "С." у журнальних статтях — використовуй том і сторінки у форматі APA.`
      : isDstu
        ? `СТИЛЬ: ДСТУ 8302:2015. СУВОРО дотримуйся ДСТУ — НЕ змішуй з APA чи іншими стилями.
Правила ДСТУ 8302:2015:
- Книга: Прізвище І. І. Назва книги. Місто : Видавець, рік. Кількість с.
- Стаття: Прізвище І. І. Назва статті. Назва журналу. рік. № номер. С. xx–xx.
- Онлайн: Прізвище І. І. Назва. URL: адреса (дата звернення: ${accessDate}).
- Ініціали пишуться ПІСЛЯ прізвища без ком між прізвищем та ініціалами.
- Між містом і видавцем — пробіл двокрапка пробіл ( : ).
- ПОРЯДОК ГРУП: 1) законодавчі акти (за хронологією/номером); 2) книги та статті кирилицею за алфавітом; 3) українські електронні джерела за алфавітом; 4) іноземні джерела латиницею за алфавітом.`
        : `СТИЛЬ: ${sourcesStyle}. Точно дотримуйся цього стилю.`;
    const fmtPrompt = `${styleRules}
${sourcesOrder} ${sourcesGrouping}
Збережи номери. Поверни ТІЛЬКИ список без заголовка. Для онлайн-джерел додай URL (дата звернення: ${accessDate}). НЕ використовуй "[Електронний ресурс]". Якщо назва джерела написана ВЕЛИКИМИ ЛІТЕРАМИ — переведи у формат речення (перша літера велика, решта малі, окрім власних назв та абревіатур).

${allRefs.map((r, i) => `${i + 1}. ${r}`).join("\n")}`;
    let fmtResult;
    try {
      fmtResult = await callGemini([{ role: "user", content: fmtPrompt }], null,
        `You are a bibliographic formatting assistant. Format references strictly in ${sourcesStyle} style only. Do not mix citation styles. Return only the formatted list, no extra text.`, 16000);
      setRefList(fmtResult.split("\n").filter(Boolean));
      const srcSec = sections.find(s => s.type === "sources");
      if (srcSec) newContent[srcSec.id] = fmtResult;
    } catch (e) { console.error(e); }

    // Будуємо карту "номер → текст посилання" з ВІДФОРМАТОВАНОГО списку (щоб мати точні номери сторінок)
    // Якщо Gemini не повернув результат — fallback на raw
    const fmtLines = fmtResult
      ? fmtResult.split("\n").filter(Boolean).map(l => l.replace(/^\d+\.\s*/, ""))
      : allRefs;
    const refCiteText = {};
    fmtLines.forEach((ref, i) => {
      const n = i + 1;
      if (isAPA) {
        // Шукаємо перше "реальне" прізвище (3+ літер) — пропускаємо ініціали типу "Л."
        const surnameMatch = ref.match(/(?:^|[\s,&])([А-ЯҐЄІЇа-яґєіїA-Za-z]{3,})/);
        const yearMatch = ref.match(/[\(\.\s](\d{4})[\)\.\,\s]/);
        const author = surnameMatch?.[1] || `Автор${n}`;
        const year = yearMatch?.[1] || "б.р.";
        refCiteText[n] = `(${author}, ${year})`;
      } else if (isMLA) {
        const surnameMatch = ref.match(/(?:^|[\s,&])([А-ЯҐЄІЇа-яґєіїA-Za-z]{3,})/);
        refCiteText[n] = `(${surnameMatch?.[1] || `Автор${n}`})`;
      } else {
        // ДСТУ та інші нумеровані стилі — витягуємо номер першої сторінки статті
        const articlePageMatch = ref.match(/[Сс]\.\s*(\d+)\s*[–\-—]/); // діапазон С. 56–74
        const singlePageMatch = !articlePageMatch && ref.match(/[Сс]\.\s*(\d+)(?!\d*\s*с\.)/); // одна сторінка С. 56, але не "210 с."
        const engPageMatch = ref.match(/pp?\.\s*(\d+)/i); // англійські pp. 56
        const startPage = articlePageMatch?.[1] || singlePageMatch?.[1] || engPageMatch?.[1];
        refCiteText[n] = startPage ? `[${n}, с. ${startPage}]` : `[${n}]`;
      }
    });

    // ── Допоміжні функції ──
    const isTableRow = p => p.includes("|") || (p.match(/\t/g) || []).length >= 2 || /^Таблиця\s+\d/.test(p.trim()) || /^Рис\.\s+\d/.test(p.trim());
    const stripCitations = text => text
      .replace(/\s*\[\d+,\s*с\.\s*\d+\]/g, "")
      .replace(/\s*\[\d+\]/g, "")
      .replace(/\s*\([А-ЯҐЄІЇA-Z][а-яґєіїa-z\-A-Za-z]+(?:\s+et\s+al\.?)?(?:,\s*\d{4})?\)/g, "");

    // Очищуємо старі посилання з усіх підрозділів перед новим розставленням
    mainSecs.forEach(sec => { if (newContent[sec.id]) newContent[sec.id] = stripCitations(newContent[sec.id]); });

    // ── ОДИН ЗАПИТ на всі підрозділи ──
    const secsWithRefs = mainSecs.filter(sec => secRefMap[sec.id]?.length && newContent[sec.id]);

    if (secsWithRefs.length > 0) {
      const exampleCite = isAPA ? "(Автор, рік)" : isMLA ? "(Автор)" : "[N]";
      const secsSummary = secsWithRefs.map(sec => {
        const uniqueNums = [...new Set(secRefMap[sec.id])];
        // Не показуємо Claude рядки таблиць як кандидати
        const paragraphs = newContent[sec.id].split("\n").filter(p => p.trim() && !isTableRow(p)).map((p, idx) => `${idx}: ${p.substring(0, 180)}`);
        // Показуємо які саме рядки посилань доступні для цього підрозділу
        const refsDetail = uniqueNums.map(n => `джерело ${n}`).join(", ");
        return `ПІДРОЗДІЛ "${sec.id}" (доступні: ${refsDetail}):
${paragraphs.join("\n")}`;
      }).join("\n\n---\n\n");

      const batchPrompt = `Визнач в яких абзацах яке джерело доречне. Стиль: ${sourcesStyle}.

ПРАВИЛА:
1. Кожне джерело ставити МАКСИМУМ 2 рази на весь текст роботи — враховуй ВСІ підрозділи разом.
2. Не ставити одне джерело підряд у кількох абзацах поспіль.
3. Посилання ставити лише там де абзац ПРЯМО спирається на це джерело (визначення, факт, цитата).
4. Розподіляй джерела рівномірно між підрозділами — не концентруй всі в одному.
5. ОБОВ'ЯЗКОВО: кожне джерело зі списку "доступні" має бути використане ХОЧА Б ОДИН РАЗ. Якщо після суворого розміщення за правилом 3 якесь джерело залишилось невикористаним — знайди підрозділ і абзац найближчий за тематикою і постав це джерело там.
6. Формат відповіді — JSON де значення це НОМЕР джерела (ціле число), а не текст посилання.

${secsSummary}

Поверни ТІЛЬКИ JSON (без markdown):
{"citations":{"1.1":{"0":1,"3":2},"1.2":{"1":3,"5":4}}}
де ключ підрозділу — id, ключ абзацу — індекс (0-based), значення — номер джерела (ціле число).`;

      try {
        const raw = await callClaude([{ role: "user", content: batchPrompt }], null,
          SYS_JSON_SHORT, 2000, null, MODEL_FAST);
        const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
        const citMap = parsed.citations || {};

        // Вставляємо посилання локально — конвертуємо номер у правильний формат
        secsWithRefs.forEach(sec => {
          const secCits = citMap[sec.id];
          if (!secCits) return;
          const paragraphs = newContent[sec.id].split("\n");
          let nonEmptyIdx = 0;
          const result = paragraphs.map((p) => {
            if (!p.trim()) return p;
            if (isTableRow(p)) { nonEmptyIdx++; return p; } // пропускаємо рядки таблиць
            const citNum = secCits[String(nonEmptyIdx)];
            nonEmptyIdx++;
            if (citNum && refCiteText[citNum]) {
              const cite = refCiteText[citNum];
              const trimmed = p.trimEnd();
              // Якщо абзац закінчується крапкою/знаком оклику/питання — ставимо посилання ДО знака
              const lastChar = trimmed.slice(-1);
              if ([".", "!", "?", "…"].includes(lastChar)) {
                return trimmed.slice(0, -1) + " " + cite + lastChar;
              }
              return trimmed + " " + cite + ".";
            }
            return p;
          }).join("\n");
          newContent[sec.id] = result;
        });

        // ── Фолбек: примусово вставити джерела що так і не потрапили в текст ──
        const placedNums = new Set();
        secsWithRefs.forEach(sec => {
          const text = newContent[sec.id] || "";
          const matches = [...text.matchAll(/\[(\d+)[,\]]/g)];
          matches.forEach(m => placedNums.add(Number(m[1])));
          // APA/MLA: витягуємо номери через refCiteText
          Object.entries(refCiteText).forEach(([n, cite]) => {
            if (text.includes(cite)) placedNums.add(Number(n));
          });
        });

        const allSourceNums = allRefs.map((_, i) => i + 1);
        const unplaced = allSourceNums.filter(n => !placedNums.has(n));

        if (unplaced.length > 0) {
          // Для кожного нерозставленого — знаходимо підрозділ де воно є в secRefMap,
          // і вставляємо в перший підходящий абзац без посилання
          const insertCite = (text, cite) => {
            const lines = text.split("\n");
            const hasCite = l => /\[\d+/.test(l) || Object.values(refCiteText).some(c => l.includes(c));
            // Шукаємо перший непустий абзац без посилання
            for (let i = 0; i < lines.length; i++) {
              const l = lines[i];
              if (!l.trim() || isTableRow(l) || hasCite(l)) continue;
              const trimmed = l.trimEnd();
              const last = trimmed.slice(-1);
              lines[i] = [".", "!", "?", "…"].includes(last)
                ? trimmed.slice(0, -1) + " " + cite + last
                : trimmed + " " + cite + ".";
              return lines.join("\n");
            }
            return text; // якщо не знайшли місця — повертаємо без змін
          };

          unplaced.forEach(n => {
            if (!refCiteText[n]) return;
            // Знаходимо підрозділи де це джерело має бути
            const targetSecs = secsWithRefs.filter(sec => secRefMap[sec.id]?.includes(n));
            // Якщо немає — беремо будь-який підрозділ з контентом
            const candidates = targetSecs.length ? targetSecs : secsWithRefs;
            for (const sec of candidates) {
              const before = newContent[sec.id];
              const after = insertCite(before, refCiteText[n]);
              if (after !== before) { newContent[sec.id] = after; break; }
            }
          });
        }
      } catch (e) { console.error("Citation batch error:", e); }
    }

    // ── Ренумерація для citation_order: привести номери до реального порядку появи в тексті ──
    if (!isAPA && !isMLA && !isAlphabeticalOrder) {
      // 1. Знаходимо реальний порядок першої появи кожного номера в тексті
      const firstSeen = []; // масив номерів у порядку першого входження
      const seen = new Set();
      mainSecs.forEach(sec => {
        const text = newContent[sec.id] || "";
        const matches = [...text.matchAll(/\[(\d+)[\],]/g)];
        matches.forEach(m => {
          const n = Number(m[1]);
          if (!seen.has(n)) { seen.add(n); firstSeen.push(n); }
        });
      });

      // 2. Будуємо oldToNew { старий_номер: новий_номер }
      const oldToNew = {};
      firstSeen.forEach((oldN, idx) => { oldToNew[oldN] = idx + 1; });

      // Додаємо джерела що взагалі не потрапили в текст (в кінець, зберігаючи їх відносний порядок)
      let nextNew = firstSeen.length + 1;
      fmtLines.forEach((_, i) => {
        const n = i + 1;
        if (!oldToNew[n]) { oldToNew[n] = nextNew++; }
      });

      // 3. Перевіряємо чи є взагалі зміни
      const needsRenumber = Object.entries(oldToNew).some(([old, nw]) => Number(old) !== nw);
      if (needsRenumber) {
        // 4. Замінюємо в тексті (одночасно через placeholder щоб уникнути колізій)
        mainSecs.forEach(sec => {
          if (!newContent[sec.id]) return;
          // Спочатку замінюємо на placeholders
          let text = newContent[sec.id].replace(/\[(\d+)(,\s*с\.\s*\d+)?\]/g, (match, n, page) => {
            const newN = oldToNew[Number(n)];
            return newN ? `%%CIT${newN}${page || ""}%%` : match;
          });
          // Потім placeholders → фінальні посилання
          text = text.replace(/%%CIT(\d+)(,\s*с\.\s*\d+)?%%/g, (_, n, page) => `[${n}${page || ""}]`);
          newContent[sec.id] = text;
        });

        // 5. Переупорядковуємо список джерел
        const newFmtLines = new Array(fmtLines.length);
        fmtLines.forEach((line, i) => {
          const newIdx = oldToNew[i + 1] - 1;
          if (newIdx >= 0 && newIdx < newFmtLines.length) newFmtLines[newIdx] = line;
        });
        const reorderedList = newFmtLines
          .map((line, i) => line ? `${i + 1}. ${line.replace(/^\d+\.\s*/, "")}` : null)
          .filter(Boolean)
          .join("\n");

        // Оновлюємо секцію джерел та стан
        const srcSec = sections.find(s => s.type === "sources");
        if (srcSec) newContent[srcSec.id] = reorderedList;
        setRefList(reorderedList.split("\n").filter(Boolean));
        fmtResult = reorderedList;
      }
    }

    setContent(newContent);
    setCitInputsSnapshot(JSON.stringify(citInputs));
    await saveToFirestore({ content: newContent, citInputs, refList: fmtResult?.split("\n").filter(Boolean) || [], stage: "sources", status: "writing" });
    setAllCitLoading(false);
  };

  // ── sources-first: ремаппінг локальних [N] → глобальні номери + форматування списку ──
  const doRemapCitations = async () => {
    setRemapLoading(true);
    const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const sourcesStyle = methodInfo?.sourcesStyle || "ДСТУ 8302:2015";
    const isAPA = /APA/i.test(sourcesStyle);
    const isMLA = /MLA/i.test(sourcesStyle);
    const isDstu = /ДСТУ/i.test(sourcesStyle);
    const isAlphabeticalOrder = methodInfo?.sourcesOrder === "alphabetical";

    // ── 1. Локальна карта: secId → { localN: sourceText } ──
    const secLocalSources = {};
    mainSecs.forEach(sec => {
      const lines = (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
      secLocalSources[sec.id] = {};
      lines.forEach((line, i) => { secLocalSources[sec.id][i + 1] = line; });
    });

    // ── 2. Глобальна дедуплікація (та сама логіка що в buildGlobalRefList) ──
    const normalize = str => str.toLowerCase()
      .replace(/\s*(url\s*:|https?:\/\/\S+|\(дата звернення[^)]*\))/gi, "")
      .replace(/\s+/g, " ").replace(/[.,;:]/g, "").trim();

    const rawRefs = [], seenRefs = new Map();
    mainSecs.forEach(sec => {
      Object.values(secLocalSources[sec.id]).forEach(text => {
        const key = normalize(text);
        const hasUrl = /https?:\/\/\S+/i.test(text);
        if (!seenRefs.has(key)) {
          rawRefs.push(text); seenRefs.set(key, rawRefs.length - 1);
        } else if (hasUrl && !/https?:\/\/\S+/i.test(rawRefs[seenRefs.get(key)])) {
          rawRefs[seenRefs.get(key)] = text;
        }
      });
    });

    // ── 3. Алфавітне сортування якщо потрібно ──
    let allRefs, indexMap;
    if (isAlphabeticalOrder) {
      const langGroup = s => /^[А-ЯҐЄІЇа-яґєії]/i.test(s) ? 0 : 1;
      const sorted = [...rawRefs].sort((a, b) => {
        const ga = langGroup(a), gb = langGroup(b);
        if (ga !== gb) return ga - gb;
        return a.localeCompare(b, ga === 0 ? "uk" : "en");
      });
      indexMap = rawRefs.map(r => sorted.indexOf(r) + 1);
      allRefs = sorted;
    } else {
      allRefs = rawRefs;
      indexMap = rawRefs.map((_, i) => i + 1);
    }

    // ── 4. Маппінг localN → globalN для кожного підрозділу ──
    const secLocalToGlobal = {};
    mainSecs.forEach(sec => {
      secLocalToGlobal[sec.id] = {};
      Object.entries(secLocalSources[sec.id]).forEach(([localN, text]) => {
        const rawIdx = seenRefs.get(normalize(text));
        if (rawIdx !== undefined) secLocalToGlobal[sec.id][Number(localN)] = indexMap[rawIdx];
      });
    });

    // ── 5. Форматування списку через Gemini (той самий промпт що в doAddAllCitations) ──
    const today = new Date();
    const accessDate = `${String(today.getDate()).padStart(2, "0")}.${String(today.getMonth() + 1).padStart(2, "0")}.${today.getFullYear()}`;
    const sourcesOrder = (isAlphabeticalOrder || isDstu) ? "Список відсортований за алфавітом." : "Список у порядку першої появи у тексті.";
    const defaultGrouping = "спочатку законодавчі акти (закони, кодекси, постанови, накази тощо) за хронологією або номером; потім книги та журнальні статті кирилицею (українські та інші кириличні) за алфавітом; потім українські електронні джерела (сайти, онлайн-матеріали кирилицею) за алфавітом; наприкінці іноземні джерела (латиниця) за алфавітом";
    const sourcesGrouping = methodInfo?.sourcesGrouping
      ? `Групування: ${methodInfo.sourcesGrouping}.`
      : (isDstu || isAlphabeticalOrder) ? `Групування за ДСТУ 8302:2015: ${defaultGrouping}.` : "";
    const styleRules = /APA/i.test(sourcesStyle)
      ? `СТИЛЬ: APA 7th edition. СУВОРО дотримуйся APA — НЕ змішуй з ДСТУ чи іншими стилями.
Правила APA:
- Книга: Прізвище, І. І. (рік). Назва книги курсивом. Видавець.
- Стаття: Прізвище, І. І. (рік). Назва статті. Назва журналу курсивом, том(номер), сторінки. https://doi.org/...
- Розділ у збірнику: Прізвище, І. І. (рік). Назва розділу. В І. І. Редактор (Ред.), Назва збірника (сс. xx–xx). Видавець.
- Онлайн-ресурс: Прізвище, І. І. (рік). Назва. Назва сайту. URL
- НЕ використовуй двокрапку між містом і видавцем (це ДСТУ, не APA).
- НЕ пиши "Київ:" або "Oxford:" перед видавцем (APA не вказує місто для більшості джерел після 7-го вид.).
- НЕ додавай "Вип.", "Т.", "С." у журнальних статтях — використовуй том і сторінки у форматі APA.`
      : isDstu
        ? `СТИЛЬ: ДСТУ 8302:2015. СУВОРО дотримуйся ДСТУ — НЕ змішуй з APA чи іншими стилями.
Правила ДСТУ 8302:2015:
- Книга: Прізвище І. І. Назва книги. Місто : Видавець, рік. Кількість с.
- Стаття: Прізвище І. І. Назва статті. Назва журналу. рік. № номер. С. xx–xx.
- Онлайн: Прізвище І. І. Назва. URL: адреса (дата звернення: ${accessDate}).
- Ініціали пишуться ПІСЛЯ прізвища без ком між прізвищем та ініціалами.
- Між містом і видавцем — пробіл двокрапка пробіл ( : ).
- ПОРЯДОК ГРУП: 1) законодавчі акти (за хронологією/номером); 2) книги та статті кирилицею за алфавітом; 3) українські електронні джерела за алфавітом; 4) іноземні джерела латиницею за алфавітом.`
        : `СТИЛЬ: ${sourcesStyle}. Точно дотримуйся цього стилю.`;

    const fmtPrompt = `${styleRules}
${sourcesOrder} ${sourcesGrouping}
Збережи номери. Поверни ТІЛЬКИ список без заголовка. Для онлайн-джерел додай URL (дата звернення: ${accessDate}). НЕ використовуй "[Електронний ресурс]". Якщо назва джерела написана ВЕЛИКИМИ ЛІТЕРАМИ — переведи у формат речення (перша літера велика, решта малі, окрім власних назв та абревіатур).

${allRefs.map((r, i) => `${i + 1}. ${r}`).join("\n")}`;

    let fmtResult;
    try {
      fmtResult = await callGemini([{ role: "user", content: fmtPrompt }], null,
        `You are a bibliographic formatting assistant. Format references strictly in ${sourcesStyle} style only. Do not mix citation styles. Return only the formatted list, no extra text.`, 16000);
    } catch (e) { console.error("remap fmt error:", e); }

    const fmtLines = fmtResult
      ? fmtResult.split("\n").filter(Boolean).map(l => l.replace(/^\d+\.\s*/, ""))
      : allRefs;

    // ── 6. Формат inline-посилань по стилю ──
    const refCiteText = {};
    fmtLines.forEach((ref, i) => {
      const n = i + 1;
      if (isAPA) {
        const surnameMatch = ref.match(/(?:^|[\s,&])([А-ЯҐЄІЇа-яґєіїA-Za-z]{3,})/);
        const yearMatch = ref.match(/[\(\.\s](\d{4})[\)\.\,\s]/);
        const author = surnameMatch?.[1] || `Автор${n}`;
        refCiteText[n] = `(${author}, ${yearMatch?.[1] || "б.р."})`;
      } else if (isMLA) {
        const surnameMatch = ref.match(/(?:^|[\s,&])([А-ЯҐЄІЇа-яґєіїA-Za-z]{3,})/);
        refCiteText[n] = `(${surnameMatch?.[1] || `Автор${n}`})`;
      } else {
        // ДСТУ: [N, с. PAGE] або [N]
        const articlePageMatch = ref.match(/[Сс]\.\s*(\d+)\s*[–\-—]/);
        const singlePageMatch = !articlePageMatch && ref.match(/[Сс]\.\s*(\d+)(?!\d*\s*с\.)/);
        const engPageMatch = ref.match(/pp?\.\s*(\d+)/i);
        const startPage = articlePageMatch?.[1] || singlePageMatch?.[1] || engPageMatch?.[1];
        refCiteText[n] = startPage ? `[${n}, с. ${startPage}]` : `[${n}]`;
      }
    });

    // ── 7. Заміна в тексті: [localN] / [localN, с. X] → %%CITglobalN%% → фінал ──
    const newContent = { ...content };
    mainSecs.forEach(sec => {
      if (!newContent[sec.id]) return;
      const mapping = secLocalToGlobal[sec.id];
      if (!mapping || !Object.keys(mapping).length) return;
      // Крок A: локальні номери → placeholders (max 2 рази на підрозділ для кожного джерела)
      const citCount = {};
      let text = newContent[sec.id].replace(/\[(\d+)(?:,\s*с\.\s*\d+)?\]/g, (match, localN) => {
        const globalN = mapping[Number(localN)];
        if (!globalN) return match;
        citCount[globalN] = (citCount[globalN] || 0) + 1;
        return citCount[globalN] <= 2 ? `%%CIT${globalN}%%` : "";
      });
      // Крок B: placeholders → фінальний формат
      text = text.replace(/%%CIT(\d+)%%/g, (_, n) => refCiteText[Number(n)] || `[${n}]`);
      newContent[sec.id] = text;
    });

    // ── 8. Ренумерація для порядку за появою (не APA/MLA, не алфавітний) ──
    if (!isAPA && !isMLA && !isAlphabeticalOrder) {
      const firstSeen = [], seen = new Set();
      mainSecs.forEach(sec => {
        const text = newContent[sec.id] || "";
        [...text.matchAll(/\[(\d+)[\],]/g)].forEach(m => {
          const n = Number(m[1]);
          if (!seen.has(n)) { seen.add(n); firstSeen.push(n); }
        });
      });
      const oldToNew = {};
      firstSeen.forEach((oldN, idx) => { oldToNew[oldN] = idx + 1; });
      let nextNew = firstSeen.length + 1;
      fmtLines.forEach((_, i) => { const n = i + 1; if (!oldToNew[n]) oldToNew[n] = nextNew++; });

      if (Object.entries(oldToNew).some(([old, nw]) => Number(old) !== nw)) {
        mainSecs.forEach(sec => {
          if (!newContent[sec.id]) return;
          let text = newContent[sec.id].replace(/\[(\d+)(,\s*с\.\s*\d+)?\]/g, (match, n, page) => {
            const newN = oldToNew[Number(n)];
            return newN ? `%%CIT${newN}${page || ""}%%` : match;
          });
          text = text.replace(/%%CIT(\d+)(,\s*с\.\s*\d+)?%%/g, (_, n, page) => `[${n}${page || ""}]`);
          newContent[sec.id] = text;
        });

        const newFmtLines = new Array(fmtLines.length);
        fmtLines.forEach((line, i) => {
          const newIdx = oldToNew[i + 1] - 1;
          if (newIdx >= 0 && newIdx < newFmtLines.length) newFmtLines[newIdx] = line;
        });
        fmtResult = newFmtLines
          .map((line, i) => line ? `${i + 1}. ${line.replace(/^\d+\.\s*/, "")}` : null)
          .filter(Boolean).join("\n");
      }
    }

    // ── 9. Оновлення секції "Список літератури" і стану ──
    const srcSec = sections.find(s => s.type === "sources");
    if (srcSec && fmtResult) newContent[srcSec.id] = fmtResult;
    const newRefList = (fmtResult || allRefs.map((r, i) => `${i + 1}. ${r}`).join("\n"))
      .split("\n").filter(Boolean);

    setRefList(newRefList);
    setContent(newContent);
    setCitInputsSnapshot(JSON.stringify(citInputs));
    await saveToFirestore({ content: newContent, citInputs, refList: newRefList, stage: "done", status: "done" });
    setRemapLoading(false);
    setStage("done");
  };

  const copyAll = () => {
    const intro = sections.find(s => s.type === "intro");
    const concs = sections.find(s => s.type === "conclusions");
    const srcs = sections.find(s => s.type === "sources");
    const main = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const order = [intro, ...main, concs, srcs].filter(Boolean);
    const sep = "\n\n" + "─".repeat(60) + "\n\n";
    navigator.clipboard.writeText(order.map(s => content[s.id] ? (s.label + "\n\n" + content[s.id]) : null).filter(Boolean).join(sep));
  };

  const progress = sections.length ? Math.round(Object.keys(content).length / sections.length * 100) : 0;
  const totalPagesNum = info ? parsePagesAvg(info.pages) : 80;

  const displayOrder = useMemo(() => {
    if (!sections.length) return [];
    const intro = sections.find(s => s.type === "intro");
    const concs = sections.find(s => s.type === "conclusions");
    const srcs = sections.find(s => s.type === "sources");
    const main = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    return [intro, ...main, concs, srcs].filter(Boolean);
  }, [sections]);

  const mainSections = useMemo(() => sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type)), [sections]);

  const resetAll = () => {
    setStage("input"); setTplText(""); setComment(""); setClientPlan("");
    setFileLabel(""); setFileB64(null); setFileType(null); setInfo(null);
    setSections([]); setPlanDisplay(""); setContent({}); setGenIdx(0);
    setPaused(false); setPlanLoading(false); setMethodInfo(null); setCommentAnalysis(null); setSourceDist({}); setSourceTotal(0);
    setKeywords({}); setCitInputs({}); setAllCitLoading(false); setRefList([]); setCitInputsSnapshot(null); setFigureRefs({}); setFigureKeywords([]); setFigKwLoading(false);
    setSpeechText(""); setAppendicesText("");
    setPresentationReady(false); setPresentationMsg(""); setSlideJson(null);
    runningRef.current = false; setRunning(false);
  };

  if (dbLoading) return (
    <div style={{ minHeight: "100vh", background: "#f5f2eb", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Spectral',serif" }}>
      <div style={{ textAlign: "center" }}>
        <SpinDot /><div style={{ fontSize: 14, color: "#888", marginTop: 12 }}>Завантаження замовлення...</div>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#f5f2eb", fontFamily: "'Spectral',Georgia,serif", color: "#1a1a14" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,400;0,600;1,400&family=Spectral+SC:wght@600&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#ede9e0}::-webkit-scrollbar-thumb{background:#bbb4a0;border-radius:3px}
        @keyframes fd{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pl{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
        .fade{animation:fd .35s ease}
        button:not(:disabled):active{transform:scale(.98)}
        .sec-row:hover{background:#edeadf!important}
        textarea:focus,input:focus{outline:none;border-color:#aaa49a}
        .sidebar-panel{transition:width .28s cubic-bezier(.4,0,.2,1),opacity .2s ease}
        .sidebar-tab:hover{background:#2a2a1a!important}
        .sidebar-field-row{display:grid;grid-template-columns:110px 1fr;border-bottom:1px solid #2a2a20;font-size:12px}
        .sidebar-field-row:last-child{border-bottom:none}
      `}</style>

      {/* Header */}
      <div style={{ position: "sticky", top: 0, zIndex: 100, background: "#1a1a14" }}>
        {/* Full header */}
        {headerOpen && (
          <div style={{ color: "#f5f2eb", padding: "15px 32px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            {onBack && (
              <button onClick={onBack} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "5px 14px", cursor: "pointer", fontFamily: "inherit", fontSize: 12, marginRight: 4 }}>
                ← Замовлення
              </button>
            )}
            <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 19, letterSpacing: 5, color: "#e8ff47", flexShrink: 0 }}>ACADEM</div>
            <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 19, letterSpacing: 5, flexShrink: 0 }}>ASSIST</div>
            {info?.orderNumber && <div style={{ fontSize: 11, color: "#888", whiteSpace: "nowrap", flexShrink: 0 }}>#{info.orderNumber}</div>}
            {info?.topic && <div style={{ fontSize: 12, color: "#666", flex: 1, minWidth: 0, lineHeight: 1.4 }}>{info.topic}</div>}
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0, marginLeft: "auto" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#888", background: "#2a2a20", borderRadius: 6, padding: "4px 10px" }}>
                <span>Claude: <b style={{ color: "#e8ff47" }}>${sessionCost.claude.toFixed(4)}</b></span>
                <span style={{ color: "#444" }}>|</span>
                <span>Gemini: <b style={{ color: "#e8ff47" }}>${sessionCost.gemini.toFixed(4)}</b></span>
                <button onClick={() => { const z = { claude: 0, gemini: 0 }; setSessionCost(z); localStorage.setItem("sessionCost", JSON.stringify(z)); }}
                  style={{ background: "transparent", border: "none", color: "#555", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "0 2px" }} title="Скинути">✕</button>
              </div>
              <SaveIndicator saving={saving} saved={saved} />
              <StagePills stage={stage} maxStageIdx={maxStageIdx} onNavigate={running ? null : handleNavigateMain} stages={activeStages} stageKeys={activeStageKeys} />
            </div>
          </div>
        )}
        {/* Collapsed bar */}
        {!headerOpen && (
          <div
            onClick={() => setHeaderOpen(true)}
            style={{ padding: "6px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", borderBottom: "1px solid #2a2a20" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontFamily: "'Spectral SC',serif", fontSize: 13, letterSpacing: 4, color: "#e8ff47" }}>ACADEM</span>
              <span style={{ fontFamily: "'Spectral SC',serif", fontSize: 13, letterSpacing: 4, color: "#f5f2eb" }}>ASSIST</span>
              {info?.orderNumber && <span style={{ fontSize: 11, color: "#555" }}>#{info.orderNumber}</span>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <StagePills stage={stage} maxStageIdx={maxStageIdx} onNavigate={running ? null : handleNavigateHeader} stages={activeStages} stageKeys={activeStageKeys} />
              <span style={{ fontSize: 11, color: "#555", marginLeft: 6 }}>▼</span>
            </div>
          </div>
        )}
      </div>

      {/* ══ LEFT SIDEBAR (fixed, план / джерела / готово) ══ */}
      {["plan", "sources", "done"].includes(stage) && info && (() => {
        const PANEL_W = 270;
        const TAB_W = 32;
        const totalW = sidebarOpen ? PANEL_W + TAB_W : TAB_W;
        return (
          <div
            onMouseEnter={() => setSidebarOpen(true)}
            onMouseLeave={() => setSidebarOpen(false)}
            style={{
              position: "fixed",
              left: 0,
              top: 0,
              height: "100vh",
              width: totalW,
              display: "flex",
              zIndex: 200,
              transition: "width .28s cubic-bezier(.4,0,.2,1)",
              overflow: "hidden",
              boxShadow: sidebarOpen ? "4px 0 20px rgba(0,0,0,.35)" : "none",
            }}
          >
            {/* Tab — always visible */}
            <div
              onClick={() => setSidebarOpen(v => !v)}
              style={{
                width: TAB_W,
                flexShrink: 0,
                background: "#1a1a14",
                borderRight: "2px solid #e8ff47",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                userSelect: "none",
              }}
            >
              <span style={{
                writingMode: "vertical-rl",
                transform: "rotate(180deg)",
                fontSize: 10,
                letterSpacing: 2,
                color: "#e8ff47",
                textTransform: "uppercase",
                fontFamily: "'Spectral SC', serif",
              }}>
                {sidebarOpen ? "◂ закрити" : "▸ дані"}
              </span>
            </div>

            {/* Panel content */}
            <div style={{
              width: PANEL_W,
              flexShrink: 0,
              background: "#1a1a14",
              height: "100%",
              overflowY: "auto",
            }}>
              {/* Header */}
              <div style={{ padding: "18px 14px 12px", borderBottom: "1px solid #2a2a20" }}>
                <div style={{ fontFamily: "'Spectral SC', serif", fontSize: 10, letterSpacing: 3, color: "#e8ff47", marginBottom: 10 }}>ДАНІ ЗАМОВЛЕННЯ</div>
                {info.workCategory && (
                  <span style={{ fontSize: 11, background: "#2a3a00", color: "#a8d060", padding: "3px 10px", borderRadius: 12, letterSpacing: 1 }}>
                    {info.workCategory}
                  </span>
                )}
              </div>

              {/* Fields */}
              <div style={{ borderBottom: "1px solid #2a2a20" }}>
                {Object.entries(FIELD_LABELS).map(([k, l]) => info[k] ? (
                  <div key={k} className="sidebar-field-row">
                    <div style={{ padding: "8px 8px 8px 14px", color: "#666", lineHeight: 1.4 }}>{l}</div>
                    <div style={{ padding: "8px 12px 8px 6px", color: "#ddd8cc", lineHeight: 1.4, wordBreak: "break-word" }}>{info[k]}</div>
                  </div>
                ) : null)}
              </div>

              {/* methodInfo chips */}
              {methodInfo && (
                <div style={{ padding: "12px 14px" }}>
                  <div style={{ fontSize: 10, letterSpacing: 2, color: "#555", textTransform: "uppercase", marginBottom: 8, fontFamily: "'Spectral SC', serif" }}>Методичка</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {methodInfo.totalPages && <span style={{ fontSize: 11, background: "#1e2a10", color: "#7ab840", padding: "3px 8px", borderRadius: 8 }}>📄 {methodInfo.totalPages} стор.</span>}
                    {methodInfo.chaptersCount && <span style={{ fontSize: 11, background: "#1e2a10", color: "#7ab840", padding: "3px 8px", borderRadius: 8 }}>📑 {methodInfo.chaptersCount} розд.</span>}
                    {methodInfo.sourcesStyle && <span style={{ fontSize: 11, background: "#102030", color: "#6ab0e0", padding: "3px 8px", borderRadius: 8 }}>📚 {methodInfo.sourcesStyle}</span>}
                    {methodInfo.sourcesOrder && <span style={{ fontSize: 11, background: "#102030", color: "#6ab0e0", padding: "3px 8px", borderRadius: 8 }}>{methodInfo.sourcesOrder === "alphabetical" ? "🔤 Алфавіт" : "🔢 За появою"}</span>}
                    {methodInfo.formatting?.font && <span style={{ fontSize: 11, background: "#222218", color: "#aaa", padding: "3px 8px", borderRadius: 8 }}>🖋 {methodInfo.formatting.font} {methodInfo.formatting.fontSize}pt</span>}
                    {methodInfo.formatting?.margins && <span style={{ fontSize: 11, background: "#222218", color: "#aaa", padding: "3px 8px", borderRadius: 8 }}>📐 Л{methodInfo.formatting.margins.left} П{methodInfo.formatting.margins.right}мм</span>}
                    {methodInfo.citationStyle && <span style={{ fontSize: 11, background: "#2a1030", color: "#c090e0", padding: "3px 8px", borderRadius: 8 }}>🔗 {methodInfo.citationStyle}</span>}
                    <span style={{ fontSize: 11, background: "#1e2a10", color: methodInfo.hasChapterConclusions ? "#7ab840" : "#666", padding: "3px 8px", borderRadius: 8 }}>
                      {methodInfo.hasChapterConclusions ? "✓ Висновки до розд." : "✗ Без висновків"}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* ══ MAIN CONTENT (shifted right when sidebar present) ══ */}
      <div style={{
        paddingLeft: ["plan", "sources", "done"].includes(stage) && info ? (sidebarOpen ? 302 : 32) : 0,
        transition: "padding-left .28s cubic-bezier(.4,0,.2,1)",
      }}>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px clamp(16px, 3vw, 48px)" }}>

        {/* ══ STAGES ══ */}
        {stage === "input" && (
          <InputStage
            tplText={tplText} setTplText={setTplText}
            clientPlan={clientPlan} setClientPlan={setClientPlan}
            comment={comment} setComment={setComment}
            fileLabel={fileLabel} fileB64={fileB64} methodInfo={methodInfo}
            photos={photos} setPhotos={setPhotos} info={info}
            running={running} loadMsg={loadMsg}
            handleFile={handleFile} doAnalyze={doAnalyze} setStage={setStage}
          />
        )}
        {stage === "parsed" && info && (
          <ParsedStage
            info={info} setInfo={setInfo}
            methodInfo={methodInfo} setMethodInfo={setMethodInfo}
            fileB64={fileB64} apiError={apiError} sections={sections}
            doGenPlan={doGenPlan} setStage={setStage}
          />
        )}
        {stage === "plan" && (
          <PlanStage
            sections={sections} setSections={setSections}
            planDisplay={planDisplay} setPlanDisplay={setPlanDisplay}
            planLoading={planLoading} clientPlan={clientPlan}
            showManualPlanInput={showManualPlanInput} setShowManualPlanInput={setShowManualPlanInput}
            manualPlanText={manualPlanText} setManualPlanText={setManualPlanText}
            planDocxLoading={planDocxLoading} setPlanDocxLoading={setPlanDocxLoading}
            namingLoading={namingLoading} totalPagesNum={totalPagesNum}
            info={info} methodInfo={methodInfo} content={content}
            doGenPlan={doGenPlan} doNamePlaceholders={doNamePlaceholders}
            startGen={startGen} setStage={setStage} workflowMode={workflowMode}
            setSourceDist={setSourceDist} setSourceTotal={setSourceTotal}
            addNewChapter={addNewChapter} recalcPages={recalcPages}
          />
        )}
        {stage === "writing" && (
          <WritingStage
            running={running} paused={paused}
            regenId={regenId} setRegenId={setRegenId}
            regenPrompt={regenPrompt} setRegenPrompt={setRegenPrompt}
            regenLoading={regenLoading} regenAllLoading={regenAllLoading}
            loadMsg={loadMsg} apiError={apiError} setApiError={setApiError}
            progress={progress} displayOrder={displayOrder}
            sections={sections} genIdx={genIdx} content={content}
            regenAllAbortRef={regenAllAbortRef}
            stopGen={stopGen} resumeGen={resumeGen} doRegenAll={doRegenAll}
            doRegenSection={doRegenSection} setStage={setStage} workflowMode={workflowMode}
            doRemapCitations={doRemapCitations} remapLoading={remapLoading}
          />
        )}
        {stage === "sources" && (
          <SourcesStage
            mainSections={mainSections}
            citInputs={citInputs} setCitInputs={setCitInputs}
            sourceDist={sourceDist} sourceTotal={sourceTotal}
            keywords={keywords} kwLoading={kwLoading}
            kwError={kwError} setKwError={setKwError}
            methodInfo={methodInfo} commentAnalysis={commentAnalysis}
            allRefs={globalRefData.allRefs} refList={refList}
            showMissingSources={showMissingSources}
            citInputsSnapshot={citInputsSnapshot} allCitLoading={allCitLoading}
            info={info} doGenKeywords={doGenKeywords}
            suggestedSources={suggestedSources}
            sourcesSearchLoading={sourcesSearchLoading}
            sourcesSearchError={sourcesSearchError}
            doSearchSources={doSearchSources}
            doAddAllCitations={doAddAllCitations}
            onAddAbstracts={(entries) => setAbstractsMap(prev => ({ ...prev, ...entries }))}
            onFinish={async () => { await saveToFirestore({ stage: "done", status: "done", content, citInputs, abstractsMap, refList }); setStage("done"); }}
            onProceedToWriting={() => setStage("writing")}
            setStage={setStage} workflowMode={workflowMode}
          />
        )}
        {stage === "done" && (
          <DoneStage
            content={content} displayOrder={displayOrder}
            titlePage={titlePage} setTitlePage={setTitlePage} titlePageLines={titlePageLines}
            regenId={regenId} setRegenId={setRegenId}
            regenPrompt={regenPrompt} setRegenPrompt={setRegenPrompt}
            regenLoading={regenLoading} regenAllLoading={regenAllLoading}
            loadMsg={loadMsg}
            appendicesText={appendicesText} setAppendicesText={setAppendicesText}
            appendicesLoading={appendicesLoading} setAppendicesLoading={setAppendicesLoading}
            appendicesCustomPrompt={appendicesCustomPrompt} setAppendicesCustomPrompt={setAppendicesCustomPrompt}
            speechText={speechText} setSpeechText={setSpeechText}
            speechLoading={speechLoading} setSpeechLoading={setSpeechLoading}
            presentationLoading={presentationLoading} presentationMsg={presentationMsg}
            presentationReady={presentationReady}
            docxLoading={docxLoading} setDocxLoading={setDocxLoading}
            figureRefs={figureRefs} figureKeywords={figureKeywords}
            figKwLoading={figKwLoading} figPanelOpen={figPanelOpen} setFigPanelOpen={setFigPanelOpen}
            sections={sections} info={info} methodInfo={methodInfo}
            doRegenSection={doRegenSection} doRegenAll={doRegenAll}
            regenAllAbortRef={regenAllAbortRef}
            doGenAppendices={doGenAppendices} saveToFirestore={saveToFirestore}
            copyAll={copyAll} resetAll={resetAll}
            generatePresentation={generatePresentation} generateSpeech={generateSpeech}
            doScanAndGenFigures={doScanAndGenFigures} setStage={setStage}
          />
        )}

        

        </div>
      </div>{/* end flex layout wrapper */}

      {/* Scroll arrow */}
      <button
        onClick={() => scrolled ? window.scrollTo({ top: 0, behavior: "smooth" }) : window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })}
        title={scrolled ? "Нагору" : "Вниз"}
        style={{
          position: "fixed", right: 18, bottom: 24, zIndex: 999,
          width: 38, height: 38, borderRadius: "50%",
          background: "#1a1a14", border: "1.5px solid #444",
          color: "#e8ff47", fontSize: 18, lineHeight: 1,
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", boxShadow: "0 2px 10px rgba(0,0,0,.25)",
          transition: "opacity .2s, transform .2s",
          opacity: 0.85,
        }}
        onMouseEnter={e => e.currentTarget.style.opacity = "1"}
        onMouseLeave={e => e.currentTarget.style.opacity = "0.85"}
      >
        {scrolled ? "↑" : "↓"}
      </button>

    </div>
  );
}
