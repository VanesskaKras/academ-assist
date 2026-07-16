// ─────────────────────────────────────────────
// shared.js — утиліти спільні для small-works (docx export, стилі, парсинг)
// Логіка API, промпти, компоненти — в lib/ та components/
// ─────────────────────────────────────────────
import { renderPlantUmlToPng } from "./lib/exportDocx.js";

const PLANTUML_FENCE_RE = /^\s*```\s*plantuml\s*$/i;
const FENCE_END_RE = /^\s*```\s*$/;

// Замінює кожен ```plantuml``` fence-блок у тексті на маркер \x00DIAGRAM<i>\x00 і
// рендерить відповідні PNG паралельно (та сама логіка, що й для великих робіт).
async function resolvePlantUmlInSections(sections) {
  const diagramImages = [];
  const jobs = [];
  const updated = sections.map(sec => {
    if (!sec.text) return sec;
    const lines = sec.text.split("\n");
    const outLines = [];
    let changed = false;
    let i = 0;
    while (i < lines.length) {
      if (PLANTUML_FENCE_RE.test(lines[i])) {
        const codeLines = [];
        let j = i + 1;
        while (j < lines.length && !FENCE_END_RE.test(lines[j])) { codeLines.push(lines[j]); j++; }
        if (j < lines.length) j++; // пропускаємо закриваючу ```
        const idx = diagramImages.length;
        diagramImages.push(null);
        jobs.push(renderPlantUmlToPng(codeLines.join("\n")).then(img => { diagramImages[idx] = img; }));
        outLines.push(`\x00DIAGRAM${idx}\x00`);
        i = j;
        changed = true;
        continue;
      }
      outLines.push(lines[i]);
      i++;
    }
    return changed ? { ...sec, text: outLines.join("\n") } : sec;
  });
  await Promise.all(jobs);
  return { sections: updated, diagramImages };
}

// ── Парсинг сторінок ──
// Дефолт 20 — для малих робіт (реферат, тези, есе). Велика версія в lib/planUtils.js має дефолт 80.
export function parsePagesAvg(str) {
  if (!str) return 20;
  const nums = String(str).match(/\d+/g);
  if (!nums) return 20;
  if (nums.length === 1) return parseInt(nums[0]);
  return Math.round(nums.reduce((a, b) => a + parseInt(b), 0) / nums.length);
}

// ── Simple docx export для малих робіт (плоский текст без підрозділів) ──
export async function exportSimpleDocx({ title, sections, info, citations, orderId, methodInfo, commentAnalysis }) {
  if (!window.docx) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js";
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  const { Document, Packer, Paragraph, TextRun, AlignmentType, PageNumber, Header, HeadingLevel, ExternalHyperlink, InternalHyperlink, Bookmark, FootnoteReferenceRun, ImageRun, Table, TableRow, TableCell, WidthType, BorderStyle } = window.docx;
  const { sections: resolvedSections, diagramImages } = await resolvePlantUmlInSections(sections);
  sections = resolvedSections;
  const FONT = "Times New Roman", SIZE = 28, SIZE_NUM = 24;
  const mmToTwip = mm => Math.round(mm * 1440 / 25.4);
  const marg = methodInfo?.formatting?.margins || commentAnalysis?.formattingHints?.margins || {};
  const toMm = v => (v != null && Number(v) > 0 ? Number(v) : null);
  const L = mmToTwip(toMm(marg.left)   ?? 30);
  const R = mmToTwip(toMm(marg.right)  ?? 15);
  const T = mmToTwip(toMm(marg.top)    ?? 20);
  const B = mmToTwip(toMm(marg.bottom) ?? 20);
  const INDENT = 709, LINE = 360;

  const footnotesRegistry = {};
  let footnoteCounter = 0;
  const footnoteTextByNum = {};

  // [N] → внутрішнє гіперпосилання на закладку джерела; %%FN<n>%% → справжня Word-виноска
  function parseTextWithCitations(text, bold = false, italics = false) {
    const CITE_RE = /\[(\d+)\]|%%FN(\d+)%%/g;
    const result = [];
    let lastIndex = 0, match;
    while ((match = CITE_RE.exec(text)) !== null) {
      if (match.index > lastIndex)
        result.push(new TextRun({ text: text.slice(lastIndex, match.index), font: FONT, size: SIZE, bold, italics, color: "000000" }));
      if (match[2]) {
        footnoteCounter++;
        const fnText = footnoteTextByNum[Number(match[2])] || "";
        footnotesRegistry[footnoteCounter] = { children: [new Paragraph({ children: [new TextRun({ text: fnText, font: FONT, size: SIZE_NUM, color: "000000" })] })] };
        result.push(new TextRun({ children: [new FootnoteReferenceRun(footnoteCounter)], font: FONT, size: SIZE, bold, italics }));
      } else {
        result.push(new InternalHyperlink({
          anchor: `ref_${match[1]}`,
          children: [new TextRun({ text: match[0], font: FONT, size: SIZE, italics, color: "000000" })],
        }));
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length)
      result.push(new TextRun({ text: text.slice(lastIndex), font: FONT, size: SIZE, bold, italics, color: "000000" }));
    return result.length ? result : [new TextRun({ text, font: FONT, size: SIZE, bold, italics, color: "000000" })];
  }

  // **жирний** inline + [N] для абзаців тексту; italics — примусовий курсив для
  // цілого абзацу (анотація за методичкою оформлюється курсивом)
  function parseBodyLine(text, italics = false) {
    const BOLD_RE = /\*\*(.+?)\*\*/g;
    const parts = [];
    let last = 0, m;
    while ((m = BOLD_RE.exec(text)) !== null) {
      if (m.index > last) parts.push({ text: text.slice(last, m.index), bold: false });
      parts.push({ text: m[1], bold: true });
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ text: text.slice(last), bold: false });
    if (!parts.length) parts.push({ text, bold: false });
    // Одинарні "*" (курсив markdown) поза межами **жирного** — у звичайних абзацах
    // не підтримуються (на відміну від списку джерел), тож просто прибираємо їх,
    // а не лишаємо буквально в тексті.
    return parts.flatMap(p => parseTextWithCitations(
      p.bold ? p.text : p.text.replace(/\*(.+?)\*/g, "$1").replace(/\*/g, ""),
      p.bold, italics
    ));
  }

  // URL → зовнішній гіперлінк, *курсив* → курсив (для рядків джерел)
  function sourceParaChildren(text) {
    const URL_RE = /(https?:\/\/[^\s]+)/;
    return text.split(URL_RE).flatMap(part => {
      if (URL_RE.test(part)) {
        const cleanUrl = part.replace(/[.,;:!?)]+$/, "");
        const tail = part.slice(cleanUrl.length);
        const link = new ExternalHyperlink({
          link: cleanUrl,
          children: [new TextRun({ text: cleanUrl, font: FONT, size: SIZE, color: "0563C1", underline: {} })],
        });
        return tail ? [link, new TextRun({ text: tail, font: FONT, size: SIZE, color: "000000" })] : [link];
      }
      const runs = [];
      const italicRe = /\*([^*]+)\*/g;
      let last2 = 0, m2;
      while ((m2 = italicRe.exec(part)) !== null) {
        if (m2.index > last2) runs.push(new TextRun({ text: part.slice(last2, m2.index), font: FONT, size: SIZE, color: "000000" }));
        runs.push(new TextRun({ text: m2[1], font: FONT, size: SIZE, italics: true, color: "000000" }));
        last2 = m2.index + m2[0].length;
      }
      if (last2 < part.length) runs.push(new TextRun({ text: part.slice(last2), font: FONT, size: SIZE, color: "000000" }));
      return runs;
    });
  }

  function sourcePara(text) {
    const cleaned = text.replace(/\*\*(.+?)\*\*/g, "$1").trim();
    if (!cleaned) return null;
    return new Paragraph({
      spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.3) },
      alignment: AlignmentType.BOTH,
      indent: { firstLine: INDENT },
      children: sourceParaChildren(cleaned),
    });
  }

  function sourceParaWithBookmark(text, refNum) {
    const cleaned = text.replace(/\*\*(.+?)\*\*/g, "$1").trim();
    if (!cleaned) return null;
    const numMatch = cleaned.match(/^(\d+[\.\)]\s*)/);
    const children = numMatch
      ? [
          new Bookmark({ id: `ref_${refNum}`, children: [new TextRun({ text: numMatch[1], font: FONT, size: SIZE, color: "000000" })] }),
          ...sourceParaChildren(cleaned.slice(numMatch[1].length)),
        ]
      : sourceParaChildren(cleaned);
    return new Paragraph({
      spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.3) },
      alignment: AlignmentType.BOTH,
      indent: { firstLine: INDENT },
      children,
    });
  }

  const SOURCES_HEADER_RE = /^(список використаних джерел|список літератури|використані джерела|references?)\s*[:\.]?\s*$/i;
  const FIG_CAPTION_RE = /^рис\.?\s+\d/i;
  const FIG_INLINE_RE = /рис(?:унок)?\.?\s*\d+/i;
  const FIG_MARKER_RE = /^\[🔍 Рисунок \d+:/;
  const TABLE_CAPTION_RE = /^(таблиця|table)\s+\d/i;
  const SOURCE_CAPTION_RE = /^(джерело|source)\s*:/i;
  const ANOTATION_RE = /^(анотація|abstract|ключові слова|keywords)\s*[:.]/i;

  // ── Виноски (ДСТУ-режим): %%FN<n>%% у тексті → реальна Word-виноска ──
  // n → повний текст джерела, узятий з explicit citations або розпарсений зі списку джерел у тексті.
  if (citations && citations.length > 0) {
    citations.forEach((c, i) => { footnoteTextByNum[i + 1] = c; });
  } else {
    sections.forEach(sec => {
      if (!sec.text) return;
      let inSrc = false;
      sec.text.split("\n").forEach(line => {
        const cleaned = line.trim().replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");
        if (SOURCES_HEADER_RE.test(cleaned)) { inSrc = true; return; }
        if (!inSrc || !cleaned) return;
        const m = cleaned.match(/^(\d+)[.)]\s*(.*)/);
        if (m) footnoteTextByNum[parseInt(m[1])] = m[2];
      });
    });
  }

  function makeSimpleTableDocx(tableLines) {
    const border = { style: BorderStyle.SINGLE, size: 1, color: "000000" };
    const cellBorders = { top: border, bottom: border, left: border, right: border };
    const dataLines = tableLines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l));
    if (!dataLines.length) return null;
    const rows = dataLines.map((l, rowIdx) => {
      const cells = l.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
      const isHeader = rowIdx === 0;
      return new TableRow({
        children: cells.map(cellText => new TableCell({
          borders: cellBorders,
          margins: { left: 57, right: 57, top: 57, bottom: 57 },
          children: [new Paragraph({
            alignment: isHeader ? AlignmentType.CENTER : AlignmentType.LEFT,
            spacing: { line: 240, lineRule: "exact", before: 0, after: 0 },
            children: [new TextRun({ text: cellText, font: FONT, size: 24, color: "000000", bold: methodInfo ? isHeader : false })],
          })],
        })),
      });
    });
    return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
  }

  const children = [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    if (!sec.text) continue;
    if (i > 0) children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
    if (sec.label) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE },
        alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
        children: [new TextRun({ text: sec.label.toUpperCase(), font: FONT, size: SIZE, bold: true, color: "000000" })],
      }));
    }
    let inSources = false;
    let lastWasDiagram = false;
    const lines = sec.text.split("\n");
    let li = 0;
    while (li < lines.length) {
      const line = lines[li];
      const trimmed = line.trim();
      const trimmedClean = trimmed.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");
      const wasDiagram = lastWasDiagram;
      lastWasDiagram = false;

      // Маркери пошуку рисунків — не потрапляють у docx
      if (FIG_MARKER_RE.test(trimmed)) { li++; continue; }

      // PlantUML-діаграма, вже відрендерена в PNG — вставляємо як зображення
      if (trimmed.startsWith("\x00DIAGRAM") && trimmed.endsWith("\x00")) {
        const img = diagramImages[Number(trimmed.slice(8, -1))];
        if (img) {
          children.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            children: [new ImageRun({ data: img.data, transformation: { width: img.width, height: img.height } })],
          }));
          lastWasDiagram = true;
          li++; continue;
        }
        lastWasDiagram = false;
        li++; continue;
      }

      // Якщо citations передано явно — пропускаємо вбудований блок джерел з тексту
      if (citations !== undefined && SOURCES_HEADER_RE.test(trimmedClean)) { inSources = true; li++; continue; }
      if (citations !== undefined && inSources) { li++; continue; }

      // Підпис таблиці: "Таблиця N – Назва" — оформлення за methodInfo.formatting.tableFormat
      // (та сама логіка, що й для великих робіт): номер окремим рядком праворуч +
      // (центрована або жирна назва) → два рядки; інакше — один рядок.
      if (TABLE_CAPTION_RE.test(trimmedClean)) {
        const tfmt = methodInfo?.formatting || {};
        const tAlignRight = !!tfmt.tableNumberRight;
        const tCenter = !!tfmt.tableTitleCenter;
        const tBold = !!tfmt.tableTitleBold;
        const tTwoLine = tAlignRight && (tCenter || tBold);
        const dashIdx = trimmedClean.search(/ [–-] /);
        if (tTwoLine && dashIdx !== -1) {
          const numPart = trimmedClean.slice(0, dashIdx).trim();
          const namePart = trimmedClean.slice(dashIdx + 3).trim();
          children.push(new Paragraph({
            alignment: AlignmentType.RIGHT, indent: { firstLine: 0 },
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            children: [new TextRun({ text: numPart, font: FONT, size: SIZE, color: "000000" })],
          }));
          children.push(new Paragraph({
            alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
            spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE },
            children: [new TextRun({ text: namePart, font: FONT, size: SIZE, bold: tBold, color: "000000" })],
          }));
        } else {
          children.push(new Paragraph({
            alignment: tAlignRight ? AlignmentType.RIGHT : AlignmentType.BOTH,
            indent: { firstLine: tAlignRight ? 0 : INDENT },
            spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE },
            children: [new TextRun({ text: trimmedClean, font: FONT, size: SIZE, bold: tBold, color: "000000" })],
          }));
        }
        li++; continue;
      }

      // Таблиця markdown (рядки що починаються з |)
      if (/^\s*\|/.test(trimmed)) {
        const tableLines = [];
        while (li < lines.length && /^\s*\|/.test(lines[li].trim())) { tableLines.push(lines[li]); li++; }
        const tbl = makeSimpleTableDocx(tableLines);
        if (tbl) {
          children.push(tbl);
          // Якщо одразу під таблицею йде рядок "Джерело:" — без інтервалу перед ним
          // (за методичкою); інакше — стандартний відступ від наступного тексту.
          let peek = li;
          while (peek < lines.length && !lines[peek].trim()) peek++;
          const nextIsSourceCaption = peek < lines.length && SOURCE_CAPTION_RE.test(lines[peek].trim());
          if (!nextIsSourceCaption) {
            children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
          }
        }
        continue;
      }

      // Підпис джерела під таблицею: "Джерело: ..." — без відступу, дрібніший шрифт,
      // без інтервалу від таблиці вище.
      if (SOURCE_CAPTION_RE.test(trimmedClean)) {
        children.push(new Paragraph({
          indent: { firstLine: 0 },
          spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
          alignment: AlignmentType.LEFT,
          children: [new TextRun({ text: trimmedClean, font: FONT, size: SIZE_NUM, color: "000000" })],
        }));
        li++; continue;
      }

      // Підпис рисунку: "Рис. N — Назва" — жирний/курсив за methodInfo.formatting.figureFormat;
      // чорний, якщо зображення вище реально вставлено, інакше помаранчевий (потрібно вручну).
      if (FIG_CAPTION_RE.test(trimmed)) {
        const ff = methodInfo?.formatting?.figureFormat || "";
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
          spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.5) },
          children: [new TextRun({ text: trimmedClean, font: FONT, size: SIZE, bold: /жирн|bold/i.test(ff), italics: /курсив|italic/i.test(ff), color: wasDiagram ? "000000" : "B85C00" })],
        }));
        li++; continue;
      }

      // Заголовок списку джерел (парсинг з тексту — лише якщо citations не передано)
      if (SOURCES_HEADER_RE.test(trimmedClean)) {
        inSources = true;
        children.push(new Paragraph({
          spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE * 0.5) },
          alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
          children: [new TextRun({ text: trimmedClean.replace(/[:\.]$/, ""), font: FONT, size: SIZE, bold: true, color: "000000" })],
        }));
        li++; continue;
      }

      // Рядки списку джерел (парсинг з тексту)
      if (inSources) {
        if (!trimmed) { li++; continue; }
        const numMatch = trimmedClean.match(/^(\d+)[\.\)]/);
        const p = numMatch ? sourceParaWithBookmark(trimmed, parseInt(numMatch[1])) : sourcePara(trimmed);
        if (p) children.push(p);
        li++; continue;
      }

      // Звичайний абзац тексту
      const raw = trimmed.replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/, "");
      const plain = raw.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");
      if (!plain) { li++; continue; }
      const hasFig = FIG_INLINE_RE.test(plain);
      // Анотація/ключові слова (укр. і англ.) — курсивом, за методичкою.
      const isAnotation = ANOTATION_RE.test(plain);
      children.push(new Paragraph({
        indent: { firstLine: INDENT },
        spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
        alignment: AlignmentType.BOTH,
        children: hasFig
          ? [new TextRun({ text: plain, font: FONT, size: SIZE, color: "B85C00" })]
          : parseBodyLine(raw, isAnotation),
      }));
      li++;
    }
  }

  // Явний список джерел (для тез — передається tezyCitations)
  if (citations && citations.length > 0) {
    children.push(new Paragraph({
      spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE * 0.5) },
      alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
      children: [new TextRun({ text: "Список використаних джерел", font: FONT, size: SIZE, bold: true, color: "000000" })],
    }));
    citations.forEach((citation, idx) => {
      const refNum = idx + 1;
      const p = sourceParaWithBookmark(`${refNum}. ${citation}`, refNum);
      if (p) children.push(p);
    });
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: SIZE, color: "000000" }, paragraph: { spacing: { line: LINE, lineRule: "auto" } } } } },
    footnotes: footnoteCounter > 0 ? footnotesRegistry : undefined,
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: T, right: R, bottom: B, left: L } }, pageNumberStart: 1, titlePage: true },
      headers: {
        first: new Header({ children: [] }),
        default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 0 }, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: SIZE_NUM, color: "000000" })] })] }),
      },
      children,
    }],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    const prefix = info?.orderNumber ? info.orderNumber + "_" : (orderId ? orderId + "_" : "");
    const safeName = prefix + (info?.topic || title || "робота").replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
    a.href = url; a.download = safeName + ".docx";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── Загальні стилі ──
export const TA = { width: "100%", background: "#f0ece2", border: "1.5px solid #d4cfc4", borderRadius: 6, color: "#1a1a14", fontSize: 14, padding: "12px 14px", resize: "vertical", lineHeight: "1.75", fontFamily: "'Spectral',Georgia,serif" };
export const TA_WHITE = { ...TA, background: "#fff", fontSize: 13 };

// ── Загальні CSS анімації (вставляються один раз в компоненті) ──
export const SHARED_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,400;0,600;1,400&family=Spectral+SC:wght@600&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#ede9e0}::-webkit-scrollbar-thumb{background:#bbb4a0;border-radius:3px}
  @keyframes fd{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
  .fade{animation:fd .35s ease}
  button:not(:disabled):active{transform:scale(.98)}
  textarea:focus,input:focus{outline:none;border-color:#aaa49a}
`;
