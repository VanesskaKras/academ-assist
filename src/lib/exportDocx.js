// ─────────────────────────────────────────────
// Перенумерація таблиць і рисунків
// ─────────────────────────────────────────────
export function renumberTablesAndFigures(content, displayOrder) {
  function getChapter(sec) {
    if (!sec?.id) return null;
    const m = sec.id.match(/^(\d+)/);
    return m ? m[1] : null;
  }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  const chTableCount = {}, chFigCount = {};
  const secRenamings = {};

  for (const sec of displayOrder) {
    const txt = content[sec.id];
    if (!txt) continue;
    const ch = getChapter(sec);
    if (!ch) continue;
    chTableCount[ch] = chTableCount[ch] || 0;
    chFigCount[ch]   = chFigCount[ch]   || 0;
    secRenamings[sec.id] = [];

    let m;
    const tableRe = /^Таблиця\s+(\d+\.\d+)/gm;
    while ((m = tableRe.exec(txt)) !== null) {
      chTableCount[ch]++;
      secRenamings[sec.id].push({ oldRef: m[1], newRef: `${ch}.${chTableCount[ch]}`, type: "table" });
    }
    const figRe = /^Рис\.\s+(\d+\.\d+)/gm;
    while ((m = figRe.exec(txt)) !== null) {
      chFigCount[ch]++;
      secRenamings[sec.id].push({ oldRef: m[1], newRef: `${ch}.${chFigCount[ch]}`, type: "fig" });
    }
  }

  const updated = { ...content };
  for (const sec of displayOrder) {
    let txt = content[sec.id];
    if (!txt) continue;
    const renamings = (secRenamings[sec.id] || []).filter(r => r.oldRef !== r.newRef);
    if (!renamings.length) continue;

    let tokI = 0;
    const tokMap = new Map();

    for (const { oldRef, newRef, type } of renamings) {
      const tok = `\x00T${tokI++}\x00`;
      tokMap.set(tok, newRef);
      if (type === "table") {
        txt = txt.replace(new RegExp(`(^Таблиця\\s+)${escRe(oldRef)}`, "m"), `$1${tok}`);
        txt = txt.replace(new RegExp(`(Таблиц[яіюю]\\s+)${escRe(oldRef)}(?!\\d)`, "g"), `$1${tok}`);
      } else {
        txt = txt.replace(new RegExp(`(^Рис\\.\\s+)${escRe(oldRef)}`, "m"), `$1${tok}`);
        txt = txt.replace(new RegExp(`(Рис\\.\\s+)${escRe(oldRef)}(?!\\d)`, "gi"), `$1${tok}`);
      }
    }

    for (const [tok, newRef] of tokMap) {
      txt = txt.replaceAll(tok, newRef);
    }
    updated[sec.id] = txt;
  }
  return updated;
}

// ─────────────────────────────────────────────
// Word export (основний документ)
// ─────────────────────────────────────────────
export async function exportToDocx({ content, info, displayOrder, appendicesText, titlePage, titlePageLines, methodInfo }) {
  if (!window.docx) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js";
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  const numberedContent = renumberTablesAndFigures(content, displayOrder);

  const { Document, Packer, Paragraph, TextRun, AlignmentType, PageNumber, Header, HeadingLevel, TableOfContents, Table, TableRow, TableCell, WidthType, BorderStyle, ExternalHyperlink, InternalHyperlink, Bookmark } = window.docx;
  const FONT = "Times New Roman", SIZE = 28, SIZE_NUM = 24;
  const mmToTwip = mm => Math.round(mm * 1440 / 25.4);
  const marg = methodInfo?.formatting?.margins || {};
  const L = mmToTwip(marg.left   || 30);
  const R = mmToTwip(marg.right  || 15);
  const T = mmToTwip(marg.top    || 20);
  const B = mmToTwip(marg.bottom || 20);
  const INDENT = 709, LINE = 360;
  const LINE_SINGLE = 240;

  function cleanMarkdown(line) {
    return line.replace(/^#{1,6}\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1").replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim();
  }
  function isDuplicateTitle(firstLine, secLabel) {
    if (!firstLine || !secLabel) return false;
    const a = cleanMarkdown(firstLine).toLowerCase().replace(/\s+/g, " ").trim();
    const b = secLabel.toLowerCase().replace(/\s+/g, " ").trim();
    if (a === b) return true;
    const numMatch = secLabel.match(/^(\d+\.\d+)/);
    if (numMatch && a.startsWith(numMatch[1])) return true;
    return false;
  }
  const FIG_INLINE_RE = /(?:рис(?:унок)?\.?\s*\d+(?:\.\d+)*|fig(?:ure)?\.?\s*\d+(?:\.\d+)*)/i;
  function parseTextWithCitations(text, color) {
    const CITE_RE = /\[(\d+)\]/g;
    const result = [];
    let lastIndex = 0;
    let match;
    while ((match = CITE_RE.exec(text)) !== null) {
      if (match.index > lastIndex) {
        result.push(new TextRun({ text: text.slice(lastIndex, match.index), font: FONT, size: SIZE, color }));
      }
      result.push(new InternalHyperlink({
        anchor: `ref_${match[1]}`,
        children: [new TextRun({ text: match[0], font: FONT, size: SIZE, color: "0563C1", underline: {} })],
      }));
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      result.push(new TextRun({ text: text.slice(lastIndex), font: FONT, size: SIZE, color }));
    }
    return result.length ? result : [new TextRun({ text, font: FONT, size: SIZE, color })];
  }
  function bodyPara(text) {
    const hasFig = FIG_INLINE_RE.test(text || "");
    const color = hasFig ? "B85C00" : "000000";
    return new Paragraph({
      indent: { firstLine: INDENT },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.BOTH,
      children: parseTextWithCitations(text || "", color),
    });
  }
  function listPara(text) {
    return new Paragraph({
      indent: { left: INDENT, hanging: 360 },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.BOTH,
      children: parseTextWithCitations(text, "000000"),
    });
  }
  function heading1(text) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
      children: [new TextRun({ text: text.toUpperCase(), font: FONT, size: SIZE, bold: true, color: "000000" })],
    });
  }
  function headingSubsection(text) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.BOTH, indent: { firstLine: INDENT },
      children: [new TextRun({ text, font: FONT, size: SIZE, bold: true, color: "000000" })],
    });
  }
  function makeTableDocx(lines) {
    const border = { style: BorderStyle.SINGLE, size: 1, color: "000000" };
    const cellBorders = { top: border, bottom: border, left: border, right: border };
    const filteredLines = lines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l));
    const rows = filteredLines.map((l, rowIndex) => {
      const cells = l.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
      const isHeader = rowIndex === 0;
      return new TableRow({
        children: cells.map(cellText =>
          new TableCell({
            borders: cellBorders,
            margins: { left: 57, right: 57, top: 57, bottom: 57 },
            children: [new Paragraph({
              alignment: isHeader ? AlignmentType.CENTER : AlignmentType.LEFT,
              spacing: { line: 240, lineRule: "exact", before: 0, after: 0 },
              children: [new TextRun({ text: cellText, font: FONT, size: 24, color: "000000", bold: isHeader })],
            })],
          })
        ),
      });
    });
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows,
    });
  }

  function makeBlocks(text, secLabel) {
    if (!text) return [];
    const result = [];
    const lines = text.split("\n");
    let firstContentLine = true;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*\|/.test(line)) {
        const tableLines = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          tableLines.push(lines[i]);
          i++;
        }
        if (tableLines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l)).length > 0) {
          result.push(makeTableDocx(tableLines));
          result.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
        }
        continue;
      }
      if (/^Таблиця\s+\d/.test(line.trim())) {
        const tf = methodInfo?.formatting?.tableFormat || "";
        const tAlignRight = /правий|right/i.test(tf);
        const tCenter = /по\s*центру.*назв|назв.*по\s*центру/i.test(tf);
        const tBold = /жирн|bold/i.test(tf);
        const tTwoLine = tAlignRight && (tCenter || tBold);
        const tAlign = tAlignRight ? AlignmentType.RIGHT : AlignmentType.BOTH;
        const dashIdx = line.search(/ [–\-] /);
        if (tTwoLine && dashIdx !== -1) {
          const numPart = line.trim().substring(0, dashIdx).trim();
          const namePart = line.trim().substring(dashIdx + 3).trim();
          result.push(new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            indent: { firstLine: 0 },
            children: [new TextRun({ text: numPart, font: FONT, size: SIZE, color: "000000" })],
          }));
          result.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            indent: { firstLine: 0 },
            children: [new TextRun({ text: namePart, font: FONT, size: SIZE, color: "000000" })],
          }));
        } else {
          result.push(new Paragraph({
            alignment: tAlignRight ? AlignmentType.RIGHT : AlignmentType.BOTH,
            spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
            indent: { firstLine: tAlignRight ? 0 : INDENT },
            children: [new TextRun({ text: line.trim(), font: FONT, size: SIZE, bold: tBold, color: "000000" })],
          }));
        }
        i++;
        continue;
      }
      if (/^Рис\.\s+\d/.test(line.trim())) {
        const ff = methodInfo?.formatting?.figureFormat || "";
        const fBold = /жирн|bold/i.test(ff);
        result.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.5) },
          children: [new TextRun({ text: line.trim(), font: FONT, size: SIZE, bold: fBold, color: "B85C00" })],
        }));
        i++;
        continue;
      }
      const isHyphenList = /^[-*]\s+/.test(line.trim());
      const raw = cleanMarkdown(line);
      if (!raw) { i++; continue; }
      if (firstContentLine && isDuplicateTitle(line, secLabel)) { firstContentLine = false; i++; continue; }
      firstContentLine = false;
      if (/^#{1,6}\s/.test(line.trim()) && raw) {
        result.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
        result.push(headingSubsection(raw));
        result.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
        i++; continue;
      }
      if (/^[–—]\s/.test(raw) || isHyphenList) {
        const listText = /^[–—]\s/.test(raw) ? raw : `– ${raw}`;
        result.push(listPara(listText));
        i++; continue;
      }
      result.push(bodyPara(raw));
      i++;
    }
    return result;
  }

  function sourceParaChildren(text) {
    const URL_RE = /(https?:\/\/[^\s]+)/;
    const parts = text.split(/(https?:\/\/[^\s]+)/);
    return parts.flatMap(part => {
      if (URL_RE.test(part)) {
        const cleanUrl = part.replace(/[.,;:!?)]+$/, '');
        const tail = part.slice(cleanUrl.length);
        const link = new ExternalHyperlink({
          link: cleanUrl,
          children: [new TextRun({ text: cleanUrl, font: FONT, size: SIZE, color: "0563C1", underline: {} })],
        });
        return tail ? [link, new TextRun({ text: tail, font: FONT, size: SIZE, color: "000000" })] : [link];
      }
      return [new TextRun({ text: part, font: FONT, size: SIZE, color: "000000" })];
    });
  }
  function sourcePara(text) {
    const cleaned = text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").trim();
    if (!cleaned) return null;
    return new Paragraph({
      spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.3) },
      alignment: AlignmentType.BOTH,
      indent: { firstLine: INDENT },
      children: sourceParaChildren(cleaned),
    });
  }
  function sourceParaWithBookmark(text, refNum) {
    const cleaned = text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").trim();
    if (!cleaned) return null;
    const numMatch = cleaned.match(/^(\d+[\.\)]\s*)/);
    let children;
    if (numMatch) {
      const prefix = numMatch[1];
      const rest = cleaned.slice(prefix.length);
      children = [
        new Bookmark({
          id: `ref_${refNum}`,
          children: [new TextRun({ text: prefix, font: FONT, size: SIZE, color: "000000" })],
        }),
        ...sourceParaChildren(rest),
      ];
    } else {
      children = sourceParaChildren(cleaned);
    }
    return new Paragraph({
      spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.3) },
      alignment: AlignmentType.BOTH,
      indent: { firstLine: INDENT },
      children,
    });
  }

  const children = [];

  const alignMap = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT };
  const topicStr = info?.topic || "";
  const currentYear = new Date().getFullYear().toString();
  const applyTopic = (t) => {
    let s = topicStr ? t.replace(/\[ТЕМА\]/g, topicStr) : t;
    if (topicStr) {
      s = s.replace(/(Тема\s*[:：]\s*«\s*)([_\s]*)(\s*»)/g, `$1${topicStr}$3`);
      s = s.replace(/\(найменування\s+теми\)/gi, topicStr);
      s = s.replace(/\(назва\s+теми\)/gi, topicStr);
    }
    s = s.replace(/\[РІК\]/g, currentYear).replace(/\[ДАТА\]/g, currentYear);
    s = s.replace(/(?<![/\d])20\d{2}(?![/\d])/g, currentYear);
    return s;
  };
  const resolvedLines = titlePageLines?.length
    ? titlePageLines.map(item => ({ ...item, text: applyTopic(item.text) }))
    : (titlePage?.trim() ? titlePage.split("\n").map(text => ({ text: applyTopic(text), align: "center" })) : null);
  if (resolvedLines) {
    resolvedLines.forEach((item, idx) => {
      const itemSize = item.fontSize ? item.fontSize * 2 : SIZE;
      const spaceBefore = item.spaceBefore != null ? item.spaceBefore : 0;
      children.push(new Paragraph({
        alignment: alignMap[item.align] || AlignmentType.CENTER,
        spacing: { line: LINE, lineRule: "auto", before: spaceBefore, after: 0 },
        indent: { firstLine: 0 },
        children: [new TextRun({ text: item.text, font: FONT, size: itemSize, bold: !!item.bold, color: "000000" })],
      }));
    });
  } else {
    children.push(new Paragraph({ spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
  }

  children.push(new Paragraph({
    pageBreakBefore: true,
    alignment: AlignmentType.CENTER,
    spacing: { line: LINE_SINGLE, lineRule: "auto", before: 0, after: LINE_SINGLE * 2 },
    children: [new TextRun({ text: "ЗМІСТ", font: FONT, size: SIZE, bold: true, color: "000000" })],
  }));

  let lastChapter = null;
  let firstMainSec = true;

  for (let i = 0; i < displayOrder.length; i++) {
    const sec = displayOrder[i]; const txt = numberedContent[sec.id];
    if (!txt) continue;
    const isMain = !["intro", "conclusions", "sources"].includes(sec.type);
    const isChapterConc = sec.type === "chapter_conclusion";
    const isSubsection = isMain && (/^\d+\.\d+/.test(sec.id) || isChapterConc);
    const thisChapter = isSubsection ? sec.id.split(".")[0] : null;

    let needsPageBreak = true;
    if (firstMainSec) { needsPageBreak = true; firstMainSec = false; }
    else if (isSubsection) {
      const prevSec = displayOrder.slice(0, i).reverse().find(s => numberedContent[s.id]);
      const prevIsSubsection = prevSec && !["intro", "conclusions", "sources"].includes(prevSec.type) && (/^\d+\.\d+/.test(prevSec.id || "") || prevSec.type === "chapter_conclusion");
      needsPageBreak = !prevIsSubsection || thisChapter !== prevSec?.id?.split(".")?.[0];
    }
    if (needsPageBreak) children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));

    if (sec.type === "sources") {
      children.push(heading1(sec.label));
      children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
      txt.split("\n").forEach(line => {
        const cleaned = line.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").trim();
        const numMatch = cleaned.match(/^(\d+)[\.\)]/);
        if (numMatch) {
          const p = sourceParaWithBookmark(line, parseInt(numMatch[1]));
          if (p) children.push(p);
        } else {
          const p = sourcePara(line);
          if (p) children.push(p);
        }
      });
      continue;
    }

    if (!isSubsection) {
      children.push(heading1(sec.label));
      if (sec.type === "intro" || sec.type === "conclusions") {
        children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
      }
    } else {
      if (thisChapter !== lastChapter) {
        lastChapter = thisChapter;
        const rawTitle = sec.sectionTitle || `РОЗДІЛ ${thisChapter}`;
        const alreadyHasPrefix = rawTitle.trim().toUpperCase().startsWith(`РОЗДІЛ ${thisChapter}`);
        const chapterLabel = alreadyHasPrefix ? rawTitle.trim() : `РОЗДІЛ ${thisChapter}. ${rawTitle}`;
        children.push(heading1(chapterLabel));
      }
      children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
      children.push(headingSubsection(sec.label));
      children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
    }
    children.push(...makeBlocks(txt, sec.label));
  }

  if (appendicesText && appendicesText.trim()) {
    children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
    children.push(heading1("ДОДАТКИ"));
    appendicesText.split("\n").forEach(line => {
      const raw = line.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").trim();
      if (!raw) {
        children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
        return;
      }
      if (/^ДОДАТОК\s+[А-ЯA-Z]/i.test(raw)) {
        children.push(new Paragraph({
          alignment: AlignmentType.RIGHT,
          indent: { firstLine: 0 },
          spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) },
          children: [new TextRun({ text: raw.toUpperCase(), font: FONT, size: SIZE, bold: false, color: "000000" })],
        }));
      } else {
        children.push(new Paragraph({
          indent: { firstLine: INDENT },
          spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
          alignment: AlignmentType.BOTH,
          children: [new TextRun({ text: raw, font: FONT, size: SIZE, color: "000000" })],
        }));
      }
    });
  }

  const doc = new Document({
    features: { updateFields: true },
    styles: {
      default: { document: { run: { font: FONT, size: SIZE, color: "000000" }, paragraph: { spacing: { line: LINE, lineRule: "auto" } } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", run: { font: FONT, size: SIZE, bold: true, color: "000000" }, paragraph: { spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, alignment: AlignmentType.CENTER, indent: { firstLine: 0 } } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", run: { font: FONT, size: SIZE, bold: true, color: "000000" }, paragraph: { spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, alignment: AlignmentType.BOTH, indent: { firstLine: INDENT } } },
      ],
    },
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
    const safeName = (info?.topic || "робота").replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
    a.href = url; a.download = safeName + ".docx";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ─────────────────────────────────────────────
// Export plan to docx
// ─────────────────────────────────────────────
export async function exportPlanToDocx({ sections, info, methodInfo }) {
  if (!window.docx) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js";
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  const { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel } = window.docx;
  const FONT = "Times New Roman", SIZE = 28, LINE = 360, INDENT = 709;
  const mmToTwip = mm => Math.round(mm * 1440 / 25.4);
  const marg = methodInfo?.formatting?.margins || {};
  const L = mmToTwip(marg.left   || 30);
  const R = mmToTwip(marg.right  || 15);
  const T = mmToTwip(marg.top    || 20);
  const B = mmToTwip(marg.bottom || 20);

  const intro = sections.find(s => s.type === "intro");
  const concs = sections.find(s => s.type === "conclusions");
  const srcs = sections.find(s => s.type === "sources");
  const main = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));

  const children = [];
  if (info?.topic) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE * 2 },
      children: [new TextRun({ text: info.topic, font: FONT, size: SIZE, color: "000000" })],
    }));
  }

  const groups = {};
  for (const s of main) { const top = s.id.split(".")[0]; if (!groups[top]) groups[top] = []; groups[top].push(s); }

  if (intro) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) }, alignment: AlignmentType.LEFT, indent: { firstLine: 0 }, children: [new TextRun({ text: "ВСТУП", font: FONT, size: SIZE, bold: true, color: "000000" })] }));

  for (const [num, items] of Object.entries(groups)) {
    const rawTitle = items[0].sectionTitle || `РОЗДІЛ ${num}`;
    const alreadyHasPrefix = rawTitle.trim().toUpperCase().startsWith(`РОЗДІЛ ${num}`);
    const secLabel = alreadyHasPrefix ? rawTitle.trim() : `РОЗДІЛ ${num}. ${rawTitle}`;
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) }, alignment: AlignmentType.LEFT, indent: { firstLine: 0 }, children: [new TextRun({ text: secLabel, font: FONT, size: SIZE, bold: true, color: "000000" })] }));
    for (const s of items) {
      if (/^\d+\.\d+/.test(s.id)) {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE / 2), after: 0 }, alignment: AlignmentType.LEFT, indent: { firstLine: INDENT }, children: [new TextRun({ text: s.label, font: FONT, size: SIZE, color: "000000" })] }));
      }
    }
    const chapConc = sections.find(s => s.type === "chapter_conclusion" && s.id === `${num}.conclusions`);
    if (chapConc) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE / 2), after: 0 }, alignment: AlignmentType.LEFT, indent: { firstLine: INDENT }, children: [new TextRun({ text: chapConc.label, font: FONT, size: SIZE, color: "000000" })] }));
    }
  }
  if (concs) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) }, alignment: AlignmentType.LEFT, indent: { firstLine: 0 }, children: [new TextRun({ text: "ВИСНОВКИ", font: FONT, size: SIZE, bold: true, color: "000000" })] }));
  if (srcs) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) }, alignment: AlignmentType.LEFT, indent: { firstLine: 0 }, children: [new TextRun({ text: "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", font: FONT, size: SIZE, bold: true, color: "000000" })] }));

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: SIZE, color: "000000" }, paragraph: { spacing: { line: LINE, lineRule: "auto" } } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: T, right: R, bottom: B, left: L } } }, children }],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    const safeName = ("план_" + (info?.topic || "робота")).replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
    a.href = url; a.download = safeName + ".docx";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ─────────────────────────────────────────────
// Додатки (.docx)
// ─────────────────────────────────────────────
export async function exportAppendixToDocx(text, info, methodInfo) {
  if (!window.docx) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js";
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  const { Document, Packer, Paragraph, TextRun, AlignmentType, PageNumber, Header, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle } = window.docx;
  const FONT = "Times New Roman", SIZE = 28, SIZE_NUM = 24;
  const mmToTwip = mm => Math.round(mm * 1440 / 25.4);
  const marg = methodInfo?.formatting?.margins || {};
  const L = mmToTwip(marg.left   || 30);
  const R = mmToTwip(marg.right  || 15);
  const T = mmToTwip(marg.top    || 20);
  const B = mmToTwip(marg.bottom || 20);
  const INDENT = 709, LINE = 360;

  function cleanMarkdown(line) {
    return line.replace(/^#{1,6}\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1").replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim();
  }
  function makeTableDocx(lines) {
    const border = { style: BorderStyle.SINGLE, size: 1, color: "000000" };
    const cellBorders = { top: border, bottom: border, left: border, right: border };
    const filteredLines = lines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l));
    const rows = filteredLines.map((l, rowIndex) => {
      const cells = l.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
      const isHeader = rowIndex === 0;
      return new TableRow({
        children: cells.map(cellText =>
          new TableCell({
            borders: cellBorders,
            margins: { left: 57, right: 57, top: 57, bottom: 57 },
            children: [new Paragraph({
              alignment: isHeader ? AlignmentType.CENTER : AlignmentType.LEFT,
              spacing: { line: 240, lineRule: "exact", before: 0, after: 0 },
              children: [new TextRun({ text: cellText, font: FONT, size: 24, color: "000000", bold: isHeader })],
            })],
          })
        ),
      });
    });
    return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
  }

  const children = [];
  const lines = text.split("\n");
  let i = 0;
  let isQuestionnaire = false;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|/.test(line)) {
      const tableLines = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { tableLines.push(lines[i]); i++; }
      if (tableLines.filter(l => !/^\s*\|[-:| ]+\|\s*$/.test(l)).length > 0) {
        children.push(makeTableDocx(tableLines));
        children.push(new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] }));
      }
      continue;
    }
    if (/^Таблиця\s+\d/.test(line.trim())) {
      const tf = methodInfo?.formatting?.tableFormat || "";
      const tAlignRight = /правий|right/i.test(tf);
      const tCenter = /по\s*центру.*назв|назв.*по\s*центру/i.test(tf);
      const tBold = /жирн|bold/i.test(tf);
      const tTwoLine = tAlignRight && (tCenter || tBold);
      const dashIdx = line.search(/ [–\-] /);
      if (tTwoLine && dashIdx !== -1) {
        const numPart = line.trim().substring(0, dashIdx).trim();
        const namePart = line.trim().substring(dashIdx + 3).trim();
        children.push(new Paragraph({
          alignment: AlignmentType.RIGHT,
          spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE * 0.5), after: 0 },
          indent: { firstLine: 0 },
          children: [new TextRun({ text: numPart, font: FONT, size: SIZE, color: "000000" })],
        }));
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
          indent: { firstLine: 0 },
          children: [new TextRun({ text: namePart, font: FONT, size: SIZE, bold: true, color: "000000" })],
        }));
      } else {
        children.push(new Paragraph({
          alignment: tAlignRight ? AlignmentType.RIGHT : AlignmentType.BOTH,
          spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE * 0.5), after: 0 },
          indent: { firstLine: tAlignRight ? 0 : INDENT },
          children: [new TextRun({ text: line.trim(), font: FONT, size: SIZE, bold: tBold, color: "000000" })],
        }));
      }
      i++; continue;
    }
    if (/^Рис\.\s+\d/.test(line.trim())) {
      const ff = methodInfo?.formatting?.figureFormat || "";
      const fBold = /жирн|bold/i.test(ff);
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.5) },
        children: [new TextRun({ text: line.trim(), font: FONT, size: SIZE, bold: fBold, color: "000000" })],
      }));
      i++; continue;
    }
    const raw = cleanMarkdown(line);
    if (!raw) { i++; continue; }
    if (/^ДОДАТОК\s+[А-ЯA-Z]/i.test(raw)) {
      // Peek at upcoming lines to detect questionnaire
      let peekIdx = i + 1;
      while (peekIdx < lines.length && !lines[peekIdx].trim()) peekIdx++;
      const nextNonEmpty = (lines[peekIdx] || "").replace(/^#{1,6}\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1").trim();
      isQuestionnaire = /анкет|опитувальник/i.test(nextNonEmpty);
      children.push(new Paragraph({
        spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) },
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: raw.toUpperCase(), font: FONT, size: SIZE, bold: true, color: "000000" })],
      }));
      i++; continue;
    }
    if (/^#{1,6}\s/.test(line.trim())) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) },
        alignment: AlignmentType.LEFT,
        indent: { firstLine: INDENT },
        children: [new TextRun({ text: raw, font: FONT, size: SIZE, bold: true, color: "000000" })],
      }));
      i++; continue;
    }
    children.push(new Paragraph({
      indent: { firstLine: isQuestionnaire ? 0 : INDENT },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: isQuestionnaire ? AlignmentType.LEFT : AlignmentType.BOTH,
      children: [new TextRun({ text: raw, font: FONT, size: SIZE, color: "000000" })],
    }));
    i++;
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: SIZE, color: "000000" }, paragraph: { spacing: { line: LINE, lineRule: "auto" } } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: T, right: R, bottom: B, left: L } }, pageNumberStart: 1 },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 0 }, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: SIZE_NUM, color: "000000" })] })] }) },
      children,
    }],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    const safeName = (info?.topic || "додатки").replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
    a.href = url; a.download = safeName + " - додатки.docx";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ─────────────────────────────────────────────
// Доповідь (.docx)
// ─────────────────────────────────────────────
export async function exportSpeechToDocx(text, info, methodInfo) {
  if (!window.docx) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js";
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  const { Document, Packer, Paragraph, TextRun, AlignmentType, PageNumber, Header } = window.docx;
  const FONT = "Times New Roman", SIZE = 28, SIZE_NUM = 24;
  const mmToTwip = mm => Math.round(mm * 1440 / 25.4);
  const marg = methodInfo?.formatting?.margins || {};
  const L = mmToTwip(marg.left   || 30);
  const R = mmToTwip(marg.right  || 15);
  const T = mmToTwip(marg.top    || 20);
  const B = mmToTwip(marg.bottom || 20);
  const INDENT = 709, LINE = 360;

  const children = text.split("\n").map(line => {
    const raw = line.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").trim();
    if (!raw) return new Paragraph({ spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 }, children: [] });
    if (/^Слайд\s+\d+/i.test(raw)) {
      return new Paragraph({
        spacing: { line: LINE, lineRule: "auto", before: 120, after: 0 },
        alignment: AlignmentType.LEFT,
        children: [new TextRun({ text: raw, font: FONT, size: SIZE, bold: true, color: "000000" })],
      });
    }
    return new Paragraph({
      indent: { firstLine: INDENT },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.BOTH,
      children: [new TextRun({ text: raw, font: FONT, size: SIZE, color: "000000" })],
    });
  });

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: SIZE, color: "000000" }, paragraph: { spacing: { line: LINE, lineRule: "auto" } } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: T, right: R, bottom: B, left: L } }, pageNumberStart: 1 },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 0 }, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: SIZE_NUM, color: "000000" })] })] }) },
      children,
    }],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    const safeName = (info?.topic || "доповідь").replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
    a.href = url; a.download = safeName + " - доповідь.docx";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
}
