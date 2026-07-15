import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { db } from "./firebase";
import { useAuth } from "./AuthContext";
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp,
} from "firebase/firestore";

import mammoth from "mammoth";
import { exportToDocx, exportPlanToDocx, exportAppendixToDocx, exportSpeechToDocx, renumberTablesAndFigures } from "./lib/exportDocx.js";
import { exportToPptxFile } from "./lib/exportPptx.js";
import { callClaude, callGemini, MODEL, MODEL_FAST } from "./lib/api.js";
import { playDoneSound } from "./lib/audio.js";
import { buildSYS, SYS_JSON, SYS_JSON_SHORT, SYS_JSON_ARRAY, STRUCTURE_READING_PROMPT, buildMethodologyReadingPrompt, buildTemplateAnalysisPrompt, buildCommentAnalysisPrompt, buildIllustrationsPrompt, buildIllustrationsPdfPrompt, buildDrawingsDescriptionPrompt, buildClientMaterialsAnalysisPrompt, buildCorrectionsAnalysisPrompt, buildCorrectionRewritePrompt, buildSourcesRestructureAnalysisPrompt, buildSourcePlacementPrompt, buildFileToSectionsPrompt, buildExtractStructurePrompt, buildContinuationPlanPrompt, buildAnnotationPrompt, buildAnnotationRegenPrompt, buildAntiPlagiarismSYS } from "./lib/prompts.js";
import { extractReadyWorkStructure, quickParsePlanIds } from "./lib/readyWorkExtract.js";
import { FIELD_LABELS, isPsychoPed, isEcon, isTechnical, hasEmpiricalResearch, getEmpiricalSections, getEconSections, getTechnicalSections, CODE_FILE_EXTENSIONS, STAGES_SOURCES_FIRST, STAGE_KEYS_SOURCES_FIRST, ORDER_STATUS, parsePagesAvg, parseTemplate, buildPlanText, buildPreviewStructure, calcSourceDist, buildWorkConfig, parseClientPlan, getLangLabels } from "./lib/planUtils.js";
import { serializeForFirestore } from "./lib/firestoreUtils.js";
import { getAcademicDefaults, classifyAppendixItem, detectSpecialty, normalizeWorkType } from "./lib/academicDefaults.js";
import { searchByPhrase, filterSourcesWithGemini, getEconInstitutionalSources } from "./lib/sourcesSearch.js";
import { applyCitationRemap, buildFinalReferenceList, buildCiteFormats, createReferenceDeduper, detectSourceGrouping, formatSourcesWithRetry, sortReferencesForDisplay } from "./lib/citationFormatting.js";
import { SpinDot, Shimmer } from "./components/SpinDot.jsx";
import { StagePills } from "./components/StagePills.jsx";
import { FieldBox, Heading, NavBtn, PrimaryBtn, GreenBtn, SaveIndicator } from "./components/Buttons.jsx";
import { StructurePreview } from "./components/StructurePreview.jsx";
import { PlanLoadingSkeleton } from "./components/PlanLoadingSkeleton.jsx";
import { DropZone } from "./components/DropZone.jsx";
import { PhotoDropZone } from "./components/PhotoDropZone.jsx";
import { ClientPlanInput } from "./components/ClientPlanInput.jsx";
import { ClientMaterialsZone } from "./components/ClientMaterialsZone.jsx";
import { InputStage } from "./components/stages/InputStage.jsx";
import { ParsedStage } from "./components/stages/ParsedStage.jsx";
import { PlanStage } from "./components/stages/PlanStage.jsx";
import { WritingStage } from "./components/stages/WritingStage.jsx";
import { SourcesStage } from "./components/stages/SourcesStage.jsx";
import { DoneStage } from "./components/stages/DoneStage.jsx";
import { ChecklistStage } from "./components/stages/ChecklistStage.jsx";
import { CorrectionsStage } from "./components/stages/CorrectionsStage.jsx";

// Fixes Latin characters accidentally inserted inside Cyrillic words by the AI model
function fixMixedScript(text, lang) {
  if (getLangLabels(lang).latinScript) return text;
  const map = {
    'a':'а','c':'с','e':'е','i':'і','o':'о','p':'р','x':'х','y':'у','g':'г','r':'р',
    'A':'А','B':'В','C':'С','E':'Е','H':'Н','I':'І','K':'К','M':'М','O':'О','P':'Р','T':'Т','X':'Х',
  };
  return text.replace(/\S+/g, w =>
    /[Ѐ-ӿ]/.test(w) && /[a-zA-Z]/.test(w)
      ? w.replace(/[a-zA-Z]/g, ch => map[ch] ?? ch)
      : w
  );
}

function typographQuotes(text) {
  return text
    .split(/(```[\s\S]*?```)/)
    .map((part, i) => (i % 2 === 1 ? part : part
      .replace(/[„""]([^"„""]*)["""]/g, "«$1»")
      .replace(/"([^"]*)"/g, "«$1»")))
    .join("");
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ── Профіль завдань дослідження у вступі: к-сть і характер за типом роботи ──
function getIntroTasksProfile(type, course, mainSecsLength, isLarge) {
  const wt = normalizeWorkType(type, course);
  const PROFILES = {
    course_1_2: { count: 4, nature: "переважно теоретичного й оглядового характеру (аналіз літератури, порівняння наукових підходів, узагальнення понять); практична складова мінімальна або відсутня" },
    course_3_4: { count: 4, nature: "переважно теоретичного й оглядового характеру (аналіз літератури, порівняння наукових підходів, узагальнення понять); практична складова мінімальна або відсутня" },
    bachelor: { count: 5, nature: "поєднання теоретичної частини з аналітичною/практичною складовою (аналіз конкретного підприємства, кейсу чи даних) — обов'язково" },
    master: { count: 6, nature: "з вищою вимогою до наукової новизни: включають не лише аналіз, а й розробку власних пропозицій, моделей чи рекомендацій з обґрунтуванням їх ефективності" },
  };
  if (PROFILES[wt]) {
    return { count: Math.min(PROFILES[wt].count, Math.max(mainSecsLength, 1)), nature: PROFILES[wt].nature };
  }
  return { count: Math.min(mainSecsLength, isLarge ? 8 : 5), nature: "" };
}

const INTRO_TASKS_MERGE_SPLIT_RULE = `Розділи плану — це змістова основа, а не буквальні назви завдань: сформулюй кожне завдання як дієслівну наукову конструкцію ("проаналізувати...", "систематизувати...", "розробити...", "обґрунтувати..." тощо). Якщо розділів більше, ніж потрібно завдань — об'єднай суміжні за змістом розділи в одне завдання; якщо розділів менше — розбий один розділ на 2 завдання за логічними частинами його підрозділів.`;

// ── Додатки з полями, що заповнюються автоматично після готовності основного тексту ──
const APPENDIX_FILL_MARKER = "ЗАПОВНЮЄТЬСЯ_АВТОМАТИЧНО";
const APPENDIX_FILL_MARKER_RULE = `Якщо для якогось конкретного поля додатку (очікуваний/фактичний результат, статус "пройдено/не пройдено", висновок, показник) значення логічно випливає із самої роботи, але наразі невідоме, бо основний текст роботи ще не написаний, — постав замість цього поля рівно текст ${APPENDIX_FILL_MARKER} (без лапок і додаткових символів), не вигадуй конкретне значення заздалегідь. Якщо ж поле вимагає реальних особистих чи фізичних даних, яких ти не можеш знати (ім'я виконавця, дата, підпис, характеристики обладнання, номер академічної групи) — залиш порожній підкреслений бланк "________" для ручного заповнення, це поле НЕ позначай маркером.`;

// ── Заземлення технічних тверджень на реальному коді клієнта (проти вигаданого функціоналу) ──
const CODE_GROUNDING_RULE = `Кожне технічне твердження про функціональність (назва методу, класу, поля, логіка обробки) має спиратися на конкретний фрагмент коду нижче. Якщо ти не можеш вказати, в якому саме методі це реалізовано — не згадуй це в тексті. Наявність поля чи структури, що натякає на функціональність (наприклад, поле IsConfirmed натякає на модерацію), не означає, що вся ця функціональність реалізована — описуй лише те, для чого є конкретний метод чи блок логіки в коді, а не те, що логічно мало б існувати. Використовуй лише наданий матеріал.`;

// ── Helpers for section reordering ──

function renumberSections(sections) {
  const chapterTitles = [];
  sections.forEach(s => {
    if (!["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type) && s.sectionTitle) {
      if (!chapterTitles.includes(s.sectionTitle)) chapterTitles.push(s.sectionTitle);
    }
  });
  const chNumMap = {};
  chapterTitles.forEach((title, idx) => { chNumMap[title] = idx + 1; });
  const chTitleMap = {};
  chapterTitles.forEach(title => {
    const newN = chNumMap[title];
    const match = title.match(/^РОЗДІЛ\s+\d+[.:]?\s*(.*)/i);
    const rest = match ? match[1] : title;
    chTitleMap[title] = `РОЗДІЛ ${newN}. ${rest}`.trimEnd();
  });
  const subCount = {};
  let lastChNum = 1;
  return sections.map(s => {
    if (["intro", "conclusions", "sources"].includes(s.type)) return s;
    if (s.type === "chapter_conclusion") {
      const newTitle = chTitleMap[s.sectionTitle] || s.sectionTitle;
      return { ...s, id: `${lastChNum}.conclusions`, sectionTitle: newTitle };
    }
    const cn = chNumMap[s.sectionTitle] || 1;
    lastChNum = cn;
    if (!subCount[cn]) subCount[cn] = 0;
    subCount[cn]++;
    const newId = `${cn}.${subCount[cn]}`;
    const newTitle = chTitleMap[s.sectionTitle] || s.sectionTitle;
    const labelBody = s.label.replace(/^\d+\.\d+\s*/, "");
    return { ...s, id: newId, sectionTitle: newTitle, label: `${newId} ${labelBody}` };
  });
}

function rebuildWithChapterConclusions(prev, newMainSecs) {
  const intro = prev.filter(s => s.type === "intro");
  const conclusions = prev.filter(s => s.type === "conclusions");
  const sources = prev.filter(s => s.type === "sources");
  const chapConcs = prev
    .filter(s => s.type === "chapter_conclusion")
    .sort((a, b) => (parseInt(a.id) || 0) - (parseInt(b.id) || 0));
  const chapTitles = [];
  const chapSecs = {};
  newMainSecs.forEach(s => {
    if (!chapSecs[s.sectionTitle]) { chapTitles.push(s.sectionTitle); chapSecs[s.sectionTitle] = []; }
    chapSecs[s.sectionTitle].push(s);
  });
  const result = [...intro];
  chapTitles.forEach((title, i) => {
    result.push(...chapSecs[title]);
    if (chapConcs[i]) result.push(chapConcs[i]);
  });
  result.push(...conclusions, ...sources);
  return result;
}

export default function AcademAssist({ orderId, onOrderCreated, onBack }) {
  const { user } = useAuth();

  const [scrolled, setScrolled] = useState(false);
  const [headerOpen, setHeaderOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [stage, setStage] = useState("input");
  const [maxStageIdx, setMaxStageIdx] = useState(0);
  const [tplText, setTplText] = useState("");
  const [comment, setComment] = useState("");
  const [clientPlan, setClientPlan] = useState("");
  const [fileLabel, setFileLabel] = useState("");
  const [fileB64, setFileB64] = useState(null);
  const [fileType, setFileType] = useState(null);
  const [methodInfo, setMethodInfo] = useState(null); // структурна інфо з методички
  const [commentAnalysis, setCommentAnalysis] = useState(null); // {planHints, writingHints}
  const [photos, setPhotos] = useState([]); // [{name, b64, type}] — додаткові фото
  const [illustrations, setIllustrations] = useState([]); // [{name, b64, type, caption, targetSection}]
  const [illustrationsPdf, setIllustrationsPdf] = useState(null); // {name, b64} — PDF із ілюстраціями
  const [illustrationDescs, setIllustrationDescs] = useState([]); // [{figureNum, description, caption, suggestedSection}]
  const [clientDrawings, setClientDrawings] = useState([]); // [{name, b64, type}] — реальні креслення клієнта (лише в Додатки, не в текст)
  const [clientMaterials, setClientMaterials] = useState([]); // [{name, text}] — файли клієнта
  const [clientMaterialsText, setClientMaterialsText] = useState(""); // ручний ввід
  const [clientMaterialsSummary, setClientMaterialsSummary] = useState(null); // {rawText, keyFacts, tablesMd, sectionHints}
  const [readyWorkFileName, setReadyWorkFileName] = useState(""); // готова частина роботи від клієнта (.docx)
  const [readyWorkText, setReadyWorkText] = useState(""); // сирий текст, розібраний по розділах після генерації плану
  const [readyWorkImportedIds, setReadyWorkImportedIds] = useState([]); // id розділів, заповнених з файлу клієнта
  const [readyWorkNeedsManualAI, setReadyWorkNeedsManualAI] = useState(false); // код не розпізнав заголовки — пропонуємо кнопку аналізу через ШІ
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
  const [searchAnchors, setSearchAnchors] = useState({});
  const [kwLoading, setKwLoading] = useState(false);
  const [kwError, setKwError] = useState("");
  const stopSearchRef = useRef(false);
  const [citInputs, setCitInputs] = useState({});
  const [docxLoading, setDocxLoading] = useState(false);
  const [planDocxLoading, setPlanDocxLoading] = useState(false);
  const [showManualPlanInput, setShowManualPlanInput] = useState(false);
  const [manualPlanText, setManualPlanText] = useState("");
  const [namingLoading, setNamingLoading] = useState(false);
  const [singleNamingId, setSingleNamingId] = useState(null);
  const [allCitLoading, setAllCitLoading] = useState(false);
  const [refList, setRefList] = useState([]);
  const [citInputsSnapshot, setCitInputsSnapshot] = useState(null);
  const [citStructured, setCitStructured] = useState({});
  const [figureRefs, setFigureRefs] = useState({});
  const [figureKeywords, setFigureKeywords] = useState([]);
  const [figKwLoading, setFigKwLoading] = useState(false);
  const [figPanelOpen, setFigPanelOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [dbLoading, setDbLoading] = useState(false);
  const [remapLoading, setRemapLoading] = useState(false);
  const [citStyleOverride, setCitStyleOverride] = useState(null);       // "ДСТУ 8302:2015" | "APA" | "MLA" | null
  const [sourcesOrderOverride, setSourcesOrderOverride] = useState(null); // "alphabetical" | "appearance" | null
  const [citFootnotes, setCitFootnotes] = useState(false);               // true → ДСТУ-посилання у виносках
  // For regenerating a single section
  const [regenId, setRegenId] = useState(null);
  const [regenPrompt, setRegenPrompt] = useState("");
  const [regenLoading, setRegenLoading] = useState(false);
  const [regenAllLoading, setRegenAllLoading] = useState(false);
  const regenAllAbortRef = useRef(null);
  // For reducing plagiarism (paraphrase existing text, not regenerate from scratch)
  const [plagId, setPlagId] = useState(null);
  const [plagLoading, setPlagLoading] = useState(false);
  const [plagAllLoading, setPlagAllLoading] = useState(false);
  const [plagAllMsg, setPlagAllMsg] = useState("");
  const plagAllAbortRef = useRef(null);
  const writingDoneRef = useRef(false);
  const autoRemapDoneRef = useRef(false);
  const appendixFillDoneRef = useRef(false);
  const maxStageIdxRef = useRef(0);
  const generationStartRef = useRef(null);
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
  const [econProfile, setEconProfile] = useState("");
  const [econProfileLoading, setEconProfileLoading] = useState(false);
  const [annotationUk, setAnnotationUk] = useState("");
  const [annotationEn, setAnnotationEn] = useState("");
  const [annotationLoading, setAnnotationLoading] = useState(false);
  const [titlePage, setTitlePage] = useState("");
  const [titlePageLines, setTitlePageLines] = useState(null);
  const [showMissingSources, setShowMissingSources] = useState(false);
  const [suggestedSources, setSuggestedSources] = useState({});
  const [sourcesSearchLoading, setSourcesSearchLoading] = useState({});
  const [sourcesSearchError, setSourcesSearchError] = useState({});
  const [abstractsMap, setAbstractsMap] = useState({}); // { citationString: abstractSnippet }
  const [searchPageCount, setSearchPageCount] = useState({}); // лічильник натискань "оновити" на секцію
  const [seenSourceKeys, setSeenSourceKeys] = useState({}); // заголовки вже показаних джерел — не показувати повторно
  const [phraseGroups, setPhraseGroups] = useState({}); // { secId: [{phrase, papers}] }
  // ── Стейт для стейджу "Правки" ──
  const [correctionText, setCorrectionText] = useState("");
  const [correctionPhotos, setCorrectionPhotos] = useState([]);
  const [correctionAnalysis, setCorrectionAnalysis] = useState(null);
  const [correctionChecked, setCorrectionChecked] = useState({});
  const [correctionLoading, setCorrectionLoading] = useState(false);
  const [correctionApplyLoading, setCorrectionApplyLoading] = useState(false);
  const [correctionApplyProgress, setCorrectionApplyProgress] = useState(null);
  const [correctionHistory, setCorrectionHistory] = useState([]);
  const [fileParseLoading, setFileParseLoading] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState("");
  const tokenAccRef = useRef({ inTok: 0, outTok: 0, costUsd: 0, claudeInTok: 0, claudeOutTok: 0, claudeCostUsd: 0, geminiInTok: 0, geminiOutTok: 0, geminiCostUsd: 0, serperCredits: 0, serperCostUsd: 0 });
  useEffect(() => {
    const handler = (e) => {
      const isGemini = e.detail.model?.startsWith("gemini");
      const isSerper = e.detail.model === "serper";
      const inTok = e.detail.inTok || 0;
      const outTok = e.detail.outTok || 0;
      const cost = e.detail.cost || 0;
      tokenAccRef.current = {
        inTok: tokenAccRef.current.inTok + (isSerper ? 0 : inTok),
        outTok: tokenAccRef.current.outTok + (isSerper ? 0 : outTok),
        costUsd: tokenAccRef.current.costUsd + cost,
        claudeInTok: tokenAccRef.current.claudeInTok + (!isGemini && !isSerper ? inTok : 0),
        claudeOutTok: tokenAccRef.current.claudeOutTok + (!isGemini && !isSerper ? outTok : 0),
        claudeCostUsd: tokenAccRef.current.claudeCostUsd + (!isGemini && !isSerper ? cost : 0),
        geminiInTok: tokenAccRef.current.geminiInTok + (isGemini ? inTok : 0),
        geminiOutTok: tokenAccRef.current.geminiOutTok + (isGemini ? outTok : 0),
        geminiCostUsd: tokenAccRef.current.geminiCostUsd + (isGemini ? cost : 0),
        serperCredits: tokenAccRef.current.serperCredits + (isSerper ? inTok : 0),
        serperCostUsd: tokenAccRef.current.serperCostUsd + (isSerper ? cost : 0),
      };
    };
    window.addEventListener("apicost", handler);
    return () => window.removeEventListener("apicost", handler);
  }, []);

  // Зберігаємо актуальний id документа (може змінитись після першого збереження)
  const currentIdRef = useRef(orderId || null);
  // true, якщо створення документа в Firestore вже підтверджено успішним збереженням
  const createdConfirmedRef = useRef(!!orderId);
  const abortRef = useRef(null);
  const contentRef = useRef(content);
  const savedTimerRef = useRef(null);
  useEffect(() => { contentRef.current = content; }, [content]);
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      setScrolled(y > 300);
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
          // якщо документ існує але без createdAt (збій першого save) — наступний save його додасть
          if (!d.createdAt) createdConfirmedRef.current = false;
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
          if (d.commentAnalysis) {
            const ca = d.commentAnalysis;
            if (Array.isArray(ca.sourcesHints)) ca.sourcesHints = ca.sourcesHints.join('; ');
            if (Array.isArray(ca.planHints)) ca.planHints = ca.planHints.join('; ');
            if (Array.isArray(ca.textStructureHints)) ca.textStructureHints = ca.textStructureHints.join('; ');
            if (Array.isArray(ca.writingHints)) ca.writingHints = ca.writingHints.join('; ');
            setCommentAnalysis(ca);
          }
          if (d.illustrations?.length) setIllustrations(d.illustrations);
          if (d.illustrationDescs?.length) setIllustrationDescs(d.illustrationDescs);
          if (d.clientDrawings?.length) setClientDrawings(d.clientDrawings);
          if (d.clientMaterialsSummary) setClientMaterialsSummary(d.clientMaterialsSummary);
          if (d.clientMaterialsText) setClientMaterialsText(d.clientMaterialsText);
          if (d.readyWorkFileName) setReadyWorkFileName(d.readyWorkFileName);
          if (d.readyWorkText) setReadyWorkText(d.readyWorkText);
          if (d.readyWorkImportedIds) setReadyWorkImportedIds(d.readyWorkImportedIds);
          if (d.content) setContent(d.content);
          if (d.citInputs) setCitInputs(d.citInputs);
          if (d.citStructured) setCitStructured(d.citStructured);
          if (d.abstractsMap) setAbstractsMap(d.abstractsMap);
          if (d.refList) setRefList(d.refList);
          if (d.suggestedSources) {
            setSuggestedSources(d.suggestedSources);
            const seen = {};
            Object.entries(d.suggestedSources).forEach(([secId, papers]) => {
              seen[secId] = new Set((papers || []).map(p => (p.title || '').toLowerCase().slice(0, 60)));
            });
            setSeenSourceKeys(seen);
          }
          if (d.phraseGroups) setPhraseGroups(d.phraseGroups);
          if (d.keywords) setKeywords(d.keywords);
          if (d.speechText) setSpeechText(d.speechText);
          if (d.appendicesText) setAppendicesText(d.appendicesText.replace(/\n{2,}/g, '\n'));
          if (d.econProfile) setEconProfile(d.econProfile);
          if (d.annotationUk) setAnnotationUk(d.annotationUk);
          if (d.annotationEn) setAnnotationEn(d.annotationEn);
          if (d.titlePage) setTitlePage(d.titlePage);
          if (d.titlePageLines) setTitlePageLines(d.titlePageLines);
          if (d.slideJson) setSlideJson(d.slideJson);
          if (d.presentationReady) setPresentationReady(true);
          if (d.correctionHistory?.length) setCorrectionHistory(d.correctionHistory);
          if (d.citStyleOverride) setCitStyleOverride(d.citStyleOverride);
          if (d.sourcesOrderOverride) setSourcesOrderOverride(d.sourcesOrderOverride);
          if (d.citFootnotes !== undefined) setCitFootnotes(d.citFootnotes);
          if (d.stage) {
            const keys = STAGE_KEYS_SOURCES_FIRST;
            const stageIdx = keys.indexOf(d.stage);
            setStage(d.stage);
            // Якщо написання вже завершено — позначаємо і розблоковуємо всі стадії
            const writingIdx = keys.indexOf("writing");
            const writingIsDone = stageIdx > writingIdx
              || d.status === "done"
              || (d.maxStageIdx !== undefined && d.maxStageIdx >= keys.length - 1)
              || (d.genIdx !== undefined && (d.sections?.length ?? 0) > 0 && d.genIdx >= d.sections.length);
            if (writingIsDone) {
              writingDoneRef.current = true;
              setMaxStageIdx(keys.length - 1);
            } else {
              const savedMax = d.maxStageIdx !== undefined ? d.maxStageIdx : stageIdx;
              setMaxStageIdx(Math.max(0, savedMax));
            }
          }
          if (d.genIdx !== undefined) setGenIdx(d.genIdx);
          if (d.totalInTok !== undefined) {
            tokenAccRef.current = {
              inTok: d.totalInTok || 0, outTok: d.totalOutTok || 0, costUsd: d.totalCostUsd || 0,
              claudeInTok: d.claudeInTok || 0, claudeOutTok: d.claudeOutTok || 0, claudeCostUsd: d.claudeCostUsd || 0,
              geminiInTok: d.geminiInTok || 0, geminiOutTok: d.geminiOutTok || 0, geminiCostUsd: d.geminiCostUsd || 0,
              serperCredits: d.serperCredits || 0, serperCostUsd: d.serperCostUsd || 0,
            };
          }
          if (d.generationStartedAt && d.status !== "done") {
            generationStartRef.current = new Date(d.generationStartedAt).getTime();
          }
        } else {
          // документ не існує (ID в sessionStorage але перший setDoc впав) — наступний save додасть createdAt
          createdConfirmedRef.current = false;
        }
      } catch (e) { console.error("Load error:", e); }
      setDbLoading(false);
    };
    load();
  }, [orderId, user]);

  const activeStageKeys = STAGE_KEYS_SOURCES_FIRST;
  const activeStages = STAGES_SOURCES_FIRST;

  // Оновлюємо maxStageIdx коли просуваємось вперед
  useEffect(() => {
    const idx = activeStageKeys.indexOf(stage);
    if (idx >= 0) {
      // На стейджі "done" одразу розблоковуємо checklist і corrections
      const newMax = stage === "done" ? activeStageKeys.length - 1 : idx;
      setMaxStageIdx(prev => Math.max(prev, newMax));
    }
  }, [stage]);

  // Синхронізуємо ref з state для використання всередині async-функцій
  useEffect(() => { maxStageIdxRef.current = maxStageIdx; }, [maxStageIdx]);

  // ── Авто-збереження полів введення (input stage) ──
  const inputSaveTimer = useRef(null);
  useEffect(() => {
    if (stage !== "input") return;
    if (!tplText.trim() && !comment.trim() && !clientPlan.trim() && !appendicesText.trim() && !clientMaterialsText.trim() && !readyWorkText.trim()) return;
    clearTimeout(inputSaveTimer.current);
    inputSaveTimer.current = setTimeout(() => {
      saveToFirestore({ tplText, comment, clientPlan, appendicesText, clientMaterialsText, readyWorkFileName, readyWorkText, fileLabel, stage: "input", status: "new" });
    }, 1500);
    return () => clearTimeout(inputSaveTimer.current);
  }, [tplText, comment, clientPlan, appendicesText, clientMaterialsText, readyWorkFileName, readyWorkText, stage]); // eslint-disable-line

  // ── Авто-збереження sections при ручному редагуванні плану ──
  const planSaveTimer = useRef(null);
  useEffect(() => {
    if (stage !== "plan" || !sections.length) return;
    clearTimeout(planSaveTimer.current);
    planSaveTimer.current = setTimeout(() => {
      saveToFirestore({ sections, planDisplay });
    }, 1500);
    return () => clearTimeout(planSaveTimer.current);
  }, [sections]); // eslint-disable-line

  // ── Авто-збереження citInputs на стейджі джерел ──
  const citSaveTimer = useRef(null);
  useEffect(() => {
    if (stage !== "sources") return;
    clearTimeout(citSaveTimer.current);
    citSaveTimer.current = setTimeout(() => {
      saveToFirestore({ citInputs, citStructured, abstractsMap });
    }, 500);
    return () => clearTimeout(citSaveTimer.current);
  }, [citInputs]); // eslint-disable-line

  // ── Авто-збереження результатів пошуку джерел ──
  const sourcesSaveTimer = useRef(null);
  useEffect(() => {
    if (stage !== "sources") return;
    if (!Object.keys(suggestedSources).length && !Object.keys(phraseGroups).length && !Object.keys(keywords).length) return;
    clearTimeout(sourcesSaveTimer.current);
    sourcesSaveTimer.current = setTimeout(() => {
      saveToFirestore({ suggestedSources, phraseGroups, keywords });
    }, 2000);
    return () => clearTimeout(sourcesSaveTimer.current);
  }, [suggestedSources, phraseGroups, keywords]); // eslint-disable-line

  // ── Збереження в Firestore ──
  const saveToFirestore = async (patch) => {
    if (!user) return;
    setSaving(true); setSaved(false);
    try {
      const isNew = !currentIdRef.current;
      const id = currentIdRef.current || `${user.uid}_${Date.now()}`;
      if (isNew) {
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
        maxStageIdx: maxStageIdxRef.current,
        totalInTok: tokenAccRef.current.inTok,
        totalOutTok: tokenAccRef.current.outTok,
        totalCostUsd: tokenAccRef.current.costUsd,
        claudeInTok: tokenAccRef.current.claudeInTok,
        claudeOutTok: tokenAccRef.current.claudeOutTok,
        claudeCostUsd: tokenAccRef.current.claudeCostUsd,
        geminiInTok: tokenAccRef.current.geminiInTok,
        geminiOutTok: tokenAccRef.current.geminiOutTok,
        geminiCostUsd: tokenAccRef.current.geminiCostUsd,
        serperCredits: tokenAccRef.current.serperCredits,
        serperCostUsd: tokenAccRef.current.serperCostUsd,
        ...(patch.status === "done" ? {
          completedAt: new Date().toISOString(),
          ...(generationStartRef.current ? { generationDurationSec: Math.round((Date.now() - generationStartRef.current) / 1000) } : {}),
        } : {}),
      };
      const data = serializeForFirestore({ ...base, ...patch });
      await setDoc(ref, { ...data, ...(!createdConfirmedRef.current ? { createdAt: new Date().toISOString() } : {}) }, { merge: true });
      createdConfirmedRef.current = true;
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
  };

  // Зберігаємо перед виходом — дебаунс-таймери скасовуються при розмонтуванні компонента
  const handleBack = async () => {
    clearTimeout(citSaveTimer.current);
    clearTimeout(sourcesSaveTimer.current);
    try {
      await saveToFirestore({ citInputs, citStructured, abstractsMap, suggestedSources, phraseGroups, keywords });
    } catch (e) { console.error("Pre-back save error:", e); }
    onBack?.();
  };

  const handleFile = useCallback((name, b64, type) => { setFileLabel(name); setFileB64(b64); setFileType(type); }, []);

  // ── Готова частина роботи від клієнта: витягуємо сирий текст (розбивка по розділах — після генерації плану) ──
  const handleReadyWorkFile = useCallback((arrayBuffer, fileName) => {
    mammoth.extractRawText({ arrayBuffer }).then(result => {
      const text = result.value.trim();
      if (!text) { alert("Не вдалося витягти текст з документа"); return; }
      setReadyWorkFileName(fileName);
      setReadyWorkText(text);
      setReadyWorkImportedIds([]);
      setReadyWorkNeedsManualAI(false);
    }).catch(e => alert("Помилка читання файлу: " + e.message));
  }, []);
  const handleRemoveReadyWork = useCallback(() => {
    setReadyWorkFileName(""); setReadyWorkText(""); setReadyWorkImportedIds([]); setReadyWorkNeedsManualAI(false);
  }, []);

  const handleNavigateMain = useCallback((s) => {
    if (running) return;
    setStage(s);
  }, [running]);

  const handleNavigateHeader = useCallback((s) => {
    if (running) return;
    setStage(s);
  }, [running]);

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
    // Переходимо на "Перевірку" одразу — далі йде методичка/коментар/ілюстрації, і це
    // може тривати довго, тож не тримаємо користувача на екрані "Дані", а даємо
    // аналізу дописатись у фоні (running лишається true, кнопки плану заблоковані).
    setStage("parsed");

    // КРОК 2: Якщо є методичка — пауза між запитами щоб не перевищити rate limit
    if (fileB64) {
      setApiError("");
      setLoadMsg("Читаю методичку...");
      await new Promise(r => setTimeout(r, 2000)); // пауза між двома API-викликами
      const docPart = { type: "document", source: { type: "base64", media_type: fileType || "application/pdf", data: fileB64 } };
      try {
        // Крок 1: витягуємо тільки структуру з chain-of-thought
        setLoadMsg("Читаю методичку... крок 1/2");
        const structMsgs = [docPart, { type: "text", text: STRUCTURE_READING_PROMPT }];
        const structRaw = await callGemini([{ role: "user", content: structMsgs }], null, SYS_JSON_SHORT, 2000, null, "gemini-2.5-flash", true);
        const structMatch = structRaw.match(/\{[\s\S]*\}/);
        let structureInfo = null;
        try { structureInfo = structMatch ? JSON.parse(structMatch[0]) : null; } catch (e) { console.warn("[methodology] structure step parse error:", e.message); }
        console.log("[methodology] structure step:", structureInfo);

        // Крок 2: повне читання методички з заблокованою структурою
        await new Promise(r => setTimeout(r, 1500));
        const methodMsgs = [docPart, { type: "text", text: buildMethodologyReadingPrompt(structureInfo) }];
        const raw = await callGemini([{ role: "user", content: methodMsgs }], null, SYS_JSON_SHORT, 8000, (s) => setLoadMsg(`Читаю методичку... крок 2/2, зачекайте ${s}с`), "gemini-2.5-flash", true);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
        // Якщо крок 1 дав структуру — пріоритет її значень над кроком 2
        if (structureInfo) {
          if (structureInfo.chaptersCount != null) parsed.chaptersCount = structureInfo.chaptersCount;
          if (structureInfo.subsectionsPerChapter != null) parsed.subsectionsPerChapter = structureInfo.subsectionsPerChapter;
          parsed.subsectionsPerChapterOverrides = structureInfo.subsectionsPerChapterOverrides ?? null;
          parsed.hasChapterConclusions = structureInfo.hasChapterConclusions;
          if (structureInfo.chapterTypes?.length) parsed.chapterTypes = structureInfo.chapterTypes;
          if (structureInfo.totalPages != null) parsed.totalPages = structureInfo.totalPages;
          if (structureInfo.introPages != null) parsed.introPages = structureInfo.introPages;
          if (structureInfo.conclusionsPages != null) parsed.conclusionsPages = structureInfo.conclusionsPages;
        }
        // Нормалізуємо поля, які Gemini може повернути як масив замість рядка
        if (Array.isArray(parsed.recommendedSources)) parsed.recommendedSources = parsed.recommendedSources.join('; ');
        if (Array.isArray(parsed.sourcesStyle)) parsed.sourcesStyle = parsed.sourcesStyle.join(', ');
        if (Array.isArray(parsed.citationStyle)) parsed.citationStyle = parsed.citationStyle.join('; ');
        if (typeof parsed.sourcesMinCount === 'string') parsed.sourcesMinCount = parseInt(parsed.sourcesMinCount) || null;
        setMethodInfo(parsed);
        if (parsed.titlePageTemplate) {
          const currentYear = new Date().getFullYear().toString();
          const topic = newInfo?.topic || "";
          const fillText = (t) => {
            let s = t;
            if (topic) {
              s = s.replace(/\[ТЕМА\]/g, topic);
              s = s.replace(/\(найменування\s+теми\)/gi, topic);
              s = s.replace(/\(назва\s+теми\)/gi, topic);
            }
            s = s.replace(/\[РІК\]/g, currentYear).replace(/\[ДАТА\]/g, currentYear);
            s = s.replace(/\b20\d\d\b/g, currentYear);
            s = s.replace(/\b20\d?\s*[_]+/g, currentYear);
            return s;
          };
          let filledLines = null;
          let filledText = "";
          if (Array.isArray(parsed.titlePageTemplate)) {
            filledLines = parsed.titlePageTemplate.map(item => ({ ...item, text: fillText(item.text) }));
            // Merge split-year lines: "Місто – 202" + "6" → "Місто – 2026"
            filledLines = filledLines.reduce((acc, item) => {
              const prev = acc[acc.length - 1];
              if (prev && /–\s*\d{1,3}$/.test(prev.text) && /^\d{1,2}$/.test(item.text.trim())) {
                acc[acc.length - 1] = { ...prev, text: prev.text + item.text.trim() };
              } else {
                acc.push(item);
              }
              return acc;
            }, []);
            filledText = filledLines.map(item => item.text).join("\n");
          } else {
            filledText = fillText(parsed.titlePageTemplate);
          }
          setTitlePage(filledText);
          setTitlePageLines(filledLines);
          await saveToFirestore({ tplText, comment, clientPlan, info: newInfo, methodInfo: parsed, fileLabel, titlePage: filledText, titlePageLines: filledLines, ...(appendicesText?.trim() ? { appendicesText } : {}), stage: "parsed", status: "new" });
        } else {
          await saveToFirestore({ tplText, comment, clientPlan, info: newInfo, methodInfo: parsed, fileLabel, ...(appendicesText?.trim() ? { appendicesText } : {}), stage: "parsed", status: "new" });
        }
      } catch (e) {
        console.warn("methodInfo extract failed:", e.message);
        setApiError(e.message);
        if (!methodInfo) setMethodInfo(null);
        await saveToFirestore({ tplText, comment, clientPlan, info: newInfo, ...(methodInfo ? { methodInfo } : {}), ...(appendicesText?.trim() ? { appendicesText } : {}), stage: "parsed", status: "new" });
      }
    } else {
      // Якщо PDF не завантажено але methodInfo вже є (з попереднього аналізу) — залишаємо його
      if (!methodInfo) setMethodInfo(null);
      await saveToFirestore({ tplText, comment, clientPlan, info: newInfo, ...(methodInfo ? { methodInfo } : {}), ...(appendicesText?.trim() ? { appendicesText } : {}), stage: "parsed", status: "new" });
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
        // Нормалізуємо поля, які AI може повернути як масив замість рядка
        if (Array.isArray(caParsed.sourcesHints)) caParsed.sourcesHints = caParsed.sourcesHints.join('; ');
        if (Array.isArray(caParsed.planHints)) caParsed.planHints = caParsed.planHints.join('; ');
        if (Array.isArray(caParsed.textStructureHints)) caParsed.textStructureHints = caParsed.textStructureHints.join('; ');
        if (Array.isArray(caParsed.writingHints)) caParsed.writingHints = caParsed.writingHints.join('; ');
        setCommentAnalysis(caParsed);
        await saveToFirestore({ tplText, comment, clientPlan, info: newInfo, commentAnalysis: caParsed, ...(appendicesText?.trim() ? { appendicesText } : {}), stage: "parsed", status: "new" });
      } catch (e) {
        console.warn("commentAnalysis failed:", e.message);
        setCommentAnalysis(null);
      }
    } else {
      setCommentAnalysis(null);
    }

    // КРОК 3.5: Опис ілюстрацій клієнта
    if (illustrations.length > 0 || illustrationsPdf) {
      setLoadMsg("Описую ілюстрації...");
      await new Promise(r => setTimeout(r, 500));
      try {
        let illContent;
        if (illustrationsPdf) {
          illContent = [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: illustrationsPdf.b64 } },
            { type: "text", text: buildIllustrationsPdfPrompt({ topic: newInfo?.topic, planSections: sections, lang: newInfo?.language }) },
          ];
        } else {
          illContent = [];
          for (const ill of illustrations) {
            illContent.push({ type: "image", source: { type: "base64", media_type: ill.type, data: ill.b64 } });
          }
          illContent.push({ type: "text", text: buildIllustrationsPrompt({ topic: newInfo?.topic, illustrations, planSections: sections, lang: newInfo?.language }) });
        }
        const illRaw = await callClaude([{ role: "user", content: illContent }], null, SYS_JSON_ARRAY, 1500, null, MODEL_FAST);
        const illMatch = illRaw.match(/\[[\s\S]*\]/);
        const illParsed = JSON.parse(illMatch?.[0] || illRaw);
        setIllustrationDescs(illParsed);
        await saveToFirestore({ ...(illustrationsPdf ? {} : { illustrations }), illustrationDescs: illParsed });
      } catch (e) {
        console.warn("illustrationDescs failed:", e.message);
        setIllustrationDescs([]);
      }
    } else {
      setIllustrationDescs([]);
    }

    // КРОК 3.6: Опис креслень клієнта (лише для заземлення тексту — самі зображення в текст не вставляються)
    let drawingDescsResult = [];
    if (clientDrawings.length > 0) {
      setLoadMsg("Описую креслення...");
      await new Promise(r => setTimeout(r, 500));
      try {
        const drContent = clientDrawings.map(d => ({ type: "image", source: { type: "base64", media_type: d.type, data: d.b64 } }));
        drContent.push({ type: "text", text: buildDrawingsDescriptionPrompt({ topic: newInfo?.topic, drawings: clientDrawings, lang: newInfo?.language }) });
        const drRaw = await callClaude([{ role: "user", content: drContent }], null, SYS_JSON_ARRAY, 1200, null, MODEL_FAST);
        const drMatch = drRaw.match(/\[[\s\S]*\]/);
        drawingDescsResult = JSON.parse(drMatch?.[0] || drRaw);
        await saveToFirestore({ clientDrawings });
      } catch (e) {
        console.warn("clientDrawingDescs failed:", e.message);
      }
    }

    // КРОК 4: Матеріали клієнта — зберігаємо повний текст без стиснення
    const combinedMaterialsText = [
      ...clientMaterials.map(m => `=== ${m.name} ===\n${m.text}`),
      ...drawingDescsResult.map(d => `=== Технічний опис креслення: ${d.name} ===\n${d.description}`),
      clientMaterialsText?.trim() || "",
    ].filter(Boolean).join("\n\n");

    if (combinedMaterialsText.trim()) {
      const rawSummary = { rawText: combinedMaterialsText };
      setClientMaterialsSummary(rawSummary);
      await saveToFirestore({ clientMaterialsSummary: rawSummary, clientMaterialsText: clientMaterialsText?.trim() || null });
    } else {
      setClientMaterialsSummary(null);
    }

    setRunning(false); runningRef.current = false; setLoadMsg("");
  };

  // ── Підбір ілюстрацій для розділу ──
  function getIllustrationsForSection(sec) {
    if (!illustrationDescs.length) return [];
    if (illustrations.length > 0) {
      return illustrations.map((ill, i) => {
        const desc = illustrationDescs.find(d => d.figureNum === i + 1) || illustrationDescs[i];
        if (!desc) return null;
        const target = ill.targetSection?.trim();
        if (target) {
          const t = target.toLowerCase().replace(/^розділ\s+/i, "").trim();
          if (sec.id?.toLowerCase() === t || sec.id?.toLowerCase().startsWith(t + ".") || sec.label?.toLowerCase().includes(t)) {
            return { ...desc, caption: ill.caption, index: i };
          }
          return null;
        }
        const suggested = desc.suggestedSection?.trim();
        if (suggested && (sec.id === suggested || sec.id?.startsWith(suggested + ".") || suggested?.startsWith(sec.id))) {
          return { ...desc, caption: ill.caption, index: i };
        }
        return null;
      }).filter(Boolean);
    }
    // PDF-режим: ілюстрації визначені тільки через illustrationDescs
    return illustrationDescs.filter(desc => {
      const suggested = desc.suggestedSection?.trim();
      return suggested && (sec.id === suggested || sec.id?.startsWith(suggested + ".") || suggested?.startsWith(sec.id));
    });
  }

  // ── Парсинг плану клієнта ──
  const buildDefaultPlan = (totalPages, lang = "Українська") => {
    const lc = getLangLabels(lang);
    const needThirdChapter = totalPages >= 40;
    const mainPages = Math.round(totalPages * 0.80);
    const chapCount = needThirdChapter ? 3 : 2;
    const pagesPerCh = Math.max(1, Math.round(mainPages / chapCount));
    const pagesPerSub = Math.max(1, Math.round(pagesPerCh / 3));
    const introPages = 2;
    const concPages = totalPages > 40 ? 3 : 2;
    const chapterNames = lc.chapterTemplate.slice(0, chapCount);
    const chTypes = ["theory", "analysis", "recommendations"];
    const sections = [];
    chapterNames.forEach((chName, ci) => {
      const chapNum = ci + 1;
      for (let i = 1; i <= 3; i++) sections.push({ id: `${chapNum}.${i}`, label: `${chapNum}.${i} [${lc.subsWord} ${chapNum}.${i}]`, sectionTitle: chName, pages: pagesPerSub, type: chTypes[ci] });
    });
    sections.push({ id: "intro", label: lc.intro, pages: introPages, type: "intro" });
    sections.push({ id: "conclusions", label: lc.conclusions, pages: concPages, type: "conclusions" });
    sections.push({ id: "sources", label: lc.sources, pages: 1, type: "sources" });
    return sections;
  };

  // ── Генерація плану ──
  const doGenPlan = async () => {
    setPlanLoading(true); setSections([]); setPlanDisplay(""); setStage("plan"); setReadyWorkNeedsManualAI(false);
    const d = info; const totalPages = parsePagesAvg(d.pages);
    const wc = buildWorkConfig({ info: d, methodInfo, commentAnalysis });
    const introP = wc.introPages;
    const conclP = wc.conclusionsPages;
    const L = getLangLabels(d?.language);
    const isEnglish = /англ|english/i.test(d?.language || "");

    const finalizeSections = async (secsIn) => {
      const secs = secsIn.filter(s => {
        if (s.type === "intro" && d?.includeIntro === false) return false;
        if (s.type === "conclusions" && d?.includeConclusions === false) return false;
        if (s.type === "sources" && d?.includeSources === false) return false;
        return true;
      });
      const mapped = secs.map(s => {
        let label = s.label;
        if (s.id && /^\d+\.\d+$/.test(s.id) && !label.startsWith(s.id)) {
          label = `${s.id} ${label}`;
        }
        return { ...s, label, prompts: s.type === "sources" ? 0 : Math.max(1, Math.ceil((s.pages || 1) / 3)) };
      });

      // Нормалізація: масштабуємо підрозділи до точної суми totalPages
      const withPrompts = (() => {
        const currentTotal = mapped.reduce((sum, s) => sum + (s.pages || 0), 0);
        if (currentTotal === totalPages) return mapped;
        const mainIdxs = mapped.reduce((acc, s, i) => {
          if (!["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type)) acc.push(i);
          return acc;
        }, []);
        const fixedTotal = mapped.reduce((sum, s, i) => mainIdxs.includes(i) ? sum : sum + (s.pages || 0), 0);
        const pagesForMain = Math.max(mainIdxs.length, totalPages - fixedTotal);
        const currentMainTotal = mainIdxs.reduce((sum, i) => sum + (mapped[i].pages || 1), 0);
        const result = [...mapped];
        let assigned = 0;
        mainIdxs.forEach((idx, j) => {
          const isLast = j === mainIdxs.length - 1;
          const p = isLast
            ? Math.max(1, pagesForMain - assigned)
            : Math.max(1, Math.round((mapped[idx].pages / currentMainTotal) * pagesForMain));
          result[idx] = { ...result[idx], pages: p, prompts: Math.max(1, Math.ceil(p / 3)) };
          if (!isLast) assigned += p;
        });
        return result;
      })();

      setSections(withPrompts); setPlanDisplay(buildPlanText(withPrompts));
      const { dist, total } = calcSourceDist(withPrompts, parsePagesAvg(d?.pages));
      setSourceDist(dist); setSourceTotal(total);
      setInfo(p => p ? { ...p, sourceCount: String(total) } : p);
      await saveToFirestore({ sections: withPrompts, stage: "plan", status: "plan_ready", info: { ...d, sourceCount: String(total) } });
      if (illustrations.length > 0 || illustrationsPdf) {
        try {
          let illContent;
          if (illustrationsPdf) {
            illContent = [
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: illustrationsPdf.b64 } },
              { type: "text", text: buildIllustrationsPdfPrompt({ topic: d?.topic, planSections: withPrompts, lang: d?.language }) },
            ];
          } else {
            illContent = illustrations.map(ill => ({
              type: "image", source: { type: "base64", media_type: ill.type, data: ill.b64 }
            }));
            illContent.push({ type: "text", text: buildIllustrationsPrompt({ topic: d?.topic, illustrations, planSections: withPrompts, lang: d?.language }) });
          }
          const illRaw = await callClaude([{ role: "user", content: illContent }], null, SYS_JSON_ARRAY, 1500, null, MODEL_FAST);
          const illMatch = illRaw.match(/\[[\s\S]*\]/);
          const illParsed = JSON.parse(illMatch?.[0] || illRaw);
          setIllustrationDescs(illParsed);
          await saveToFirestore({ illustrationDescs: illParsed });
        } catch (e) {
          console.warn("illustrationDescs re-analysis in plan:", e.message);
        }
      }
      // Готову частину роботи клієнта більше НЕ підганяємо автоматично через ШІ тут — код-розпізнавання
      // вже спробувало це вище; якщо не вийшло, клієнтка сама натискає кнопку "Аналізувати через ШІ".
      setPlanLoading(false);
    };

    // Якщо клієнт надав готову частину роботи — беремо структуру З НЕЇ (реальні заголовки й реальний обсяг),
    // а не вигадуємо нову структуру і не підганяємо готовий текст під неї. Спочатку пробуємо чистим кодом
    // (безкоштовно, миттєво); лише якщо код не зміг розпізнати заголовки — падаємо на ШІ-резерв.
    if (readyWorkText?.trim()) {
      try {
        setLoadMsg("Аналізую структуру готової частини роботи клієнта...");
        const planSections = clientPlan?.trim() ? quickParsePlanIds(clientPlan) : null;
        const extracted = extractReadyWorkStructure({ documentText: readyWorkText, lang: d?.language, planSections });

        if (extracted) {
          let finalSecs = extracted.sections;
          let finalContent = extracted.content;

          // Немає окремого плану клієнта — перевіряємо, чи не бракує розділів (продовження) і догенеровуємо їх
          if (!clientPlan?.trim()) {
            const chapNums = finalSecs.map(s => parseInt(String(s.id).split(".")[0], 10)).filter(n => !isNaN(n));
            const lastChapNum = chapNums.length ? Math.max(...chapNums) : 0;
            const existingPages = finalSecs.reduce((sum, s) => sum + (s.pages || 0), 0);
            const continuationBudget = totalPages;
            // Методичка клієнта, якщо є, головна — інакше загальне правило за обсягом
            const desiredChapCount = Math.max(lastChapNum, methodInfo?.chaptersCount || ((existingPages + continuationBudget) >= 40 ? 3 : 2));
            const hasIntro = finalSecs.some(s => s.type === "intro");
            const hasConclusions = finalSecs.some(s => s.type === "conclusions");
            const hasSources = finalSecs.some(s => s.type === "sources");
            const needsChapterConcl = methodInfo?.hasChapterConclusions === true;
            const missingChapNums = [];
            for (let n = lastChapNum + 1; n <= desiredChapCount; n++) missingChapNums.push(n);

            if (missingChapNums.length || !hasIntro || !hasConclusions || !hasSources) {
              setLoadMsg("Догенеровую відсутні розділи (продовження)...");
              let newChapterData = [];
              if (missingChapNums.length) {
                try {
                  const subsOverrides = methodInfo?.subsectionsPerChapterOverrides || {};
                  const defaultSubsPerChapter = methodInfo?.subsectionsPerChapter || 3;
                  const existingChapterTitles = [...new Set(finalSecs.filter(s => s.sectionTitle).map(s => s.sectionTitle))];
                  const prompt = buildContinuationPlanPrompt({
                    topic: d.topic, subject: d.subject, type: d.type, lang: d?.language,
                    existingChapterTitles,
                    newChapters: missingChapNums.map(num => ({
                      num,
                      subsCount: subsOverrides[String(num)] ?? defaultSubsPerChapter,
                      forcedType: methodInfo?.chapterTypes?.[num - 1],
                    })),
                    otherRequirements: methodInfo?.otherRequirements,
                  });
                  const raw = await callClaude([{ role: "user", content: prompt }], null, SYS_JSON, 2000, null, MODEL_FAST);
                  const jsonMatch = raw.match(/\{[\s\S]*\}/);
                  const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
                  newChapterData = parsed.chapters || [];
                } catch (e) { console.error("Продовження плану:", e); }
              }

              const newSubCount = newChapterData.reduce((sum, c) => sum + (c.subsections?.length || 0), 0);
              const introPages = hasIntro ? 0 : 2;
              const conclPages = hasConclusions ? 0 : 3;
              const srcPages = hasSources ? 0 : 1;
              const chapConclCount = needsChapterConcl ? newChapterData.length : 0;
              const pagesForSubs = Math.max(newSubCount, continuationBudget - introPages - conclPages - srcPages - chapConclCount);
              const pagesPerSub = newSubCount ? Math.max(1, Math.round(pagesForSubs / newSubCount)) : 0;

              const newChapterSecs = [];
              newChapterData.forEach(c => {
                const forcedType = methodInfo?.chapterTypes?.[c.num - 1];
                (c.subsections || []).forEach((subLabel, i) => {
                  const idMatch = subLabel.match(/^(\d+\.\d+)/);
                  const id = idMatch ? idMatch[1] : `${c.num}.${i + 1}`;
                  newChapterSecs.push({ id, label: subLabel, sectionTitle: c.title, pages: pagesPerSub, type: forcedType || c.type || "theory" });
                });
                if (needsChapterConcl) {
                  newChapterSecs.push({ id: `${c.num}.conclusions`, label: `Висновки до розділу ${c.num}`, sectionTitle: c.title, pages: 1, type: "chapter_conclusion" });
                }
              });

              const mainExisting = finalSecs.filter(s => !["intro", "conclusions", "sources"].includes(s.type));
              const introSec = finalSecs.find(s => s.type === "intro") || (hasIntro ? null : { id: "intro", label: "Вступ", pages: introPages, type: "intro" });
              const conclSec = finalSecs.find(s => s.type === "conclusions") || (hasConclusions ? null : { id: "conclusions", label: "Висновки", pages: conclPages, type: "conclusions" });
              const srcSec = finalSecs.find(s => s.type === "sources") || (hasSources ? null : { id: "sources", label: "Список використаних джерел", pages: srcPages, type: "sources" });

              finalSecs = [introSec, ...mainExisting, ...newChapterSecs, conclSec, srcSec].filter(Boolean);
            }
          } else {
            // Явний план клієнта є — додаємо пункти плану, яких НЕМА в самому документі, як порожні
            // (звичайний крок "Написання" допише їх пізніше); обсяг для них ділимо порівну з рештою бюджету.
            const foundIdsSet = new Set(finalSecs.map(s => s.id));
            const missingPlanIds = (planSections || []).filter(p => !foundIdsSet.has(p.id));
            if (missingPlanIds.length) {
              const existingPages = finalSecs.reduce((sum, s) => sum + (s.pages || 0), 0);
              const pagesLeft = Math.max(missingPlanIds.length, totalPages - existingPages);
              const pagesPerMissing = Math.max(1, Math.round(pagesLeft / missingPlanIds.length));
              missingPlanIds.forEach(p => {
                finalSecs = [...finalSecs, { id: p.id, label: p.label, pages: pagesPerMissing, type: p.chapNum === 1 ? "theory" : p.chapNum === 2 ? "analysis" : "recommendations" }];
              });
              finalSecs.sort((a, b) => {
                const na = String(a.id).split(".").map(Number), nb = String(b.id).split(".").map(Number);
                if (a.id === "intro") return -1; if (b.id === "intro") return 1;
                if (a.id === "conclusions" || a.id === "sources") return 1; if (b.id === "conclusions" || b.id === "sources") return -1;
                return (na[0] - nb[0]) || ((na[1] || 0) - (nb[1] || 0));
              });
            }
            if (!finalSecs.some(s => s.type === "intro")) finalSecs = [{ id: "intro", label: "Вступ", pages: 2, type: "intro" }, ...finalSecs];
            if (!finalSecs.some(s => s.type === "conclusions")) finalSecs = [...finalSecs, { id: "conclusions", label: "Висновки", pages: 3, type: "conclusions" }];
            if (!finalSecs.some(s => s.type === "sources")) finalSecs = [...finalSecs, { id: "sources", label: "Список використаних джерел", pages: 1, type: "sources" }];
          }

          const mergedContent = { ...contentRef.current, ...finalContent };
          const mergedCitInputs = { ...citInputs, ...extracted.citInputs };
          setSections(finalSecs);
          setPlanDisplay(buildPlanText(finalSecs));
          const { dist, total } = calcSourceDist(finalSecs, totalPages);
          setSourceDist(dist); setSourceTotal(total);
          setContent(mergedContent);
          contentRef.current = mergedContent;
          setCitInputs(mergedCitInputs);
          setReadyWorkImportedIds(extracted.foundIds);
          await saveToFirestore({
            sections: finalSecs, planDisplay: buildPlanText(finalSecs),
            content: mergedContent, citInputs: mergedCitInputs,
            readyWorkImportedIds: extracted.foundIds, stage: "plan", status: "plan_ready",
          });
          setPlanLoading(false); setLoadMsg("");
          return;
        }

        // Код не зміг розпізнати заголовки (нестандартне оформлення) — НЕ викликаємо ШІ автоматично.
        // Звичайний план згенерується як завжди нижче; аналіз через ШІ клієнтка запускає вручну кнопкою на етапі плану.
        console.warn("Структура з готової роботи: розпізнано замало розділів, повертаюсь до звичайної генерації плану");
        setReadyWorkNeedsManualAI(true);
      } catch (e) { console.error("Витяг структури з готової роботи:", e); }
      setLoadMsg("");
    }

    if (clientPlan?.trim()) {
      const parsed = parseClientPlan(clientPlan.trim(), totalPages, d?.language);
      if (parsed) { await finalizeSections(parsed); return; }
    }

    // Якщо на фото є готовий план — використати його структуру як шаблон (тільки якщо план клієнта не надано)
    if (!clientPlan?.trim() && commentAnalysis?.photoTOC && typeof commentAnalysis.photoTOC === "string" && commentAnalysis.photoTOC.length > 20) {
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

    // Якщо коментар містить приклад структури плану — використати як шаблон, адаптувати назви під тему (тільки якщо план клієнта не надано)
    if (!clientPlan?.trim() && comment?.trim() && /розділ\s*\d+/i.test(comment)) {
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

    // Дефолти за типом роботи — fallback коли клієнт нічого не вказав
    const acadDefaults = (!commentAnalysis?.practicalApproach && !commentAnalysis?.researchDesign)
      ? getAcademicDefaults(d.subject, d.type, d.course, d.topic)
      : null;
    const acadDefaultsBlock = acadDefaults
      ? `\nRESEARCH TYPE FOR PRACTICAL CHAPTER (use as context for subsection naming): ${acadDefaults.researchType}. Methods: ${acadDefaults.methods.join(", ")}.${acadDefaults.notes ? ` Note: ${acadDefaults.notes}.` : ""}`
      : "";

    if (methodInfo) {
      // Маємо готову структурну інфу з методички — генеруємо план без PDF
      const chapCount = methodInfo.chaptersCount || (totalPages >= 40 ? 3 : 2);
      const hasConcl = methodInfo.hasChapterConclusions === true || commentHasConcl || false;
      const chTypes = methodInfo.chapterTypes?.length ? methodInfo.chapterTypes : ["theory", "analysis", "recommendations"].slice(0, chapCount);
      const chapConclP = hasConcl ? chapCount : 0;

      const subsPerChapter = methodInfo.subsectionsPerChapter || 3;
      const subsOverrides = methodInfo.subsectionsPerChapterOverrides || {};
      const chapSubsCounts = Array.from({ length: chapCount }, (_, i) => subsOverrides[String(i + 1)] ?? subsPerChapter);
      const totalSubsCount = chapSubsCounts.reduce((a, b) => a + b, 0);
      const pagesPerSub = Math.max(3, Math.round((totalPages - introP - conclP - chapConclP) / totalSubsCount));
      const subsCountLine = chapSubsCounts.every(c => c === subsPerChapter)
        ? `- Subsections per chapter: ${subsPerChapter}`
        : chapSubsCounts.map((c, i) => `- Chapter ${i + 1} subsections: ${c}`).join('\n');

      const planPrompt = `Create a plan for ${d.type} on topic: "${d.topic}". Field: ${d.subject}. Pages: ${totalPages}.
Language of work: ${d.language || "Ukrainian"} — all labels and titles must be in this language.
${clientPlan?.trim() ? `\nCLIENT'S REQUIRED CHAPTER TITLES — use these EXACTLY as sectionTitle values, in this exact order, do NOT rename or reorder them:\n${clientPlan}\n` : (commentAnalysis?.planHints ? `\nCLIENT HINTS:\n${commentAnalysis.planHints}\n` : "")}${acadDefaultsBlock}
GUIDE REQUIREMENTS:
- Chapters: ${chapCount}
${subsCountLine}
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
    const namingPrompt = `For ${d.type} on topic "${d.topic}" (field: ${d.subject}) create subsection titles.${commentAnalysis?.planHints ? `\nHINTS:\n${commentAnalysis.planHints}` : ""}${psychoPedNamingHint}${acadDefaultsBlock}\nFixed structure:\n${planSecs.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type)).map(s => `${s.id} [${s.sectionTitle}]`).join("\n")}\n\nReturn ONLY JSON without markdown:\n{"titles":{"1.1":"Title","1.2":"Title","2.1":"Title","2.2":"Title"}}`;
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

  // ── Перерахувати сторінки рівномірно (чиста функція — придатна для повторного використання) ──
  const recalcPagesFor = (secs, wc) => {
    const mainIdxs = secs.reduce((acc, s, i) => {
      if (!["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type)) acc.push(i);
      return acc;
    }, []);
    // Фіксований обсяг — усе, що НЕ підрозділ: вступ/висновки (за wc), висновки до розділів (по 1 стор.), джерела (як є)
    const fixedTotal = secs.reduce((sum, s) => {
      if (s.type === "intro") return sum + wc.introPages;
      if (s.type === "conclusions") return sum + wc.conclusionsPages;
      if (s.type === "chapter_conclusion") return sum + 1;
      if (s.type === "sources") return sum + (s.pages || 1);
      return sum;
    }, 0);
    const pagesForMain = Math.max(mainIdxs.length * 3, wc.totalPages - fixedTotal);
    const pagesPerSub = Math.max(1, Math.floor(pagesForMain / Math.max(mainIdxs.length, 1)));
    const result = [...secs];
    let assigned = 0;
    mainIdxs.forEach((idx, j) => {
      const isLast = j === mainIdxs.length - 1;
      const p = isLast ? Math.max(1, pagesForMain - assigned) : pagesPerSub;
      result[idx] = { ...result[idx], pages: p, prompts: Math.max(1, Math.ceil(p / 3)) };
      if (!isLast) assigned += p;
    });
    return result.map(s => {
      if (s.type === "intro") return { ...s, pages: wc.introPages };
      if (s.type === "conclusions") return { ...s, pages: wc.conclusionsPages };
      if (s.type === "chapter_conclusion") return { ...s, pages: 1 };
      return s;
    });
  };

  const recalcPages = () => {
    const wc = buildWorkConfig({ info, methodInfo, commentAnalysis });
    setSections(prev => {
      const next = recalcPagesFor(prev, wc);
      setPlanDisplay(buildPlanText(next));
      return next;
    });
  };

  // ── Увімкнути/вимкнути вступ, висновки або список джерел прямо в уже сформованому плані ──
  const toggleStructureSection = (key) => {
    const type = key === "includeIntro" ? "intro" : key === "includeConclusions" ? "conclusions" : "sources";
    const wc = buildWorkConfig({ info, methodInfo, commentAnalysis });
    const lc = getLangLabels(info?.language);
    const currentlyOn = info?.[key] !== false;
    const nextOn = !currentlyOn;
    setInfo(p => (p ? { ...p, [key]: nextOn } : p));
    setSections(prev => {
      let base;
      if (!nextOn) {
        base = prev.filter(s => s.type !== type);
      } else if (prev.some(s => s.type === type)) {
        base = prev;
      } else {
        const newSec = type === "intro" ? { id: "intro", label: lc.intro, pages: wc.introPages, type: "intro" }
          : type === "conclusions" ? { id: "conclusions", label: lc.conclusions, pages: wc.conclusionsPages, type: "conclusions" }
          : { id: "sources", label: lc.sources, pages: 1, type: "sources" };
        if (type === "intro") base = [newSec, ...prev];
        else if (type === "sources") base = [...prev, newSec];
        else {
          const srcIdx = prev.findIndex(s => s.type === "sources");
          base = srcIdx >= 0 ? [...prev.slice(0, srcIdx), newSec, ...prev.slice(srcIdx)] : [...prev, newSec];
        }
      }
      const next = recalcPagesFor(base, wc);
      setPlanDisplay(buildPlanText(next));
      const { dist, total } = calcSourceDist(next);
      setSourceDist(dist); setSourceTotal(total);
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
    const lc = getLangLabels(info?.language);
    const sectionTitle = `${lc.chapterWord} ${chapNum}. [${lc.subsWord}]`;
    const newSubs = [1, 2, 3].map(i => ({
      id: `${chapNum}.${i}`,
      label: `${chapNum}.${i} [${lc.subsWord}]`,
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

  // ── Переміщення підрозділів ──
  const _applyMove = (prev, newMainSecs) => {
    const rebuilt = rebuildWithChapterConclusions(prev, newMainSecs);
    const renumbered = renumberSections(rebuilt);
    setPlanDisplay(buildPlanText(renumbered));
    const { dist, total } = calcSourceDist(renumbered);
    setSourceDist(dist); setSourceTotal(total);
    return renumbered;
  };

  const moveSectionUp = (sectionId) => {
    setSections(prev => {
      const movable = prev.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
      const idx = movable.findIndex(s => s.id === sectionId);
      if (idx <= 0) return prev;
      const newMovable = [...movable];
      const moved = { ...newMovable[idx] };
      const above = newMovable[idx - 1];
      if (moved.sectionTitle !== above.sectionTitle) moved.sectionTitle = above.sectionTitle;
      newMovable.splice(idx, 1);
      newMovable.splice(idx - 1, 0, moved);
      return _applyMove(prev, newMovable);
    });
  };

  const moveSectionDown = (sectionId) => {
    setSections(prev => {
      const movable = prev.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
      const idx = movable.findIndex(s => s.id === sectionId);
      if (idx < 0 || idx >= movable.length - 1) return prev;
      const newMovable = [...movable];
      const moved = { ...newMovable[idx] };
      const below = newMovable[idx + 1];
      if (moved.sectionTitle !== below.sectionTitle) moved.sectionTitle = below.sectionTitle;
      newMovable.splice(idx, 1);
      newMovable.splice(idx + 1, 0, moved);
      return _applyMove(prev, newMovable);
    });
  };

  const moveSectionToPosition = (sectionId, targetChapterTitle, targetPosition) => {
    setSections(prev => {
      const movable = prev.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
      const idx = movable.findIndex(s => s.id === sectionId);
      if (idx < 0) return prev;
      const newMovable = [...movable];
      const [moved] = newMovable.splice(idx, 1);
      const updatedMoved = { ...moved, sectionTitle: targetChapterTitle };
      let insertIdx = newMovable.length;
      let count = 0;
      for (let i = 0; i <= newMovable.length; i++) {
        if (newMovable[i]?.sectionTitle === targetChapterTitle) {
          if (count === targetPosition - 1) { insertIdx = i; break; }
          count++;
        } else if (count > 0) { insertIdx = i; break; }
      }
      newMovable.splice(insertIdx, 0, updatedMoved);
      return _applyMove(prev, newMovable);
    });
  };

  // ── Придумати назви для заглушок ──
  const doNamePlaceholders = async () => {
    setNamingLoading(true);
    const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const placeholderSubs = mainSecs.filter(s => /\[|новий/i.test(s.label));
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

  // ── Придумати назву для одного підрозділу-заглушки ──
  const doNameSinglePlaceholder = async (sectionId) => {
    setSingleNamingId(sectionId);
    const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const target = mainSecs.find(s => s.id === sectionId);
    if (!target) { setSingleNamingId(null); return; }
    const isChapPlaceholder = /\[Назва розділу/i.test(target.sectionTitle);
    const chNum = sectionId.split(".")[0];
    const planContext = mainSecs.map(s => `${s.id} — ${s.label}`).join("\n");
    const prompt = `Academic work. Topic: "${info?.topic}". Type: ${info?.type}. Field: ${info?.subject}.
Language: ${info?.language || "Ukrainian"} — all titles must be in this language.

CURRENT PLAN:
${planContext}

Generate a title for ONE placeholder section: ${sectionId} (currently: "${target.label}"). It must fit the topic and not repeat existing sections.
${isChapPlaceholder ? `Also generate a chapter title for РОЗДІЛ ${chNum}.` : ""}
Return ONLY JSON:
{"subsections":{"${sectionId}":"subsection title"}${isChapPlaceholder ? `,"chapters":{"${chNum}":"chapter title (without РОЗДІЛ N. prefix)"}` : ""}}`;
    try {
      const raw = await callClaude([{ role: "user", content: prompt }], null, SYS_JSON_SHORT, 600, null, MODEL_FAST);
      const match = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match?.[0] || raw);
      const subTitles = parsed.subsections || {};
      const chapTitles = parsed.chapters || {};
      setSections(prev => {
        const next = prev.map(s => {
          const cn = s.id.split(".")[0];
          const newSectionTitle = chapTitles[cn] ? `РОЗДІЛ ${cn}. ${chapTitles[cn]}` : s.sectionTitle;
          const newLabel = subTitles[s.id] ? `${s.id} ${subTitles[s.id]}` : s.label;
          return { ...s, label: newLabel, sectionTitle: newSectionTitle };
        });
        setPlanDisplay(buildPlanText(next));
        return next;
      });
    } catch (e) {
      console.warn("single naming failed:", e.message);
    }
    setSingleNamingId(null);
  };

  const startGen = async () => {
    const ORDER = ["theory", "analysis", "recommendations", "chapter_conclusion", "intro", "conclusions", "sources"];
    setSections(prev => [...prev].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type)));
    // Не стираємо текст, імпортований з готової частини роботи клієнта — лише те, що ще належить дописати
    setContent(prev => {
      const preserved = {};
      (readyWorkImportedIds || []).forEach(id => { if (prev[id]) preserved[id] = prev[id]; });
      return preserved;
    });
    setGenIdx(0); setPaused(false); writingDoneRef.current = false; autoRemapDoneRef.current = false; appendixFillDoneRef.current = false;
    const practicalApproachForGen = commentAnalysis?.practicalApproach;
    const acadDefaultsForGen = getAcademicDefaults(info?.subject, info?.type, info?.course, info?.topic);
    const needsAppendixForGen = practicalApproachForGen || isPsychoPed(info) || (acadDefaultsForGen?.appendicesAiGen?.length > 0);
    const needsEconProfileForGen = !econProfile && isEcon(info);
    (async () => {
      // Для економічних робіт додатки мають спиратись на той самий профіль підприємства,
      // що й основний текст — тому чекаємо його готовності перед генерацією додатків.
      const profileForAppendices = needsEconProfileForGen ? await doGenEconProfile() : econProfile;
      if (!appendicesText && needsAppendixForGen) doGenAppendices(profileForAppendices);
    })();
    setStage("sources");
    generationStartRef.current = Date.now();
    saveToFirestore({ workflowMode: "sources-first", stage: "sources", status: "writing", generationStartedAt: new Date().toISOString() });
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

  // ── Авто-заповнення полів додатків, позначених маркером, при переході на done ──
  useEffect(() => {
    if (stage !== "done") return;
    doFillAppendixData();
  }, [stage]); // eslint-disable-line

  // ── Генерація тексту ──
  useEffect(() => {
    if (stage !== "writing" || paused) return;
    if (runningRef.current) return;
    if (genIdx >= sections.length) {
      if (!writingDoneRef.current) {
        writingDoneRef.current = true;
        playDoneSound();
        const allUnlocked = activeStageKeys.length - 1;
        saveToFirestore({ stage: "writing", status: "writing", content, citInputs, maxStageIdx: allUnlocked });
      }
      if (!autoRemapDoneRef.current) {
        autoRemapDoneRef.current = true;
        doRemapCitations();
      }
      return;
    }
    const sec = sections[genIdx];
    if (contentRef.current[sec.id] !== undefined) { setGenIdx(g => g + 1); return; }
    if (sec.type === "sources") {
      setContent(p => ({ ...p, [sec.id]: "[Додайте джерела на кроці «Джерела»]" }));
      setGenIdx(g => g + 1); return;
    }
    // Практичні підрозділи потребують готового Додатку А — чекаємо якщо він ще генерується
    if (appendicesLoading && !appendicesText && info) {
      const empSecs = getEmpiricalSections(sections, info, commentAnalysis, methodInfo);
      const hasEmpirical = hasEmpiricalResearch(commentAnalysis, methodInfo);
      const practApproach = commentAnalysis?.practicalApproach;
      const needsAppendix = empSecs.chapterSectionIds.includes(sec.id) || sec.id === empSecs.anchorId ||
        (hasEmpirical && ["analysis", "recommendations"].includes(sec.type)) ||
        (practApproach && practApproach !== "questionnaire" && ["analysis", "recommendations"].includes(sec.type));
      if (needsAppendix) return;
    }
    runSection(sec);
  }, [stage, genIdx, paused, sections, appendicesText, appendicesLoading]);

  const runSection = async (sec) => {
    runningRef.current = true; setRunning(true); setLoadMsg("Генерую: " + sec.label + "...");
    const ctrl = new AbortController(); abortRef.current = ctrl;
    const d = info;
    const lang = d?.language || "Українська";

    // Будуємо повний multi-turn контекст як у Claude.ai
    const buildMessages = (instruction) => {
      const prevEntries = Object.entries(contentRef.current).filter(([k]) => k !== sec.id);
      if (!prevEntries.length) return [{ role: "user", content: instruction }];
      const isLargeWork = totalPages > 50;
      const currentChapter = sec.id.split(".")[0];
      const contextText = prevEntries.map(([k, v]) => {
        const s = sections.find(x => x.id === k);
        const label = s?.label || k;
        if (!isLargeWork) return `=== ${label} ===\n${v}`;
        const sameChapter = k.split(".")[0] === currentChapter;
        const isIntroForConclusions = sec.type === "conclusions" && s?.type === "intro";
        if (sameChapter || isIntroForConclusions) return `=== ${label} ===\n${v}`;
        // Інші розділи: лише перший змістовний абзац
        const firstPara = v.split("\n").find(p => p.trim().length > 60) || v.slice(0, 400);
        return `=== ${label} [перший абзац] ===\n${firstPara}`;
      }).join("\n\n---\n\n");
      return [
        { role: "user", content: "Ось вже написані частини цієї роботи:" },
        { role: "assistant", content: contextText },
        { role: "user", content: instruction },
      ];
    };
    const approxParas = Math.max(2, Math.round((sec.pages || 1) * 2.5));
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
      const tasksProfile = getIntroTasksProfile(d.type, d.course, mainSecs.length, isLarge);
      const tasksCount = tasksProfile.count;

      // Будуємо список елементів вступу: стандартні + з методички
      const lc = getLangLabels(lang);
      const il = lc.introLabels || {};
      const defaultComponents = lc.defaultIntroComponents || ["актуальність теми", "мета дослідження", "завдання дослідження", "об'єкт дослідження", "предмет дослідження", "методи дослідження", "практичне значення дослідження", "структура роботи"];
      const allComponents = methodInfo?.introComponents?.length
        ? methodInfo.introComponents
        : defaultComponents;

      // Формуємо рядки структури з урахуванням мови роботи
      const componentLines = allComponents.map((comp, i) => {
        const label = comp.charAt(0).toUpperCase() + comp.slice(1);
        if (/актуальн|actuality|aktual|relevance|relevanz|pertine/i.test(comp)) {
          const phrase = il.actuality || "Актуальність теми.";
          return `${label}: one paragraph starting with "${phrase}" — immediately introduce why the topic is relevant today. Do not split into multiple paragraphs.`;
        }
        if (/теоретико|теоретичн.*основ|методологічн.*основ|podstawy.*teoret|theoretical.*basis/i.test(comp)) {
          const phrase = il.theoryBasis || "Теоретико-методологічну основу дослідження становлять";
          return `${label}: one paragraph starting with "${phrase}" — list scholarly works, authors, regulatory sources relevant to the topic.`;
        }
        if ((/мета|goal|cel|ziel|objetivo|purpose|účel|cieľ/i.test(comp)) && !/завдання|tasks|zadania|aufgaben|úkoly|úlohy/i.test(comp)) {
          const phrase = il.goal || "Мета дослідження –";
          return `${label}: write in format "${phrase} [clearly formulated goal for topic "${d.topic}"]".`;
        }
        if (/завдання|tasks|zadania|aufgaben|tareas|úkoly|úlohy/i.test(comp)) {
          const phrase = il.tasks || "Завдання дослідження:";
          const natureLine = tasksProfile.nature ? ` Завдання мають бути ${tasksProfile.nature}.` : "";
          return `${label}: write in format "${phrase}" — then exactly ${tasksCount} numbered tasks.${natureLine} ${INTRO_TASKS_MERGE_SPLIT_RULE}\nСтруктура плану роботи (змістова основа для завдань):\n${mainSecs.map((s, j) => `   ${j + 1}) "${s.label}"`).join("\n")}`;
        }
        if (/об.єкт|przedmiot|gegenstand|objeto/i.test(comp) && !/предмет|subject|obiekt/i.test(comp)) {
          const phrase = il.object || "Об'єкт дослідження –";
          return `${label}: write in format "${phrase} [phenomenon or process being studied]".`;
        }
        if (/предмет|subject|obiekt/i.test(comp)) {
          const phrase = il.subject || "Предмет дослідження –";
          return `${label}: write in format "${phrase} [specific aspect of the object being analyzed]".`;
        }
        if (/метод|method/i.test(comp) && !/теоретико|методологічн.*основ|podstawy/i.test(comp)) {
          const phrase = il.methods || "Методи дослідження:";
          return `${label}: write in format "${phrase} [list of methods, comma-separated]".`;
        }
        if (/новизн|novelty|nowość|neuheit|novedad/i.test(comp)) {
          const phrase = il.novelty || "Наукова новизна дослідження –";
          return `${label}: write in format "${phrase} [new positions or solutions proposed by the author]".`;
        }
        if (/практичн|practical|praktyczn|praktisch|přínos|prínos/i.test(comp)) {
          const phrase = il.practical || "Практична значущість:";
          return `${label}: write in format "${phrase} [how results can be applied in practice]".`;
        }
        if (/апробац|approbation|aprobata/i.test(comp)) {
          const phrase = il.approbation || "Апробація результатів дослідження –";
          return `${label}: write in format "${phrase} [conferences, publications, seminars where results were presented]".`;
        }
        if (/структура|structure|struktura|štruktúra/i.test(comp)) {
          const phrase = il.structure || "Структура роботи:";
          return `${label}: write in format "${phrase} the work consists of introduction," — number of chapters, conclusions, sources list, total page count.`;
        }
        return `${label}: write in format "${label} – [content relevant to topic "${d.topic}"]".`;
      });

      instruction = `Напиши ВСТУП для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.

INTRO STRUCTURE (follow strictly, each element as a new paragraph):

${componentLines.map((l, i) => `${i + 1}. ${l}`).join("\n\n")}
${methodInfo?.otherRequirements ? `\nМЕТОДИЧКА ВИМОГИ: ${methodInfo.otherRequirements}` : ""}${commentAnalysis?.textStructureHints ? `\nКЛІЄНТ ВИМОГИ (ОБОВ'ЯЗКОВО): ${commentAnalysis.textStructureHints}` : ""}

IMPORTANT: use already written sections (in context) for exact formulation of methods, sample, object — everything must match the text. Follow each element's format strictly. No citations. No bold or italic. Write in continuous paragraphs. EXCEPTION: research tasks — write as numbered list (1. 2. 3. ...), each task on a new line.`;

    } else if (sec.type === "conclusions") {
      const conclReq = methodInfo?.conclusionsRequirements || "";
      const mainSecsForConcl = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
      const conclTasksProfile = getIntroTasksProfile(d.type, d.course, mainSecsForConcl.length, isLarge);

      instruction = `Напиши ВИСНОВКИ для ${d.type} на тему "${d.topic}".
${conclReq ? `ВИМОГИ МЕТОДИЧКИ: ${conclReq}\n` : ""}${commentAnalysis?.textStructureHints ? `ВИМОГИ КЛІЄНТА ДО СТРУКТУРИ (ОБОВ'ЯЗКОВО): ${commentAnalysis.textStructureHints}\n` : ""}
ПРАВИЛА:
- Обсяг: приблизно ${(sec.pages || 2) * 270} слів, ±10% (~${sec.pages} стор.).
- Перший абзац — загальний підсумок мети і що вдалось досягти
- Далі — рівно ${conclTasksProfile.count} абзаців, по одному на кожне завдання дослідження, сформульоване у вступі (текст вступу є в контексті) — у тому самому порядку. Якщо завдання у вступі поєднувало кілька підрозділів плану — зведи їхні конкретні результати в одному абзаці; якщо завдання було розбите з одного підрозділу — розподіли результати на відповідну кількість абзаців
- Кожен такий абзац = конкретний результат, що відповідає своєму завданню
- Останній абзац — перспективи подальших досліджень
- НЕ повторювати те що сказано у вступі, НЕ вводити нову інформацію
- Без посилань. Без жирного. Без нумерації. Пиши суцільними абзацами, не використовуй жодних списків.

Спирайся на весь написаний текст роботи, включно з формулюваннями завдань у вступі (є в контексті) — формулюй конкретні висновки на основі реального змісту підрозділів.`;

    } else if (sec.type === "chapter_conclusion") {
      const chapNum = sec.chapterNum || sec.id.split(".")[0];
      const chapConclReq = methodInfo?.chapterConclusionRequirements || "стисло підсумуй основні думки підрозділів, кожен абзац = один підрозділ";
      instruction = `Напиши "Висновки до розділу ${chapNum}" для ${d.type} на тему "${d.topic}".
${methodInfo?.chapterConclusionRequirements ? `ВИМОГИ МЕТОДИЧКИ: ${methodInfo.chapterConclusionRequirements}` : ""}
Обсяг: 120–150 слів (не більше).
Без нової інформації. Без посилань. Без жирного. Без нумерації. Пиши суцільними абзацами.
Спирайся на повний текст підрозділів розділу ${chapNum} (є в контексті).`;
    } else {
      // Вимоги з методички для цього типу підрозділу
      const methodReqMap = {
        theory: methodInfo?.theoryRequirements,
        analysis: methodInfo?.analysisRequirements,
        recommendations: methodInfo?.analysisRequirements,
      };
      const methodReq = methodReqMap[sec.type] || methodInfo?.otherRequirements || "";

      const empSecs = getEmpiricalSections(sections, d, commentAnalysis, methodInfo);
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
        const profileBlock = econProfile
          ? `\nФІКСОВАНІ БАЗОВІ ДАНІ ПІДПРИЄМСТВА (використовуй САМЕ ЦІ дані в усіх розрахунках і таблицях цього підрозділу, не вигадуй іншу назву/рік/цифри):\n${econProfile}\n`
          : "";
        econBlock = `${profileBlock}${formulasBlock}${tablesBlock}${genericEcon}`;
      }

      // Технічний блок (інженерія/будівництво/IT/кібербезпека)
      const technicalSecIds = getTechnicalSections(sections, d);
      const isTechnicalSec = technicalSecIds.includes(sec.id);
      let technicalBlock = "";
      if (isTechnicalSec) {
        const secFormulasT = (methodInfo?.requiredFormulas || []).filter(f => !f.section || f.section === sec.type);
        const secTablesT = (methodInfo?.requiredTables || []).filter(t => !t.section || t.section === sec.type);
        const formulasBlockT = secFormulasT.length
          ? `\nОБОВ'ЯЗКОВІ ФОРМУЛИ З МЕТОДИЧКИ (підстав реалістичні числові значення та підрахуй результат):\n${secFormulasT.map(f =>
            `- ${f.name}: ${f.formula}\n  Змінні: ${f.variables}${f.interpretation ? `\n  Інтерпретація: ${f.interpretation}` : ""}`
          ).join("\n")}`
          : "";
        const tablesBlockT = secTablesT.length
          ? `\nОБОВ'ЯЗКОВІ ТАБЛИЦІ З МЕТОДИЧКИ (відтвори структуру, заповни реалістичними даними під тему "${d.topic}"):\n${secTablesT.map(t =>
            `- ${t.name}\n  Структура: ${t.structure}\n  Що заповнювати: ${t.instructions}`
          ).join("\n")}`
          : "";
        const genericTechnical = !secFormulasT.length && !secTablesT.length
          ? `\nОБОВ'ЯЗКОВО для цього підрозділу (технічна/інженерна робота):
- Наведи конкретний інженерний/технічний розрахунок з формулою і підстановкою реалістичних числових значень
- Результати розрахунків зведи в таблицю markdown (|---|---| формат)`
          : "";
        const hasClientMaterials = !!(clientMaterialsSummary?.rawText || clientMaterialsText?.trim());
        const codeSnippetBlock = hasClientMaterials
          ? `\nЯКЩО серед МАТЕРІАЛІВ КЛІЄНТА є реальний вихідний код — цей підрозділ ОБОВ'ЯЗКОВО пиши на основі цього коду: опиши реальну структуру програми (модулі/класи/функції), послідовність роботи алгоритму та ключову логіку, посилаючись на фактичні назви функцій/класів/змінних із наданого коду. ${CODE_GROUNDING_RULE} Додатково наведи в тексті ОДИН короткий фрагмент (5-15 рядків) цього коду як ілюстрацію, оформлений у потрійних зворотних лапках (\`\`\`), точно як у наданому коді (не вигадуй новий код, не спотворюй). Якщо коду серед матеріалів немає — пропусти цю вимогу.`
          : "";
        technicalBlock = `${formulasBlockT}${tablesBlockT}${genericTechnical}${codeSnippetBlock}`;
      }

      const appendixBlock = appendicesText
        ? `\nДОДАТОК А (вже згенерований — спирайся на нього точно):\n${appendicesText}\n`
        : "";

      const rd = commentAnalysis?.researchDesign ?? (commentAnalysis?.empiricalHints ? { instrumentType: "questionnaire", groups: [], comparisonRequired: false, biographicalFields: [], statisticalMinN: null } : null);
      const methodInfoHasEmpirical = !!(methodInfo && /анкет|опитуванн|емпіричн|респондент|вибірк|тест|експеримент|методик/i.test(
        [methodInfo.analysisRequirements, methodInfo.otherRequirements, methodInfo.theoryRequirements].filter(Boolean).join(" ")
      ));
      const hasEmpirical = !!(rd || methodInfoHasEmpirical);
      // Якщо клієнт явно вказав нон-анкетний тип практики — не нав'язуємо емпіричний блок
      const practicalApproachEarly = commentAnalysis?.practicalApproach;
      const suppressEmpiricalBlock = !!(practicalApproachEarly && practicalApproachEarly !== "questionnaire");

      // Дефолтні методи за типом роботи — fallback коли клієнт нічого не вказав
      const secAcadDefaults = (!rd && !methodInfoHasEmpirical && !practicalApproachEarly && ["analysis", "recommendations"].includes(sec.type))
        ? getAcademicDefaults(d.subject, d.type, d.course, d.topic)
        : null;
      const secMethodsHint = secAcadDefaults?.methods?.length
        ? `\nМЕТОДИ ДОСЛІДЖЕННЯ (за типом роботи): ${secAcadDefaults.researchType}. Використовувані методи: ${secAcadDefaults.methods.join(", ")}.${secAcadDefaults.notes ? ` Примітка: ${secAcadDefaults.notes}.` : ""}`
        : "";

      // Будуємо читабельний рядок з researchDesign або fallback
      const buildEmpHint = (rd, legacyHint) => {
        if (!rd) return legacyHint || "";
        const parts = [];
        if (rd.groups?.length) parts.push(`Групи: ${rd.groups.map(g => `${g.name}${g.minN ? ` (n≥${g.minN})` : ""}${g.criteria ? `, ${g.criteria}` : ""}`).join("; ")}.`);
        if (rd.biographicalFields?.length) parts.push(`Біографічний блок: ${rd.biographicalFields.join(", ")}.`);
        if (rd.statisticalMinN) parts.push(`Мін. вибірка: ${rd.statisticalMinN} осіб.`);
        if (rd.comparisonRequired) parts.push("Порівняння між групами обов'язкове.");
        return parts.join(" ") || legacyHint || "";
      };
      const empHint = buildEmpHint(rd, commentAnalysis?.empiricalHints || (methodInfo?.otherRequirements && /учасник|респондент|вибірк|осіб/i.test(methodInfo.otherRequirements) ? methodInfo.otherRequirements : "20-30 респондентів"));

      const hasMultipleGroups = (rd?.groups?.length || 0) > 1;
      const comparisonRequired = rd?.comparisonRequired || hasMultipleGroups;
      const bioDesc = rd?.biographicalFields?.length ? rd.biographicalFields.join(", ") : "ПІБ, вік, стаж, кваліфікація";
      const tableDataSource = appendicesText ? "по запитаннях з Додатку А" : "з репрезентативними відсотковими показниками за темою дослідження";
      const appendixRef = appendicesText ? '\nДодай речення: "Анкета наведена у Додатку А."' : "";
      const compTableInstruction = comparisonRequired ? `\nПорівняльна таблиця: ОБОВ'ЯЗКОВО окрема таблиця markdown що порівнює ключові показники між групами.` : "";

      if (isEmpChapter && !suppressEmpiricalBlock) {
        empiricalBlock = `

КОНТЕКСТ (емпіричне дослідження):
${appendixBlock}${empHint ? `ВИМОГА: ${empHint}\n` : ""}Цей підрозділ є частиною емпіричного дослідження. Визнач за назвою підрозділу що саме писати:
- якщо підрозділ про організацію або методику дослідження: опиши вибірку (групи, кількість, критерії відбору), біографічний блок анкети (${bioDesc}), метод та принцип проведення.${appendixRef}
- якщо підрозділ про аналіз або результати: таблиця markdown ${tableDataSource}, аналіз даних.${compTableInstruction}
- якщо підрозділ про рекомендації: спирайся на результати з попередніх підрозділів, не повторюй опис вибірки.`;
      } else if (isEmpAnchor && !suppressEmpiricalBlock) {
        empiricalBlock = `

ОБОВ'ЯЗКОВО для цього підрозділу (емпіричне дослідження):
${appendixBlock}${empHint ? `ВИМОГА: ${empHint}\n` : ""}1. Вибірка: ${rd?.groups?.length ? rd.groups.map(g => `${g.name}${g.minN ? ` — мін. ${g.minN} осіб` : ""}${g.criteria ? ` (${g.criteria})` : ""}`).join("; ") : "25-30 осіб (вік, категорія, умови відбору)"}.
2. Біографічний блок анкети: ${bioDesc}.
3. Метод: ${rd?.instrumentType === "fitness_test" ? "фізичне тестування" : rd?.instrumentType === "psycho_scale" ? "психологічна методика/шкала" : rd?.instrumentType === "pedagogical_experiment" ? "педагогічний експеримент" : "анкетування"}. Мета, кількість запитань${appendicesText ? " — точно як в Додатку А" : " — відповідно до теми"}.
4. Принцип проведення: умови та порядок.
5. Результати: таблиця markdown (|---|---| формат) ${tableDataSource}.${compTableInstruction}
6. Аналіз: інтерпретація результатів.${appendixRef}`;
      } else if (hasEmpirical && ["analysis", "recommendations"].includes(sec.type) && !suppressEmpiricalBlock) {
        const practicalSecs = sections.filter(s => ["analysis", "recommendations"].includes(s.type));
        const secIdx = practicalSecs.findIndex(s => s.id === sec.id);
        if (secIdx === 0) {
          empiricalBlock = `

ОБОВ'ЯЗКОВО для цього підрозділу (емпіричне дослідження):
${appendixBlock}${empHint ? `ВИМОГА: ${empHint}\n` : ""}1. Організація дослідження: ${rd?.groups?.length ? `вибірка по групах: ${rd.groups.map(g => `${g.name}${g.minN ? ` (n≥${g.minN})` : ""}${g.criteria ? `, ${g.criteria}` : ""}`).join("; ")}` : "вибірка — кількість, категорії, критерії відбору"}.
2. Біографічний блок анкети: ${bioDesc}.
3. Метод: ${rd?.instrumentType === "fitness_test" ? "фізичне тестування" : rd?.instrumentType === "psycho_scale" ? "психологічна методика/шкала" : rd?.instrumentType === "pedagogical_experiment" ? "педагогічний експеримент" : "анкетування"}. ${appendicesText ? "Мета та кількість запитань — точно як в Додатку А." : "Опиши мету та орієнтовну кількість питань."}
4. Принцип проведення: умови та порядок, якщо кілька груп — опиши кожну окремо.
5. Результати: таблиця markdown (|---|---| формат) ${tableDataSource}.${compTableInstruction}
6. Аналіз: інтерпретація результатів.${appendixRef}`;
        } else if (secIdx < practicalSecs.length - 1) {
          empiricalBlock = `

КОНТЕКСТ (емпіричне дослідження):
${appendixBlock}${empHint ? `ВИМОГА: ${empHint}\n` : ""}Цей підрозділ продовжує аналіз результатів. Таблиця markdown (|---|---| формат) ${tableDataSource}.${compTableInstruction} Аналіз і висновки. Не повторюй опис вибірки та методики.`;
        } else {
          empiricalBlock = `

КОНТЕКСТ (емпіричне дослідження):
${appendixBlock}${empHint ? `ВИМОГА: ${empHint}\n` : ""}Рекомендації на основі результатів дослідження з попередніх підрозділів. Не повторюй опис вибірки та методики.`;
        }
      }

      // Практичний блок для нон-анкетних типів практики
      let practicalBlock = "";
      const practicalApproachRun = commentAnalysis?.practicalApproach;
      if (practicalApproachRun && practicalApproachRun !== "questionnaire" && ["analysis", "recommendations"].includes(sec.type)) {
        const appRef = appendicesText ? "\nДодай речення з посиланням на Додаток А." : "";
        const appCtx = appendicesText ? `\nДОДАТОК А (вже згенерований — спирайся на нього точно):\n${appendicesText}\n` : "";
        if (practicalApproachRun === "textbook_analysis") {
          practicalBlock = `

ОБОВ'ЯЗКОВО для цього підрозділу (аналіз підручників):${appCtx}Визнач за назвою підрозділу що саме писати:
- підрозділ про критерії або методику аналізу: опиши принципи відбору підручників, параметри порівняння (структура, зміст, типи вправ, ілюстрації, методичний апарат, відповідність програмі).
- підрозділ про аналіз або результати: таблиця markdown з порівнянням підручників за критеріями (спирайся на Додаток А). Після таблиці детальний аналіз кожного підручника.${appRef}
- підрозділ про висновки або рекомендації: порівняльні висновки, який підручник краще відповідає меті навчання і чому.`;
        } else if (practicalApproachRun === "lesson_observation") {
          practicalBlock = `

ОБОВ'ЯЗКОВО для цього підрозділу (аналіз уроків):${appCtx}Визнач за назвою підрозділу що саме писати:
- підрозділ про методику спостереження: опиши протокол спостереження (Додаток А), кількість спостережуваних уроків, вчителів, клас.${appRef}
- підрозділ про результати: таблиця markdown з результатами спостережень за аспектами (мотивація, пояснення, практика, організація тощо). Аналіз виявлених закономірностей.
- підрозділ про рекомендації: методичні рекомендації вчителям на основі результатів спостережень.`;
        } else if (practicalApproachRun === "materials_development") {
          practicalBlock = `

ОБОВ'ЯЗКОВО для цього підрозділу (розробка матеріалів):${appCtx}Визнач за назвою підрозділу що саме писати:
- підрозділ про теоретичне обґрунтування: принципи розробки матеріалів, психолого-педагогічне підґрунтя вибору підходу.
- підрозділ про опис матеріалів: детальний опис розроблених матеріалів (Додаток А) — структура, призначення, як використовувати на практиці.${appRef}
- підрозділ про апробацію або ефективність: результати практичного застосування або обґрунтування очікуваної ефективності матеріалів.`;
        }
      }

      const secSourceLines = (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
      const sourcesBlock = secSourceLines.length > 0
        ? `\nДЖЕРЕЛА ДЛЯ ЦЬОГО ПІДРОЗДІЛУ (${secSourceLines.length} шт.) — спирайся на них при написанні, вставляй посилання [N] після відповідних тверджень:\n${secSourceLines.map((s, i) => {
          const snippet = abstractsMap[s];
          return snippet ? `[${i + 1}] ${s}\n    Зміст: ${snippet}` : `[${i + 1}] ${s}`;
        }).join("\n")}\n`
        : "";
      const citNote = secSourceLines.length > 0
        ? "Вставляй [N] у текст одразу після тверджень що спираються на джерело (де N — номер зі списку вище). ЗАБОРОНЕНО вигадувати імена авторів перед цитатою — не пиши 'Іванов А. стверджує...'. Використовуй безособові конструкції: 'у дослідженні зазначається [N]', 'науковці вказують [N]', 'встановлено [N]' тощо. Розподіляй посилання рівномірно між усіма наданими джерелами — спочатку використай кожне хоч раз, і лише потім за потреби повторюй. Одне й те саме джерело [N] НЕ цитувати більше 2 разів у межах цього підрозділу."
        : "Без посилань [1],[2].";

      instruction = `Напиши підрозділ "${sec.label}" для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.
Тип підрозділу: ${typeHints[sec.type] || "основний"}.
${methodReq ? `ВИМОГИ МЕТОДИЧКИ ДО ЦЬОГО РОЗДІЛУ: ${methodReq}` : ""}${empiricalBlock}${practicalBlock}${econBlock}${technicalBlock}${secMethodsHint}${sourcesBlock}
ПЛАН РОБОТИ (для розуміння структури та уникнення повторів):
${planSummary}

Обсяг: приблизно ${Math.round((sec.pages || 1) * 270)} слів, ±10% (~${sec.pages} стор.).
Не обривай текст. Завершуй підсумковим абзацом. ${citNote} Без жирного.
ЗАБОРОНЕНО вставляти будь-які внутрішні підназви, заголовки абзаців або окремі рядки-мітки ("Загальна картина", "Результати аналізу" тощо). Кожен рядок тексту — повне речення, рядок таблиці або підпис до таблиці/рисунка.
Абзаци мають різнитись за довжиною: чергуй короткі (2-3 речення) з довшими (5-7 речень).`;
    }
    const clientWritingReqs = [
      commentAnalysis?.writingHints,
      commentAnalysis?.textStructureHints,
    ].filter(Boolean).join("\n");
    if (clientWritingReqs) instruction += `\n\nВИМОГИ КЛІЄНТА (ОБОВ'ЯЗКОВО виконати при написанні):\n${clientWritingReqs}`;
    const secIllustrations = getIllustrationsForSection(sec);
    if (secIllustrations.length) {
      const hasIndex = secIllustrations.every(ill => ill.index != null);
      const illLines = secIllustrations.map(ill =>
        `Рис. ${ill.figureNum}${ill.caption ? ` – ${ill.caption}` : ""}: ${ill.description}${hasIndex ? ` — маркер вставки: [КЛІЄНТ-ІЛЮСТРАЦІЯ:${ill.index}]` : ""}`
      ).join("\n");
      instruction += `\n\nІЛЮСТРАЦІЇ КЛІЄНТА ДО ЦЬОГО ПІДРОЗДІЛУ (вже надані, треба вставити в текст):\n${illLines}\nОБОВ'ЯЗКОВО для кожної ілюстрації: 1) додай посилання на неї в тексті (напр. "як показано на Рис. X.Y..."), використовуючи нумерацію X.Y відповідно до номера підрозділу;${hasIndex ? " 2) безпосередньо ПЕРЕД стандартним підписом рисунка (Рис. X.Y – Назва) додай окремим рядком точно вказаний вище маркер вставки у форматі [КЛІЄНТ-ІЛЮСТРАЦІЯ:N] — без жодних змін, більше нічого на цьому рядку." : ""}`;
    }
    const isTechnicalSecFinal = getTechnicalSections(sections, d).includes(sec.id);
    if (clientMaterialsSummary?.rawText) {
      instruction += `\n\nМАТЕРІАЛИ КЛІЄНТА (використовуй ці дані — не вигадуй, не замінюй):\n${clientMaterialsSummary.rawText.slice(0, 80000)}`;
      if (isTechnicalSecFinal) instruction += `\n\n${CODE_GROUNDING_RULE}`;
    } else if (clientMaterialsText?.trim()) {
      instruction += `\n\nМАТЕРІАЛИ КЛІЄНТА (використовуй ці дані — не вигадуй, не замінюй):\n${clientMaterialsText.slice(0, 80000)}`;
      if (isTechnicalSecFinal) instruction += `\n\n${CODE_GROUNDING_RULE}`;
    }
    const sectionMaxTokens = Math.min(60000, Math.max(8000, Math.round((sec.pages || 1) * 3000)));
    const cleanResult = (raw) => typographQuotes(fixMixedScript(raw, lang)
      .replace(/ — /g, ", ").replace(/— /g, "").replace(/ —/g, "")
      .replace(/[ᄀ-ᇿ⺀-鿿ꀀ-꓿가-퟿豈-﫿]/g, "")
)
      .replace(/(\[[^\]]*)\]\s*\[([^\]]*\])/g, "$1; $2")
      .replace(/(\[[^\]]*)\]\s*\[([^\]]*\])/g, "$1; $2");
    // Ціль в словах для перевірки фактичного обсягу після генерації (окремо від тексту промпту)
    const targetWords = sec.type === "chapter_conclusion" ? 135 : Math.round((sec.pages || 1) * 270);
    const enforceWordCount = async (text) => {
      if (sec.type === "sources") return text;
      const n = countWords(text);
      try {
        if (n < targetWords * 0.85) {
          const missing = targetWords - n;
          setLoadMsg(`Дописую: ${sec.label}...`);
          const contPrompt = `Ось поточний текст підрозділу "${sec.label}" (${n} слів):\n\n${text}\n\nДопиши ще приблизно ${missing} слів, органічно продовжуючи виклад далі. Не повторюй вже написане. Не додавай вступних фраз на кшталт "Продовжимо" чи "Отже". Просто продовжуй текст з того місця де він закінчився, без заголовків і міток.`;
          const contRaw = await callClaude([{ role: "user", content: contPrompt }], ctrl.signal, buildSYS(lang, methodInfo), Math.min(20000, Math.max(2000, Math.round(missing * 3))));
          return text + "\n\n" + cleanResult(contRaw).trim();
        }
        if (n > targetWords * 1.2) {
          setLoadMsg(`Скорочую: ${sec.label}...`);
          const shortenPrompt = `Ось поточний текст підрозділу "${sec.label}" (${n} слів):\n\n${text}\n\nСкороти його до приблизно ${targetWords} слів: прибери повтори та другорядні деталі, збережи головні тези і структуру абзаців. Поверни лише скорочений текст, без коментарів.`;
          const shortRaw = await callClaude([{ role: "user", content: shortenPrompt }], ctrl.signal, buildSYS(lang, methodInfo), Math.min(30000, Math.max(4000, Math.round(targetWords * 3))));
          return cleanResult(shortRaw).trim();
        }
      } catch (e) {
        // Якщо допис/скорочення не вдалось - лишаємо початковий текст як є
      }
      return text;
    };
    try {
      const raw = await callClaude(buildMessages(instruction), ctrl.signal, buildSYS(lang, methodInfo), sectionMaxTokens, (s) => setLoadMsg(`Генерую: ${sec.label}... зачекайте ${s}с`));
      // Видаляємо довге тире на всякий випадок (модель іноді ігнорує заборону)
      const result = await enforceWordCount(cleanResult(raw));
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
    const approxParas = Math.max(2, Math.round((sec.pages || 1) * 2.5));
    const customInstructions = regenPrompt ? `\nДОДАТКОВІ ВИМОГИ: ${regenPrompt}` : "";
    const originalText = contentRef.current[sec.id] || "";

    // Будуємо multi-turn: всі інші секції як контекст + оригінал поточної
    const buildRegenMessages = (instruction) => {
      const otherEntries = Object.entries(contentRef.current).filter(([k]) => k !== sec.id);
      const msgs = [];
      if (otherEntries.length) {
        const contextText = otherEntries.map(([k, v]) => {
          const s = sections.find(x => x.id === k);
          return `=== ${s?.label || k} ===\n${v}`;
        }).join("\n\n---\n\n");
        msgs.push({ role: "user", content: "Ось вже написані частини цієї роботи:" });
        msgs.push({ role: "assistant", content: contextText });
      }
      if (originalText) {
        msgs.push({ role: "user", content: `Ось поточний варіант підрозділу "${sec.label}" — він потребує переписування:` });
        msgs.push({ role: "assistant", content: originalText });
      }
      msgs.push({ role: "user", content: instruction });
      return msgs;
    };

    let instruction = "";
    const totalPages = parsePagesAvg(d?.pages);
    const isLarge = totalPages > 40;

    if (sec.type === "intro") {
      const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
      const tasksProfile = getIntroTasksProfile(d.type, d.course, mainSecs.length, isLarge);
      const tasksCount = tasksProfile.count;
      const lc = getLangLabels(lang);
      const il = lc.introLabels || {};
      const defaultComponents = lc.defaultIntroComponents || ["актуальність теми", "мета дослідження", "завдання дослідження", "об'єкт дослідження", "предмет дослідження", "методи дослідження", "практичне значення дослідження", "структура роботи"];
      const allComponents = methodInfo?.introComponents?.length ? methodInfo.introComponents : defaultComponents;
      const componentLines = allComponents.map((comp) => {
        const label = comp.charAt(0).toUpperCase() + comp.slice(1);
        if (/актуальн|actuality|aktual|relevance|relevanz|pertine/i.test(comp)) {
          const phrase = il.actuality || "Актуальність теми.";
          return `${label}: one paragraph starting with "${phrase}" — strong opening sentence about the problem. Do NOT split into multiple paragraphs.`;
        }
        if (/теоретико|теоретичн.*основ|методологічн.*основ|theoretical.*basis|podstawy.*teor/i.test(comp)) {
          const phrase = il.theoryBasis || "Теоретико-методологічну основу дослідження становлять";
          return `${label}: paragraph starting with "${phrase}" — list authors, academic works, regulatory acts relevant to the topic.`;
        }
        if ((/мета|goal|cel\b|ziel|objetivo|cíl|účel/i.test(comp)) && !/завдання|task|zadani|aufgab/i.test(comp)) {
          const phrase = il.goal || "Мета дослідження –";
          return `${label}: write as "${phrase} [clearly formulated goal]".`;
        }
        if (/завдання|tasks|zadania|aufgaben|tareas|úkoly/i.test(comp)) {
          const phrase = il.tasks || "Завдання дослідження:";
          const natureLine = tasksProfile.nature ? ` Tasks should be ${tasksProfile.nature}.` : "";
          return `${label}: write as "${phrase}" — exactly ${tasksCount} numbered tasks.${natureLine} ${INTRO_TASKS_MERGE_SPLIT_RULE}\nPlan structure (content basis for tasks):\n${mainSecs.map((s, j) => `   ${j + 1}) "${s.label}"`).join("\n")}`;
        }
        if (/об.єкт|object|przedmiot\s+bad|gegenstand|objeto\s+de/i.test(comp)) {
          const phrase = il.object || "Об'єкт дослідження –";
          return `${label}: write as "${phrase} [phenomenon or process under study]".`;
        }
        if (/предмет|subject|obiekt\s+bad|subjekt|sujeto/i.test(comp)) {
          const phrase = il.subject || "Предмет дослідження –";
          return `${label}: write as "${phrase} [specific aspect of the object]".`;
        }
        if ((/метод|methods|metody|methoden|métodos/i.test(comp)) && !/теоретико|методологічн.*основ|teoretyczn|podstawy/i.test(comp)) {
          const phrase = il.methods || "Методи дослідження:";
          return `${label}: write as "${phrase} [comma-separated list of methods]".`;
        }
        if (/новизн|novelty|nowość|neuheit|novedad/i.test(comp)) {
          const phrase = il.novelty || "Наукова новизна дослідження –";
          return `${label}: write as "${phrase} [new propositions, distinction from known]".`;
        }
        if (/практичн|practical|praktyczn|praktisch|práctico/i.test(comp)) {
          const phrase = il.practical || "Практична значущість:";
          return `${label}: write as "${phrase} [practical application of results]".`;
        }
        if (/апробац|approbation|aprobacja/i.test(comp)) {
          const phrase = il.approbation || "Апробація результатів дослідження –";
          return `${label}: write as "${phrase} [where presented: conferences, articles, seminars]".`;
        }
        if (/структура|structure|struktura|aufbau/i.test(comp)) {
          const phrase = il.structure || "Структура роботи:";
          return `${label}: write as "${phrase} the work consists of introduction," — number of chapters, conclusions, bibliography.`;
        }
        return `${label}: write in format "${label} – [content relevant to the topic]".`;
      });

      instruction = `Rewrite the INTRODUCTION for ${d.type} on the topic "${d.topic}". Field: ${d.subject}.

INTRO STRUCTURE (follow strictly, each element as a new paragraph):

${componentLines.map((l, i) => `${i + 1}. ${l}`).join("\n\n")}
${methodInfo?.otherRequirements ? `\nMETHOD REQUIREMENTS: ${methodInfo.otherRequirements}` : ""}
IMPORTANT: use the written chapters (provided in context) for precise formulation of methods, sample, object. Follow the format of each element strictly. Do NOT bold or italicize anything. No citations. EXCEPTION: research tasks — write as a numbered list (1. 2. 3. ...), each task on a new line.${customInstructions}`;

    } else if (sec.type === "conclusions") {
      const mainSecsForConcl = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
      const conclTasksProfile = getIntroTasksProfile(d.type, d.course, mainSecsForConcl.length, isLarge);
      instruction = `Перепиши ВИСНОВКИ для ${d.type} на тему "${d.topic}".
${methodInfo?.conclusionsRequirements ? `ВИМОГИ МЕТОДИЧКИ: ${methodInfo.conclusionsRequirements}\n` : ""}
Обсяг: приблизно ${(sec.pages || 2) * 225} слів, ±10% (~${sec.pages} стор.). Кожен абзац = один конкретний результат.
Перший — загальний підсумок. Далі — рівно ${conclTasksProfile.count} абзаців, по одному на кожне завдання дослідження, сформульоване у вступі (текст вступу є в контексті), у тому самому порядку; якщо завдання поєднувало кілька підрозділів — зведи результати в одному абзаці, якщо було розбите з одного підрозділу — розподіли на відповідну кількість абзаців. Останній — перспективи.
НЕ повторювати вступ. НЕ вводити нове. Без посилань. Без жирного. Без нумерації.
Спирайся на весь написаний текст роботи, включно з формулюваннями завдань у вступі (є в контексті).${customInstructions}`;
    } else {
      const empSecsRegen = getEmpiricalSections(sections, d, commentAnalysis, methodInfo);
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
        const profileBlockRegen = econProfile
          ? `\nФІКСОВАНІ БАЗОВІ ДАНІ ПІДПРИЄМСТВА (використовуй САМЕ ЦІ дані в усіх розрахунках і таблицях цього підрозділу, не вигадуй іншу назву/рік/цифри):\n${econProfile}\n`
          : "";
        econBlockRegen = `${profileBlockRegen}${formulasBlock}${tablesBlock}${genericEcon}`;
      }

      const technicalSecIdsRegen = getTechnicalSections(sections, d);
      const isTechnicalSecRegen = technicalSecIdsRegen.includes(sec.id);
      let technicalBlockRegen = "";
      if (isTechnicalSecRegen) {
        const secFormulasT = (methodInfo?.requiredFormulas || []).filter(f => !f.section || f.section === sec.type);
        const secTablesT = (methodInfo?.requiredTables || []).filter(t => !t.section || t.section === sec.type);
        const formulasBlockT = secFormulasT.length
          ? `\nОБОВ'ЯЗКОВІ ФОРМУЛИ З МЕТОДИЧКИ (підстав реалістичні числові значення та підрахуй результат):\n${secFormulasT.map(f =>
            `- ${f.name}: ${f.formula}\n  Змінні: ${f.variables}${f.interpretation ? `\n  Інтерпретація: ${f.interpretation}` : ""}`
          ).join("\n")}`
          : "";
        const tablesBlockT = secTablesT.length
          ? `\nОБОВ'ЯЗКОВІ ТАБЛИЦІ З МЕТОДИЧКИ (відтвори структуру, заповни реалістичними даними під тему "${d.topic}"):\n${secTablesT.map(t =>
            `- ${t.name}\n  Структура: ${t.structure}\n  Що заповнювати: ${t.instructions}`
          ).join("\n")}`
          : "";
        const genericTechnical = !secFormulasT.length && !secTablesT.length
          ? `\nОБОВ'ЯЗКОВО для цього підрозділу (технічна/інженерна робота): конкретний інженерний/технічний розрахунок з формулою і підстановкою реалістичних числових значень, результати — у таблиці markdown (|---|---| формат)`
          : "";
        const hasClientMaterialsRegen = !!(clientMaterialsSummary?.rawText || clientMaterialsText?.trim());
        const codeSnippetBlockRegen = hasClientMaterialsRegen
          ? `\nЯКЩО серед МАТЕРІАЛІВ КЛІЄНТА є реальний вихідний код — цей підрозділ ОБОВ'ЯЗКОВО пиши на основі цього коду: опиши реальну структуру програми (модулі/класи/функції), послідовність роботи алгоритму та ключову логіку, посилаючись на фактичні назви функцій/класів/змінних із наданого коду. ${CODE_GROUNDING_RULE} Додатково наведи ОДИН короткий фрагмент (5-15 рядків) цього коду як приклад, у потрійних зворотних лапках (\`\`\`), точно як у наданому коді. Якщо коду немає — пропусти цю вимогу.`
          : "";
        technicalBlockRegen = `${formulasBlockT}${tablesBlockT}${genericTechnical}${codeSnippetBlockRegen}`;
      }

      const rdRegen = commentAnalysis?.researchDesign ?? (commentAnalysis?.empiricalHints ? { instrumentType: "questionnaire", groups: [], comparisonRequired: false, biographicalFields: [], statisticalMinN: null } : null);
      const methodInfoHasEmpiricalRegen = !!(methodInfo && /анкет|опитуванн|емпіричн|респондент|вибірк|тест|експеримент|методик/i.test(
        [methodInfo.analysisRequirements, methodInfo.otherRequirements, methodInfo.theoryRequirements].filter(Boolean).join(" ")
      ));
      const hasEmpiricalRegen = !!(rdRegen || methodInfoHasEmpiricalRegen);
      const empHintRegen = (() => {
        if (!rdRegen) return commentAnalysis?.empiricalHints || "";
        const parts = [];
        if (rdRegen.groups?.length) parts.push(`Групи: ${rdRegen.groups.map(g => `${g.name}${g.minN ? ` (n≥${g.minN})` : ""}${g.criteria ? `, ${g.criteria}` : ""}`).join("; ")}.`);
        if (rdRegen.biographicalFields?.length) parts.push(`Біографічний блок: ${rdRegen.biographicalFields.join(", ")}.`);
        if (rdRegen.statisticalMinN) parts.push(`Мін. вибірка: ${rdRegen.statisticalMinN} осіб.`);
        if (rdRegen.comparisonRequired) parts.push("Порівняння між групами обов'язкове.");
        return parts.join(" ") || commentAnalysis?.empiricalHints || "";
      })();
      const hasMultipleGroupsRegen = (rdRegen?.groups?.length || 0) > 1;
      const comparisonRequiredRegen = rdRegen?.comparisonRequired || hasMultipleGroupsRegen;
      const bioDescRegen = rdRegen?.biographicalFields?.length ? rdRegen.biographicalFields.join(", ") : "ПІБ, вік, стаж, кваліфікація";
      const appendixRefRegen = appendicesText ? '\nДодай речення: "Анкета наведена у Додатку А."' : "";
      const compTableRegen = comparisonRequiredRegen ? `\nПорівняльна таблиця: ОБОВ'ЯЗКОВО окрема таблиця markdown що порівнює ключові показники між групами.` : "";
      const tableSourceRegen = appendicesText ? "по запитаннях з Додатку А" : "з репрезентативними відсотковими показниками за темою";

      const practicalApproachRegen = commentAnalysis?.practicalApproach;
      const suppressEmpRegen = !!(practicalApproachRegen && practicalApproachRegen !== "questionnaire");

      if (isEmpChapterRegen && !suppressEmpRegen) {
        empiricalBlockRegen = `

КОНТЕКСТ (емпіричне дослідження):
${empHintRegen ? `ВИМОГА: ${empHintRegen}\n` : ""}Визнач за назвою підрозділу що писати:
- організація/методика: вибірка (групи, кількість, критерії), біографічний блок (${bioDescRegen}), метод та принцип проведення.${appendixRefRegen}
- аналіз/результати: таблиця markdown ${tableSourceRegen}, аналіз.${compTableRegen}
- рекомендації: на основі результатів з попередніх підрозділів, без повтору вибірки.`;
      } else if (isEmpAnchorRegen && !suppressEmpRegen) {
        empiricalBlockRegen = `

ОБОВ'ЯЗКОВО (емпіричне дослідження):
${empHintRegen ? `ВИМОГА: ${empHintRegen}\n` : ""}Вибірка, біографічний блок (${bioDescRegen}), метод, принцип проведення, таблиця markdown ${tableSourceRegen}, аналіз.${compTableRegen}${appendixRefRegen}`;
      } else if (hasEmpiricalRegen && ["analysis", "recommendations"].includes(sec.type) && !suppressEmpRegen) {
        const practicalSecsRegen = sections.filter(s => ["analysis", "recommendations"].includes(s.type));
        const secIdxRegen = practicalSecsRegen.findIndex(s => s.id === sec.id);
        if (secIdxRegen === 0) {
          empiricalBlockRegen = `

ОБОВ'ЯЗКОВО (емпіричне дослідження):
${empHintRegen ? `ВИМОГА: ${empHintRegen}\n` : ""}1. Організація: ${rdRegen?.groups?.length ? rdRegen.groups.map(g => `${g.name}${g.minN ? ` (n≥${g.minN})` : ""}${g.criteria ? `, ${g.criteria}` : ""}`).join("; ") : "вибірка — кількість, категорії, критерії"}.
2. Біографічний блок: ${bioDescRegen}.
3. Метод та принцип проведення.
4. Таблиця markdown (|---|---| формат) ${tableSourceRegen}.${compTableRegen}
5. Аналіз і висновки.${appendixRefRegen}`;
        } else if (secIdxRegen < practicalSecsRegen.length - 1) {
          empiricalBlockRegen = `

КОНТЕКСТ (емпіричне дослідження):
${empHintRegen ? `ВИМОГА: ${empHintRegen}\n` : ""}Таблиця markdown ${tableSourceRegen}.${compTableRegen} Аналіз. Без повтору опису вибірки.`;
        } else {
          empiricalBlockRegen = `

КОНТЕКСТ (емпіричне дослідження):
${empHintRegen ? `ВИМОГА: ${empHintRegen}\n` : ""}Рекомендації на основі результатів. Без повтору опису вибірки та методики.`;
        }
      }

      const clientReqsRegen = [
        commentAnalysis?.writingHints,
        commentAnalysis?.textStructureHints,
      ].filter(Boolean).join("\n");
      const clientMaterialsBlockRegen = (() => {
        if (clientMaterialsSummary?.rawText) {
          return `\n\nМАТЕРІАЛИ КЛІЄНТА (використовуй ці дані):\n${clientMaterialsSummary.rawText.slice(0, 80000)}${isTechnicalSecRegen ? `\n\n${CODE_GROUNDING_RULE}` : ""}`;
        }
        if (clientMaterialsText?.trim()) {
          return `\n\nМАТЕРІАЛИ КЛІЄНТА (використовуй ці дані — не вигадуй, не замінюй):\n${clientMaterialsText.slice(0, 80000)}${isTechnicalSecRegen ? `\n\n${CODE_GROUNDING_RULE}` : ""}`;
        }
        return "";
      })();
      const secIllRegen = getIllustrationsForSection(sec);
      const hasIndexRegen = secIllRegen.every(ill => ill.index != null);
      const illBlockRegen = secIllRegen.length
        ? `\n\nІЛЮСТРАЦІЇ КЛІЄНТА ДО ЦЬОГО ПІДРОЗДІЛУ:\n${secIllRegen.map(ill => `Рис. ${ill.figureNum}${ill.caption ? ` – ${ill.caption}` : ""}: ${ill.description}${hasIndexRegen ? ` — маркер вставки: [КЛІЄНТ-ІЛЮСТРАЦІЯ:${ill.index}]` : ""}`).join("\n")}\nОБОВ'ЯЗКОВО для кожної ілюстрації: 1) додай посилання на неї в тексті;${hasIndexRegen ? " 2) безпосередньо ПЕРЕД стандартним підписом рисунка (Рис. X.Y – Назва) додай окремим рядком точно вказаний вище маркер вставки у форматі [КЛІЄНТ-ІЛЮСТРАЦІЯ:N] — без жодних змін, більше нічого на цьому рядку." : ""} Використовуй нумерацію X.Y відповідно до номера підрозділу.`
        : "";
      instruction = `Перепиши підрозділ "${sec.label}" для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.
${empiricalBlockRegen}${econBlockRegen}${technicalBlockRegen}
${clientReqsRegen ? `ВИМОГИ КЛІЄНТА (ОБОВ'ЯЗКОВО виконати):\n${clientReqsRegen}\n` : ""}Обсяг: приблизно ${Math.round((sec.pages || 1) * 225)} слів, ±10% (~${sec.pages} стор.).
Не обривай текст. Завершуй підсумковим абзацом. Без посилань. Без жирного.
ЗАБОРОНЕНО вставляти будь-які внутрішні підназви, заголовки абзаців або окремі рядки-мітки. Кожен рядок тексту — повне речення, рядок таблиці або підпис до таблиці/рисунка.${customInstructions}${illBlockRegen}${clientMaterialsBlockRegen}`;
    }
    const regenMaxTokens = Math.min(60000, Math.max(8000, Math.round((sec.pages || 1) * 3000)));
    try {
      const raw = await callClaude(buildRegenMessages(instruction), null, buildSYS(lang, methodInfo), regenMaxTokens);
      const result = typographQuotes(fixMixedScript(raw, lang)
        .replace(/ — /g, ", ").replace(/— /g, "").replace(/ —/g, "")
        .replace(/[\u1100-\u11FF\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7FF\uF900-\uFAFF]/g, "")
)
        .replace(/(\[[^\]]*)\]\s*\[([^\]]*\])/g, "$1; $2")
        .replace(/(\[[^\]]*)\]\s*\[([^\]]*\])/g, "$1; $2");
      const newContent = { ...contentRef.current, [sec.id]: result };
      setContent(newContent);
      setRegenId(null); setRegenPrompt("");
      await saveToFirestore({ content: newContent });
    } catch (e) { console.error(e); }
    setRegenLoading(false);
  };

  // ── Перефразувати наявний текст секції, щоб знизити плагіат (не генерація з нуля) ──
  const reduceSectionPlagiarismText = async (text, lang, signal) => {
    const approxWords = text.trim().split(/\s+/).length;
    const maxTokens = Math.min(60000, Math.max(4000, Math.round((approxWords / 225) * 3000)));
    const raw = await callClaude(
      [{ role: "user", content: text }],
      signal,
      buildAntiPlagiarismSYS(lang),
      maxTokens
    );
    return typographQuotes(fixMixedScript(raw, lang)
      .replace(/ — /g, ", ").replace(/— /g, "").replace(/ —/g, "")
)
      .replace(/(\[[^\]]*)\]\s*\[([^\]]*\])/g, "$1; $2")
      .replace(/(\[[^\]]*)\]\s*\[([^\]]*\])/g, "$1; $2");
  };

  // ── Зменшити плагіат в одній секції ──
  const doReducePlagiarism = async (sec) => {
    const originalText = contentRef.current[sec.id] || "";
    if (!originalText.trim()) return;
    setPlagLoading(true);
    setPlagId(sec.id);
    setApiError("");
    try {
      const lang = info?.language || "Українська";
      const result = await reduceSectionPlagiarismText(originalText, lang);
      const newContent = { ...contentRef.current, [sec.id]: result };
      setContent(newContent);
      setPlagId(null);
      await saveToFirestore({ content: newContent });
    } catch (e) {
      console.error(e);
      setApiError(e.message);
    }
    setPlagLoading(false);
  };

  // ── Зменшити плагіат по всій роботі (послідовно, з можливістю зупинити) ──
  const doReducePlagiarismAll = async () => {
    if (!window.confirm("Перефразувати всі секції для зниження плагіату? Поточний текст буде замінено.")) return;
    const ctrl = new AbortController();
    plagAllAbortRef.current = ctrl;
    setPlagAllLoading(true);
    setApiError("");

    const lang = info?.language || "Українська";
    const secsToProcess = sections.filter(s => s.type !== "sources" && contentRef.current[s.id]);

    for (let i = 0; i < secsToProcess.length; i++) {
      if (ctrl.signal.aborted) break;
      const sec = secsToProcess[i];
      setPlagAllMsg(`Зменшую плагіат (${i + 1}/${secsToProcess.length}): ${sec.label}...`);
      try {
        const result = await reduceSectionPlagiarismText(contentRef.current[sec.id], lang, ctrl.signal);
        const newContent = { ...contentRef.current, [sec.id]: result };
        setContent(newContent);
        await saveToFirestore({ content: newContent });
      } catch (e) {
        if (e.name === "AbortError") break;
        console.error(e);
        setApiError(e.message);
        break;
      }
    }

    setPlagAllMsg("");
    setPlagAllLoading(false);
  };

  // ── Текст доповіді (без міток слайдів) — джерело істини для змісту презентації ──
  const generateSpeechText = async () => {
    const lang = info?.language || "Українська";

    const sectionSummaries = sections
      .filter(s => s.type !== "sources")
      .map(s => { const txt = content[s.id] || ""; return txt ? `### ${s.label}\n${txt}` : ""; })
      .filter(Boolean).join("\n\n");

    const prompt = `Напиши текст доповіді для захисту ${info?.type || "наукової роботи"} перед науковою комісією на тему "${info?.topic}".

ПОВНИЙ ТЕКСТ РОБОТИ (витягуй звідси конкретні факти, методи, результати, числа):
${sectionSummaries}

ВИМОГИ:
- Обсяг: 9-12 хвилин (4-5 сторінок)
- Структура: вступ → актуальність → мета і завдання → методи → результати → висновки → завершення
- Стиль: стриманий академічний усний. Науковець звітує перед комісією
- ОБОВ'ЯЗКОВО: конкретні назви методів, числа, відсотки, коефіцієнти, розміри вибірки з роботи
- ЗАБОРОНЕНО: "тема є актуальною", "у роботі розглядається", "варто відмітити", "слід зазначити"
- Кожне речення — факт, метод, результат або висновок
- БЕЗ міток "Слайд N" — суцільний академічний текст
- НЕ виводь назви розділів та їх номери (наприклад "Розділ 1.2")
- Мова: ${lang}
- Без markdown, зірочок, жирного`;

    const raw = await callGemini(
      [{ role: "user", content: prompt }], null,
      `You are an expert academic writing assistant. Write a substantive, factual oral defense speech for a scientific committee. Every sentence must state a concrete fact, method, result or conclusion — no filler phrases. No markdown formatting.`, 6000,
      null, "gemini-2.5-flash"
    );

    return typographQuotes(raw
      .split("\n")
      .filter(line => {
        const t = line.trim();
        if (!t) return true;
        if (/^\d+(\.\d+)+[\s\.]/.test(t)) return false;
        if (/^(ВСТУП|ВИСНОВКИ|РОЗДІЛ|ЗМІСТ|ДОДАТКИ?|СПИСОК\s+ЛІТЕРАТУРИ)$/i.test(t)) return false;
        if (/^#{1,6}\s/.test(t)) return false;
        return true;
      })
      .join("\n")
      .replace(/[ᄀ-ᇿ⺀-鿿ꀀ-꓿가-퟿豈-﫿]/g, "")
)
      .replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");
  };

  const generateSpeech = async () => {
    setSpeechLoading(true);
    try {
      const result = await generateSpeechText();
      setSpeechText(result);
      await saveToFirestore({ speechText: result });
    } catch (e) { alert("Помилка генерації доповіді: " + e.message); }
    setSpeechLoading(false);
  };

  // ── Прибрати мітки "Слайд N" з тексту доповіді (щоб не дублювати при повторній розмітці) ──
  const stripSlideLabels = (text) => (text || "")
    .split("\n")
    .filter(line => !/^Слайд\s+\d+\s*$/i.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // ── Розмітка готового тексту доповіді мітками "Слайд N" відповідно до структури презентації ──
  const labelSpeechWithSlides = async (plainSpeechText, slideData) => {
    const lang = info?.language || "Українська";
    const LAYOUT_LABEL = {
      hero: "Титульний/фінальний", two_column: "Два стовпці", stat_callout: "Статистика",
      icon_list: "Список з іконками", highlight_box: "Виділені пункти", numbered_steps: "Кроки",
    };
    const slidesOutline = slideData.slides
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

    const prompt = `Розклади наведений нижче ГОТОВИЙ текст доповіді по слайдах презентації — встав мітку "Слайд N" окремим рядком перед фрагментом, який відповідає цьому слайду.

ГОТОВИЙ ТЕКСТ ДОПОВІДІ (використай ДОСЛІВНО — НЕ редагуй, НЕ перефразовуй, НЕ скорочуй і НЕ додавай нових речень, лише розбий його на фрагменти):
${plainSpeechText.trim()}

СТРУКТУРА ПРЕЗЕНТАЦІЇ (${slideData.slides.length} слайдів, виступ має йти паралельно з ними):
${slidesOutline}

ВИМОГИ:
- Розбий наведений текст доповіді на фрагменти — по одному на кожен слайд (або групу суміжних слайдів, якщо для окремого слайду немає відповідного фрагменту) — і встав перед кожним мітку "Слайд N" окремим рядком
- Збережи дослівний текст і його послідовність — це лише розмітка наявного тексту, а не новий текст
- Мова: ${lang}
- Без markdown, зірочок, жирного — тільки мітки "Слайд N" і незмінний текст доповіді`;

    const raw = await callGemini(
      [{ role: "user", content: prompt }], null,
      "You only segment and label the given text into slide-aligned fragments — you must not rewrite, paraphrase, shorten or add anything to it.", 5000,
      null, "gemini-2.5-flash"
    );

    return raw
      .split("\n")
      .filter(line => {
        const t = line.trim();
        if (!t) return true;
        if (/^Слайд\s+\d+/i.test(t)) return true;
        if (/^#{1,6}\s/.test(t)) return false;
        return true;
      })
      .join("\n")
      .replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");
  };

  // ── Фіксований базовий профіль підприємства для економічних/фінансових робіт ──
  // Генерується один раз перед написанням, щоб усі економічні підрозділи спирались
  // на ту саму назву підприємства, галузь і базові показники, а не вигадували нові.
  const doGenEconProfile = async () => {
    setEconProfileLoading(true);
    let result = "";
    try {
      const lang = info?.language || "Українська";
      const realMaterials = clientMaterialsSummary?.rawText || clientMaterialsText?.trim() || "";
      const prompt = realMaterials
        ? `На основі наведених нижче матеріалів клієнта визнач базовий профіль підприємства для економічної/фінансової роботи на тему "${info?.topic}". Галузь: ${info?.subject}.

МАТЕРІАЛИ КЛІЄНТА (реальні дані підприємства):
${realMaterials.slice(0, 80000)}

Виведи компактно, без markdown і зірочок, у форматі:
Підприємство: [точна назва з матеріалів]
Галузь: [галузь]
Період аналізу: [роки, наявні в матеріалах]
Базові показники: [ключові показники з матеріалів по роках — виручка, чистий прибуток, активи, власний капітал тощо, лише ті, що дійсно є в матеріалах]

Використовуй ТІЛЬКИ дані з матеріалів клієнта, нічого не вигадуй.`
        : `Створи умовний базовий профіль підприємства для економічної/фінансової роботи на тему "${info?.topic}". Галузь: ${info?.subject}.
Клієнт не надав реальної фінансової звітності, тому потрібен правдоподібний умовний приклад.

Виведи компактно, без markdown і зірочок, у форматі:
Підприємство: [правдоподібна умовна назва відповідно до галузі]
Галузь: [галузь]
Період аналізу: [останні 3-4 завершені роки]
Базові показники: [виручка, чистий прибуток, активи, власний капітал та інші релевантні показники за кожен рік періоду — конкретні числові значення в тис. грн]

Ці дані будуть використані як незмінна основа для всіх розрахунків і таблиць у роботі, тому цифри мають бути внутрішньо узгодженими (динаміка логічна, показники не суперечать один одному).`;

      const raw = await callClaude([{ role: "user", content: prompt }], null, buildSYS(lang, methodInfo), 1200, null, MODEL_FAST);
      result = raw
        .replace(/ — /g, ", ").replace(/— /g, "").replace(/ —/g, "")
        .replace(/[ᄀ-ᇿ⺀-鿿ꀀ-꓿가-퟿豈-﫿]/g, "")
        .trim();
      setEconProfile(result);
      await saveToFirestore({ econProfile: result });
    } catch (e) {
      console.warn("econ profile generation failed:", e.message);
    }
    setEconProfileLoading(false);
    return result;
  };

  // Повний вихідний код клієнта у Додаток — програмно (без AI), щоб не обрізати й не перефразувати реальний код.
  // existingText — вже згенерований текст Додатків (для визначення вільної літери додатку).
  const buildCodeAppendixBlock = (existingText, lang) => {
    if (!isTechnical(info)) return "";
    const codeMaterials = clientMaterials.filter(m =>
      CODE_FILE_EXTENSIONS.some(ext => m.name.toLowerCase().endsWith(ext))
    );
    if (!codeMaterials.length) return "";

    const abc = getLangLabels(lang).appendixLetters;
    const usedLetters = new Set();
    const re = /ДОДАТОК\s+([А-ЯA-Z])/gi;
    let m;
    while ((m = re.exec(existingText || "")) !== null) usedLetters.add(m[1].toUpperCase());
    const letter = abc.find(l => !usedLetters.has(l)) || abc[abc.length - 1];

    const listings = codeMaterials.map((mat, idx) =>
      `Лістинг ${letter}.${idx + 1} — ${mat.name}\n\`\`\`\n${mat.text}\n\`\`\``
    ).join("\n\n");
    return `\nДОДАТОК ${letter}\nВихідний код програми\n\n${listings}`;
  };

  const doGenAppendices = async (econProfileOverride) => {
    setAppendicesLoading(true);
    try {
      const lang = info?.language || "Українська";

      // План підрозділів для контексту (текст ще може бути не згенерований)
      const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
      const planBlock = mainSecs.length
        ? `СТРУКТУРА РОБОТИ:\n${mainSecs.map(s => `- ${s.label} (${s.type})`).join("\n")}`
        : "";

      // Реальні дані клієнта — щоб додатки узгоджувались з тим самим джерелом істини,
      // що й основний текст (реальний код для технічних робіт, профіль підприємства для економічних).
      const realMaterialsForApp = clientMaterialsSummary?.rawText || clientMaterialsText?.trim() || "";
      const econProfileForApp = econProfileOverride !== undefined ? econProfileOverride : econProfile;
      const groundingBlock = isTechnical(info) && realMaterialsForApp
        ? `\nМАТЕРІАЛИ КЛІЄНТА (реальний код — використовуй ці дані: посилайся на фактичні назви класів/функцій, мову програмування та тип інтерфейсу з цього коду, не вигадуй іншу архітектуру):\n${realMaterialsForApp.slice(0, 80000)}\n`
        : (isEcon(info) && econProfileForApp)
          ? `\nФІКСОВАНІ БАЗОВІ ДАНІ ПІДПРИЄМСТВА (використовуй САМЕ ЦІ дані, не вигадуй іншу назву/рік/цифри):\n${econProfileForApp}\n`
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

      const empSecs = getEmpiricalSections(sections, info, commentAnalysis, methodInfo);
      const hasEmpChapter = empSecs.chapterSectionIds.length > 0 || empSecs.anchorId;

      // Текст секцій уже може сам "обіцяти" анкету в додатку (ШІ вирішив це під час написання аналізу),
      // навіть якщо методичка/коментар клієнта про це не згадували
      const promisesAppendixAnketa = Object.values(content || {}).some(text =>
        typeof text === "string" && text.split(/[.!?\n]/).some(s => /анкет/i.test(s) && /додат/i.test(s))
      );

      const rdApp = commentAnalysis?.researchDesign ?? (commentAnalysis?.empiricalHints ? { instrumentType: "questionnaire", groups: [], comparisonRequired: false, biographicalFields: [], statisticalMinN: null } : null);
      const hasEmpiricalApp = hasEmpiricalResearch(commentAnalysis, methodInfo) || isPsychoPed(info) || hasEmpChapter || promisesAppendixAnketa;
      // Дефолти за типом роботи — скільки окремих інструментів (методик) очікується, якщо клієнт нічого не вказав
      const acadDefaultsApp = !rdApp ? getAcademicDefaults(info?.subject, info?.type, info?.course, info?.topic) : null;

      // Будуємо блок вимог з researchDesign
      const empClientBlock = (() => {
        if (!rdApp && !commentAnalysis?.empiricalHints) return "";
        const parts = [];
        if (rdApp?.groups?.length) parts.push(`Групи учасників: ${rdApp.groups.map(g => `${g.name}${g.minN ? ` (мін. ${g.minN} осіб)` : ""}${g.criteria ? `, ${g.criteria}` : ""}`).join("; ")}.`);
        if (rdApp?.biographicalFields?.length) parts.push(`Біографічний блок анкети: ${rdApp.biographicalFields.join(", ")}.`);
        if (rdApp?.statisticalMinN) parts.push(`Загальна мін. вибірка: ${rdApp.statisticalMinN} осіб.`);
        if (rdApp?.comparisonRequired || (rdApp?.groups?.length || 0) > 1) parts.push("Передбачити порівняння між групами — питання мають бути однаковими для всіх груп.");
        if (!parts.length && commentAnalysis?.empiricalHints) return `ВИМОГА КЛІЄНТА: ${commentAnalysis.empiricalHints}\n`;
        return parts.length ? `ВИМОГА КЛІЄНТА:\n${parts.join("\n")}\n` : "";
      })();

      const needTwoQuestionnaires = rdApp?.groups?.length >= 2 ||
        /2\s*(дослідження|анкет|методик)|дві\s*(анкет|методик)|два\s*дослідження/i.test(commentAnalysis?.empiricalHints || "");

      const instrumentType = rdApp?.instrumentType || "questionnaire";
      const bioFieldsLine = rdApp?.biographicalFields?.length
        ? `Біографічний блок (перші запитання анкети): ${rdApp.biographicalFields.join(", ")}.`
        : "Біографічний блок (перші 4-5 запитань): ПІБ або псевдонім, вік, стаж, кваліфікація або посада.";

      const buildQuestionnairePrompt = (appendixLabel, groupDesc) => `Перший рядок: ${appendixLabel}
Другий рядок: назва анкети відповідно до теми роботи: "${info?.topic}"${groupDesc ? `, для групи: ${groupDesc}` : ""}.
Звернення до респондента та інструкція (2-3 речення).
${bioFieldsLine}
12-15 запитань закритого типу з варіантами відповідей: а), б), в), г).
Запитання логічно охоплюють різні аспекти теми "${info?.topic}"${groupDesc ? ` для групи: ${groupDesc}` : ""}.
В кінці: "Дякуємо за участь у дослідженні!"`;

      const buildScalePrompt = (appendixLabel) => `Перший рядок: ${appendixLabel}
Обери РЕАЛЬНУ, загальновідому стандартизовану психологічну методику (шкалу, опитувальник, тест), яка справді існує і відповідає темі роботи "${info?.topic}" (наприклад методики Айзенка, Розенберга, Кеттелла, Холмса-Рея, Спілбергера (оригінальна версія STAI, без російських адаптацій) та подібні залежно від теми).
СТРОГО ЗАБОРОНЕНО обирати методику, автор або адаптатор якої є російським чи білоруським науковцем (наприклад НЕ використовуй "Спілбергера-Ханіна" — Ханін є радянським/російським психологом; НЕ використовуй методики з прізвищами авторів-адаптаторів з Росії чи Білорусі). Обирай лише методики західних, українських або інших міжнародних (не рос./білор.) авторів. Якщо загальновідома методика має поширену в СНД назву з російським прізвищем — використай оригінальну назву автора (напр. оригінал Spielberger State-Trait Anxiety Inventory, без "-Ханіна").
Другий рядок: справжня назва цієї методики та автор(и).
Опис методики: мета, сфера застосування, кількість тверджень — як в оригіналі.
Інструкція для респондента — як в оригінальній методиці.
Відтвори пункти методики максимально точно як в офіційному оригіналі (ця методика загальновідома і вільно публікується в методичних збірниках, тому відтворення доречне). Якщо не повністю впевнений у дослівному формулюванні якогось пункту — формулюй його максимально близько до відомої структури та змісту цієї методики, не вигадуй нову методику з нуля.
Шкала відповідей та ключ до обробки — як в оригінальній методиці (розподіл балів, рівні).
СТРОГО ЗАБОРОНЕНО видавати вигадану (неіснуючу) методику за реальну. Якщо для теми справді немає підходящої стандартизованої методики — обери найближчу за тематикою реальну (не рос./білор. автора) і зазнач можливість адаптації.`;

      const buildFitnessTestPrompt = (appendixLabel) => `Перший рядок: ${appendixLabel}
Другий рядок: назва батареї тестів відповідно до теми роботи: "${info?.topic}".
Перелік 5-8 фізичних тестів або вимірювань: назва тесту, одиниці вимірювання, порядок проведення.
Нормативна таблиця: вікові норми або рівні (низький/нижчий за середній/середній/вищий за середній/високий).
Протокол фіксації результатів (таблиця для заповнення).`;

      const buildExperimentPrompt = (appendixLabel) => `Перший рядок: ${appendixLabel}
Другий рядок: назва протоколу педагогічного експерименту відповідно до теми роботи: "${info?.topic}".
Мета та гіпотеза експерименту відповідно до теми роботи: "${info?.topic}".
Опис контрольної та експериментальної груп (кількість, критерії відбору).
Констатувальний етап: діагностичний інструментарій (тести, завдання, спостереження) — 10-15 пунктів.
Формувальний етап: короткий опис педагогічного впливу або програми.
Контрольний етап: ті самі діагностичні інструменти для порівняння.
Протокол фіксації результатів до і після.`;

      // ── Спеціалізовані білдери для генерації Додатків за таблицею academicDefaults (не-психологічні спеціальності) ──
      const buildDataTableAppendixPart = (slot, itemName, topic) => `${slot} — ${itemName}.
Створи ілюстративну таблицю markdown (|---|---| формат) з реалістичними, правдоподібними даними відповідно до теми "${topic}". Підпис таблиці одним рядком перед нею. За потреби короткий пояснювальний коментар під таблицею (2-3 речення).`;

      const buildSchemeAppendixPart = (slot, itemName, topic) => `${slot} — ${itemName}.
Опиши схему/структуру у вигляді чіткого структурованого тексту (список рівнів, блоків і зв'язків між ними) відповідно до теми "${topic}". Це текстовий опис схеми, графічний рендер недоступний.`;

      const buildProgramAppendixPart = (slot, itemName, topic) => `${slot} — ${itemName}.
Розроби структуровану програму/методику/стратегію відповідно до теми "${topic}": мета, етапи або напрями роботи, конкретні заходи чи кроки, очікувані результати.`;

      const buildDocumentAppendixPart = (slot, itemName, topic) => `${slot} — ${itemName}.
Сформуй перелік або документ-зразок відповідно до теми "${topic}" — конкретні пункти, назви, реквізити. Не вигадуй реальні номери судових справ чи назви конкретних організацій, якщо вони не підтверджені контекстом.`;

      const buildFormAppendixPart = (slot, itemName, topic) => `${slot} — ${itemName}.
Створи бланк/протокол/гайд відповідно до теми "${topic}": структура, поля для заповнення, інструкція, 8-15 пунктів де доречно.`;

      const buildSoftwareTestProtocolAppendixPart = (slot, itemName, topic) => `${slot} — ${itemName}.
Створи протокол тестування функціональності програми відповідно до теми "${topic}": короткий вступний блок (назва програмного продукту, версія, мова реалізації, середовище виконання, шкала оцінювання результату: ПРОЙДЕНО / ПРОВАЛЕНО / ЧАСТКОВО), далі markdown-таблиця (|---|---| формат) з колонками: Тест | Умова | Очікуваний результат | Фактичний результат | Статус | Примітки. 6-10 рядків, що покривають ключові функції програми відповідно до теми (якщо в матеріалах клієнта є реальний код — тести мають відповідати саме тим функціям, що є в цьому коді). В кінці окремим рядком додай "Дата тестування: ${APPENDIX_FILL_MARKER}" — для цього протоколу дата теж позначається маркером (виняток із загального правила про порожній бланк для дати), бо вона підставляється автоматично.
У колонках "Фактичний результат" і "Статус" НЕ вигадуй конкретне значення — постав туди рівно текст ${APPENDIX_FILL_MARKER}, ці дані стають відомі лише після завершення написання роботи.`;

      const APPENDIX_BUILDERS = {
        data_table: buildDataTableAppendixPart,
        scheme: buildSchemeAppendixPart,
        program: buildProgramAppendixPart,
        document: buildDocumentAppendixPart,
        form: buildFormAppendixPart,
      };

      const isItSpecialty = detectSpecialty(info?.subject) === "it";

      // Будує блок промпту: список кандидатів-додатків з таблиці, AI сам обирає що згенерувати
      const buildAcadDefaultsAppendixBlock = (candidates, topic) => {
        const parts = candidates.map(item => {
          const builder = (isItSpecialty && /тест/i.test(item))
            ? buildSoftwareTestProtocolAppendixPart
            : (APPENDIX_BUILDERS[classifyAppendixItem(item)] || buildFormAppendixPart);
          return builder("[ДОДАТОК]", item, topic);
        });
        const abc = getLangLabels(lang).appendixLetters;
        const sample = abc.slice(0, 3).join(", ");
        return `Можливі додатки для цієї роботи (оціни кожен і обери лише ті, що дійсно логічно потрібні для теми "${topic}" — не обов'язково всі, зазвичай достатньо 2-4):

${parts.join("\n\n---\n\n")}

Для кожного обраного додатку постав послідовну позначку ДОДАТОК ${sample}... з ${abc.length === 24 ? "цієї української абетки (без Ґ, Є, З, І, Ї, Й, О, Ч, Ь)" : "латинської абетки"} (тільки для тих що дійсно генеруєш, без пропусків у нумерації).
Якщо для якогось додатку доречно посилатись на конкретну методику, теорію, модель або стандарт — СТРОГО ЗАБОРОНЕНО використовувати ті, чий автор є російським чи білоруським науковцем. Обирай лише західні, українські або інші міжнародні (не рос./білор.) джерела.`;
      };

      let prompt;
      if (hasEmpiricalApp && !appendicesCustomPrompt.trim()) {
        const header = `Згенеруй інструмент дослідження (Додаток А) для ${info?.type || "наукової роботи"} на тему "${info?.topic}". Галузь: ${info?.subject}.
${planBlock}
${methodBlock}
${empClientBlock}${clientBlock}${groundingBlock}
Мова: ${lang}. БЕЗ markdown, зірочок, жирного. Звичайний текст.`;

        if (instrumentType === "psycho_scale") {
          prompt = `${header}\n\n${buildScalePrompt("ДОДАТОК А")}`;
        } else if (instrumentType === "fitness_test") {
          prompt = `${header}\n\n${buildFitnessTestPrompt("ДОДАТОК А")}`;
        } else if (instrumentType === "pedagogical_experiment") {
          prompt = `${header}\n\n${buildExperimentPrompt("ДОДАТОК А")}`;
        } else if (needTwoQuestionnaires && rdApp?.groups?.length >= 2) {
          const g1 = rdApp.groups[0];
          const g2 = rdApp.groups[1];
          prompt = `${header}

Кожен додаток — окрема анкета для своєї групи учасників.

ДОДАТОК А — анкета для групи: ${g1.name}${g1.criteria ? ` (${g1.criteria})` : ""}.
${buildQuestionnairePrompt("ДОДАТОК А", g1.name)}

---

ДОДАТОК Б — анкета для групи: ${g2.name}${g2.criteria ? ` (${g2.criteria})` : ""}.
${buildQuestionnairePrompt("ДОДАТОК Б", g2.name)}
${rdApp.groups.length > 2 ? `\nПримітка: якщо є третя група (${rdApp.groups[2]?.name}), використовують той самий інструмент що й для найближчої за профілем групи.` : ""}`;
        } else if (acadDefaultsApp?.instrumentsCount > 1) {
          // Клієнт нічого не вказав — використовуємо дефолтну кількість методик за типом роботи
          const n = acadDefaultsApp.instrumentsCount;
          const letters = (getLangLabels(lang).appendixLetters || []).slice(0, n);
          const blocks = letters.map((letter, i) => {
            const label = `ДОДАТОК ${letter}`;
            if (i === 0) return `${label} — авторська анкета.\n${buildQuestionnairePrompt(label, "")}`;
            return `${label} — окрема реальна психологічна методика (шкала/тест), відмінна від анкети та інших методик у цьому списку.\n${buildScalePrompt(label)}`;
          }).join("\n\n---\n\n");
          prompt = `${header}

Згенеруй ${n} окремі додатки — інструменти дослідження для емпіричної частини (${letters[0]} — авторська анкета, решта — реальні стандартизовані психологічні методики, кожна відмінна від інших), усі відповідно до теми.

${blocks}`;
        } else if (acadDefaultsApp?.appendicesAiGen?.length > 0) {
          // Психолого-педагогічна робота без researchDesign і без instrumentsCount (напр. педагогіка) —
          // використовуємо таблицю academicDefaults замість generic анкети
          prompt = `${header}

${buildAcadDefaultsAppendixBlock(acadDefaultsApp.appendicesAiGen, info?.topic)}`;
        } else {
          prompt = `${header}

Додаток А містить анкету для емпіричного дослідження.${rdApp?.groups?.length ? ` Основна група респондентів: ${rdApp.groups[0].name}${rdApp.groups[0].criteria ? ` (${rdApp.groups[0].criteria})` : ""}.` : ""}
Визнач що саме досліджується відповідно до теми.

${buildQuestionnairePrompt("ДОДАТОК А", rdApp?.groups?.[0]?.name || "")}`;
        }
      } else if (!appendicesCustomPrompt.trim() && acadDefaultsApp?.appendicesAiGen?.length > 0) {
        // Не-психологічна/педагогічна спеціальність без researchDesign — генеруємо за таблицею academicDefaults
        const header = `Згенеруй Додатки для ${info?.type || "наукової роботи"} на тему "${info?.topic}". Галузь: ${info?.subject}.
${planBlock}
${methodBlock}
${clientBlock}${groundingBlock}
Мова: ${lang}. БЕЗ markdown, зірочок, жирного. Звичайний текст.`;
        prompt = `${header}

${buildAcadDefaultsAppendixBlock(acadDefaultsApp.appendicesAiGen, info?.topic)}`;
      } else {
        prompt = `Згенеруй розділ "Додатки" для ${info?.type || "наукової роботи"} на тему "${info?.topic}". Галузь: ${info?.subject || ""}.
${planBlock}
${methodBlock}
${clientBlock}${groundingBlock}
${customBlock || `Включи один або два додатки що логічно доповнюють роботу відповідно до теми та структури (таблиці, схеми, зразки документів тощо).`}
Мова: ${lang}. БЕЗ markdown, зірочок, жирного. Кожен додаток починається з нового рядка: ДОДАТОК А, ДОДАТОК Б тощо.`;
      }

      prompt += `\n\n${APPENDIX_FILL_MARKER_RULE}`;

      const raw = await callClaude(
        [{ role: "user", content: prompt }], null, buildSYS(lang, methodInfo), 6000, null, MODEL
      );
      const result = typographQuotes(raw
        .replace(/ — /g, ", ").replace(/— /g, "").replace(/ —/g, "")
        .replace(/[\u1100-\u11FF\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7FF\uF900-\uFAFF]/g, "")
)
        .replace(/\n{2,}/g, '\n');
      const finalResult = result + buildCodeAppendixBlock(result, lang);
      setAppendicesText(finalResult);
      await saveToFirestore({ appendicesText: finalResult });
    } catch (e) { alert("Помилка генерації додатків: " + e.message); }
    setAppendicesLoading(false);
  };

  // ── Автозаповнення полів додатків, позначених маркером, коли основний текст роботи вже готовий ──
  const doFillAppendixData = async () => {
    if (appendixFillDoneRef.current) return;
    if (!appendicesText || !appendicesText.includes(APPENDIX_FILL_MARKER)) return;
    appendixFillDoneRef.current = true;
    setAppendicesLoading(true);
    try {
      const lang = info?.language || "Українська";
      const todayStr = new Date().toLocaleDateString("uk-UA");
      const dateFilledText = appendicesText.replace(
        new RegExp(`(Дата тестування:\\s*)${APPENDIX_FILL_MARKER}`, "g"),
        `$1${todayStr}`
      );
      if (!dateFilledText.includes(APPENDIX_FILL_MARKER)) {
        setAppendicesText(dateFilledText);
        await saveToFirestore({ appendicesText: dateFilledText });
        setAppendicesLoading(false);
        return;
      }
      const finishedText = sections
        .filter(s => s.type !== "sources")
        .map(s => content[s.id])
        .filter(Boolean)
        .join("\n\n");
      const prompt = `Нижче наведено розділ "Додатки" ${info?.type || "наукової роботи"} на тему "${info?.topic}", у якому частину полів позначено маркером ${APPENDIX_FILL_MARKER} — їх потрібно заповнити значеннями, узгодженими з основним текстом роботи, який тепер повністю готовий.

ОСНОВНИЙ ТЕКСТ РОБОТИ (спирайся на нього, не вигадуй даних, що суперечать йому):
${finishedText.slice(0, 60000)}

ДОДАТКИ З МАРКЕРАМИ:
${dateFilledText}

Заміни КОЖЕН маркер ${APPENDIX_FILL_MARKER} на конкретне значення, узгоджене з тим, що вже стверджується в основному тексті роботи (наприклад, якщо текст стверджує, що функціонал працює коректно — постав відповідний фактичний результат і статус "ПРОЙДЕНО"; якщо десь згадано проблему чи обмеження — врахуй це). Решту тексту додатків НЕ змінюй і поверни дослівно, окрім заміни маркерів. Мова: ${lang}. БЕЗ markdown, зірочок, жирного (markdown-таблиці, що вже є в тексті, лишаються у форматі |---|---|).`;
      const raw = await callClaude([{ role: "user", content: prompt }], null, buildSYS(lang, methodInfo), 6000, null, MODEL);
      if (raw && raw.trim()) {
        const filled = raw.trim();
        setAppendicesText(filled);
        await saveToFirestore({ appendicesText: filled });
      }
    } catch (e) { console.warn("Автозаповнення додатків не вдалося:", e.message); }
    setAppendicesLoading(false);
  };

  const generatePresentation = async () => {
    setPresentationLoading(true);
    setPresentationMsg("Готую доповідь...");
    try {
      const lang = info?.language || "Українська";

      // ── Крок 0: Доповідь — джерело істини для змісту слайдів (генеруємо, якщо її ще немає) ──
      let baseSpeech = stripSlideLabels(speechText);
      if (!baseSpeech) {
        setPresentationMsg("Генерую доповідь...");
        baseSpeech = await generateSpeechText();
        setSpeechText(baseSpeech);
        await saveToFirestore({ speechText: baseSpeech });
      }

      setPresentationMsg("Аналізую текст роботи...");
      // ── Крок 1: Gemini аналізує текст ──
      const fullText = sections
        .filter(s => s.type !== "sources")
        .map(s => { const txt = content[s.id] || ""; return txt ? `### ${s.label}\n${txt}` : ""; })
        .filter(Boolean).join("\n\n");

      const geminiPrompt = `Проаналізуй наукову роботу та витягни всі дані для презентації захисту. Поверни ТІЛЬКИ валідний JSON без markdown:
{
  "student_info": {
    "student": "ПІБ студента (з титульної сторінки або null)",
    "supervisor": "ПІБ наукового керівника (або null)",
    "institution": "Коротка назва навчального закладу (або null)"
  },
  "relevance": "Чому ця тема актуальна, яку проблему вирішує (2-3 речення)",
  "object": "Об'єкт дослідження (точно як у роботі)",
  "subject": "Предмет дослідження (точно як у роботі)",
  "goal": "Мета дослідження (точно як у роботі)",
  "tasks": ["завдання 1", "завдання 2", "завдання 3"],
  "hypothesis": "Гіпотеза (якщо є у вступі, інакше null)",
  "methods": [
    {"name": "Назва методу", "description": "1 речення опису"}
  ],
  "main_results": [
    {
      "title": "Назва блоку результату",
      "points": ["конкретний результат 1", "результат 2"],
      "key_stat": {"value": "87%", "label": "точність моделі"}
    }
  ],
  "conclusions": ["висновок 1", "висновок 2", "висновок 3"],
  "practical_value": "Де і як можна застосувати результати (або null)",
  "novelty": "Наукова новизна (або null)",
  "field": "tech | medicine | social | economics | default"
}

ПРАВИЛА:
- student_info: шукай рядки "ПІБ студента", "Виконав", "Науковий керівник", назву закладу — на початку тексту
- main_results: 3-5 блоків з конкретними знахідками. Числа/відсотки → key_stat. Без числа → key_stat: null
- tasks: рівно стільки, скільки перелічено у вступі роботи
- Мова: ${lang}

ТИТУЛЬНА СТОРІНКА:
${titlePage ? titlePage.substring(0, 800) : "(не надана)"}

ТЕКСТ РОБОТИ:
${fullText}

ТЕКСТ ДОПОВІДІ ДЛЯ ЗАХИСТУ (ОБОВ'ЯЗКОВО — масиви "tasks", "methods", "main_results", "conclusions" мають збігатися з тим, що перелічено в доповіді: ТА Ж кількість елементів, нічого не пропускай і не додавай зайвого, аби виступ і слайди презентації не розходились):
${baseSpeech}`;

      const geminiRaw = await callGemini(
        [{ role: "user", content: geminiPrompt }], null,
        SYS_JSON_SHORT, 5000,
        (s) => setPresentationMsg(`Аналізую... зачекайте ${s}с`), "gemini-2.5-flash"
      );

      let analysis;
      try {
        analysis = JSON.parse(geminiRaw.replace(/```json\n?|\n?```/g, "").trim());
      } catch { throw new Error("Gemini повернув некоректний JSON аналізу"); }

      // ── Крок 2: Claude генерує зміст слайдів ──
      setPresentationMsg("Генерую слайди...");

      const themeMap = { tech: "midnight", medicine: "forest", social: "coral", economics: "slate" };
      const defaultTheme = themeMap[analysis.field] || "warm";

      const hasHypothesis = !!analysis.hypothesis;
      const hasPractical = !!(analysis.practical_value || analysis.novelty);
      const resultsCount = Math.min(Math.max((analysis.main_results || []).length, 3), 5);
      let slideN = 0;
      const next = () => ++slideN;

      const slideSpecs = [];
      slideSpecs.push(`Слайд ${next()}: layout "title_slide"
  title: ${JSON.stringify(info?.topic || "")}
  work_type: ${JSON.stringify(info?.type || "Наукова робота")}
  student: ${JSON.stringify(analysis.student_info?.student || null)}
  supervisor: ${JSON.stringify(analysis.student_info?.supervisor || null)}
  institution: ${JSON.stringify(analysis.student_info?.institution || null)}
  year: ${new Date().getFullYear()}`);

      slideSpecs.push(`Слайд ${next()}: layout "two_column" — title: "Актуальність"
  left: 2-3 речення чому тема важлива (з analysis.relevance)
  right_type: "text", right: яку конкретну проблему вирішує`);

      slideSpecs.push(`Слайд ${next()}: layout "two_column" — title: "Об'єкт і предмет дослідження"
  left: "Об'єкт дослідження:\\n${(analysis.object || "").replace(/"/g, "'")}"
  right_type: "text", right: "Предмет дослідження:\\n${(analysis.subject || "").replace(/"/g, "'")}"`);

      slideSpecs.push(`Слайд ${next()}: layout "icon_list" — title: "Мета та завдання"
  visual.items: [{icon:"🎯",header:"Мета",text:${JSON.stringify(analysis.goal || "")}}, потім по одному item на кожне завдання {icon:"→",header:"Завдання N",text:...}]
  Максимум 5 items загалом`);

      if (hasHypothesis) {
        slideSpecs.push(`Слайд ${next()}: layout "highlight_box" — title: "Гіпотеза дослідження"
  points: [${JSON.stringify(analysis.hypothesis)}]
  accent: "Перевіряється в ході дослідження"`);
      }

      slideSpecs.push(`Слайд ${next()}: layout "numbered_steps" — title: "Методи дослідження"
  visual.items: до 4 методів з analysis.methods → [{"num":"1","title":"назва","text":"1 речення"}]`);

      (analysis.main_results || []).slice(0, resultsCount).forEach((res, i) => {
        const hasStat = res.key_stat?.value;
        const layout = hasStat ? "stat_callout" : "highlight_box";
        slideSpecs.push(`Слайд ${next()}: layout "${layout}" — title: ${JSON.stringify(res.title || `Результати ${i + 1}`)}
  ${hasStat
          ? `visual.stats: [{"value":${JSON.stringify(res.key_stat.value)},"label":${JSON.stringify(res.key_stat.label || "")}}]\n  content: ${JSON.stringify((res.points || []).slice(0, 2).join(". "))}`
          : `points: [${(res.points || []).map(p => JSON.stringify(p)).join(", ")}]`}`);
      });

      slideSpecs.push(`Слайд ${next()}: layout "icon_list" — title: "Висновки"
  visual.items: до 5 висновків з analysis.conclusions → [{"icon":"✅","header":"Висновок N","text":"..."}]`);

      if (hasPractical) {
        slideSpecs.push(`Слайд ${next()}: layout "two_column" — title: "Практичне значення та наукова новизна"
  left: ${JSON.stringify(analysis.practical_value || "Практичне застосування результатів")}
  right_type: "text", right: ${JSON.stringify(analysis.novelty || "Сфери впровадження")}`);
      }

      slideSpecs.push(`Слайд ${next()}: layout "hero" — title: "Дякую за увагу!", subtitle: ""`);
      const totalSlides = slideN;

      const claudePrompt = `Згенеруй JSON для презентації захисту ${info?.type || "наукової роботи"}.

АНАЛІЗ РОБОТИ (від Gemini):
${JSON.stringify(analysis, null, 2)}

СПЕЦИФІКАЦІЯ — рівно ${totalSlides} слайдів:
${slideSpecs.join("\n\n")}

ПРАВИЛА JSON:
- Мова всіх текстів: ${lang}
- title_slide: поля title, work_type, student, supervisor, institution, year (null якщо невідомо)
- icon_list items: [{"icon":"...","header":"...","text":"..."}]
- numbered_steps items: [{"num":"...","title":"...","text":"..."}]
- stat_callout: {title, visual:{stats:[{value,label}]}, content}
- two_column: {title, left, right_type, right} або right_value/right_label для stat
- highlight_box: {title, points:[], accent} (accent — короткий підсумковий текст для виділеного блоку внизу слайду; пиши реальний зміст або залиш null; НІКОЛИ не пиши назви кольорів)
- hero: {title, subtitle}
- Числа та % з аналізу — обов'язково включай
- НІКОЛИ не додавай номер замовлення, ID або технічні ідентифікатори у текст будь-якого слайду
- НЕ додавай зайвих слайдів, рівно ${totalSlides}

Поверни ТІЛЬКИ валідний JSON без markdown:
{"theme":"${defaultTheme}","slides":[...рівно ${totalSlides} об'єктів...]}`;

      const claudeRaw = await callClaude(
        [{ role: "user", content: claudePrompt }], null,
        SYS_JSON_SHORT, 6000,
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

      // ── Крок 4: Розмічаємо доповідь мітками "Слайд N" відповідно до готових слайдів ──
      setPresentationMsg("Узгоджую доповідь зі слайдами...");
      try {
        const labeled = await labelSpeechWithSlides(baseSpeech, slideData);
        setSpeechText(labeled);
        await saveToFirestore({ speechText: labeled });
      } catch { /* презентація вже готова — лишаємо доповідь без міток, якщо розмітка не вдалась */ }
    } catch (e) { alert("Помилка генерації презентації: " + e.message); }
    setPresentationLoading(false);
    setPresentationMsg("");
  };

  const stopGen = () => { abortRef.current?.abort(); runningRef.current = false; setRunning(false); setPaused(true); setLoadMsg(""); };
  const resumeGen = () => { setApiError(""); setPaused(false); };

  // ── Аналіз правок від викладача ──
  const doAnalyzeCorrections = async () => {
    if (!correctionText.trim() && correctionPhotos.length === 0) return;
    setCorrectionLoading(true);
    setCorrectionAnalysis(null);
    setCorrectionChecked({});
    try {
      // Орієнтовний діапазон сторінок кожного розділу — рахуємо за реальним порядком
      // документа (displayOrder), а не сирим порядком масиву sections, інакше номери
      // сторінок не відповідали б фактичному розташуванню в експортованому файлі.
      let cumPage = 0;
      const sectionsWithPages = displayOrder.map(s => {
        const secPages = Math.max(1, Math.round(s.pages || 1));
        const pageStart = cumPage + 1;
        cumPage += secPages;
        return { ...s, pageStart, pageEnd: cumPage };
      });
      const prompt = buildCorrectionsAnalysisPrompt({
        topic: info?.topic,
        subject: info?.subject,
        direction: info?.direction,
        sections: sectionsWithPages,
        correctionsText: correctionText,
      });
      const imageContent = correctionPhotos.map(p => ({
        type: "image",
        source: { type: "base64", media_type: p.type, data: p.b64 },
      }));
      const userContent = imageContent.length
        ? [...imageContent, { type: "text", text: prompt }]
        : prompt;
      // Динамічний ліміт токенів: довге чи багаторозділове зауваження дає довший
      // JSON-масив у відповіді — фіксовані 2000 могли обрізати відповідь на середині.
      const approxCorrectionWords = correctionText.trim() ? correctionText.trim().split(/\s+/).length : 0;
      const analysisMaxTokens = Math.min(8000, Math.max(2000, approxCorrectionWords * 6 + sections.length * 40));
      // MODEL (Sonnet) замість MODEL_FAST — визначення потрібного розділу за змістом
      // зауваження це судження, що потребує кращого розуміння контексту, а не проста
      // класифікація; відповідь тут маленька, тож різниця у вартості мінімальна.
      const raw = await callClaude([{ role: "user", content: userContent }], null, SYS_JSON_ARRAY, analysisMaxTokens, null, MODEL);
      const jsonStr = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) throw new Error("Не масив");
      // Дедуплікація за sectionId — якщо ШІ повернув два окремі зауваження до
      // одного розділу, об'єднуємо їх в один пункт, інакше чекбокс в UI (ключ —
      // sectionId) керував би обома одночасно, і застосування правки продублювалось б.
      const mergedBySection = {};
      parsed.forEach(item => {
        if (!item?.sectionId) return;
        if (mergedBySection[item.sectionId]) {
          mergedBySection[item.sectionId].issue += "; " + item.issue;
          mergedBySection[item.sectionId].suggestion += "; " + item.suggestion;
          if (item.sourcesAction === "restructure") mergedBySection[item.sectionId].sourcesAction = "restructure";
        } else {
          mergedBySection[item.sectionId] = { ...item };
        }
      });
      const dedupedParsed = Object.values(mergedBySection);
      const defaultChecked = {};
      dedupedParsed.forEach(item => { defaultChecked[item.sectionId] = true; });
      setCorrectionAnalysis(dedupedParsed);
      setCorrectionChecked(defaultChecked);
    } catch (e) {
      alert("Помилка аналізу правок: " + e.message);
    }
    setCorrectionLoading(false);
  };

  // ── Перебудова списку джерел (додати/видалити конкретні джерела) + перенумерація
  // посилань по всій роботі. На відміну від звичайної правки розділу, ця дія
  // зачіпає ВСІ розділи одразу, тож іде окремим шляхом, а не через
  // buildCorrectionRewritePrompt для розділу "sources".
  const applySourcesRestructure = async (item, currentContent) => {
    const srcSec = sections.find(s => s.type === "sources");
    if (!srcSec) throw new Error("Розділ джерел не знайдено");
    const currentSourcesText = currentContent[srcSec.id] || "";
    if (!currentSourcesText.trim()) throw new Error("Список джерел порожній");

    // A — що саме видалити / додати
    const restructurePrompt = buildSourcesRestructureAnalysisPrompt({
      currentSourcesText,
      issue: item.issue,
      suggestion: item.suggestion,
    });
    const restructureRaw = await callClaude([{ role: "user", content: restructurePrompt }], null, SYS_JSON, 2000, null, MODEL);
    const restructureParsed = JSON.parse(restructureRaw.replace(/```json|```/g, "").trim());
    const removeNumbers = new Set((restructureParsed.remove || []).map(Number).filter(n => Number.isFinite(n)));
    const addRaw = (restructureParsed.add || []).filter(s => s && s.trim());

    // B — розпарсити поточний пронумерований список
    const currentEntries = [];
    currentSourcesText.split("\n").forEach(line => {
      const m = line.match(/^\s*(\d+)[.)]\s*(.*)$/);
      if (m) currentEntries.push({ number: Number(m[1]), text: m[2].trim() });
    });
    if (!currentEntries.length) throw new Error("Не вдалося розпарсити список джерел");
    const survivors = currentEntries.filter(e => !removeNumbers.has(e.number));
    const removedCount = currentEntries.length - survivors.length;

    // C — відформатувати ЛИШЕ нові джерела (дешево — не чіпаємо вже готові)
    const lang = info?.language || "Українська";
    const extraStyleText = (methodInfo?.otherRequirements || "") + " " + (methodInfo?.citationStyle || "");
    const sourcesStyle = citStyleOverride || methodInfo?.sourcesStyle
      || (/APA/i.test(extraStyleText) ? "APA" : /MLA/i.test(extraStyleText) ? "MLA" : "ДСТУ 8302:2015");
    const isAPA = /APA/i.test(sourcesStyle);
    const isMLA = /MLA/i.test(sourcesStyle);
    const isDstu = /ДСТУ/i.test(sourcesStyle);
    const isFootnoteMode = citFootnotes && isDstu;
    const effectiveOrder = sourcesOrderOverride || methodInfo?.sourcesOrder;
    const isAlphabeticalOrder = !effectiveOrder || effectiveOrder === "alphabetical";
    const isLatinWork = /англ|english|польськ|polish|нім|german|франц|french|іспан|spanish|італ|italian/i.test(lang);

    let newFormatted = [];
    if (addRaw.length) {
      newFormatted = await formatSourcesWithRetry({
        rawRefs: addRaw,
        findStructured: () => null,
        sourcesStyle,
        sourcesFormatRules: methodInfo?.sourcesFormatRules,
        callClaude,
      });
    }

    // D — злиття й визначення фінального порядку (чистий код, без ШІ)
    let finalTexts, survivorOldNumbers;
    if (isAlphabeticalOrder) {
      const items = [
        ...survivors.map(e => ({ text: e.text, structured: null, _old: e.number })),
        ...newFormatted.map(t => ({ text: t, structured: null, _old: null })),
      ];
      const grouping = detectSourceGrouping({ sourcesFormatRules: methodInfo?.sourcesFormatRules, sourcesGrouping: methodInfo?.sourcesGrouping });
      const sorted = sortReferencesForDisplay(items, { latinFirst: isLatinWork, grouping });
      finalTexts = sorted.map(it => it.text);
      survivorOldNumbers = sorted.map(it => it._old);
    } else {
      // Порядок появи в тексті — нові джерела додаються в кінець, наявний порядок лишається.
      finalTexts = [...survivors.map(e => e.text), ...newFormatted];
      survivorOldNumbers = [...survivors.map(e => e.number), ...newFormatted.map(() => null)];
    }

    // E — мапа старий→новий номер (лише для тих, що лишились) + фінальні номери нових
    const oldToNew = {};
    survivorOldNumbers.forEach((oldN, idx) => { if (oldN != null) oldToNew[oldN] = idx + 1; });
    const newSourceFinalNumbers = newFormatted.map(text => finalTexts.indexOf(text) + 1);

    // F — формат inline-цитат для фінального списку
    const { refCiteText, pageRanges } = buildCiteFormats({
      finalTexts, rawRefs: finalTexts, indexMap: finalTexts.map((_, i) => i + 1),
      findStructured: () => null, isAPA, isMLA, isFootnoteMode,
    });

    // G — перенумерувати наявні посилання по ВСІХ розділах — чистий код, без токенів.
    // Посилання на видалені джерела applyCitationRemap сам прибирає з тексту.
    // ВАЖЛИВО: у вже фіналізованому тексті ЗАЛИШАЮТЬСЯ маркери [N] тільки для звичайного
    // ДСТУ без виносок — APA/MLA вже мають вигляд "(Автор, Рік)", а режим виносок уже
    // "%%FNn%%", і жоден з них ця перенумерація (яка шукає саме "[N]") не знайде й не
    // зачепить. Тому для цих стилів чесно попереджаємо користувача замість того, щоб
    // мовчки нічого не зробити з наявними цитатами.
    const canAutoRenumberInText = isDstu && !isFootnoteMode;
    const updatedContent = { ...currentContent };
    const mainSecs = sections.filter(s => s.type !== "sources");
    let orphanedCount = 0;
    if (canAutoRenumberInText) {
      mainSecs.forEach(sec => {
        const text = updatedContent[sec.id];
        if (!text) return;
        if (removedCount > 0) {
          removeNumbers.forEach(n => {
            const re = new RegExp(`\\[\\s*${n}\\s*(?:,\\s*[сc]\\.?[^\\]]*)?\\]`, "g");
            orphanedCount += (text.match(re) || []).length;
          });
        }
        updatedContent[sec.id] = applyCitationRemap(text, oldToNew, refCiteText, { pageRanges });
      });
    }

    // H — визначити, куди процитувати нові джерела, і вставити цитування
    const affectedSectionIds = [srcSec.id];
    const unplacedSources = [];
    if (addRaw.length) {
      const placementPrompt = buildSourcePlacementPrompt({
        newSources: newFormatted,
        sections: mainSecs.map(s => ({ id: s.id, label: s.label })),
      });
      let placements = [];
      try {
        const placementRaw = await callClaude([{ role: "user", content: placementPrompt }], null, SYS_JSON_ARRAY, 2000, null, MODEL);
        placements = JSON.parse(placementRaw.replace(/```json|```/g, "").trim());
      } catch (e) {
        console.error("Помилка визначення розділу для нового джерела", e);
      }

      for (let i = 0; i < newFormatted.length; i++) {
        const placement = Array.isArray(placements) ? placements.find(p => p.sourceIndex === i) : null;
        const targetSec = placement ? mainSecs.find(s => s.id === placement.sectionId) : null;
        if (!targetSec) { unplacedSources.push(newSourceFinalNumbers[i]); continue; }
        const finalN = newSourceFinalNumbers[i];
        // Формат маркера залежить від стилю — [N] лише для звичайного ДСТУ; для
        // APA/MLA/виносок у вже фіналізованому тексті використовується інший вигляд
        // ("(Автор, Рік)" / "%%FNn%%"), і саме його треба вставляти, а не голий [N].
        const citationMarker = refCiteText[finalN] || `[${finalN}]`;
        const targetOriginalText = updatedContent[targetSec.id] || "";
        const existingCitationNumbers = [...new Set(
          [...targetOriginalText.matchAll(/\[(\d+)\]|%%FN(\d+)%%/g)].map(m => m[1] || m[2])
        )];
        const insertPrompt = buildCorrectionRewritePrompt({
          section: targetSec,
          originalText: targetOriginalText,
          issue: "Розділ не містить посилання на нове джерело, щойно додане до списку літератури.",
          suggestion: `Встав посилання ${citationMarker} до речення, яке найбільше стосується змісту цього джерела.`,
          info, methodInfo, lang,
          existingCitationNumbers,
          allowedNewCitation: { number: finalN, marker: citationMarker, sourceText: newFormatted[i] },
        });
        try {
          const insertRaw = await callClaude([{ role: "user", content: insertPrompt }], null, buildSYS(lang, methodInfo), Math.min(60000, Math.max(4000, Math.round((targetSec.pages || 1) * 3000))), null, MODEL, { cache: true });
          const cleaned = typographQuotes(fixMixedScript(insertRaw, lang)
            .replace(/ — /g, ", ").replace(/— /g, "").replace(/ —/g, "")
            .replace(/[ᄀ-ᇿ⺀-鿿ꀀ-꓿가-퟿豈-﫿]/g, "")
          ).replace(/(\[[^\]]*)\]\s*\[([^\]]*\])/g, "$1; $2").replace(/(\[[^\]]*)\]\s*\[([^\]]*\])/g, "$1; $2").trim();
          updatedContent[targetSec.id] = cleaned;
          if (!affectedSectionIds.includes(targetSec.id)) affectedSectionIds.push(targetSec.id);
        } catch (e) {
          console.error("Помилка вставки цитати нового джерела", e);
          unplacedSources.push(finalN);
        }
      }
    }

    // I — оновити текст розділу джерел фінальним пронумерованим списком
    updatedContent[srcSec.id] = finalTexts.map((t, i) => `${i + 1}. ${t}`).join("\n");

    const summaryParts = [];
    if (removedCount) summaryParts.push(`видалено ${removedCount} джерел${orphanedCount ? ` (у ${orphanedCount} місцях прибрано посилання на них — перевірте ці твердження)` : ""}`);
    if (newFormatted.length) summaryParts.push(`додано ${newFormatted.length} нових джерел${unplacedSources.length ? ` (для №${unplacedSources.join(", ")} не вдалося автоматично підібрати місце цитування — процитуйте вручну)` : ""}`);
    if (!canAutoRenumberInText && (removedCount || oldToNew && Object.entries(oldToNew).some(([o, n]) => Number(o) !== n))) {
      summaryParts.push("увага: для цього стилю цитування (APA/MLA чи виноски) наявні посилання в тексті НЕ перенумеровано автоматично — перевірте їх вручну");
    }
    if (!summaryParts.length) summaryParts.push("змін у списку джерел не знайдено за цим зауваженням");

    return { updatedContent, affectedSectionIds, summary: summaryParts.join("; ") };
  };

  // ── Застосування правок до обраних розділів ──
  const doApplyCorrections = async () => {
    if (!correctionAnalysis?.length) return;
    const toFix = correctionAnalysis.filter(item => correctionChecked[item.sectionId]);
    if (!toFix.length) return;
    setCorrectionApplyLoading(true);
    setCorrectionApplyProgress({ current: "", done: 0, total: toFix.length });
    const lang = info?.language || "Українська";
    const newContent = { ...contentRef.current };
    const sectionsAffected = [];
    const failedSections = [];
    const failedItems = [];
    const restructureSummaries = [];
    // Короткий конспект структури роботи (лише назви розділів) — для узгодженості
    // без потреби надсилати повний текст усіх інших розділів (дорого).
    const structureList = sections.filter(s => s.type !== "sources").map(s => s.label);
    const econSecIds = getEconSections(sections, info);
    const technicalSecIds = getTechnicalSections(sections, info);
    const clientMaterialsRaw = clientMaterialsSummary?.rawText || clientMaterialsText?.trim() || "";
    for (let i = 0; i < toFix.length; i++) {
      const item = toFix[i];
      const sec = sections.find(s => s.id === item.sectionId);
      if (!sec) { failedSections.push(item.sectionId); failedItems.push(item); continue; }
      setCorrectionApplyProgress({ current: sec.label || sec.id, done: i, total: toFix.length });
      // Додавання/видалення конкретних джерел — окремий шлях, що зачіпає весь
      // документ (перенумерація), а не звичайне переписування одного розділу.
      if (item.sourcesAction === "restructure") {
        try {
          const { updatedContent, affectedSectionIds, summary } = await applySourcesRestructure(item, contentRef.current);
          Object.assign(newContent, updatedContent);
          contentRef.current = { ...newContent };
          setContent({ ...newContent });
          affectedSectionIds.forEach(sid => { if (!sectionsAffected.includes(sid)) sectionsAffected.push(sid); });
          restructureSummaries.push(summary);
          await saveToFirestore({ content: newContent });
        } catch (e) {
          console.error("Помилка перебудови списку джерел", e);
          failedSections.push(sec?.label || item.sectionId);
          failedItems.push(item);
        }
        continue;
      }
      try {
        const originalText = contentRef.current[item.sectionId] || "";
        const existingCitationNumbers = [...new Set(
          [...originalText.matchAll(/\[(\d+)\]|%%FN(\d+)%%/g)].map(m => m[1] || m[2])
        )];
        const hasClientIllustrations = originalText.includes("[КЛІЄНТ-ІЛЮСТРАЦІЯ:");

        // Формули/таблиці з методички та реальні матеріали клієнта — потрібні, коли
        // правка стосується розрахунків чи технічного опису в econ/technical розділах.
        let extraGroundingBlock = "";
        if (econSecIds.includes(sec.id) || technicalSecIds.includes(sec.id)) {
          const secFormulas = (methodInfo?.requiredFormulas || []).filter(f => !f.section || f.section === sec.type);
          const secTables = (methodInfo?.requiredTables || []).filter(t => !t.section || t.section === sec.type);
          if (secFormulas.length) {
            extraGroundingBlock += `\nФОРМУЛИ З МЕТОДИЧКИ ДЛЯ ЦЬОГО РОЗДІЛУ (якщо правка стосується розрахунків — використовуй саме їх): ${secFormulas.map(f => `${f.name}: ${f.formula}`).join("; ")}`;
          }
          if (secTables.length) {
            extraGroundingBlock += `\nОБОВ'ЯЗКОВІ ТАБЛИЦІ З МЕТОДИЧКИ: ${secTables.map(t => t.name).join("; ")}`;
          }
          if (technicalSecIds.includes(sec.id) && clientMaterialsRaw) {
            extraGroundingBlock += `\n\nМАТЕРІАЛИ КЛІЄНТА (використовуй ці дані — не вигадуй, не замінюй):\n${clientMaterialsRaw.slice(0, 80000)}\n\n${CODE_GROUNDING_RULE}`;
          }
        }

        const prompt = buildCorrectionRewritePrompt({
          section: sec,
          originalText,
          issue: item.issue,
          suggestion: item.suggestion,
          info,
          methodInfo,
          lang,
          structureList,
          existingCitationNumbers,
          extraGroundingBlock,
          hasClientIllustrations,
        });
        const sectionMaxTokens = Math.min(60000, Math.max(4000, Math.round((sec.pages || 1) * 3000)));
        // cache:true — той самий системний промпт (buildSYS) повторюється на кожній
        // ітерації цього циклу, тож кешування різко знижує вартість після першого виклику.
        const raw = await callClaude([{ role: "user", content: prompt }], null, buildSYS(lang, methodInfo), sectionMaxTokens, null, MODEL, { cache: true });
        let result = typographQuotes(fixMixedScript(raw, lang)
          .replace(/ — /g, ", ").replace(/— /g, "").replace(/ —/g, "")
          .replace(/[ᄀ-ᇿ⺀-鿿ꀀ-꓿가-퟿豈-﫿]/g, "")
        )
          .replace(/(\[[^\]]*)\]\s*\[([^\]]*\])/g, "$1; $2")
          .replace(/(\[[^\]]*)\]\s*\[([^\]]*\])/g, "$1; $2")
          .trim();

        // Контроль обсягу — лише якщо результат сильно "поплив" відносно оригіналу,
        // щоб не робити зайвий виклик на кожну дрібну правку.
        if (sec.type !== "sources" && originalText) {
          const origWords = countWords(originalText);
          const newWords = countWords(result);
          if (origWords > 30 && newWords < origWords * 0.7) {
            const missing = origWords - newWords;
            const contPrompt = `Ось поточний текст підрозділу "${sec.label}" (${newWords} слів, оригінал мав ${origWords}):\n\n${result}\n\nДопиши ще приблизно ${missing} слів, органічно продовжуючи виклад далі, не повторюючи вже написане. Без вступних фраз, без заголовків. Просто продовж текст.`;
            try {
              const contRaw = await callClaude([{ role: "user", content: contPrompt }], null, buildSYS(lang, methodInfo), Math.min(20000, Math.max(2000, Math.round(missing * 3))), null, MODEL, { cache: true });
              result = (result + "\n\n" + typographQuotes(fixMixedScript(contRaw, lang))).trim();
            } catch { /* лишаємо як є */ }
          } else if (origWords > 30 && newWords > origWords * 1.5) {
            const shortenPrompt = `Ось поточний текст підрозділу "${sec.label}" (${newWords} слів):\n\n${result}\n\nСкороти його до приблизно ${origWords} слів: прибери повтори та другорядні деталі, збережи головні тези. Поверни лише скорочений текст, без коментарів.`;
            try {
              const shortRaw = await callClaude([{ role: "user", content: shortenPrompt }], null, buildSYS(lang, methodInfo), Math.min(30000, Math.max(4000, Math.round(origWords * 3))), null, MODEL, { cache: true });
              result = typographQuotes(fixMixedScript(shortRaw, lang)).trim();
            } catch { /* лишаємо як є */ }
          }
        }

        newContent[item.sectionId] = result;
        sectionsAffected.push(item.sectionId);
        setContent({ ...newContent });
        contentRef.current = { ...newContent };
        // Зберігаємо одразу після кожного розділу (як у звичайній генерації, doGen) —
        // щоб при обриві сесії посеред циклу вже виправлені розділи не загубились.
        await saveToFirestore({ content: newContent });
      } catch (e) {
        console.error("Помилка виправлення розділу", item.sectionId, e);
        failedSections.push(sec?.label || item.sectionId);
        failedItems.push(item);
      }
    }
    setCorrectionApplyProgress({ current: "", done: toFix.length, total: toFix.length });
    // Історію правок фіксуємо лише якщо хоч щось реально застосувалось
    if (sectionsAffected.length) {
      const historyEntry = {
        clientTimestamp: Date.now(),
        text: correctionText,
        hasPhoto: correctionPhotos.length > 0,
        sectionsAffected,
        applied: true,
      };
      const newHistory = [...correctionHistory, historyEntry];
      setCorrectionHistory(newHistory);
      await saveToFirestore({ content: newContent, correctionHistory: newHistory });
    }
    if (failedItems.length) {
      // Часткова невдача — лишаємо в аналізі тільки невдалі розділи, позначені для
      // повторної спроби, замість того щоб змушувати вводити зауваження заново.
      const retryChecked = {};
      failedItems.forEach(item => { retryChecked[item.sectionId] = true; });
      setCorrectionAnalysis(failedItems);
      setCorrectionChecked(retryChecked);
      setCorrectionPhotos([]);
    } else {
      setCorrectionText("");
      setCorrectionPhotos([]);
      setCorrectionAnalysis(null);
      setCorrectionChecked({});
    }
    setCorrectionApplyLoading(false);
    setCorrectionApplyProgress(null);
    if (restructureSummaries.length) {
      alert(`Список джерел оновлено: ${restructureSummaries.join(". ")}.`);
    }
    if (failedSections.length) {
      alert(`Не вдалося виправити: ${failedSections.join(", ")}. Ці розділи лишились у списку — натисніть «Виправити» ще раз.`);
    }
  };

  // ── Завантаження власного файлу і розбивка по розділах ──
  const doParseUploadedFile = async (arrayBuffer, fileName) => {
    setFileParseLoading(true);
    setUploadedFileName(fileName);
    try {
      const result = await mammoth.extractRawText({ arrayBuffer });
      const docText = result.value.trim();
      if (!docText) throw new Error("Не вдалося витягти текст з документа");
      const prompt = buildFileToSectionsPrompt({ sections, documentText: docText });
      const approxWords = docText.split(/\s+/).length;
      const maxTokens = Math.min(60000, Math.max(16000, Math.round((approxWords / 225) * 3000)));
      const raw = await callClaude([{ role: "user", content: prompt }], null, null, maxTokens, null, MODEL);
      const newContent = { ...contentRef.current };
      const blockRe = /@@@SECTION id="([^"]+)"@@@([\s\S]*?)@@@END@@@/g;
      let m;
      while ((m = blockRe.exec(raw))) {
        const [, id, textPart] = m;
        const text = textPart.trim();
        if (text) newContent[id] = text;
      }
      setContent(newContent);
      contentRef.current = newContent;
      await saveToFirestore({ content: newContent });
    } catch (e) {
      alert("Помилка завантаження файлу: " + e.message);
      setUploadedFileName("");
    }
    setFileParseLoading(false);
  };

  // ── Готова частина роботи клієнта: ручний аналіз через ШІ ──
  // Викликається кнопкою на етапі плану, коли код-розпізнавання заголовків не впоралось
  // (нестандартне оформлення документа клієнта) — не автоматично, щоб не витрачати токени наосліп.
  const doAIAnalyzeReadyWork = async () => {
    if (!readyWorkText?.trim()) return;
    setPlanLoading(true); setLoadMsg("Аналізую готову частину роботи через ШІ...");
    try {
      const prompt = buildExtractStructurePrompt({ documentText: readyWorkText });
      const approxWords = readyWorkText.trim().split(/\s+/).length;
      const maxTokens = Math.min(60000, Math.max(16000, Math.round((approxWords / 225) * 3000)));
      const raw = await callClaude([{ role: "user", content: prompt }], null, null, maxTokens, null, MODEL);
      const blockRe = /@@@SECTION id="([^"]+)" title="([^"]*)" chapterTitle="([^"]*)" type="([^"]+)"@@@([\s\S]*?)@@@SOURCES@@@([\s\S]*?)@@@END@@@/g;
      const extractedSecs = [];
      const extractedContent = {};
      const extractedCitInputs = {};
      const extractedIds = [];
      let m;
      while ((m = blockRe.exec(raw))) {
        const [, id, title, chapterTitle, type, textPart, sourcesPart] = m;
        const text = textPart.trim();
        if (!text) continue;
        const words = text.split(/\s+/).length;
        const pages = Math.max(1, Math.round(words / 270));
        extractedSecs.push({ id, label: title?.trim() || id, ...(chapterTitle?.trim() ? { sectionTitle: chapterTitle.trim() } : {}), pages, type: type || "theory" });
        extractedContent[id] = text;
        extractedIds.push(id);
        const sources = sourcesPart.split("\n").map(s => s.trim()).filter(Boolean);
        if (sources.length) extractedCitInputs[id] = sources.join("\n");
      }
      if (extractedSecs.length <= 3) {
        alert("ШІ теж не зміг впевнено розпізнати структуру документа. Спробуйте вписати план вручну.");
        return;
      }
      const mergedContent = { ...contentRef.current, ...extractedContent };
      const mergedCitInputs = { ...citInputs, ...extractedCitInputs };
      setSections(extractedSecs);
      setPlanDisplay(buildPlanText(extractedSecs));
      const { dist, total } = calcSourceDist(extractedSecs, parsePagesAvg(info?.pages));
      setSourceDist(dist); setSourceTotal(total);
      setContent(mergedContent);
      contentRef.current = mergedContent;
      setCitInputs(mergedCitInputs);
      setReadyWorkImportedIds(extractedIds);
      setReadyWorkNeedsManualAI(false);
      await saveToFirestore({
        sections: extractedSecs, planDisplay: buildPlanText(extractedSecs),
        content: mergedContent, citInputs: mergedCitInputs,
        readyWorkImportedIds: extractedIds, stage: "plan", status: "plan_ready",
      });
    } catch (e) {
      console.error("ШІ-аналіз готової частини роботи:", e);
      alert("Не вдалося розібрати готову частину роботи клієнта: " + e.message);
    }
    setPlanLoading(false); setLoadMsg("");
  };

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
    const empSecs = getEmpiricalSections(sections, d, commentAnalysis, methodInfo);
    const empIdsSet = new Set(empSecs.chapterSectionIds);

    // Будуємо multi-turn повідомлення для doRegenAll
    const buildRegenAllMessages = (excludeId, instruction) => {
      const otherEntries = sections
        .filter(s => s.id !== excludeId && contentRef.current[s.id] && s.type !== "sources")
        .map(s => [s.id, contentRef.current[s.id]]);
      if (!otherEntries.length) return [{ role: "user", content: instruction }];
      const contextText = otherEntries.map(([k, v]) => {
        const s = sections.find(x => x.id === k);
        return `=== ${s?.label || k} ===\n${v}`;
      }).join("\n\n---\n\n");
      return [
        { role: "user", content: "Ось вже написані частини цієї роботи:" },
        { role: "assistant", content: contextText },
        { role: "user", content: instruction },
      ];
    };

    for (let i = 0; i < secsToRegen.length; i++) {
      if (ctrl.signal.aborted) break;
      const sec = secsToRegen[i];
      setLoadMsg(`Переписую (${i + 1}/${secsToRegen.length}): ${sec.label}...`);

      const approxParas = Math.max(3, Math.round((sec.pages || 1) * 3.5));
      let instruction = "";

      if (sec.type === "intro") {
        const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
        const tasksProfile = getIntroTasksProfile(d.type, d.course, mainSecs.length, isLarge);
        const tasksCount = tasksProfile.count;
        const lc = getLangLabels(lang);
        const il = lc.introLabels || {};
        const defaultComponents = lc.defaultIntroComponents || ["актуальність теми", "мета дослідження", "завдання дослідження", "об'єкт дослідження", "предмет дослідження", "методи дослідження", "структура роботи"];
        const allComponents = methodInfo?.introComponents?.length ? methodInfo.introComponents : defaultComponents;
        const componentLines = allComponents.map((comp) => {
          const label = comp.charAt(0).toUpperCase() + comp.slice(1);
          if (/актуальн|actuality|aktual|relevance|relevanz|pertine/i.test(comp)) {
            const phrase = il.actuality || "Актуальність теми.";
            return `${label}: starts with "${phrase}" — do NOT split into multiple paragraphs`;
          }
          if (/теоретико|теоретичн.*основ|методологічн.*основ|theoretical.*basis|podstawy.*teor/i.test(comp)) {
            const phrase = il.theoryBasis || "Теоретико-методологічну основу дослідження становлять";
            return `${label}: starts with "${phrase}" — authors, works, regulatory acts`;
          }
          if ((/мета|goal|cel\b|ziel|objetivo|cíl|účel/i.test(comp)) && !/завдання|task|zadani|aufgab/i.test(comp)) {
            const phrase = il.goal || "Метою роботи є";
            return `${label}: starts with "${phrase}"`;
          }
          if (/завдання|tasks|zadania|aufgaben|tareas|úkoly/i.test(comp)) {
            const phrase = il.tasks || "Для досягнення мети поставлено такі завдання:";
            const natureLine = tasksProfile.nature ? ` Завдання мають бути ${tasksProfile.nature}.` : "";
            return `${label}: starts with "${phrase}" — exactly ${tasksCount} numbered tasks.${natureLine} ${INTRO_TASKS_MERGE_SPLIT_RULE}\nСтруктура плану роботи (змістова основа для завдань):\n${mainSecs.map((s, j) => `  ${j + 1}) "${s.label}"`).join("\n")}`;
          }
          if (/об.єкт|object|przedmiot\s+bad|gegenstand|objeto\s+de/i.test(comp)) {
            const phrase = il.object || "Об'єктом дослідження є";
            return `${label}: starts with "${phrase}"`;
          }
          if (/предмет|subject|obiekt\s+bad|subjekt|sujeto/i.test(comp)) {
            const phrase = il.subject || "Предметом дослідження є";
            return `${label}: starts with "${phrase}"`;
          }
          if ((/метод|methods|metody|methoden|métodos/i.test(comp)) && !/теоретико|методологічн.*основ|teoretyczn|podstawy/i.test(comp)) {
            const phrase = il.methods || "Для вирішення поставлених завдань використано такі методи:";
            return `${label}: starts with "${phrase}"`;
          }
          if (/новизн|novelty|nowość|neuheit|novedad/i.test(comp)) {
            const phrase = il.novelty || "Наукова новизна дослідження полягає в тому, що";
            return `${label}: starts with "${phrase}"`;
          }
          if (/практичн|practical|praktyczn|praktisch|práctico/i.test(comp)) {
            const phrase = il.practical || "Практична значущість одержаних результатів полягає в тому, що";
            return `${label}: starts with "${phrase}"`;
          }
          if (/апробац|approbation|aprobacja/i.test(comp)) {
            const phrase = il.approbation || "Апробація результатів дослідження здійснювалась";
            return `${label}: starts with "${phrase}"`;
          }
          if (/структура|structure|struktura|aufbau/i.test(comp)) {
            const phrase = il.structure || "Робота складається з вступу,";
            return `${label}: starts with "${phrase}"`;
          }
          return `${label}`;
        });
        instruction = `Write the INTRODUCTION for ${d.type} on the topic "${d.topic}". Field: ${d.subject}.
INTRO STRUCTURE (strictly, each element as a new paragraph):
${componentLines.map((l, idx) => `${idx + 1}. ${l}`).join("\n")}
${methodInfo?.otherRequirements ? `\nMETHOD REQUIREMENTS: ${methodInfo.otherRequirements}` : ""}
Use the written chapters (provided in context) for precise formulation of sample, methods, results — everything must match.
Do NOT bold anything. Do NOT add citations. Write as continuous prose paragraphs.`;

      } else if (sec.type === "conclusions") {
        const mainSecsForConcl = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
        const conclTasksProfile = getIntroTasksProfile(d.type, d.course, mainSecsForConcl.length, isLarge);
        instruction = `Напиши ВИСНОВКИ для ${d.type} на тему "${d.topic}".
${methodInfo?.conclusionsRequirements ? `ВИМОГИ МЕТОДИЧКИ: ${methodInfo.conclusionsRequirements}\n` : ""}
Перший абзац — загальний підсумок мети і досягнутого. Далі — рівно ${conclTasksProfile.count} абзаців, по одному на кожне завдання дослідження, сформульоване у вступі (текст вступу є в контексті), у тому самому порядку; якщо завдання поєднувало кілька підрозділів — зведи результати в одному абзаці, якщо було розбите з одного підрозділу — розподіли на відповідну кількість абзаців. Останній абзац — перспективи подальших досліджень.
Без посилань. Без жирного. Без нумерації. Суцільними абзацами.
Спирайся на весь написаний текст роботи, включно з формулюваннями завдань у вступі (є в контексті).`;

      } else if (sec.type === "chapter_conclusion") {
        const chapNum = sec.chapterNum || sec.id.split(".")[0];
        instruction = `Напиши "Висновки до розділу ${chapNum}" для ${d.type} на тему "${d.topic}".
${methodInfo?.chapterConclusionRequirements ? `ВИМОГИ МЕТОДИЧКИ: ${methodInfo.chapterConclusionRequirements}` : ""}
Обсяг: 120–150 слів (не більше). Без нової інформації. Без посилань. Без жирного. Без нумерації. Суцільними абзацами.
Спирайся на повний текст підрозділів розділу ${chapNum} (є в контексті).`;

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

Обсяг: приблизно ${Math.round((sec.pages || 1) * 225)} слів, ±10% (~${sec.pages} стор.).
Не обривай текст. Завершуй підсумковим абзацом. Без посилань [1],[2]. Без жирного.
ЗАБОРОНЕНО вставляти будь-які внутрішні підназви, заголовки абзаців або окремі рядки-мітки. Кожен рядок тексту — повне речення, рядок таблиці або підпис до таблиці/рисунка.
Абзаци різняться за довжиною: чергуй короткі (2-3 речення) з довшими (5-7 речень).`;
      }

      const sectionMaxTokens = Math.min(60000, Math.max(8000, Math.round((sec.pages || 1) * 3000)));
      try {
        const raw = await callClaude(buildRegenAllMessages(sec.id, instruction), ctrl.signal, buildSYS(lang, methodInfo), sectionMaxTokens, null, MODEL);
        const result = typographQuotes(fixMixedScript(raw, lang)
          .replace(/ — /g, ", ").replace(/— /g, "").replace(/ —/g, "")
          .replace(/[\u1100-\u11FF\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7FF\uF900-\uFAFF]/g, "")
);
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
  const doSearchSources = async (secId, thesesData, sectionLabel = '', resetPage = false) => {
    stopSearchRef.current = false;
    const isFirstSearch = resetPage || (searchPageCount[secId] || 0) === 0;
    // Для econ-аналітичних підрозділів додаємо офіційну статистику (Держстат/НБУ/Мінфін/World Bank)
    // як нагадування-посилання, поряд зі знайденими науковими статтями
    const isEconSecForSources = isEcon(info) && getEconSections(sections, info).includes(secId);
    const isTechnicalWork = isTechnical(info);
    const institutionalGroup = (isFirstSearch && isEconSecForSources)
      ? [{ phrase: "Офіційна статистика", papers: getEconInstitutionalSources() }]
      : [];
    if (isFirstSearch) {
      setSuggestedSources(prev => ({ ...prev, [secId]: institutionalGroup.flatMap(g => g.papers) }));
      setPhraseGroups(prev => ({ ...prev, [secId]: institutionalGroup }));
      setSeenSourceKeys(prev => ({ ...prev, [secId]: new Set() }));
    }
    setSourcesSearchLoading(prev => ({ ...prev, [secId]: true }));
    setSourcesSearchError(prev => ({ ...prev, [secId]: null }));
    const nextCount = resetPage ? 1 : (searchPageCount[secId] || 0) + 1;
    setSearchPageCount(prev => ({ ...prev, [secId]: nextCount }));
    const page = nextCount;
    try {
      const topicCtx = [info?.topic, info?.direction, info?.subject].filter(Boolean).join(' ');
      const globalSeen = new Set(isFirstSearch ? [] : (seenSourceKeys[secId] || []));
      const updatedGroups = isFirstSearch ? [...institutionalGroup] : [...(phraseGroups[secId] || [])];

      // Для розділів без підрозділів label містить "РОЗДІЛ N. НАЗВА РОЗДІЛУ" —
      // обрізаємо структурний префікс щоб Gemini-фільтр орієнтувався на зміст, а не на "напрями удосконалення"
      const filterLabel = sectionLabel
        .replace(/^РОЗДІЛ\s+[IVXivxІVХ\d]+[.\s:]+/i, '')
        .trim() || sectionLabel;

      // Нормалізація: підтримка як [{thesis, phrases}], так і старого плоского рядкового масиву
      const normalizedTheses = Array.isArray(thesesData) && thesesData.length > 0 && typeof thesesData[0] === 'string'
        ? [{ thesis: '', phrases: thesesData }]
        : (thesesData || []);

      outer:
      for (const { thesis, phrases } of normalizedTheses) {
        for (let pi = 0; pi < (phrases || []).length; pi++) {
          if (stopSearchRef.current) break outer;
          const phrase = phrases[pi];
          const useScholar = pi === 0 || isTechnicalWork; // Scholar тільки для першої фрази тези; для технічних робіт — на кожній
          const candidates = await searchByPhrase(phrase, 10, page, useScholar, isTechnicalWork);
          const fresh = candidates.filter(p => {
            const key = (p.title || '').toLowerCase().slice(0, 60);
            return key && !globalSeen.has(key);
          });
          if (!fresh.length) continue;

          const top15 = await filterSourcesWithGemini(fresh.slice(0, 15), filterLabel, topicCtx, 15, thesis);
          top15.forEach(p => globalSeen.add((p.title || '').toLowerCase().slice(0, 60)));

          const existingIdx = updatedGroups.findIndex(g => g.phrase === phrase);
          if (existingIdx >= 0) {
            updatedGroups[existingIdx] = {
              phrase,
              papers: [...updatedGroups[existingIdx].papers, ...top15],
            };
          } else {
            updatedGroups.push({ phrase, papers: top15 });
          }

          // Прогресивне оновлення — кожна фраза відображається одразу
          setPhraseGroups(prev => ({ ...prev, [secId]: [...updatedGroups] }));
          setSuggestedSources(prev => ({ ...prev, [secId]: updatedGroups.flatMap(g => g.papers) }));
        }
      }

      setSeenSourceKeys(prev => ({ ...prev, [secId]: globalSeen }));
      // Явне збереження після завершення пошуку по секції — не залежить від дебаунс-таймерів
      if (updatedGroups.length > 0) {
        const finalSuggested = { ...suggestedSources, [secId]: updatedGroups.flatMap(g => g.papers) };
        const finalGroups = { ...phraseGroups, [secId]: updatedGroups };
        saveToFirestore({ suggestedSources: finalSuggested, phraseGroups: finalGroups, keywords });
      }
    } catch (e) {
      console.error('Source search error:', e.message);
      setSourcesSearchError(prev => ({ ...prev, [secId]: e.message }));
    }
    setSourcesSearchLoading(prev => ({ ...prev, [secId]: false }));
  };

  // ── Ключові слова ──
  const doGenKeywords = async () => {
    setKwLoading(true);
    stopSearchRef.current = false;
    // Розділи, вже імпортовані з готової частини роботи клієнта, мають реальні джерела з документа — не шукаємо для них додатково
    const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type) && !readyWorkImportedIds.includes(s.id));
    const labelToId = {};
    for (const s of mainSecs) {
      labelToId[s.id] = s.id;
      const m = s.label.match(/^(\d+(?:\.\d+)*)/);
      if (m) labelToId[m[1]] = s.id;
    }
    const normalizeKey = (k) => labelToId[k] || k.match(/^(\d+\.\d+)/)?.[1] || k;
    const domainCtx = [info?.direction, info?.subject].filter(Boolean).join(', ');
    const commentCtx = [commentAnalysis?.planHints, commentAnalysis?.writingHints].filter(Boolean).join(' ').slice(0, 400);
    const methodCtx = [methodInfo?.otherRequirements, methodInfo?.theoryRequirements, methodInfo?.analysisRequirements].filter(Boolean).join(' ').slice(0, 400);

    // Батч по 8 секцій — щоб JSON відповідь не обрізалась токенним лімітом
    const BATCH_SIZE = 8;
    const snippetLen = mainSecs.length > 10 ? 600 : 1200;
    const allThesesNorm = {};
    const allAnchorsNorm = {};

    try {
      for (let bStart = 0; bStart < mainSecs.length; bStart += BATCH_SIZE) {
        if (stopSearchRef.current) break;
        const batch = mainSecs.slice(bStart, bStart + BATCH_SIZE);
        const secBlocks = batch.map(s => {
          const txt = content[s.id]
            ? `\n${content[s.id].substring(0, snippetLen).replace(/["\\]/g, " ").replace(/\n+/g, " ")}`
            : "";
          return `### [${s.id}] ${s.label} (потрібно ${sourceDist[s.id] || 3} джерела)${txt}`;
        }).join("\n\n");

        const prompt = `Ти допомагаєш знайти наукові джерела для академічної роботи на тему "${info?.topic}"${domainCtx ? ` (галузь: ${domainCtx})` : ''}.

ЗАВДАННЯ — для кожного підрозділу:

КРОК 1. Визнач 4–5 конкретних тез — про що писатиметься у цьому підрозділі (3–7 слів кожна, конкретний аспект змісту, не загальні назви розділів).

КРОК 2. Для кожної тези склади 2–3 пошукових фрази українською.
Кожна фраза = [1–2 ключових слова з ТЕМИ роботи] + [конкретний аспект тези].
Приклад: тема "ЕІ підлітки", теза "структура компонентів ЕІ" → "компоненти емоційного інтелекту підлітки", "структура ЕІ психологічна модель".
ВАЖЛИВО: кожна фраза має містити конкретний предмет теми — не загальні слова без прив'язки.${commentCtx ? `\nПОБАЖАННЯ КЛІЄНТА: ${commentCtx}` : ''}${methodCtx ? `\nВИМОГИ МЕТОДИЧКИ: ${methodCtx}` : ''}

ПІДРОЗДІЛИ:
${secBlocks}

Поверни валідний JSON з двома полями:
- "theses": об'єкт, ключ = ідентифікатор підрозділу з квадратних дужок ("1.1", "1.2", "3" тощо), значення = масив об'єктів {"thesis": рядок, "phrases": масив рядків}
- "searchAnchors": об'єкт, ключ = ідентифікатор підрозділу з квадратних дужок, значення = масив з 2–3 якірних фраз (рядки)`;

        const res = await fetch("/api/gemini", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            _model: "gemini-2.5-flash-lite",
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 8192, responseMimeType: "application/json" },
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data).slice(0, 200));
        if (data.usageMetadata) {
          const cost = (data.usageMetadata.promptTokenCount * 0.10 + data.usageMetadata.candidatesTokenCount * 0.40) / 1_000_000;
          window.dispatchEvent(new CustomEvent("apicost", { detail: { cost, model: "gemini-2.5-flash-lite", inTok: data.usageMetadata.promptTokenCount, outTok: data.usageMetadata.candidatesTokenCount } }));
        }
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const parsed = JSON.parse(raw);
        const thesesRaw = parsed.theses || {};
        const anchorsRaw = parsed.searchAnchors || {};

        for (const [k, v] of Object.entries(anchorsRaw)) {
          allAnchorsNorm[normalizeKey(k)] = Array.isArray(v) ? v.map(String).filter(Boolean) : [];
        }
        for (const [k, arr] of Object.entries(thesesRaw)) {
          allThesesNorm[normalizeKey(k)] = (Array.isArray(arr) ? arr : []).map(t => ({
            thesis: String(t.thesis || '').trim(),
            phrases: (Array.isArray(t.phrases) ? t.phrases : []).map(String).filter(Boolean),
          })).filter(t => t.phrases.length > 0);
        }
      }

      setSearchAnchors(allAnchorsNorm);

      const kwNorm = Object.fromEntries(
        Object.entries(allThesesNorm).map(([k, theses]) => [k, theses.flatMap(t => t.phrases)])
      );
      setKeywords(kwNorm);

      const econSecIdsForSources = getEconSections(sections, info);
      for (const s of mainSecs) {
        if (stopSearchRef.current) break;
        const normalKey = normalizeKey(s.id);
        const thesesData = allThesesNorm[normalKey] || allThesesNorm[s.id] || [];
        // Навіть якщо Gemini не повернув тез для econ-підрозділу (обрізаний батч, збій парсингу),
        // офіційна статистика (Держстат/НБУ/Мінфін/World Bank) все одно має з'явитись
        if (thesesData.length || econSecIdsForSources.includes(s.id)) {
          await doSearchSources(s.id, thesesData, s.label || '');
        }
      }
    } catch (e) { console.error(e); setKwError(e.message); }
    setKwLoading(false);
  };

  const doStopSearch = () => { stopSearchRef.current = true; };

  // ── Оновлення ключових слів + пошук для одного підрозділу ──
  const doRegenSectionSources = async (sec) => {
    setSourcesSearchLoading(prev => ({ ...prev, [sec.id]: true }));
    setSourcesSearchError(prev => ({ ...prev, [sec.id]: null }));
    try {
      const txt = content[sec.id]
        ? `\n${content[sec.id].substring(0, 1200).replace(/["\\]/g, " ").replace(/\n+/g, " ")}`
        : "";
      const domainCtx = [info?.direction, info?.subject].filter(Boolean).join(', ');
      const commentCtx = [commentAnalysis?.planHints, commentAnalysis?.writingHints].filter(Boolean).join(' ').slice(0, 400);
      const methodCtx = [methodInfo?.otherRequirements, methodInfo?.theoryRequirements, methodInfo?.analysisRequirements].filter(Boolean).join(' ').slice(0, 400);
      const secBlock = `### ${sec.label} (потрібно ${sourceDist[sec.id] || 3} джерела)${txt}`;
      const prompt = `Ти допомагаєш знайти наукові джерела для академічної роботи на тему "${info?.topic}"${domainCtx ? ` (галузь: ${domainCtx})` : ''}.

ЗАВДАННЯ — для підрозділу:

КРОК 1. Визнач 4–5 конкретних тез — про що писатиметься у цьому підрозділі (3–7 слів кожна, конкретний аспект змісту, не загальні назви).

КРОК 2. Для кожної тези склади 2–3 пошукових фрази українською.
Кожна фраза = [1–2 ключових слова з ТЕМИ роботи] + [конкретний аспект тези].
ВАЖЛИВО: кожна фраза має містити конкретний предмет теми — не загальні слова без прив'язки.${commentCtx ? `\nПОБАЖАННЯ КЛІЄНТА: ${commentCtx}` : ''}${methodCtx ? `\nВИМОГИ МЕТОДИЧКИ: ${methodCtx}` : ''}

ПІДРОЗДІЛ:
${secBlock}

Поверни валідний JSON: {"theses": масив об'єктів {"thesis": рядок, "phrases": масив рядків}}`;

      const res = await fetch("/api/gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _model: "gemini-2.5-flash-lite",
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 1200,
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                theses: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      thesis: { type: "string" },
                      phrases: { type: "array", items: { type: "string" } },
                    },
                    required: ["thesis", "phrases"],
                  },
                },
              },
              required: ["theses"],
            },
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data).slice(0, 200));
      if (data.usageMetadata) {
        const cost = (data.usageMetadata.promptTokenCount * 0.10 + data.usageMetadata.candidatesTokenCount * 0.40) / 1_000_000;
        window.dispatchEvent(new CustomEvent("apicost", { detail: { cost, model: "gemini-2.5-flash-lite", inTok: data.usageMetadata.promptTokenCount, outTok: data.usageMetadata.candidatesTokenCount } }));
      }
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const parsed = JSON.parse(raw);
      const newTheses = (Array.isArray(parsed.theses) ? parsed.theses : [])
        .map(t => ({
          thesis: String(t.thesis || '').trim(),
          phrases: (Array.isArray(t.phrases) ? t.phrases : []).map(String).filter(Boolean),
        }))
        .filter(t => t.phrases.length > 0);
      if (newTheses.length) {
        setKeywords(prev => ({ ...prev, [sec.id]: newTheses.flatMap(t => t.phrases) }));
        await doSearchSources(sec.id, newTheses, sec.label || '', true);
      } else {
        setSourcesSearchLoading(prev => ({ ...prev, [sec.id]: false }));
      }
    } catch (e) {
      console.error('doRegenSectionSources error:', e.message);
      setSourcesSearchError(prev => ({ ...prev, [sec.id]: e.message }));
      setSourcesSearchLoading(prev => ({ ...prev, [sec.id]: false }));
    }
  };

  // ── Джерела ──
  const buildGlobalRefList = () => {
    const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const _effectiveOrder = sourcesOrderOverride || methodInfo?.sourcesOrder;
    const isAlphabetical = !_effectiveOrder || _effectiveOrder === "alphabetical";

    // Збираємо всі унікальні джерела з прив'язкою до секцій (за порядком появи).
    // Нечітка дедуплікація (createReferenceDeduper) — та сама логіка, що й у
    // doRemapCitations, щоб прев'ю тут збігалося з фінальним результатом.
    const deduper = createReferenceDeduper();
    const secRefMapRaw = {};
    mainSecs.forEach(sec => {
      const raw = citInputs[sec.id] || "";
      const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
      secRefMapRaw[sec.id] = lines.map(line => deduper.add(line));
    });
    const rawRefs = deduper.canonicalRefs;

    // Якщо алфавітний порядок — сортуємо і перебудовуємо індекси. Групування
    // (закони окремо / мовні блоки) вмикається лише за явним сигналом методички
    // (detectSourceGrouping) — інакше плаский алфавітний список, щоб прев'ю тут
    // збігалося з фінальним результатом doRemapCitations.
    let allRefs, indexMap;
    if (isAlphabetical) {
      const _workLang = info?.language || "Українська";
      const _latinFirst = /англ|english|польськ|polish|нім|german|франц|french|іспан|spanish|італ|italian/i.test(_workLang);
      const { lawFirst: _lawFirst, foreignGroup: _foreignGroup } = detectSourceGrouping({
        sourcesFormatRules: methodInfo?.sourcesFormatRules, sourcesGrouping: methodInfo?.sourcesGrouping,
      });
      const _isLaw = s => _lawFirst && /^(закон|кодекс|конституція|постанова|указ\s|декрет\s|наказ\s|розпорядження\s)/i.test(s.trim());
      const langGroup = (s) => {
        if (!_foreignGroup) return 0;
        const isCyrillic = /^[А-ЯҐЄІЇа-яґєії]/i.test(s);
        return _latinFirst ? (isCyrillic ? 1 : 0) : (isCyrillic ? 0 : 1);
      };
      const _groupLocales = _latinFirst ? ["en", "uk"] : ["uk", "en"];
      const sorted = [...rawRefs].sort((a, b) => {
        const lawA = _isLaw(a), lawB = _isLaw(b);
        if (lawA !== lawB) return lawA ? -1 : 1;
        const ga = langGroup(a), gb = langGroup(b);
        if (ga !== gb) return ga - gb;
        return a.localeCompare(b, _groupLocales[ga]);
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

  const globalRefData = useMemo(() => buildGlobalRefList(), [citInputs, sections, sourcesOrderOverride, methodInfo]); // eslint-disable-line

  const handleCitStyleChange = (style) => {
    setCitStyleOverride(style);
    saveToFirestore({ citStyleOverride: style });
  };
  const handleSourcesOrderChange = (order) => {
    setSourcesOrderOverride(order);
    saveToFirestore({ sourcesOrderOverride: order });
  };
  const handleCitFootnotesChange = (val) => {
    setCitFootnotes(val);
    saveToFirestore({ citFootnotes: val });
  };

  // ── Анотація (укр + англ) для магістерських/бакалаврських/дипломних робіт ──
  const doGenAnnotation = async (contentForGen, refListForGen) => {
    setAnnotationLoading(true);
    try {
      const intro = sections.find(s => s.type === "intro");
      const concs = sections.find(s => s.type === "conclusions");
      const introText = intro ? (contentForGen[intro.id] || "") : "";
      const concsText = concs ? (contentForGen[concs.id] || "") : "";

      const wt = normalizeWorkType(info?.type, info?.course);
      const degreeLabel = wt === "master" ? "магістра (Master's)" : "бакалавра (Bachelor's)";
      const chaptersCount = new Set(mainSections.map(s => s.id.split(".")[0])).size;
      const sourcesCount = (refListForGen || refList || []).length;
      const appendicesCount = (appendicesText.match(/^ДОДАТОК\s+[А-ЯA-Z]/gim) || []).length;
      const pagesLabel = info?.pages || methodInfo?.totalPages || "";

      const statsText = [
        `Освітній ступінь: ${degreeLabel}`,
        `Спеціальність/напрям: ${info?.subject || info?.direction || ""}`,
        `Кількість розділів: ${chaptersCount}`,
        `Кількість використаних джерел: ${sourcesCount}`,
        appendicesCount ? `Кількість додатків: ${appendicesCount}` : "Додатків немає",
        pagesLabel ? `Орієнтовний обсяг роботи: ${pagesLabel} сторінок` : "",
      ].filter(Boolean).join("\n");

      const prompt = buildAnnotationPrompt(info, methodInfo, statsText, introText, concsText);
      const raw = await callClaude([{ role: "user", content: prompt }], null, SYS_JSON, 3000, null, MODEL);
      const match = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match?.[0] || raw.replace(/```json|```/g, "").trim());
      setAnnotationUk(parsed.uk || "");
      setAnnotationEn(parsed.en || "");
      await saveToFirestore({ annotationUk: parsed.uk || "", annotationEn: parsed.en || "" });
    } catch (e) {
      console.error("doGenAnnotation error:", e);
    }
    setAnnotationLoading(false);
  };

  // ── Точкове редагування анотації за коментарем (без повної регенерації) ──
  const doRegenAnnotation = async (comment) => {
    setAnnotationLoading(true);
    try {
      const prompt = buildAnnotationRegenPrompt(annotationUk, annotationEn, comment);
      const raw = await callClaude([{ role: "user", content: prompt }], null, SYS_JSON, 3000, null, MODEL);
      const match = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match?.[0] || raw.replace(/```json|```/g, "").trim());
      const newUk = parsed.uk || annotationUk;
      const newEn = parsed.en || annotationEn;
      setAnnotationUk(newUk);
      setAnnotationEn(newEn);
      await saveToFirestore({ annotationUk: newUk, annotationEn: newEn });
    } catch (e) {
      console.error("doRegenAnnotation error:", e);
      alert("Помилка: " + e.message);
    }
    setAnnotationLoading(false);
  };

  // ── sources-first: ремаппінг локальних [N] → глобальні номери + форматування списку ──
  const doRemapCitations = async () => {
    setRemapLoading(true);
    // Усі секції, що можуть містити цитати клієнта чи ШІ, окрім самого списку джерел
    // (вступ і висновки теж можуть цитувати джерела — раніше вони виключались і їхні
    // цитати так і лишались зі старими, не перенумерованими локальними номерами).
    const mainSecs = sections.filter(s => s.type !== "sources");
    const _extraText2 = (methodInfo?.otherRequirements || "") + " " + (methodInfo?.citationStyle || "") + " " + (commentAnalysis?.sourcesHints || "");
    const sourcesStyle = citStyleOverride
      || methodInfo?.sourcesStyle
      || (/APA/i.test(_extraText2) ? "APA" : /MLA/i.test(_extraText2) ? "MLA" : "ДСТУ 8302:2015");
    const isAPA = /APA/i.test(sourcesStyle);
    const isMLA = /MLA/i.test(sourcesStyle);
    const isDstu = /ДСТУ/i.test(sourcesStyle);
    const isFootnoteMode = citFootnotes && isDstu;
    const _effectiveOrderRemap = sourcesOrderOverride || methodInfo?.sourcesOrder;
    const isAlphabeticalOrder = !_effectiveOrderRemap || _effectiveOrderRemap === "alphabetical";

    // ── 1. Локальна карта: secId → { localN: sourceText } ──
    const secLocalSources = {};
    mainSecs.forEach(sec => {
      const lines = (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
      secLocalSources[sec.id] = {};
      lines.forEach((line, i) => { secLocalSources[sec.id][i + 1] = line; });
    });

    // ── 2. Глобальна дедуплікація — нечітка (createReferenceDeduper): об'єднує не
    // лише побайтово однакові тексти, а й "майже дублікати" того самого джерела
    // (той самий запис з кодом УДК чи без нього, куций стаб-запис клієнта і повна
    // версія, знайдена пошуком) за перетином ідентифікаційних токенів.
    const deduper = createReferenceDeduper();
    mainSecs.forEach(sec => {
      Object.values(secLocalSources[sec.id]).forEach(text => { deduper.add(text); });
    });
    const rawRefs = deduper.canonicalRefs;

    // ── 3-6. Форматування джерел через LLM (без права переставляти) → сортування
    // кодом на вже правильно оформленому тексті → мапа localN→globalN → формат
    // inline-посилань. Спільна логіка з
    // remapAndFormatCitations (citationFormatting.js): buildFinalReferenceList сама
    // звіряє відповідь LLM за змістом і, за потреби, ділить список навпіл, щоб
    // відновитись після провалу валідації, замість відкидання всього списку.
    const _remapWorkLang = info?.language || "Українська";
    const _remapLatinFirst = /англ|english|польськ|polish|нім|german|франц|french|іспан|spanish|італ|italian/i.test(_remapWorkLang);

    const structuredByTitle2 = {};
    Object.values(citStructured).forEach(papers => {
      (papers || []).forEach(p => {
        if (p.title) structuredByTitle2[p.title.toLowerCase().slice(0, 60)] = p;
      });
    });
    const findStructured2 = (refText) => {
      const lower = refText.toLowerCase();
      for (const [key, paper] of Object.entries(structuredByTitle2)) {
        if (lower.includes(key)) return paper;
      }
      return null;
    };

    const { finalTexts: allRefs, indexMap } = await buildFinalReferenceList({
      rawRefs, findStructured: findStructured2, sourcesStyle, isLatinWork: _remapLatinFirst,
      sourcesFormatRules: methodInfo?.sourcesFormatRules, sourcesGrouping: methodInfo?.sourcesGrouping, callClaude,
      skipSort: !isAlphabeticalOrder && !isDstu,
    });
    const fmtLines = allRefs;
    let fmtResult = allRefs.map((r, i) => `${i + 1}. ${r}`).join("\n");

    // ── Маппінг localN → globalN для кожного підрозділу ──
    const secLocalToGlobal = {};
    mainSecs.forEach(sec => {
      secLocalToGlobal[sec.id] = {};
      Object.entries(secLocalSources[sec.id]).forEach(([localN, text]) => {
        const rawIdx = deduper.add(text); // ідемпотентно — знаходить уже канонічний індекс
        secLocalToGlobal[sec.id][Number(localN)] = indexMap[rawIdx];
      });
    });

    // ── Формат inline-посилань по стилю ──
    const { refCiteText, pageRanges: pageRanges2 } = buildCiteFormats({
      finalTexts: allRefs, rawRefs, indexMap, findStructured: findStructured2,
      isAPA, isMLA, isFootnoteMode,
    });

    // ── 7. Заміна в тексті: [localN] / [localN, с. X] / [localN, localM] → фінал ──
    // Сторінку, яку модель сама вписала при написанні, лишаємо (якщо вона в межах
    // діапазону джерела); інакше підставляємо сторінку з діапазону. Кожна згадка
    // джерела лишається окремою — повторне цитування одного джерела не видаляємо.
    // Логіка спільна з applyCitationRemap (citationFormatting.js) — вона ж підтримує
    // групові цитати [N, M], які може породжувати localizeCitations для готової
    // частини клієнта.
    const newContent = { ...content };
    mainSecs.forEach(sec => {
      if (!newContent[sec.id]) return;
      const mapping = secLocalToGlobal[sec.id];
      if (!mapping || !Object.keys(mapping).length) return;
      newContent[sec.id] = applyCitationRemap(newContent[sec.id], mapping, refCiteText, { pageRanges: pageRanges2 });
    });

    // ── 8а. Очищення: прибираємо номери поза діапазоном реального списку (будь-який стиль) ──
    if (!isAPA && !isMLA) {
      mainSecs.forEach(sec => {
        if (!newContent[sec.id]) return;
        newContent[sec.id] = newContent[sec.id].replace(/\[\s*(\d+(?:\s*[,;]\s*\d+)*)\s*(?:,\s*[сc]\.?\s*\d*[^\]]*)?\s*\]/g, (match, nums) => {
          const valid = nums.split(/[,;]/).every(n => {
            const num = Number(n.trim());
            return num >= 1 && num <= fmtLines.length;
          });
          return valid ? match : "";
        });
      });
    }

    // ── 8. Ренумерація для порядку за появою (не APA/MLA, не алфавітний) ──
    if (!isAPA && !isMLA && !isAlphabeticalOrder) {
      const firstSeen = [], seen = new Set();
      mainSecs.forEach(sec => {
        const text = newContent[sec.id] || "";
        [...text.matchAll(/\[\s*(\d+(?:\s*[,;]\s*\d+)*)/g)].forEach(m => {
          m[1].split(/[,;]/).forEach(s => {
            const n = Number(s.trim());
            if (!seen.has(n)) { seen.add(n); firstSeen.push(n); }
          });
        });
      });
      const oldToNew = {};
      firstSeen.forEach((oldN, idx) => { oldToNew[oldN] = idx + 1; });
      let nextNew = firstSeen.length + 1;
      fmtLines.forEach((_, i) => { const n = i + 1; if (!oldToNew[n]) oldToNew[n] = nextNew++; });

      if (Object.entries(oldToNew).some(([old, nw]) => Number(old) !== nw)) {
        mainSecs.forEach(sec => {
          if (!newContent[sec.id]) return;
          let text = newContent[sec.id].replace(/\[\s*(\d+(?:\s*[,;]\s*\d+)*)\s*(?:,\s*[сc]\.?\s*(\d+)?[^\]]*)?\s*\]/g, (match, nums, page) => {
            const newNums = nums.split(/[,;]/).map(s => oldToNew[Number(s.trim())]).filter(Boolean);
            if (!newNums.length) return match;
            if (newNums.length === 1) return `[${newNums[0]}${page ? `, с. ${page}` : ""}]`;
            return `[${[...new Set(newNums)].join(", ")}]`;
          });
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
    if (srcSec) newContent[srcSec.id] = fmtResult || allRefs.map((r, i) => `${i + 1}. ${r}`).join("\n");
    const newRefList = (fmtResult || allRefs.map((r, i) => `${i + 1}. ${r}`).join("\n"))
      .split("\n").filter(Boolean);

    setRefList(newRefList);
    setContent(newContent);
    setCitInputsSnapshot(JSON.stringify(citInputs));
    await saveToFirestore({ content: newContent, citInputs, citStructured, refList: newRefList, stage: "done", status: "done" });

    const wt = normalizeWorkType(info?.type, info?.course);
    if (wt === "master" || wt === "bachelor") {
      await doGenAnnotation(newContent, newRefList);
    }

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
    // Сортуємо за номером розділу/підрозділу — незалежно від фізичного порядку в масиві sections,
    // щоб розділи в експортованому документі завжди йшли за зростанням (1, 2, 3...).
    const main = sections
      .filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type))
      .slice()
      .sort((a, b) => {
        const [aChap, aSub] = a.id.split(".").map(Number);
        const [bChap, bSub] = b.id.split(".").map(Number);
        if (aChap !== bChap) return aChap - bChap;
        return (aSub || 0) - (bSub || 0);
      });
    const ordered = [];
    for (let i = 0; i < main.length; i++) {
      ordered.push(main[i]);
      const chap = main[i].id.split(".")[0];
      const nextChap = main[i + 1]?.id.split(".")[0];
      if (chap !== nextChap) {
        const chapConc = sections.find(s => s.type === "chapter_conclusion" && s.id === `${chap}.conclusions`);
        if (chapConc) ordered.push(chapConc);
      }
    }
    return [intro, ...ordered, concs, srcs].filter(Boolean);
  }, [sections]);

  const mainSections = useMemo(() => sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type)), [sections]);

  const resetAll = () => {
    setStage("input"); setTplText(""); setComment(""); setClientPlan("");
    setFileLabel(""); setFileB64(null); setFileType(null); setInfo(null);
    setSections([]); setPlanDisplay(""); setContent({}); setGenIdx(0);
    setPaused(false); setPlanLoading(false); setMethodInfo(null); setCommentAnalysis(null); setSourceDist({}); setSourceTotal(0);
    setKeywords({}); setCitInputs({}); setAllCitLoading(false); setRefList([]); setCitInputsSnapshot(null); setFigureRefs({}); setFigureKeywords([]); setFigKwLoading(false);
    setSpeechText(""); setAppendicesText(""); setEconProfile("");
    setAnnotationUk(""); setAnnotationEn(""); setAnnotationLoading(false); setAnnotationConfirmed(false);
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
              <button onClick={handleBack} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "5px 14px", cursor: "pointer", fontFamily: "inherit", fontSize: 12, marginRight: 4 }}>
                ← Замовлення
              </button>
            )}
            <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 19, letterSpacing: 5, color: "#e8ff47", flexShrink: 0 }}>ACADEM</div>
            <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 19, letterSpacing: 5, flexShrink: 0 }}>ASSIST</div>
            {info?.orderNumber && <div style={{ fontSize: 11, color: "#888", whiteSpace: "nowrap", flexShrink: 0 }}>#{info.orderNumber}</div>}
            {info?.topic && <div style={{ fontSize: 12, color: "#666", flex: 1, minWidth: 0, lineHeight: 1.4 }}>{info.topic}</div>}
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0, marginLeft: "auto" }}>
              <SaveIndicator saving={saving} saved={saved} error={saveError} />
              <StagePills stage={stage} maxStageIdx={maxStageIdx} onNavigate={running ? null : handleNavigateMain} stages={activeStages} stageKeys={activeStageKeys} />
              <button
                onClick={() => setMaxStageIdx(activeStageKeys.length - 1)}
                style={{ background: "transparent", border: "1px solid #555", color: "#888", fontSize: 10, letterSpacing: 1, padding: "4px 10px", borderRadius: 20, cursor: "pointer" }}>
                🔓 Розблокувати всі кроки
              </button>
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
              appendicesText={appendicesText} setAppendicesText={setAppendicesText}
              fileLabel={fileLabel} fileB64={fileB64} methodInfo={methodInfo}
              photos={photos} setPhotos={setPhotos}
              illustrations={illustrations} setIllustrations={setIllustrations}
              illustrationsPdf={illustrationsPdf} setIllustrationsPdf={setIllustrationsPdf}
              clientDrawings={clientDrawings} setClientDrawings={setClientDrawings}
              info={info}
              clientMaterials={clientMaterials}
              onAddClientMaterial={m => setClientMaterials(prev => [...prev, m])}
              onRemoveClientMaterial={i => setClientMaterials(prev => prev.filter((_, idx) => idx !== i))}
              clientMaterialsText={clientMaterialsText} setClientMaterialsText={setClientMaterialsText}
              readyWorkFileName={readyWorkFileName}
              onReadyWorkFile={handleReadyWorkFile}
              onRemoveReadyWork={handleRemoveReadyWork}
              running={running} loadMsg={loadMsg}
              handleFile={handleFile} doAnalyze={doAnalyze} setStage={setStage}
            />
          )}
          {stage === "parsed" && info && (
            <ParsedStage
              info={info} setInfo={setInfo}
              methodInfo={methodInfo} setMethodInfo={setMethodInfo}
              fileB64={fileB64} apiError={apiError} sections={sections}
              commentAnalysis={commentAnalysis} setCommentAnalysis={setCommentAnalysis}
              doGenPlan={doGenPlan} setStage={setStage}
              running={running} loadMsg={loadMsg}
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
              info={info} setInfo={setInfo} methodInfo={methodInfo} content={content}
              readyWorkFileName={readyWorkFileName} readyWorkImportedIds={readyWorkImportedIds}
              readyWorkNeedsManualAI={readyWorkNeedsManualAI} doAIAnalyzeReadyWork={doAIAnalyzeReadyWork}
              doGenPlan={doGenPlan} doNamePlaceholders={doNamePlaceholders}
              startGen={startGen} setStage={setStage}
              setSourceDist={setSourceDist} setSourceTotal={setSourceTotal}
              addNewChapter={addNewChapter} recalcPages={recalcPages}
              toggleStructureSection={toggleStructureSection}
              moveSectionUp={moveSectionUp} moveSectionDown={moveSectionDown}
              moveSectionToPosition={moveSectionToPosition}
              doNameSinglePlaceholder={doNameSinglePlaceholder} singleNamingId={singleNamingId}
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
              doRegenSection={doRegenSection} setStage={setStage}
              doRemapCitations={doRemapCitations} remapLoading={remapLoading}
              appendicesText={appendicesText} appendicesLoading={appendicesLoading}
            />
          )}
          {stage === "sources" && (
            <SourcesStage
              mainSections={mainSections}
              readyWorkImportedIds={readyWorkImportedIds}
              citInputs={citInputs} setCitInputs={setCitInputs}
              citStructured={citStructured} setCitStructured={setCitStructured}
              sourceDist={sourceDist} sourceTotal={sourceTotal}
              keywords={keywords} kwLoading={kwLoading}
              kwError={kwError} setKwError={setKwError}
              onStopSearch={doStopSearch}
              methodInfo={methodInfo} commentAnalysis={commentAnalysis}
              citStyleOverride={citStyleOverride} sourcesOrderOverride={sourcesOrderOverride}
              onCitStyleChange={handleCitStyleChange} onSourcesOrderChange={handleSourcesOrderChange}
              citFootnotes={citFootnotes} onCitFootnotesChange={handleCitFootnotesChange}
              allRefs={globalRefData.allRefs} refList={refList}
              showMissingSources={showMissingSources}
              citInputsSnapshot={citInputsSnapshot} allCitLoading={allCitLoading}
              info={info} doGenKeywords={doGenKeywords}
              suggestedSources={suggestedSources}
              phraseGroups={phraseGroups}
              sourcesSearchLoading={sourcesSearchLoading}
              sourcesSearchError={sourcesSearchError}
              doSearchSources={doSearchSources}
              doRegenSectionSources={doRegenSectionSources}
              onAddAbstracts={(entries) => setAbstractsMap(prev => ({ ...prev, ...entries }))}
              onFinish={doRemapCitations} remapLoading={remapLoading}
              onProceedToWriting={() => setStage("writing")}
              setStage={setStage}
              onSave={() => saveToFirestore({ citInputs, citStructured, abstractsMap, suggestedSources, phraseGroups, keywords })}
              saving={saving}
              hasGeneratedContent={Object.keys(content).some(id => !readyWorkImportedIds.includes(id))}
              onRegenWithNewSources={() => {
                // Контент, імпортований з готової частини роботи клієнта, не рахуємо "згенерованим" — його не чіпаємо
                const hasWrittenContent = Object.keys(content).some(id => !readyWorkImportedIds.includes(id));
                if (hasWrittenContent) {
                  if (!window.confirm("Переписати всю роботу з нуля з новими джерелами? Поточний текст буде замінено.")) return;
                  const preserved = {};
                  readyWorkImportedIds.forEach(id => { if (content[id]) preserved[id] = content[id]; });
                  contentRef.current = preserved;
                  setContent(preserved);
                  setGenIdx(0);
                  writingDoneRef.current = false;
                  autoRemapDoneRef.current = false;
                  setPaused(false);
                }
                setStage("writing");
              }}
            />
          )}
          {stage === "done" && (
            <DoneStage
              annotationUk={annotationUk} setAnnotationUk={setAnnotationUk}
              annotationEn={annotationEn} setAnnotationEn={setAnnotationEn}
              annotationLoading={annotationLoading} doRegenAnnotation={doRegenAnnotation}
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
              sections={sections} info={info} methodInfo={methodInfo} commentAnalysis={commentAnalysis}
              illustrations={illustrations}
              doRegenSection={doRegenSection} doRegenAll={doRegenAll}
              regenAllAbortRef={regenAllAbortRef}
              plagId={plagId} setPlagId={setPlagId} plagLoading={plagLoading}
              doReducePlagiarism={doReducePlagiarism}
              plagAllLoading={plagAllLoading} plagAllMsg={plagAllMsg}
              doReducePlagiarismAll={doReducePlagiarismAll} plagAllAbortRef={plagAllAbortRef}
              doGenAppendices={doGenAppendices} saveToFirestore={saveToFirestore}
              copyAll={copyAll} resetAll={resetAll}
              generatePresentation={generatePresentation} generateSpeech={generateSpeech}
              doScanAndGenFigures={doScanAndGenFigures} setStage={setStage}
              orderId={currentIdRef.current}
            />
          )}
          {stage === "checklist" && (
            <ChecklistStage info={info} methodInfo={methodInfo} setStage={setStage} mode="large" />
          )}
          {stage === "corrections" && (
            <CorrectionsStage
              sections={sections}
              correctionText={correctionText} setCorrectionText={setCorrectionText}
              correctionPhotos={correctionPhotos} setCorrectionPhotos={setCorrectionPhotos}
              correctionAnalysis={correctionAnalysis}
              correctionChecked={correctionChecked} setCorrectionChecked={setCorrectionChecked}
              correctionLoading={correctionLoading}
              correctionApplyLoading={correctionApplyLoading}
              correctionApplyProgress={correctionApplyProgress}
              correctionHistory={correctionHistory}
              doAnalyzeCorrections={doAnalyzeCorrections}
              doApplyCorrections={doApplyCorrections}
              doParseUploadedFile={doParseUploadedFile}
              fileParseLoading={fileParseLoading}
              uploadedFileName={uploadedFileName}
              setStage={setStage}
              onExportDocx={async (setLoading) => {
                setLoading(true);
                try {
                  await exportToDocx({ sections, content, info, displayOrder, appendicesText, titlePage, titlePageLines, methodInfo, commentAnalysis, orderId: currentIdRef.current, illustrations, clientDrawings });
                } catch (e) { alert("Помилка: " + e.message); }
                setLoading(false);
              }}
            />
          )}

        </div>
      </div>{/* end flex layout wrapper */}

      {/* Scroll arrows */}
      <div style={{ position: "fixed", right: 18, bottom: 24, zIndex: 999, display: "flex", flexDirection: "column", gap: 6 }}>
        {[{ dir: "↑", title: "Нагору", action: () => window.scrollTo({ top: 0, behavior: "smooth" }) },
        { dir: "↓", title: "Вниз", action: () => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }) }
        ].map(({ dir, title, action }) => (
          <button key={dir} onClick={action} title={title}
            style={{
              width: 38, height: 38, borderRadius: "50%",
              background: "#1a1a14", border: "1.5px solid #444",
              color: "#e8ff47", fontSize: 18, lineHeight: 1,
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", boxShadow: "0 2px 10px rgba(0,0,0,.25)",
              opacity: 0.85,
            }}
            onMouseEnter={e => e.currentTarget.style.opacity = "1"}
            onMouseLeave={e => e.currentTarget.style.opacity = "0.85"}
          >{dir}</button>
        ))}
      </div>

    </div>
  );
}
