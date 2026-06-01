import { useState, useRef, useEffect } from "react";
import mammoth from "mammoth";
import { db } from "./firebase";
import { useAuth } from "./AuthContext";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { callClaude, MODEL, MODEL_FAST } from "./lib/api.js";
import {
  SYS_JSON, SYS_JSON_ARRAY,
  buildFileCorrectionsAnalysisPrompt,
  buildFileApplyCorrectionPrompt,
  buildAnnotationCorrectionPrompt,
} from "./lib/prompts.js";
import { SpinDot } from "./components/SpinDot.jsx";
import { PhotoDropZone } from "./components/PhotoDropZone.jsx";

// ─────────────────────────────────────────────
// Кольори Word-виділень
// ─────────────────────────────────────────────
const HIGHLIGHT_COLORS = {
  yellow:      { ua: "жовте",         css: "#FEF08A", text: "#854D0E" },
  red:         { ua: "червоне",       css: "#FCA5A5", text: "#991B1B" },
  green:       { ua: "зелене",        css: "#86EFAC", text: "#166534" },
  cyan:        { ua: "блакитне",      css: "#A5F3FC", text: "#155E75" },
  magenta:     { ua: "рожеве",        css: "#F9A8D4", text: "#9D174D" },
  blue:        { ua: "синє",          css: "#BFDBFE", text: "#1E3A8A" },
  darkBlue:    { ua: "темно-синє",    css: "#3B82F6", text: "#fff" },
  darkCyan:    { ua: "бірюзове",      css: "#06B6D4", text: "#fff" },
  darkGreen:   { ua: "темно-зелене",  css: "#22C55E", text: "#fff" },
  darkMagenta: { ua: "фіолетове",     css: "#A855F7", text: "#fff" },
  darkRed:     { ua: "бордове",       css: "#EF4444", text: "#fff" },
  darkYellow:  { ua: "золоте",        css: "#EAB308", text: "#fff" },
  darkGray:    { ua: "сіре",          css: "#9CA3AF", text: "#fff" },
  lightGray:   { ua: "світло-сіре",   css: "#E5E7EB", text: "#374151" },
};

// ─────────────────────────────────────────────
// JSZip loader
// ─────────────────────────────────────────────
async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return window.JSZip;
}

// ─────────────────────────────────────────────
// Витяг виділень і коментарів з .docx
// ─────────────────────────────────────────────
async function extractAnnotations(arrayBuffer) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const docXmlRaw = await zip.file("word/document.xml")?.async("string");
  if (!docXmlRaw) return { highlights: [], comments: [] };

  let commentsXmlRaw = "";
  try { commentsXmlRaw = (await zip.file("word/comments.xml")?.async("string")) || ""; } catch { /**/ }

  const parser = new DOMParser();
  const docXml = parser.parseFromString(docXmlRaw, "text/xml");

  // ── Коментарі ──
  const commentMap = {};
  if (commentsXmlRaw) {
    const commentsXml = parser.parseFromString(commentsXmlRaw, "text/xml");
    const commentEls = commentsXml.getElementsByTagName("w:comment");
    for (const c of commentEls) {
      const id = c.getAttribute("w:id");
      const author = c.getAttribute("w:author") || "Автор";
      const tEls = c.getElementsByTagName("w:t");
      let text = "";
      for (const t of tEls) text += t.textContent + " ";
      commentMap[id] = { author, text: text.trim() };
    }
  }

  // ── Виділення (параграф за параграфом) ──
  const highlights = [];
  const paragraphs = docXml.getElementsByTagName("w:p");

  for (const para of paragraphs) {
    // Повний текст параграфу
    const allT = para.getElementsByTagName("w:t");
    let paraText = "";
    for (const t of allT) paraText += t.textContent;
    if (!paraText.trim()) continue;

    const runs = para.getElementsByTagName("w:r");
    let curColor = null;
    let curText = "";

    for (const run of runs) {
      const rPr = run.getElementsByTagName("w:rPr")[0];
      const highlightEl = rPr?.getElementsByTagName("w:highlight")[0];
      const color = highlightEl?.getAttribute("w:val");

      const tEls = run.getElementsByTagName("w:t");
      let runText = "";
      for (const t of tEls) runText += t.textContent;

      const isHighlighted = color && color !== "none" && color !== "white" && color !== "black";

      if (isHighlighted) {
        if (color === curColor) {
          curText += runText;
        } else {
          if (curText && curColor) {
            highlights.push({
              color: curColor,
              colorInfo: HIGHLIGHT_COLORS[curColor] || { ua: curColor, css: "#e5e7eb", text: "#374151" },
              text: curText.trim(),
              context: paraText.trim(),
            });
          }
          curColor = color;
          curText = runText;
        }
      } else {
        if (curText && curColor) {
          highlights.push({
            color: curColor,
            colorInfo: HIGHLIGHT_COLORS[curColor] || { ua: curColor, css: "#e5e7eb", text: "#374151" },
            text: curText.trim(),
            context: paraText.trim(),
          });
          curColor = null;
          curText = "";
        }
      }
    }
    if (curText && curColor) {
      highlights.push({
        color: curColor,
        colorInfo: HIGHLIGHT_COLORS[curColor] || { ua: curColor, css: "#e5e7eb", text: "#374151" },
        text: curText.trim(),
        context: paraText.trim(),
      });
    }
  }

  // ── Коментарі з прив'язкою до тексту ──
  const comments = [];
  if (Object.keys(commentMap).length > 0) {
    const commentStarts = docXml.getElementsByTagName("w:commentRangeStart");
    for (const startEl of commentStarts) {
      const id = startEl.getAttribute("w:id");
      const comment = commentMap[id];
      if (!comment) continue;

      // Витягуємо текст між commentRangeStart і commentRangeEnd через рядковий пошук
      const startMarker = `w:id="${id}"`;
      const endTag = `<w:commentRangeEnd`;
      let searchFrom = 0;
      let commentedText = "";

      while (searchFrom < docXmlRaw.length) {
        const sPos = docXmlRaw.indexOf("<w:commentRangeStart", searchFrom);
        if (sPos === -1) break;
        const idPos = docXmlRaw.indexOf(startMarker, sPos);
        const tagEnd = docXmlRaw.indexOf(">", sPos);
        if (idPos !== -1 && idPos < tagEnd) {
          const afterStart = tagEnd + 1;
          let ePos = afterStart;
          // Знаходимо commentRangeEnd з тим самим id
          while (ePos < docXmlRaw.length) {
            const candidateEnd = docXmlRaw.indexOf(endTag, ePos);
            if (candidateEnd === -1) { ePos = docXmlRaw.length; break; }
            const endIdPos = docXmlRaw.indexOf(startMarker, candidateEnd);
            const endTagEnd = docXmlRaw.indexOf(">", candidateEnd);
            if (endIdPos !== -1 && endIdPos < endTagEnd) { ePos = candidateEnd; break; }
            ePos = candidateEnd + 1;
          }
          if (ePos < docXmlRaw.length) {
            const between = docXmlRaw.slice(afterStart, ePos);
            const tMatches = [...between.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)];
            commentedText = tMatches.map(m => m[1]).join("").trim();
          }
          break;
        }
        searchFrom = sPos + 1;
      }

      if (commentedText || comment.text) {
        comments.push({
          id,
          author: comment.author,
          instruction: comment.text,
          commentedText: commentedText || "(текст не визначено)",
        });
      }
    }
  }

  return { highlights, comments };
}

// ─────────────────────────────────────────────
// Конвертація анотацій → tasks
// ─────────────────────────────────────────────
function annotationsToTasks(annotations) {
  const tasks = [];
  annotations.highlights.forEach((h, i) => {
    tasks.push({
      id: `h_${i}`,
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
      type: "comment",
      colorInfo: null,
      label: `Коментар: ${c.author}`,
      annotatedText: c.commentedText,
      context: null,
      instruction: c.instruction,
    });
  });
  return tasks;
}

// ─────────────────────────────────────────────
// Покращений експорт .docx
// ─────────────────────────────────────────────
async function exportCorrectedDocx(text, originalName) {
  if (!window.docx) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js";
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  const { Document, Packer, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell, WidthType, BorderStyle, Header, PageNumber } = window.docx;
  const FONT = "Times New Roman", SIZE = 28, LINE = 360, INDENT = 709;

  const TABLE_RE = /^\s*\|/;
  const LIST_RE = /^[–—-]\s+/;

  // Висновки до розділу / chapter conclusions — підзаголовок без нової сторінки
  const CHAPTER_CONCL_RE = /^(висновки до |podsumowanie rozdzia|fazit zu kapitel|conclusiones del cap)/i;
  // Підрозділи типу "1.1", "2.3.1" — підзаголовок без нової сторінки
  const SUBSECTION_RE = /^\d+\.\d+/;
  // Великі розділи — нова сторінка
  const MAJOR_RE = /^(ЗМІСТ|ВСТУП|ВИСНОВКИ|СПИСОК|ДОДАТКИ|РОЗДІЛ|INTRODUCTION|CHAPTER|CONCLUSIONS|REFERENCES|APPENDIX|BIBLIOGRAPHY|CONTENTS|ROZDZIAŁ|WSTĘP|WNIOSKI|ZAKOŃCZENIE|PODSUMOWANIE|BIBLIOGRAFIA|SPIS|CAPÍTULO|INTRODUCCIÓN|CONCLUSIONES|BIBLIOGRAFÍA|REFERENCIAS|APÉNDICE|KAPITEL|EINLEITUNG|FAZIT|SCHLUSSFOLGERUNG|LITERATURVERZEICHNIS|ANHANG|INHALTSVERZEICHNIS|KAPITOLA|ÚVOD|ZÁVĚR|SEZNAM|PŘÍLOHY|ZÁVER|ZOZNAM|PRÍLOHY|第|绪论|结论|参考文献|附录|目录)/i;

  function classifyLine(t) {
    if (CHAPTER_CONCL_RE.test(t)) return "subsection";   // висновки до розділу
    if (SUBSECTION_RE.test(t))    return "subsection";   // 1.1 Назва
    if (MAJOR_RE.test(t))         return "major";        // РОЗДІЛ, ВСТУП тощо
    return "body";
  }

  function makeTableFromLines(lines) {
    const filtered = lines.filter(l => !/^\s*\|[-:|\s]+\|\s*$/.test(l));
    if (!filtered.length) return null;
    const rows = filtered.map((l, ri) => {
      const cells = l.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
      return new TableRow({
        children: cells.map(cellText => new TableCell({
          borders: { top: { style: BorderStyle.SINGLE, size: 1 }, bottom: { style: BorderStyle.SINGLE, size: 1 }, left: { style: BorderStyle.SINGLE, size: 1 }, right: { style: BorderStyle.SINGLE, size: 1 } },
          margins: { left: 57, right: 57, top: 57, bottom: 57 },
          children: [new Paragraph({
            alignment: ri === 0 ? AlignmentType.CENTER : AlignmentType.LEFT,
            spacing: { line: 240, lineRule: "exact", before: 0, after: 0 },
            children: [new TextRun({ text: cellText, font: FONT, size: 24, bold: ri === 0 })],
          })],
        })),
      });
    });
    return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
  }

  // Ключові слова вступу що потребують жирного початку
  const INTRO_BOLD_RE = /^(Актуальн|Мет(?:ою|а[\s.])|Завдання|Для досягн|Для вирішен|Об['']?єкт|Предмет|Метод(?:и|ологічн)|Наукова новизна|Практична знач|Апробац|Структур|Теоретико|Матеріал|Хронологічн)/i;

  function makeIntroBoldPara(t) {
    let boldEnd = -1;
    const colon = t.indexOf(":");
    if (colon > 0 && colon < 120) { boldEnd = colon + 1; }
    else {
      const dash = t.search(/ [–—-] /);
      if (dash > 0 && dash < 80) { boldEnd = dash + 2; }
      else {
        const dot = t.indexOf(".");
        if (dot > 0 && dot < 50) { boldEnd = dot + 1; }
      }
    }
    if (boldEnd <= 0) {
      return new Paragraph({
        indent: { firstLine: INDENT }, spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
        alignment: AlignmentType.BOTH,
        children: [new TextRun({ text: t, font: FONT, size: SIZE })],
      });
    }
    return new Paragraph({
      indent: { firstLine: INDENT }, spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.BOTH,
      children: [
        new TextRun({ text: t.slice(0, boldEnd), font: FONT, size: SIZE, bold: true }),
        new TextRun({ text: t.slice(boldEnd), font: FONT, size: SIZE }),
      ],
    });
  }

  const docChildren = [];
  const lines = text.split("\n");
  let inIntro = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (TABLE_RE.test(line)) {
      const tableLines = [];
      while (i < lines.length && TABLE_RE.test(lines[i])) { tableLines.push(lines[i]); i++; }
      const tbl = makeTableFromLines(tableLines);
      if (tbl) {
        docChildren.push(tbl);
        docChildren.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
      }
      continue;
    }

    if (!trimmed) { i++; continue; }

    const kind = classifyLine(trimmed);
    const isList = LIST_RE.test(trimmed);

    if (kind === "major") {
      // Відстежуємо чи ми у вступі
      inIntro = /^(ВСТУП|INTRODUCTION|WSTĘP|ÚVOD|EINLEITUNG|INTRODUCCIÓN|绪论)$/i.test(trimmed);
      docChildren.push(new Paragraph({
        pageBreakBefore: docChildren.length > 0,
        alignment: AlignmentType.CENTER,
        spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.3) },
        indent: { firstLine: 0 },
        children: [new TextRun({ text: trimmed, font: FONT, size: SIZE, bold: true })],
      }));
    } else if (kind === "subsection") {
      inIntro = false;
      docChildren.push(new Paragraph({
        alignment: AlignmentType.BOTH,
        spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE * 0.3), after: Math.round(LINE * 0.2) },
        indent: { firstLine: INDENT },
        children: [new TextRun({ text: trimmed, font: FONT, size: SIZE, bold: true })],
      }));
    } else if (isList) {
      docChildren.push(new Paragraph({
        indent: { left: INDENT, hanging: 360 },
        spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
        alignment: AlignmentType.BOTH,
        children: [new TextRun({ text: trimmed, font: FONT, size: SIZE })],
      }));
    } else if (inIntro && INTRO_BOLD_RE.test(trimmed)) {
      // Абзаци вступу з жирним початком: "Мета дослідження –", "Актуальність теми." тощо
      docChildren.push(makeIntroBoldPara(trimmed));
    } else {
      docChildren.push(new Paragraph({
        alignment: AlignmentType.BOTH,
        spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
        indent: { firstLine: INDENT },
        children: [new TextRun({ text: trimmed, font: FONT, size: SIZE })],
      }));
    }
    i++;
  }

  const doc = new Document({
    sections: [{
      properties: {
        page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1701, right: 851 } },
        pageNumberStart: 1, titlePage: true,
      },
      headers: {
        first: new Header({ children: [] }),
        default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 0 }, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 24 })] })] }),
      },
      children: docChildren,
    }],
  });

  const blob = await Packer.toBlob(doc);
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
function StepBar({ current, mode }) {
  const STEPS = mode === "A"
    ? ["Файл", "Виділення", "Виправлення", "Готово"]
    : ["Файл", "Зауваження", "Виправлення", "Готово"];
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
// Головний компонент
// ─────────────────────────────────────────────
export default function FileCorrectionsPage({ onBack }) {
  const { user } = useAuth();

  // Режим: null = не обрано, "A" = виділення+коментарі, "B" = ручні зауваження
  const [mode, setMode] = useState(null);
  const [step, setStep] = useState(0);

  // Файл
  const [fileName, setFileName] = useState("");
  const [docText, setDocText] = useState("");
  const [storedBuffer, setStoredBuffer] = useState(null);
  const [fileLoading, setFileLoading] = useState(false);
  const fileRef = useRef();

  // Режим А
  const [extractLoading, setExtractLoading] = useState(false);
  const [annotations, setAnnotations] = useState({ highlights: [], comments: [] });
  const [tasksA, setTasksA] = useState([]);

  // Режим Б
  const [correctionsText, setCorrectionsText] = useState("");
  const [correctionPhotos, setCorrectionPhotos] = useState([]);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [tasksB, setTasksB] = useState([]);

  // Спільне (кроки 2-3)
  const [checked, setChecked] = useState({});
  const [applyLoading, setApplyLoading] = useState(false);
  const [applyProgress, setApplyProgress] = useState(0);
  const [currentDocText, setCurrentDocText] = useState("");
  const [correctedText, setCorrectedText] = useState("");
  const [error, setError] = useState("");

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

  const activeTasks = mode === "A" ? tasksA : tasksB;
  const checkedCount = Object.values(checked).filter(Boolean).length;

  // ── Обрати режим ──
  function selectMode(m) {
    setMode(m);
    setError("");
  }

  // ── Завантаження файлу ──
  async function handleFile(file) {
    if (!file) return;
    setFileLoading(true);
    setError("");
    try {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      const text = result.value.trim();
      if (!text) throw new Error("Не вдалося витягти текст з документа");
      setFileName(file.name);
      setDocText(text);
      setCurrentDocText(text);
      setStoredBuffer(arrayBuffer);

      if (mode === "A") {
        // Одразу витягуємо анотації
        await doExtract(arrayBuffer, text);
      } else {
        setStep(1);
      }
    } catch (e) {
      setError("Помилка читання файлу: " + e.message);
    }
    setFileLoading(false);
  }

  // ── Витяг анотацій (режим А) ──
  async function doExtract(buffer, text) {
    setExtractLoading(true);
    setError("");
    try {
      const result = await extractAnnotations(buffer);
      setAnnotations(result);
      const tasks = annotationsToTasks(result);
      if (tasks.length === 0) {
        setError("У файлі не знайдено виділень або коментарів. Спробуйте Варіант Б — введіть зауваження вручну.");
        setExtractLoading(false);
        return;
      }
      const defaultChecked = {};
      tasks.forEach(t => { defaultChecked[t.id] = true; });
      setTasksA(tasks);
      setChecked(defaultChecked);
      setStep(1);
    } catch (e) {
      setError("Помилка читання виділень: " + e.message);
    }
    setExtractLoading(false);
  }

  // ── Аналіз зауважень (режим Б) ──
  async function doAnalyze() {
    if (!correctionsText.trim() && correctionPhotos.length === 0) return;
    setAnalysisLoading(true);
    setError("");
    setTasksB([]);
    setChecked({});
    try {
      const prompt = buildFileCorrectionsAnalysisPrompt({ documentText: docText, correctionsText });
      const imageContent = correctionPhotos.map(p => ({ type: "image", source: { type: "base64", media_type: p.type, data: p.b64 } }));
      const userContent = imageContent.length ? [...imageContent, { type: "text", text: prompt }] : prompt;
      const raw = await callClaude([{ role: "user", content: userContent }], null, SYS_JSON_ARRAY, 2000, null, MODEL_FAST);
      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
      if (!Array.isArray(parsed)) throw new Error("Некоректна відповідь");
      const defaultChecked = {};
      parsed.forEach(t => { defaultChecked[t.id] = true; });
      setTasksB(parsed);
      setChecked(defaultChecked);
      setStep(2);
    } catch (e) {
      setError("Помилка аналізу: " + e.message);
    }
    setAnalysisLoading(false);
  }

  // ── Застосування виправлень ──
  async function doApply() {
    const toFix = activeTasks.filter(t => checked[t.id] !== false);
    if (!toFix.length) return;
    setApplyLoading(true);
    setApplyProgress(0);
    setError("");
    let text = currentDocText;
    try {
      for (let i = 0; i < toFix.length; i++) {
        const task = toFix[i];
        let prompt;
        if (mode === "A") {
          prompt = buildAnnotationCorrectionPrompt({
            documentText: text,
            annotatedText: task.annotatedText,
            context: task.context,
            instruction: task.instruction,
          });
        } else {
          prompt = buildFileApplyCorrectionPrompt({
            documentText: text,
            location: task.location,
            issue: task.issue,
            suggestion: task.suggestion,
          });
        }
        const result = await callClaude([{ role: "user", content: prompt }], null, SYS_JSON, 10000, null, MODEL);
        try {
          const { original, replacement } = JSON.parse(result.replace(/```json|```/g, "").trim());
          if (original && text.includes(original)) {
            text = text.replace(original, replacement || "");
          }
        } catch { /* пропускаємо якщо не розпарсилось */ }
        setApplyProgress(i + 1);
      }
      setCorrectedText(text);
      setCurrentDocText(text);
      setStep(3);
      try {
        const acc = tokenAccRef.current;
        await addDoc(collection(db, "orders"), {
          mode: "file_corrections", type: "file_corrections",
          topic: `Правки: ${fileName}`, uid: user?.uid || null,
          createdAt: new Date().toISOString(), timestamp: serverTimestamp(),
          fileName, correctionsApplied: toFix.length,
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
    activeTasks.forEach(t => { next[t.id] = val; });
    setChecked(next);
  }

  function reset() {
    setMode(null); setStep(0); setFileName(""); setDocText(""); setStoredBuffer(null);
    setAnnotations({ highlights: [], comments: [] }); setTasksA([]); setTasksB([]);
    setChecked({}); setCorrectionsText(""); setCorrectionPhotos([]);
    setCorrectedText(""); setCurrentDocText(""); setError("");
    setApplyProgress(0);
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
            if (!mode) { onBack(); return; }
            if (step === 0) { setMode(null); setError(""); return; }
            if (step === 1) { setStep(0); setTasksA([]); setAnnotations({ highlights: [], comments: [] }); return; }
            if (step === 2) { setStep(mode === "A" ? 1 : 1); setApplyProgress(0); return; }
            if (step === 3) { setStep(mode === "A" ? 1 : 2); setCorrectedText(""); setCurrentDocText(docText); setApplyProgress(0); }
          }}
          style={{ background: "none", border: "none", color: "#888", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: 4 }}
        >←</button>
        <div style={{ color: "#e8ff47", fontFamily: "'Spectral SC',serif", fontSize: 14, letterSpacing: 3 }}>ПРАВКИ ДО ФАЙЛУ</div>
        {sessionCost > 0 && <div style={{ marginLeft: "auto", fontSize: 11, color: "#888", fontFamily: "monospace" }}>сесія: ${sessionCost.toFixed(4)}</div>}
      </div>

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "28px 20px 0" }}>
        {mode && <StepBar current={step} mode={mode} />}

        {error && (
          <div style={{ background: "#fff0f0", border: "1.5px solid #f00a", borderRadius: 8, padding: "10px 16px", marginBottom: 14, fontSize: 13, color: "#c00" }}>
            {error}
            {error.includes("не знайдено виділень") && (
              <button onClick={() => { setMode("B"); setError(""); setStep(1); }} style={{ marginLeft: 12, fontSize: 12, color: "#1a1a14", background: "#e8ff47", border: "none", borderRadius: 4, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit" }}>
                Перейти до Варіанту Б
              </button>
            )}
          </div>
        )}

        {/* ═══ КРОК 0: Вибір режиму + завантаження ═══ */}
        {step === 0 && (
          <>
            {/* Вибір режиму */}
            {!mode && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, color: "#666", marginBottom: 16, textAlign: "center" }}>
                  Оберіть як внесено правки у вашому файлі:
                </div>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                  {/* Варіант А */}
                  <button
                    onClick={() => selectMode("A")}
                    style={{ flex: 1, minWidth: 220, background: "#1a1a14", border: "2px solid #333", borderRadius: 10, padding: "20px 18px", cursor: "pointer", textAlign: "left", fontFamily: "'Spectral',serif", transition: "border-color 0.15s" }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = "#e8ff47"}
                    onMouseLeave={e => e.currentTarget.style.borderColor = "#333"}
                  >
                    <div style={{ fontSize: 24, marginBottom: 8 }}>🎨</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#e8ff47", marginBottom: 6 }}>Варіант А</div>
                    <div style={{ fontSize: 12, color: "#c8c4bc", lineHeight: 1.6 }}>
                      Файл з кольоровими виділеннями або коментарями керівника
                    </div>
                    <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {["жовте", "червоне", "фіолетове"].map(c => (
                        <span key={c} style={{ fontSize: 10, background: "#2a2a1e", color: "#aaa", borderRadius: 3, padding: "2px 6px" }}>{c}</span>
                      ))}
                      <span style={{ fontSize: 10, background: "#2a2a1e", color: "#aaa", borderRadius: 3, padding: "2px 6px" }}>💬 коментарі</span>
                    </div>
                  </button>

                  {/* Варіант Б */}
                  <button
                    onClick={() => selectMode("B")}
                    style={{ flex: 1, minWidth: 220, background: "#1a1a14", border: "2px solid #333", borderRadius: 10, padding: "20px 18px", cursor: "pointer", textAlign: "left", fontFamily: "'Spectral',serif", transition: "border-color 0.15s" }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = "#a8e060"}
                    onMouseLeave={e => e.currentTarget.style.borderColor = "#333"}
                  >
                    <div style={{ fontSize: 24, marginBottom: 8 }}>✏️</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#a8e060", marginBottom: 6 }}>Варіант Б</div>
                    <div style={{ fontSize: 12, color: "#c8c4bc", lineHeight: 1.6 }}>
                      Введу зауваження вручну або завантажу фото правок від керівника
                    </div>
                    <div style={{ marginTop: 10, display: "flex", gap: 4 }}>
                      <span style={{ fontSize: 10, background: "#2a2a1e", color: "#aaa", borderRadius: 3, padding: "2px 6px" }}>текст</span>
                      <span style={{ fontSize: 10, background: "#2a2a1e", color: "#aaa", borderRadius: 3, padding: "2px 6px" }}>📷 фото</span>
                    </div>
                  </button>
                </div>
              </div>
            )}

            {/* Завантаження файлу */}
            {mode && (
              <div style={cardStyle}>
                <div style={cardHead()}>
                  <div style={dot(mode === "A" ? "#e8ff47" : "#a8e060")} />
                  <div style={labelStyle}>
                    {mode === "A" ? "Завантажте файл з виділеннями або коментарями" : "Завантажте вашу роботу (.docx)"}
                  </div>
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
                        {mode === "A" && <div style={{ fontSize: 11, color: "#aaa" }}>Файл має містити кольорові виділення або коментарі Word</div>}
                      </>
                    }
                  </div>
                  <input ref={fileRef} type="file" accept=".docx" style={{ display: "none" }} onChange={e => handleFile(e.target.files[0])} />
                </div>
              </div>
            )}

            {mode && (
              <button onClick={() => { setMode(null); setError(""); }} style={{ background: "none", border: "none", color: "#aaa", fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: "4px 0" }}>
                ← Змінити варіант
              </button>
            )}
          </>
        )}

        {/* ═══ КРОК 1А: Список виділень і коментарів ═══ */}
        {step === 1 && mode === "A" && (
          <>
            {/* Файл */}
            <div style={{ ...cardStyle, marginBottom: 14 }}>
              <div style={cardHead("#1a2a00")}>
                <div style={dot("#a8e060")} />
                <div style={labelStyle}>Файл завантажено</div>
                <div style={{ marginLeft: "auto", fontSize: 11, color: "#a8e060" }}>{fileName}</div>
              </div>
            </div>

            {/* Знайдені анотації */}
            <div style={{ ...cardStyle, border: "1.5px solid #4a6a00" }}>
              <div style={{ ...cardHead("#1a2a00"), justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={dot("#a8e060")} />
                  <div style={labelStyle}>
                    Знайдено: {annotations.highlights.length} виділень, {annotations.comments.length} коментарів
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => toggleAll(true)} style={{ fontSize: 10, color: "#a8e060", background: "transparent", border: "1px solid #4a6a00", borderRadius: 4, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Всі</button>
                  <button onClick={() => toggleAll(false)} style={{ fontSize: 10, color: "#888", background: "transparent", border: "1px solid #444", borderRadius: 4, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Жоден</button>
                </div>
              </div>
              <div style={{ background: "#faf8f3" }}>
                {tasksA.map((task, i) => {
                  const isChecked = checked[task.id] !== false;
                  return (
                    <div key={task.id} style={{ padding: "12px 16px", borderBottom: i < tasksA.length - 1 ? "1px solid #e8e4dc" : "none", display: "flex", gap: 12, alignItems: "flex-start", opacity: isChecked ? 1 : 0.4 }}>
                      <input type="checkbox" checked={isChecked} onChange={e => setChecked(prev => ({ ...prev, [task.id]: e.target.checked }))} style={{ marginTop: 3, accentColor: "#6a9000", flexShrink: 0, cursor: "pointer" }} />
                      <div style={{ flex: 1 }}>
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
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ padding: "12px 16px", background: "#1a2a00", display: "flex", gap: 10, alignItems: "center" }}>
                <button onClick={() => { setStep(2); }} disabled={checkedCount === 0} style={btnGreen(checkedCount === 0)}>
                  Виправити обрані ({checkedCount}) →
                </button>
              </div>
            </div>

            <button onClick={() => { setStep(0); setTasksA([]); setAnnotations({ highlights: [], comments: [] }); }} style={{ background: "none", border: "none", color: "#aaa", fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: "4px 0" }}>
              ← Завантажити інший файл
            </button>
          </>
        )}

        {/* ═══ КРОК 1Б: Введення зауважень ═══ */}
        {step === 1 && mode === "B" && (
          <>
            <div style={{ ...cardStyle, marginBottom: 14 }}>
              <div style={cardHead("#1a2a00")}>
                <div style={dot("#a8e060")} />
                <div style={labelStyle}>Файл завантажено</div>
                <div style={{ marginLeft: "auto", fontSize: 11, color: "#a8e060" }}>{fileName}</div>
              </div>
              <div style={{ ...cardBody, maxHeight: 140, overflowY: "auto" }}>
                <pre style={{ fontSize: 11, color: "#555", whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit", lineHeight: 1.7 }}>
                  {docText.slice(0, 500)}{docText.length > 500 ? "\n..." : ""}
                </pre>
              </div>
            </div>

            <div style={cardStyle}>
              <div style={cardHead()}>
                <div style={dot("#e8ff47")} />
                <div style={labelStyle}>Зауваження викладача</div>
              </div>
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
                    {analysisLoading ? <><SpinDot />Аналізую...</> : "Проаналізувати →"}
                  </button>
                  {analysisLoading && <span style={{ fontSize: 12, color: "#888" }}>Claude визначає що потрібно виправити</span>}
                </div>
              </div>
            </div>

            <button onClick={() => setStep(0)} style={{ background: "none", border: "none", color: "#aaa", fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: "4px 0" }}>
              ← Завантажити інший файл
            </button>
          </>
        )}

        {/* ═══ КРОК 2: Підтвердження та виконання (режим Б) ═══ */}
        {step === 2 && mode === "B" && (
          <>
            <div style={{ ...cardStyle, border: "1.5px solid #4a6a00" }}>
              <div style={{ ...cardHead("#1a2a00"), justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={dot("#a8e060")} />
                  <div style={labelStyle}>Що потрібно виправити ({tasksB.length})</div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => toggleAll(true)} style={{ fontSize: 10, color: "#a8e060", background: "transparent", border: "1px solid #4a6a00", borderRadius: 4, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Всі</button>
                  <button onClick={() => toggleAll(false)} style={{ fontSize: 10, color: "#888", background: "transparent", border: "1px solid #444", borderRadius: 4, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>Жоден</button>
                </div>
              </div>
              <div style={{ background: "#faf8f3" }}>
                {tasksB.map((task, i) => {
                  const isChecked = checked[task.id] !== false;
                  return (
                    <div key={i} style={{ padding: "12px 16px", borderBottom: i < tasksB.length - 1 ? "1px solid #e8e4dc" : "none", display: "flex", gap: 12, alignItems: "flex-start", opacity: isChecked ? 1 : 0.45 }}>
                      <input type="checkbox" checked={isChecked} onChange={e => setChecked(prev => ({ ...prev, [task.id]: e.target.checked }))} style={{ marginTop: 3, accentColor: "#6a9000", flexShrink: 0, cursor: "pointer" }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 11, color: "#888", marginBottom: 3, textTransform: "uppercase", letterSpacing: 0.5 }}>{task.location}</div>
                        <div style={{ fontSize: 13, color: "#c04020", marginBottom: 3 }}><span style={{ fontWeight: 600 }}>Проблема:</span> {task.issue}</div>
                        <div style={{ fontSize: 13, color: "#3a6010" }}><span style={{ fontWeight: 600 }}>Що зробити:</span> {task.suggestion}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ padding: "12px 16px", background: "#1a2a00", display: "flex", gap: 10, alignItems: "center" }}>
                <button onClick={doApply} disabled={applyLoading || checkedCount === 0} style={btnGreen(applyLoading || checkedCount === 0)}>
                  {applyLoading ? <><SpinDot light />Виправляю ({applyProgress}/{tasksB.filter(t => checked[t.id] !== false).length})...</> : `Виконати обрані (${checkedCount}) →`}
                </button>
                {applyLoading && <span style={{ fontSize: 12, color: "#6a9000" }}>Claude застосовує виправлення</span>}
              </div>
            </div>
            <button onClick={() => setStep(1)} style={{ background: "none", border: "none", color: "#aaa", fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: "4px 0" }}>
              ← Змінити зауваження
            </button>
          </>
        )}

        {/* ═══ КРОК 2: Виправлення (режим А — ті самі tasks з кроку 1) ═══ */}
        {step === 2 && mode === "A" && (
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
            <button onClick={() => setStep(1)} style={{ background: "none", border: "none", color: "#aaa", fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: "4px 0" }}>
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
                <div style={labelStyle}>Виправлення внесено</div>
              </div>
              <div style={{ ...cardBody, maxHeight: 300, overflowY: "auto" }}>
                <pre style={{ fontSize: 12, color: "#333", whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit", lineHeight: 1.7 }}>
                  {correctedText.slice(0, 1200)}{correctedText.length > 1200 ? "\n\n...[решта документа]" : ""}
                </pre>
              </div>
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <button onClick={() => exportCorrectedDocx(correctedText, fileName)} style={btnGreen(false)}>
                Завантажити виправлений .docx
              </button>
              <button
                onClick={() => { setStep(mode === "A" ? 1 : 1); setApplyProgress(0); setCorrectedText(""); setCurrentDocText(docText); }}
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
