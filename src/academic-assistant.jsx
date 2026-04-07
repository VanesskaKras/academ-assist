import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { db } from "./firebase";
import { useAuth } from "./AuthContext";
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp,
} from "firebase/firestore";

// ─────────────────────────────────────────────
// Word export
// ─────────────────────────────────────────────
async function exportToDocx({ content, info, displayOrder, appendicesText, titlePage }) {
  if (!window.docx) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js";
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  const { Document, Packer, Paragraph, TextRun, AlignmentType, PageNumber, Header, HeadingLevel, TableOfContents, Table, TableRow, TableCell, WidthType, BorderStyle, ExternalHyperlink } = window.docx;
  const FONT = "Times New Roman", SIZE = 28, SIZE_NUM = 24;
  const L = 1701, R = 851, T = 1134, B = 1134, INDENT = 709, LINE = 360;
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
  function bodyPara(text) {
    const hasFig = FIG_INLINE_RE.test(text || "");
    return new Paragraph({
      indent: { firstLine: INDENT },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.BOTH,
      children: [new TextRun({ text: text || "", font: FONT, size: SIZE, color: hasFig ? "B85C00" : "000000" })],
    });
  }
  function heading1(text) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE },
      alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
      children: [new TextRun({ text: text.toUpperCase(), font: FONT, size: SIZE, bold: true, color: "000000" })],
    });
  }
  function headingSubsection(text) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) },
      alignment: AlignmentType.LEFT, indent: { firstLine: INDENT },
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
        result.push(new Paragraph({
          alignment: AlignmentType.BOTH,
          spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
          indent: { firstLine: INDENT },
          children: [new TextRun({ text: line.trim(), font: FONT, size: SIZE, color: "000000" })],
        }));
        i++;
        continue;
      }
      if (/^Рис\.\s+\d/.test(line.trim())) {
        result.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.5) },
          children: [new TextRun({ text: line.trim(), font: FONT, size: SIZE, color: "B85C00" })],
        }));
        i++;
        continue;
      }
      const raw = cleanMarkdown(line);
      if (!raw) { i++; continue; }
      if (firstContentLine && isDuplicateTitle(line, secLabel)) { firstContentLine = false; i++; continue; }
      firstContentLine = false;
      if (/^#{1,6}\s/.test(line.trim()) && raw) { result.push(headingSubsection(raw)); i++; continue; }
      result.push(bodyPara(raw));
      i++;
    }
    return result;
  }

  function sourceParaChildren(text) {
    const URL_RE = /(https?:\/\/[^\s]+)/;
    const parts = text.split(/(https?:\/\/[^\s]+)/);
    return parts.map(part => {
      if (URL_RE.test(part)) {
        return new ExternalHyperlink({
          link: part,
          children: [new TextRun({ text: part, font: FONT, size: SIZE, color: "0563C1", underline: {} })],
        });
      }
      return new TextRun({ text: part, font: FONT, size: SIZE, color: "000000" });
    });
  }
  function sourcePara(text) {
    const cleaned = text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").trim();
    if (!cleaned) return null;
    return new Paragraph({
      spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.3) },
      alignment: AlignmentType.BOTH,
      indent: { left: INDENT, hanging: INDENT },
      children: sourceParaChildren(cleaned),
    });
  }


  const children = [];

  // ── Сторінка 1: титульна ──
  if (titlePage && titlePage.trim()) {
    const titleLines = titlePage.split("\n");
    titleLines.forEach((line, idx) => {
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { line: LINE, lineRule: "auto", before: 0, after: idx === titleLines.length - 1 ? 0 : Math.round(LINE * 0.2) },
        indent: { firstLine: 0 },
        children: [new TextRun({ text: line, font: FONT, size: SIZE, color: "000000" })],
      }));
    });
  } else {
    children.push(new Paragraph({ spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
  }

  // ── Сторінка 2: ЗМІСТ (автоматичний Word TOC) ──
  children.push(new Paragraph({
    pageBreakBefore: true,
    alignment: AlignmentType.CENTER,
    spacing: { line: LINE_SINGLE, lineRule: "auto", before: 0, after: LINE_SINGLE * 2 },
    children: [new TextRun({ text: "ЗМІСТ", font: FONT, size: SIZE, bold: true, color: "000000" })],
  }));
  children.push(new TableOfContents("ЗМІСТ", {
    hyperlink: true,
    headingStyleRange: "1-2",
    b: false,
  }));

  // ── Сторінки 3+: основний текст ──
  let lastChapter = null;
  let firstMainSec = true;

  for (let i = 0; i < displayOrder.length; i++) {
    const sec = displayOrder[i]; const txt = content[sec.id];
    if (!txt) continue;
    const isMain = !["intro", "conclusions", "sources"].includes(sec.type);
    const isSubsection = isMain && /^\d+\.\d+/.test(sec.id);
    const thisChapter = isSubsection ? sec.id.split(".")[0] : null;

    // Визначаємо чи потрібен page break
    let needsPageBreak = true;
    if (firstMainSec) { needsPageBreak = true; firstMainSec = false; }
    else if (isSubsection) {
      const prevSec = displayOrder.slice(0, i).reverse().find(s => content[s.id]);
      const prevIsSubsection = prevSec && !["intro", "conclusions", "sources"].includes(prevSec.type) && /^\d+\.\d+/.test(prevSec.id || "");
      needsPageBreak = !prevIsSubsection || thisChapter !== prevSec?.id?.split(".")?.[0];
    }
    if (needsPageBreak) children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));

    if (sec.type === "sources") {
      children.push(heading1(sec.label));
      txt.split("\n").forEach(line => {
        const p = sourcePara(line);
        if (p) children.push(p);
      });
      continue;
    }

    if (!isSubsection) {
      children.push(heading1(sec.label));
    } else {
      if (thisChapter !== lastChapter) {
        lastChapter = thisChapter;
        const rawTitle = sec.sectionTitle || `РОЗДІЛ ${thisChapter}`;
        const alreadyHasPrefix = rawTitle.trim().toUpperCase().startsWith(`РОЗДІЛ ${thisChapter}`);
        const chapterLabel = alreadyHasPrefix ? rawTitle.trim() : `РОЗДІЛ ${thisChapter}. ${rawTitle}`;
        children.push(heading1(chapterLabel));
      }
      children.push(headingSubsection(sec.label));
    }
    children.push(...makeBlocks(txt, sec.label));
  }

  // ── ДОДАТКИ (після списку джерел) ──
  if (appendicesText && appendicesText.trim()) {
    children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
    // Загальний заголовок розділу
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
          children: [new TextRun({ text: raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase(), font: FONT, size: SIZE, bold: false, color: "000000" })],
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
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", run: { font: FONT, size: SIZE, bold: true, color: "000000" }, paragraph: { spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE }, alignment: AlignmentType.CENTER, indent: { firstLine: 0 } } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", run: { font: FONT, size: SIZE, bold: true, color: "000000" }, paragraph: { spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) }, alignment: AlignmentType.LEFT, indent: { firstLine: INDENT } } },
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
  const a = document.createElement("a");
  const safeName = (info?.topic || "робота").replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
  a.href = url; a.download = safeName + ".docx";
  document.body.appendChild(a); a.click(); document.body.removeChild(a); a.href = "";
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ─────────────────────────────────────────────
// Export plan to docx
// ─────────────────────────────────────────────
async function exportPlanToDocx({ sections, info }) {
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
  const L = 1701, R = 851, T = 1134, B = 1134;

  const intro = sections.find(s => s.type === "intro");
  const concs = sections.find(s => s.type === "conclusions");
  const srcs = sections.find(s => s.type === "sources");
  const main = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
  const ordered = [intro, ...main, concs, srcs].filter(Boolean);

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
  }
  if (concs) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) }, alignment: AlignmentType.LEFT, indent: { firstLine: 0 }, children: [new TextRun({ text: "ВИСНОВКИ", font: FONT, size: SIZE, bold: true, color: "000000" })] }));
  if (srcs) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE / 2) }, alignment: AlignmentType.LEFT, indent: { firstLine: 0 }, children: [new TextRun({ text: "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", font: FONT, size: SIZE, bold: true, color: "000000" })] }));

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: SIZE, color: "000000" }, paragraph: { spacing: { line: LINE, lineRule: "auto" } } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: T, right: R, bottom: B, left: L } } }, children }],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeName = ("план_" + (info?.topic || "робота")).replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
  a.href = url; a.download = safeName + ".docx";
  document.body.appendChild(a); a.click(); document.body.removeChild(a); a.href = "";
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ─────────────────────────────────────────────
// Додатки (.docx)
// ─────────────────────────────────────────────
async function exportAppendixToDocx(text, info) {
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
  const L = 1701, R = 851, T = 1134, B = 1134, INDENT = 709, LINE = 360;

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
      children.push(new Paragraph({
        alignment: AlignmentType.BOTH,
        spacing: { line: LINE, lineRule: "auto", before: Math.round(LINE * 0.5), after: 0 },
        indent: { firstLine: INDENT },
        children: [new TextRun({ text: line.trim(), font: FONT, size: SIZE, color: "000000" })],
      }));
      i++; continue;
    }
    if (/^Рис\.\s+\d/.test(line.trim())) {
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.5) },
        children: [new TextRun({ text: line.trim(), font: FONT, size: SIZE, color: "000000" })],
      }));
      i++; continue;
    }
    const raw = cleanMarkdown(line);
    if (!raw) { i++; continue; }
    if (/^ДОДАТОК\s+[А-ЯA-Z]/i.test(raw)) {
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
      indent: { firstLine: INDENT },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.BOTH,
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
  const a = document.createElement("a");
  const safeName = (info?.topic || "додатки").replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
  a.href = url; a.download = safeName + " - додатки.docx";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ─────────────────────────────────────────────
// Доповідь (.docx)
// ─────────────────────────────────────────────
async function exportSpeechToDocx(text, info) {
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
  const L = 1701, R = 851, T = 1134, B = 1134, INDENT = 709, LINE = 360;

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
  const a = document.createElement("a");
  const safeName = (info?.topic || "доповідь").replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
  a.href = url; a.download = safeName + " - доповідь.docx";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ─────────────────────────────────────────────
// Presentation export (.pptx) — v2
// ─────────────────────────────────────────────
async function exportToPptxFile(slideData, info) {
  if (!window.PptxGenJS) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js";
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  const pptx = new window.PptxGenJS();
  pptx.layout = "LAYOUT_16x9";

  const THEMES = {
    midnight: { bg: "1E2761", accent: "CADCFC", light: "EEF3FF", text: "1E2761" },
    forest: { bg: "2C5F2D", accent: "97BC62", light: "F0F7F0", text: "1A3A1B" },
    coral: { bg: "B85042", accent: "F5C6C0", light: "FDF8F5", text: "5A1A0F" },
    slate: { bg: "36454F", accent: "C8D8E4", light: "F5F5F5", text: "2A3540" },
    warm: { bg: "1A1A14", accent: "D4CF80", light: "FAF8F3", text: "1A1A14" },
  };

  const detectTheme = (info) => {
    const dir = ((info?.direction || "") + " " + (info?.subject || "")).toLowerCase();
    if (/it|інформ|програм|комп|tech|техн|систем|цифр/.test(dir)) return "midnight";
    if (/медицин|біол|фарм|здоров|лікар/.test(dir)) return "forest";
    if (/право|психол|соціол|педагог|гуманіт|мов|освіт/.test(dir)) return "coral";
    if (/економ|менедж|фінанс|облік|маркет|бізнес/.test(dir)) return "slate";
    return "warm";
  };

  const themeName = (slideData.theme && THEMES[slideData.theme]) ? slideData.theme : detectTheme(info);
  const T = THEMES[themeName];

  const STRIP_W = 0.18;
  const CONTENT_X = STRIP_W + 0.17;
  const CONTENT_W = 10 - CONTENT_X - 0.15;
  const TITLE_H = 0.9;

  // ── Helper: light slide frame + title ──
  const addTitle = (s, title) => {
    s.background = { color: T.light };
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: STRIP_W, h: 5.625, fill: { color: T.bg }, line: { type: "none" } });
    s.addText(title || "", {
      x: CONTENT_X - 0.05, y: 0.06, w: 10 - CONTENT_X, h: TITLE_H,
      fontSize: 22, bold: true, color: T.text,
      fontFace: "Georgia", align: "center", valign: "middle",
    });
  };

  // ── renderHero: темний повноекранний слайд (title / thanks) ──
  const renderHero = (s, data) => {
    s.background = { color: T.bg };
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 10, h: 0.13, fill: { color: T.accent }, line: { type: "none" } });
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 5.5, w: 10, h: 0.125, fill: { color: T.accent }, line: { type: "none" } });
    s.addShape(pptx.ShapeType.rect, { x: 0.45, y: 1.3, w: 0.07, h: 2.7, fill: { color: T.accent }, line: { type: "none" } });
    s.addText(data.title || info?.topic || "", {
      x: 0.7, y: 1.2, w: 8.8, h: 2.1,
      fontSize: 34, bold: true, color: "FFFFFF",
      fontFace: "Georgia", align: "left", valign: "middle", wrap: true,
    });
    if (data.subtitle) {
      s.addText(data.subtitle, {
        x: 0.7, y: 3.4, w: 8.8, h: 1.2,
        fontSize: 16, color: T.accent, fontFace: "Calibri",
        align: "left", valign: "top", wrap: true,
      });
    }
  };

  // ── renderTwoColumn: текст ліво + кольоровий блок право ──
  const renderTwoColumn = (s, data) => {
    addTitle(s, data.title);
    const COL_Y = TITLE_H + 0.25;
    const COL_H = 5.625 - COL_Y - 0.25;
    s.addText(data.left || data.content || "", {
      x: CONTENT_X, y: COL_Y, w: 4.3, h: COL_H,
      fontSize: 14, color: "333333", fontFace: "Calibri",
      valign: "top", wrap: true, paraSpaceAfter: 8,
    });
    const RIGHT_X = CONTENT_X + 4.5;
    const RIGHT_W = 10 - RIGHT_X - 0.15;
    s.addShape(pptx.ShapeType.roundRect, {
      x: RIGHT_X, y: COL_Y, w: RIGHT_W, h: COL_H,
      fill: { color: T.bg }, line: { type: "none" }, rectRadius: 0.1,
    });
    if (data.right_type === "stat") {
      s.addText(data.right_value || "", {
        x: RIGHT_X, y: COL_Y + 0.35, w: RIGHT_W, h: 1.5,
        fontSize: 54, bold: true, color: T.accent,
        fontFace: "Calibri", align: "center", valign: "middle",
      });
      s.addText(data.right_label || "", {
        x: RIGHT_X + 0.1, y: COL_Y + 1.95, w: RIGHT_W - 0.2, h: 0.65,
        fontSize: 14, color: "FFFFFF", fontFace: "Calibri", align: "center", wrap: true,
      });
    } else {
      s.addText(data.right || data.key_point || "", {
        x: RIGHT_X + 0.2, y: COL_Y + 0.25, w: RIGHT_W - 0.35, h: COL_H - 0.4,
        fontSize: 14, color: "FFFFFF", fontFace: "Calibri",
        valign: "top", wrap: true, paraSpaceAfter: 8,
      });
    }
  };

  // ── renderStatCallout: 1-3 великих числа на картках ──
  const renderStatCallout = (s, data) => {
    addTitle(s, data.title);
    const v = data.visual || {};
    const stats = v.stats || (v.stat
      ? [{ value: v.stat, label: v.stat_label || "" }, ...(v.stat2 ? [{ value: v.stat2, label: v.stat2_label || "" }] : [])]
      : []);
    const n = Math.min(stats.length, 3);
    const CARD_Y = TITLE_H + 0.2;
    const CARD_H = 2.15;
    if (n > 0) {
      const cardW = 2.7;
      const totalW = n * cardW + (n - 1) * 0.2;
      const startX = (10 - totalW) / 2;
      stats.slice(0, 3).forEach((st, i) => {
        const cx = startX + i * (cardW + 0.2);
        s.addShape(pptx.ShapeType.roundRect, {
          x: cx, y: CARD_Y, w: cardW, h: CARD_H,
          fill: { color: T.bg }, line: { type: "none" }, rectRadius: 0.12,
        });
        s.addText(st.value || "", {
          x: cx, y: CARD_Y + 0.1, w: cardW, h: 1.35,
          fontSize: 54, bold: true, color: T.accent,
          fontFace: "Calibri", align: "center", valign: "middle",
        });
        s.addText(st.label || "", {
          x: cx + 0.1, y: CARD_Y + 1.5, w: cardW - 0.2, h: 0.55,
          fontSize: 13, color: "FFFFFF", fontFace: "Calibri", align: "center", wrap: true,
        });
      });
    }
    if (data.content) {
      s.addText(data.content, {
        x: CONTENT_X, y: CARD_Y + CARD_H + 0.2, w: CONTENT_W, h: 5.625 - (CARD_Y + CARD_H + 0.2) - 0.2,
        fontSize: 14, color: "444444", fontFace: "Calibri", wrap: true, valign: "top",
      });
    }
  };

  // ── renderIconList: список з іконками (goals / conclusions) ──
  const renderIconList = (s, data) => {
    addTitle(s, data.title);
    const ICONS_DEFAULT = ["🎯", "📊", "🔬", "💡", "✅", "→"];
    const rawItems = data.visual?.items || data.points || (data.content ? data.content.split("\n").filter(Boolean) : []);
    const n = Math.min(rawItems.length, 5);
    if (!n) return;
    const COL_Y = TITLE_H + 0.2;
    const availH = 5.625 - COL_Y - 0.25;
    const itemH = availH / n;
    const circSize = Math.min(0.52, itemH * 0.55);
    rawItems.slice(0, 5).forEach((item, i) => {
      const ty = COL_Y + i * itemH;
      const icon = typeof item === "object" ? (item.icon || ICONS_DEFAULT[i % ICONS_DEFAULT.length]) : ICONS_DEFAULT[i % ICONS_DEFAULT.length];
      const header = typeof item === "object" ? item.header : null;
      const text = typeof item === "object" ? (item.text || item.header) : item;
      s.addShape(pptx.ShapeType.ellipse, {
        x: CONTENT_X, y: ty + (itemH - circSize) / 2, w: circSize, h: circSize,
        fill: { color: T.bg }, line: { type: "none" },
      });
      s.addText(String(icon), {
        x: CONTENT_X, y: ty + (itemH - circSize) / 2, w: circSize, h: circSize,
        fontSize: 14, align: "center", valign: "middle",
      });
      const textX = CONTENT_X + circSize + 0.14;
      const textW = CONTENT_W - circSize - 0.14;
      if (header) {
        s.addText(header, {
          x: textX, y: ty + (itemH - circSize) / 2, w: textW, h: circSize * 0.42,
          fontSize: 14, bold: true, color: T.text, fontFace: "Calibri", valign: "bottom",
        });
        s.addText(String(text), {
          x: textX, y: ty + (itemH - circSize) / 2 + circSize * 0.42, w: textW, h: circSize * 0.58,
          fontSize: 12, color: "555555", fontFace: "Calibri", valign: "top", wrap: true,
        });
      } else {
        s.addText(String(text), {
          x: textX, y: ty, w: textW, h: itemH,
          fontSize: 14, color: T.text, fontFace: "Calibri", valign: "middle", wrap: true,
        });
      }
    });
  };

  // ── renderHighlightBox: смугасті рядки + опціональний акцент-футер ──
  const renderHighlightBox = (s, data) => {
    addTitle(s, data.title);
    const items = data.visual?.items || data.points || (data.content ? data.content.split("\n").filter(Boolean) : []);
    const hasFooter = !!(data.accent || data.gap);
    const footerH = 0.88;
    const COL_Y = TITLE_H + 0.15;
    const availH = 5.625 - COL_Y - (hasFooter ? footerH + 0.22 : 0.25);
    const n = Math.min(items.length, 4);
    if (n) {
      const itemH = availH / n;
      items.slice(0, 4).forEach((pt, i) => {
        const ty = COL_Y + i * itemH;
        s.addShape(pptx.ShapeType.rect, {
          x: CONTENT_X, y: ty + 0.05, w: CONTENT_W, h: itemH - 0.1,
          fill: { color: i % 2 === 0 ? T.light : "FFFFFF" }, line: { color: T.accent, w: 0.5 },
        });
        s.addShape(pptx.ShapeType.rect, {
          x: CONTENT_X, y: ty + 0.05, w: 0.1, h: itemH - 0.1,
          fill: { color: T.bg }, line: { type: "none" },
        });
        const text = typeof pt === "object" ? (pt.text || pt.header) : pt;
        s.addText(String(text), {
          x: CONTENT_X + 0.18, y: ty + 0.05, w: CONTENT_W - 0.22, h: itemH - 0.1,
          fontSize: 13, color: T.text, fontFace: "Calibri", valign: "middle", wrap: true,
        });
      });
    }
    if (hasFooter) {
      const gy = 5.625 - footerH - 0.1;
      s.addShape(pptx.ShapeType.rect, { x: CONTENT_X, y: gy, w: CONTENT_W, h: footerH, fill: { color: T.accent }, line: { type: "none" } });
      s.addText(String(data.accent || data.gap), {
        x: CONTENT_X + 0.15, y: gy, w: CONTENT_W - 0.3, h: footerH,
        fontSize: 13, bold: true, color: T.text, fontFace: "Calibri", align: "left", valign: "middle", wrap: true,
      });
    }
  };

  // ── renderNumberedSteps: картки-кроки 1→2→3→4 (методи / процеси) ──
  const renderNumberedSteps = (s, data) => {
    addTitle(s, data.title);
    const steps = data.visual?.items || data.steps
      || (data.points ? data.points.map((p, i) => ({ num: String(i + 1), title: "", text: p })) : []);
    const n = Math.min(steps.length, 4);
    if (!n) return;
    const COL_Y = TITLE_H + 0.2;
    const cardW = (CONTENT_W - (n - 1) * 0.15) / n;
    const cardH = 5.625 - COL_Y - 0.25;
    steps.slice(0, 4).forEach((st, i) => {
      const cx = CONTENT_X + i * (cardW + 0.15);
      if (i < n - 1) {
        s.addShape(pptx.ShapeType.rect, {
          x: cx + cardW + 0.01, y: COL_Y + cardH / 2 - 0.04, w: 0.13, h: 0.07,
          fill: { color: T.accent }, line: { type: "none" },
        });
      }
      s.addShape(pptx.ShapeType.rect, {
        x: cx, y: COL_Y, w: cardW, h: cardH,
        fill: { color: T.light }, line: { color: T.accent, w: 0.75 },
      });
      const cSize = 0.52;
      s.addShape(pptx.ShapeType.ellipse, {
        x: cx + (cardW - cSize) / 2, y: COL_Y + 0.12, w: cSize, h: cSize,
        fill: { color: T.bg }, line: { type: "none" },
      });
      s.addText(st.num || String(i + 1), {
        x: cx + (cardW - cSize) / 2, y: COL_Y + 0.12, w: cSize, h: cSize,
        fontSize: 16, bold: true, color: "FFFFFF", fontFace: "Calibri", align: "center", valign: "middle",
      });
      if (st.title) {
        s.addText(st.title, {
          x: cx + 0.1, y: COL_Y + 0.78, w: cardW - 0.2, h: 0.55,
          fontSize: 13, bold: true, color: T.text, fontFace: "Georgia", align: "center", valign: "middle", wrap: true,
        });
      }
      const textY = COL_Y + (st.title ? 1.42 : 0.82);
      s.addText(st.text || (typeof st === "string" ? st : ""), {
        x: cx + 0.1, y: textY, w: cardW - 0.2, h: COL_Y + cardH - textY - 0.1,
        fontSize: 12, color: "444444", fontFace: "Calibri", align: "left", valign: "top", wrap: true,
      });
    });
  };

  // ── Dispatch ──
  for (const slide of (slideData.slides || [])) {
    const s = pptx.addSlide();
    switch (slide.layout) {
      case "hero":
      case "dark_title": renderHero(s, slide); break;
      case "two_column": renderTwoColumn(s, slide); break;
      case "stat_callout": renderStatCallout(s, slide); break;
      case "icon_list":
      case "icon_grid": renderIconList(s, slide); break;
      case "numbered_steps":
      case "timeline": renderNumberedSteps(s, slide); break;
      default: renderHighlightBox(s, slide); break;
    }
  }

  const safeName = (info?.topic || "презентація").replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
  await pptx.writeFile({ fileName: safeName + " - презентація.pptx" });
}

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const MODEL = "claude-sonnet-4-6";        // для генерації тексту
const MODEL_FAST = "claude-haiku-4-5-20251001"; // для JSON-задач (аналіз, план, ключові слова)

// ── Звукове сповіщення ──
// Щоб замінити на свій звук: покладіть файл (mp3/wav/ogg) в папку /public
// і замініть CUSTOM_SOUND_URL на шлях, наприклад "/sounds/done.mp3"
const CUSTOM_SOUND_URL = "/sounds/hi.mp3"; // або "/sounds/done.mp3"

function _playAudioNow() {
  if (CUSTOM_SOUND_URL) {
    try { new Audio(CUSTOM_SOUND_URL).play(); } catch { }
    return;
  }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.15;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.18, t + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.start(t); osc.stop(t + 0.35);
    });
  } catch { }
}

function playDoneSound() {
  if (!document.hidden) {
    _playAudioNow();
    return;
  }
  // Вкладка прихована — показуємо браузерне сповіщення
  const showNotification = () => {
    try {
      new Notification("Текст готовий!", {
        body: "Генерація завершена. Повертайтесь до вкладки.",
        icon: "/favicon.ico",
        silent: false,
      });
    } catch { }
  };
  if ("Notification" in window) {
    if (Notification.permission === "granted") {
      showNotification();
    } else if (Notification.permission !== "denied") {
      Notification.requestPermission().then(p => { if (p === "granted") showNotification(); });
    }
  }
  // Запасний варіант: грати звук коли користувач повернеться на вкладку
  const onVisible = () => {
    if (!document.hidden) {
      document.removeEventListener("visibilitychange", onVisible);
      _playAudioNow();
    }
  };
  document.addEventListener("visibilitychange", onVisible);
}

function buildSYS(lang = "Українська") {
  const isEnglish = /англ|english/i.test(lang || "");
  const langLine = isEnglish
    ? "Language: Write ONLY in English. All content, headings, and text must be in English."
    : `Мова відповіді: ТІЛЬКИ ${lang || "українська"}. Весь текст, заголовки та зміст — цією мовою.`;

  const forbiddenWords = isEnglish
    ? "FORBIDDEN words (and derivatives): aspect, important, special, significant, key, critical, fundamental."
    : "ЗАБОРОНЕНІ СЛОВА (та всі похідні): аспект, важливий, особливий, значущий, ключовий, критичний, фундаментальний.";

  return `Ти — експерт з написання академічних робіт.

## МОВА ТА ДЖЕРЕЛА
${langLine}
Джерела: тільки українські або зарубіжні. Російські та білоруські — ЗАБОРОНЕНО повністю.
Дослідники та вчені: НЕ посилатись і НЕ згадувати російських та білоруських науковців, дослідників або теоретиків. Замість них використовувати українських, західних або інших зарубіжних вчених.

## ФОРМАТУВАННЯ (суворо)
НЕ використовуй markdown розмітку: жодних #, ##, **, *, - на початку рядка. Пиши звичайний текст.
ВИНЯТОК: якщо в тексті потрібна таблиця — оформлюй її виключно у форматі markdown з вертикальними рисками: перший рядок — заголовки стовпців через |, другий рядок — розділювач |---|---|, далі рядки даних через |. Не використовуй / або інші символи як роздільники стовпців.
ТАБЛИЦІ — обов'язкові правила:
1. Перед кожною таблицею (на окремому рядку, одразу перед першим рядком |) пиши підпис: Таблиця X.Y – Назва таблиці (де X — номер розділу, Y — порядковий номер таблиці в цьому розділі, після тире назва таблиці).
2. В тексті підрозділу перед таблицею обов'язково є речення що посилається на неї, наприклад: "наведено в Таблиці X.Y", "представлено в Таблиці X.Y", "показано в Таблиці X.Y" тощо. Без такого посилання таблиця не з'являється.
РИСУНКИ — обов'язкові правила:
1. Якщо підрозділ потребує рисунку (схема, графік, діаграма тощо) — встав плейсхолдер на окремому рядку після місця рисунку у форматі: Рис. X.Y – Назва рисунку (де X — номер розділу, Y — порядковий номер рисунку в цьому розділі).
2. В тексті підрозділу перед плейсхолдером рисунку обов'язково є речення що посилається на нього, наприклад: "показано на Рис. X.Y", "зображено на Рис. X.Y", "наведено на Рис. X.Y" тощо. Без такого посилання рисунок не з'являється.
НЕ виділяй нічого жирним шрифтом у тексті підрозділів.
НЕ повторюй назву підрозділу на початку тексту — одразу починай зміст.
НЕ додавай посилання на джерела у тексті підрозділів.
КАТЕГОРИЧНО ЗАБОРОНЕНО додавати список літератури, список джерел або використаних джерел в кінці підрозділу. Жодних "Список використаних джерел:", "Джерела:", "References:" тощо.
КАТЕГОРИЧНО ЗАБОРОНЕНО використовувати довге тире "—" (em dash). Замість нього використовуй кому або перебудуй речення. Символ "—" не повинен з'являтися в тексті ЖОДНОГО разу.

## ПРАВИЛА ПУНКТУАЦІЇ (суворо)
Крапки: ставити завжди в кінці кожного речення.
Коми: максимум 1 кома на речення. Якщо можна обійтись без коми — обходись без неї.
Двокрапки: використовувати ВИКЛЮЧНО у розділі "ВСТУП". У всіх інших розділах двокрапки ЗАБОРОНЕНІ.
Тире (будь-яке: коротке, довге, em dash): КАТЕГОРИЧНО ЗАБОРОНЕНО у будь-якому вигляді.
Крапки з комою: КАТЕГОРИЧНО ЗАБОРОНЕНО.

## ЗАБОРОНЕНІ СЛОВА
${forbiddenWords}

## СТИЛЬ ПИСЬМА
Починай кожен підрозділ із захоплюючого гачка, що одразу вводить у тему.
Пиши короткими, чіткими реченнями. Використовуй активний стан дієслів.
Замінюй жаргон і складні терміни на повсякденні слова. Використовуй мінімум скорочень.
Уникай надмірно довгих речень. Розбивай довгі речення на менші шматки.
Чергуй довжину речень для природного ритму читання.
Чергуй довжину абзаців: короткі абзаци (3-4 речення) мають чергуватись із довшими (5-7 речень). Уникай однакового розміру абзаців поспіль. ЗАБОРОНЕНО писати абзаци з одного або двох речень.
Додавай короткі, зрозумілі приклади для пояснення теоретичних положень.
Використовуй неформальні сполучники: "тож", "тоді", "отже", "водночас".
Використовуй окремі короткі фрагменти, коли це здається природним.
Вставляй прості метафори для ясності там, де це доречно.
Перетворюй категоричні твердження на м'які пропозиції. Вставляй короткі переходи між абзацами.
Використовуй фразові дієслова (наприклад, "розпочати", "виявити", "розглянути").
Зменшуй драматичну терміновість і пафос.
Зберігай усі ключові факти недоторканими.
Прийми теплий, розмовний але академічний тон. Текст має бути у науковому стилі.
Зберігай оригінальну структуру підрозділу, але послаблюй формальність.
Кожен підрозділ завершується логічно, повним реченням та підсумковою думкою. Не обривай текст.`;
}

const FIELD_LABELS = {
  type: "Тип роботи", pages: "К-сть сторінок", topic: "Тема роботи",
  subject: "Тематика / предмет", direction: "Галузь / напрям", uniqueness: "Унікальність",
  language: "Мова роботи", deadline: "Дедлайн", extras: "Додаткові матеріали",
  methodNotes: "Вимоги методички",
};

// Визначає чи є робота з психології або педагогіки
const isPsychoPed = (info) => {
  if (info?.workCategory === "Гуманітарне") {
    const dir = ((info?.direction || "") + " " + (info?.subject || "")).toLowerCase();
    return /психол|педагог/.test(dir);
  }
  if (info?.workCategory && info.workCategory !== "Гуманітарне") return false;
  const dir = ((info?.direction || "") + " " + (info?.subject || "")).toLowerCase();
  return /психол|педагог/.test(dir);
};

// Визначає чи є робота економічного спрямування
const isEcon = (info) => {
  if (info?.workCategory === "Економічне") return true;
  if (info?.workCategory && info.workCategory !== "Економічне") return false;
  const dir = ((info?.direction || "") + " " + (info?.subject || "")).toLowerCase();
  return /економ|фінанс|менедж|облік|маркет|бізнес|бухгалт|аудит|логіст|підприємн|публічн.*управл|держ.*управл/.test(dir);
};

// Визначає підрозділи що мають отримати інструкції емпіричного дослідження
// Варіант 2: у плані є ключові слова — всі підрозділи того розділу
// Варіант 1: ключових слів немає — один найбільш підходящий підрозділ
const getEmpiricalSections = (sections, info) => {
  const empty = { anchorId: null, chapterSectionIds: [] };
  if (!isPsychoPed(info)) return empty;

  const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
  const empiricalRe = /дослідженн|емпіричн|анкетуванн|практичн.*дослідж|вибірк|результат.*дослідж/i;

  // Варіант 2: є підрозділи з ключовими словами → беремо весь їх розділ
  const matchingChapNums = new Set(
    mainSecs
      .filter(s => empiricalRe.test(s.label) || empiricalRe.test(s.sectionTitle || ""))
      .map(s => s.id.split(".")[0])
  );
  if (matchingChapNums.size > 0) {
    const ids = mainSecs
      .filter(s => matchingChapNums.has(s.id.split(".")[0]))
      .map(s => s.id);
    return { anchorId: null, chapterSectionIds: ids };
  }

  // Варіант 1: ключових слів немає → один найкращий підрозділ
  const practicalSecs = mainSecs.filter(s => ["analysis", "recommendations"].includes(s.type));
  if (!practicalSecs.length) return empty;
  const softRe = /практичн|аналіз|результат|застосуванн/i;
  const best = practicalSecs.find(s => softRe.test(s.label)) || practicalSecs[practicalSecs.length - 1];
  return { anchorId: best.id, chapterSectionIds: [] };
};

// Повертає id підрозділів економічної роботи що мають містити таблиці/розрахунки
const getEconSections = (sections, info) => {
  if (!isEcon(info)) return [];
  return sections
    .filter(s => ["analysis", "recommendations"].includes(s.type))
    .map(s => s.id);
};

const STAGES = ["Дані", "Перевірка", "План", "Написання", "Джерела", "Готово"];
const STAGE_KEYS = ["input", "parsed", "plan", "writing", "sources", "done"];

// Статуси для Firestore
const ORDER_STATUS = {
  input: "new",
  parsed: "new",
  plan: "plan_ready",
  writing: "writing",
  sources: "writing",
  done: "done",
};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function parsePagesAvg(str) {
  if (!str) return 80;
  const nums = String(str).match(/\d+/g);
  if (!nums) return 80;
  if (nums.length === 1) return parseInt(nums[0]);
  return Math.round(nums.reduce((a, b) => a + parseInt(b), 0) / nums.length);
}

function parseTemplate(text) {
  const g = (re, fb = "") => { const m = text.match(re); return m ? m[1].trim() : fb; };
  return {
    orderNumber: g(/№\s*замовлення\s*[-–:]\s*(\S+)/i),
    type: g(/Тип\s*[-–:]\s*(.+?)(?=\n|⏰|📌|✈️|⚙️|⚡|$)/i),
    deadline: g(/Дедлайн\s*[-–:]\s*(.+?)(?=\n|⚡|📌|✈️|⚙️|$)/i),
    direction: g(/Напрям\s*[-–:]\s*(.+?)(?=\n|📌|✈️|⚙️|$)/i),
    subject: g(/Тематика\s*[-–:]\s*(.+?)(?=\n|✈️|⚙️|$)/i),
    topic: g(/Тема\s*[-–:]\s*(.+?)(?=\n|Презентація|⚙️|$)/i),
    pages: g(/К-кість стр\.\s*[-–:]\s*(.+?)(?=\n|⚙️|$)/i),
    uniqueness: g(/Унікальність\s*[-–:]\s*(.+?)(?=\n|$)/i),
    extras: g(/Презентація(.+?)(?=\n|⚙️|$)/i),
    language: "Українська", methodNotes: "", sourceCount: "30-40",
  };
}

async function callClaude(messages, signal, systemPrompt, maxTokens, onWait, model) {
  const MAX_RETRIES = 5;
  let delay = 12000;
  const useStream = (maxTokens || 8000) >= 2000; // stream for large responses only

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch("/api/claude", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model || MODEL,
        max_tokens: maxTokens || 8000,
        system: systemPrompt || buildSYS(),
        messages,
        ...(useStream ? { stream: true } : {}),
      }),
    });

    if (res.status === 429) {
      if (attempt === MAX_RETRIES) throw new Error("Rate limit: спробуйте через хвилину");
      const waitSec = Math.ceil(delay / 1000);
      for (let s = waitSec; s > 0; s--) {
        if (onWait) onWait(s);
        await new Promise(r => setTimeout(r, 1000));
        if (signal?.aborted) throw new Error("AbortError");
      }
      delay = Math.min(delay * 1.5, 60000);
      continue;
    }
    if (res.status === 400) {
      let errData = {};
      try { errData = await res.json(); } catch { }
      const msg = errData?.error?.message || "";
      if (msg.includes("usage limits") || msg.includes("regain access")) {
        throw new Error("💳 Вичерпано місячний ліміт API. Поповніть баланс або підніміть ліміт на console.anthropic.com");
      }
      throw new Error("API 400: " + (msg || "Bad Request"));
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error("API " + res.status + " " + errText.slice(0, 200));
    }

    // --- Streaming path ---
    if (useStream) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      let buffer = "";
      let inputTokens = 0, outputTokens = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (signal?.aborted) throw new Error("AbortError");
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (!raw || raw === "[DONE]") continue;
            try {
              const evt = JSON.parse(raw);
              if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
                fullText += evt.delta.text;
              } else if (evt.type === "message_start" && evt.message?.usage) {
                inputTokens = evt.message.usage.input_tokens || 0;
              } else if (evt.type === "message_delta" && evt.usage) {
                outputTokens = evt.usage.output_tokens || 0;
              }
            } catch { /* ignore malformed chunks */ }
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (inputTokens || outputTokens) {
        const PRICES = { [MODEL]: { in: 3, out: 15 }, [MODEL_FAST]: { in: 0.80, out: 4 } };
        const p = PRICES[model || MODEL] || PRICES[MODEL];
        const cost = (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
        window.dispatchEvent(new CustomEvent("apicost", { detail: { cost, model: model || MODEL, inTok: inputTokens, outTok: outputTokens } }));
      }
      return fullText;
    }

    // --- Non-streaming path (short JSON tasks) ---
    const data = await res.json();
    if (!data.content) {
      console.error("Claude API unexpected response:", JSON.stringify(data).slice(0, 300));
      throw new Error("No content in response: " + JSON.stringify(data).slice(0, 200));
    }
    if (data.usage) {
      const PRICES = { [MODEL]: { in: 3, out: 15 }, [MODEL_FAST]: { in: 0.80, out: 4 } };
      const p = PRICES[model || MODEL] || PRICES[MODEL];
      const cost = (data.usage.input_tokens * p.in + data.usage.output_tokens * p.out) / 1_000_000;
      window.dispatchEvent(new CustomEvent("apicost", { detail: { cost, model: model || MODEL, inTok: data.usage.input_tokens, outTok: data.usage.output_tokens } }));
    }
    return data.content.map(b => b.text || "").join("") || "";
  }
}

async function callGemini(messages, signal, systemPrompt, maxTokens, onWait, model, jsonMode) {
  const MAX_RETRIES = 5;
  let delay = 12000;

  const toGeminiPart = (c) => {
    if ((c.type === "document" || c.type === "image") && c.source?.type === "base64")
      return { inlineData: { mimeType: c.source.media_type || "application/pdf", data: c.source.data } };
    return { text: c.text || c.content || "" };
  };

  const contents = messages.map((msg, i) => {
    if (Array.isArray(msg.content)) {
      const parts = msg.content.map(toGeminiPart);
      if (i === 0 && systemPrompt) {
        const firstTextIdx = parts.findIndex(p => p.text !== undefined);
        if (firstTextIdx >= 0) parts[firstTextIdx] = { text: systemPrompt + "\n\n" + parts[firstTextIdx].text };
        else parts.unshift({ text: systemPrompt });
      }
      return { role: msg.role === "assistant" ? "model" : "user", parts };
    }
    return {
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: (i === 0 && systemPrompt ? systemPrompt + "\n\n" : "") + (msg.content || "") }],
    };
  });

  const body = {
    _model: model || "gemini-2.5-flash",
    contents,
    generationConfig: { maxOutputTokens: maxTokens || 8000, thinkingConfig: { thinkingBudget: 0 }, ...(jsonMode ? { responseMimeType: "application/json" } : {}) },
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch("/api/gemini", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status === 503) {
      if (attempt === MAX_RETRIES) throw new Error(res.status === 503 ? "Gemini перевантажений, спробуйте ще раз" : "Rate limit: спробуйте через хвилину");
      const waitSec = Math.ceil(delay / 1000);
      for (let s = waitSec; s > 0; s--) {
        if (onWait) onWait(s);
        await new Promise(r => setTimeout(r, 1000));
        if (signal?.aborted) { const e = new Error("AbortError"); e.name = "AbortError"; throw e; }
      }
      delay = Math.min(delay * 1.5, 60000);
      continue;
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error("Gemini API " + res.status + ": " + errText.slice(0, 200));
    }
    const data = await res.json();
    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason;
    if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
      throw new Error(`Gemini зупинився: ${finishReason}. ${candidate?.content ? "" : "Відповідь порожня."}`);
    }
    const text = candidate?.content?.parts?.filter(p => !p.thought)?.map(p => p.text || "").join("") || "";
    if (!text) {
      console.error("Gemini порожня відповідь. Raw:", JSON.stringify(data).slice(0, 500));
      throw new Error("Gemini: порожня відповідь" + (finishReason ? ` (${finishReason})` : ""));
    }
    if (data.usageMetadata) {
      const cost = (data.usageMetadata.promptTokenCount * 0.075 + data.usageMetadata.candidatesTokenCount * 0.30) / 1_000_000;
      window.dispatchEvent(new CustomEvent("apicost", { detail: { cost, model: "gemini-2.5-flash", inTok: data.usageMetadata.promptTokenCount, outTok: data.usageMetadata.candidatesTokenCount } }));
    }
    return text;
  }
}

function buildPlanText(secs) {
  const intro = secs.find(s => s.type === "intro");
  const concs = secs.find(s => s.type === "conclusions");
  const srcs = secs.find(s => s.type === "sources");
  const main = secs.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
  const lines = [];
  if (intro) lines.push("ВСТУП\n");
  const groups = {};
  for (const s of main) { const top = s.id.split(".")[0]; if (!groups[top]) groups[top] = []; groups[top].push(s); }
  for (const [num, items] of Object.entries(groups)) {
    const rawTitle = items[0].sectionTitle || items[0].label.replace(/^\d+\.\d+\s+/, "").split(" ").slice(0, 7).join(" ").toUpperCase();
    const alreadyHasPrefix = rawTitle.trim().toUpperCase().startsWith(`РОЗДІЛ ${num}`);
    const secLabel = alreadyHasPrefix ? rawTitle.trim() : `РОЗДІЛ ${num}. ${rawTitle}`;
    lines.push(secLabel);
    for (const s of items) { if (/^\d+\.\d+/.test(s.id)) lines.push(`    ${s.label}`); }
    const chapConc = secs.find(s => s.type === "chapter_conclusion" && s.id === `${num}.conclusions`);
    if (chapConc) lines.push(`    ${chapConc.label}`);
    lines.push("");
  }
  if (concs) lines.push("ВИСНОВКИ\n");
  if (srcs) lines.push("СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ");
  return lines.join("\n");
}

function buildPreviewStructure(totalPages) {
  return [
    { label: "ВСТУП", sub: [] },
    { label: "РОЗДІЛ 1. Теоретичні основи дослідження", sub: ["1.1 [підрозділ 1.1]", "1.2 [підрозділ 1.2]", "1.3 [підрозділ 1.3]"] },
    { label: "РОЗДІЛ 2. Аналітично-практична частина", sub: ["2.1 [підрозділ 2.1]", "2.2 [підрозділ 2.2]", "2.3 [підрозділ 2.3]"] },
    ...(totalPages >= 70 ? [{ label: "РОЗДІЛ 3. Рекомендації та пропозиції", sub: ["3.1 [підрозділ 3.1]", "3.2 [підрозділ 3.2]"] }] : []),
    { label: "ВИСНОВКИ", sub: [] },
    { label: "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", sub: [] },
  ];
}

function calcSourceDist(secs, overallPages) {
  const mainSecs = secs.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
  const secPagesSum = mainSecs.reduce((sum, s) => sum + (s.pages || 0), 0);
  if (!secPagesSum) return { dist: {}, total: 0 };
  // К-сть джерел = к-сті сторінок основного тексту роботи
  const total = Math.max(mainSecs.length * 2, overallPages || secPagesSum);
  const minPerSec = Math.max(1, Math.floor(total / mainSecs.length / 2));
  const dist = {}; let assigned = 0;
  mainSecs.forEach((s, i) => {
    if (i === mainSecs.length - 1) { dist[s.id] = Math.max(minPerSec, total - assigned); }
    else { const share = Math.max(minPerSec, Math.round((s.pages / secPagesSum) * total)); dist[s.id] = share; assigned += share; }
  });
  return { dist, total: Object.values(dist).reduce((a, b) => a + b, 0) };
}

// ─────────────────────────────────────────────
// WorkConfig — єдина точка розрахунку параметрів роботи
// ─────────────────────────────────────────────
function buildWorkConfig({ info, methodInfo, commentAnalysis }) {
  const totalPages = parsePagesAvg(info?.pages);

  // introPages: методичка → textStructureHints → дефолт 2
  let introPages = 2;
  if (methodInfo?.introPages) {
    introPages = methodInfo.introPages;
  } else if (commentAnalysis?.textStructureHints) {
    const m = commentAnalysis.textStructureHints.match(/вступ[^.\d]{0,20}(\d+)\s*стор/i);
    if (m) introPages = parseInt(m[1]);
  }

  // conclusionsPages: методичка → textStructureHints → дефолт
  let conclusionsPages = totalPages > 40 ? 3 : 2;
  if (methodInfo?.conclusionsPages) {
    conclusionsPages = methodInfo.conclusionsPages;
  } else if (commentAnalysis?.textStructureHints) {
    const m = commentAnalysis.textStructureHints.match(/висновк[^.\d]{0,20}(\d+)\s*стор/i);
    if (m) conclusionsPages = parseInt(m[1]);
  }

  // sourcesMinCount: методичка → дефолт по обсягу
  const sourcesMinCount = methodInfo?.sourcesMinCount || (totalPages >= 40 ? 40 : 20);

  return {
    totalPages,
    introPages,
    conclusionsPages,
    chapConclusionPages: 1,
    sourcesMinCount,
    sourcesStyle: methodInfo?.sourcesStyle || "ДСТУ 8302:2015",
    sourcesOrder: methodInfo?.sourcesOrder || "alphabetical",
    sourcesGrouping: methodInfo?.sourcesGrouping || "",
    citationStyle: methodInfo?.citationStyle || "(Автор, рік)",
  };
}

// ─────────────────────────────────────────────
// UI components
// ─────────────────────────────────────────────
const TA = { width: "100%", background: "#f0ece2", border: "1.5px solid #d4cfc4", borderRadius: 6, color: "#1a1a14", fontSize: 14, padding: "12px 14px", resize: "vertical", lineHeight: "1.75", fontFamily: "'Spectral',Georgia,serif" };
const TA_WHITE = { ...TA, background: "#fff", fontSize: 13 };

function SpinDot({ light }) {
  const c = light ? "#e8ff47" : "#1a1a14";
  return <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", border: `2px solid ${c}33`, borderTop: `2px solid ${c}`, animation: "spin .7s linear infinite", flexShrink: 0 }} />;
}
function Shimmer({ width = "100%", height = 13 }) {
  return <div style={{ width, height, borderRadius: 4, background: "linear-gradient(90deg,#e8e4da 25%,#f5f2ea 50%,#e8e4da 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.4s infinite" }} />;
}
function StagePills({ stage, maxStageIdx, onNavigate }) {
  const cur = STAGE_KEYS.indexOf(stage);
  const maxReached = maxStageIdx ?? cur;
  return <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
    {STAGES.map((l, i) => {
      const isClickable = i <= maxReached && onNavigate;
      return (
        <div key={i}
          onClick={isClickable ? () => onNavigate(STAGE_KEYS[i]) : undefined}
          style={{
            padding: "4px 12px", borderRadius: 20, fontSize: 11, letterSpacing: "1px",
            background: i === cur ? "#e8ff47" : i < cur ? "#1e2a00" : i <= maxReached ? "#2a3a00" : "transparent",
            color: i === cur ? "#111" : i < cur ? "#6a9000" : i <= maxReached ? "#8aaa30" : "#555",
            border: `1px solid ${i === cur ? "#e8ff47" : i < cur ? "#3a5000" : i <= maxReached ? "#4a6a00" : "#444"}`,
            cursor: isClickable ? "pointer" : "default",
          }}>
          {i < cur ? "✓ " : i > cur && i <= maxReached ? "↩ " : ""}{l}
        </div>
      );
    })}
  </div>;
}
function FieldBox({ label, children }) {
  return <div style={{ marginBottom: 16 }}>
    <div style={{ fontSize: 11, color: "#888", letterSpacing: "2px", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
    {children}
  </div>;
}
function Heading({ children, style = {} }) {
  return <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 17, letterSpacing: 2, marginBottom: 20, ...style }}>{children}</div>;
}
function NavBtn({ onClick, children, disabled }) {
  return <button onClick={onClick} disabled={disabled} style={{ background: "transparent", border: "1.5px solid #c4bfb4", color: disabled ? "#ccc" : "#777", borderRadius: 7, padding: "11px 22px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: disabled ? "default" : "pointer" }}>{children}</button>;
}
function PrimaryBtn({ onClick, disabled, loading, msg, label }) {
  return <button onClick={onClick} disabled={disabled || loading} style={{ background: (disabled || loading) ? "#aaa" : "#1a1a14", color: (disabled || loading) ? "#eee" : "#e8ff47", border: "none", borderRadius: 7, padding: "11px 34px", fontFamily: "'Spectral',serif", fontSize: 13, letterSpacing: "1.5px", cursor: (disabled || loading) ? "default" : "pointer" }}>
    {loading ? <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><SpinDot light />{msg}</span> : label}
  </button>;
}
function GreenBtn({ onClick, disabled, loading, msg, label }) {
  return <button onClick={onClick} disabled={disabled || loading} style={{ background: (disabled || loading) ? "#aaa" : "#2a3a1a", color: (disabled || loading) ? "#eee" : "#a8d060", border: "none", borderRadius: 7, padding: "10px 24px", fontFamily: "'Spectral',serif", fontSize: 12, letterSpacing: "1px", cursor: (disabled || loading) ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
    {loading ? <><SpinDot light />{msg}</> : label}
  </button>;
}

function SaveIndicator({ saving, saved }) {
  if (saving) return <span style={{ fontSize: 11, color: "#aaa", display: "inline-flex", alignItems: "center", gap: 5 }}><SpinDot />Збереження...</span>;
  if (saved) return <span style={{ fontSize: 11, color: "#6a9000" }}>✓ Збережено</span>;
  return null;
}

function StructurePreview({ totalPages }) {
  const items = buildPreviewStructure(totalPages);
  return <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 18 }}>
    <div style={{ background: "#1a1a14", color: "#e8ff47", padding: "10px 18px", fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 3 }}>СТРУКТУРА (попередній перегляд)</div>
    <div style={{ padding: "14px 18px", background: "#faf8f3" }}>
      {items.map((item, i) => (
        <div key={i} style={{ marginBottom: item.sub.length ? 10 : 6 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#1a1a14", marginBottom: 4 }}>{item.label}</div>
          {item.sub.map((s, j) => <div key={j} style={{ fontSize: 12, color: "#888", paddingLeft: 20, marginBottom: 2 }}>{s}</div>)}
        </div>
      ))}
    </div>
  </div>;
}

function PlanLoadingSkeleton() {
  return <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 18 }}>
    <div style={{ background: "#1a1a14", color: "#e8ff47", padding: "10px 18px", display: "flex", alignItems: "center", gap: 10, fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 3 }}>
      <SpinDot light /> ГЕНЕРУЮ ПЛАН...
    </div>
    <div style={{ padding: "18px", background: "#faf8f3", display: "flex", flexDirection: "column", gap: 11 }}>
      <Shimmer width="55%" height={15} /><div style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 8 }}><Shimmer width="72%" /><Shimmer width="64%" /><Shimmer width="69%" /></div>
      <Shimmer width="50%" height={15} /><div style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 8 }}><Shimmer width="68%" /><Shimmer width="58%" /></div>
      <Shimmer width="28%" height={13} /><Shimmer width="44%" height={13} />
    </div>
  </div>;
}

function DropZone({ fileLabel, onFile }) {
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef();
  const handleDrop = useCallback(e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) processFile(f); }, []);
  function processFile(f) { const r = new FileReader(); r.onload = ev => onFile(f.name, ev.target.result.split(",")[1], f.type); r.readAsDataURL(f); }
  return <>
    <div onClick={() => fileRef.current.click()} onDrop={handleDrop} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
      style={{ minHeight: 90, border: `1.5px dashed ${dragging ? "#1a1a14" : "#c4bfb4"}`, borderRadius: 6, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, cursor: "pointer", padding: 14, background: dragging ? "#e8e4d8" : "#ede9e0", transition: "all .2s" }}>
      <div style={{ fontSize: 24 }}>{fileLabel ? "📄" : "⬆️"}</div>
      <div style={{ fontSize: 12, color: "#888", textAlign: "center" }}>{fileLabel || "Перетягніть або клікніть для вибору PDF"}</div>
      {fileLabel && <div style={{ fontSize: 10, color: "#aaa" }}>(клікніть щоб замінити)</div>}
    </div>
    <input ref={fileRef} type="file" accept=".pdf" style={{ display: "none" }} onChange={e => { const f = e.target.files[0]; if (f) processFile(f); }} />
  </>;
}

function PhotoDropZone({ photos, onAdd, onRemove }) {
  const fileRef = useRef();
  const [dragging, setDragging] = useState(false);

  function processFiles(files) {
    Array.from(files).forEach(f => {
      if (!f.type.startsWith("image/")) return;
      const r = new FileReader();
      r.onload = ev => onAdd({ name: f.name, b64: ev.target.result.split(",")[1], type: f.type });
      r.readAsDataURL(f);
    });
  }

  return (
    <div>
      <div
        onClick={() => fileRef.current.click()}
        onDrop={e => { e.preventDefault(); setDragging(false); processFiles(e.dataTransfer.files); }}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        style={{ minHeight: 60, border: `1.5px dashed ${dragging ? "#1a1a14" : "#c4bfb4"}`, borderRadius: 6, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, cursor: "pointer", padding: 10, background: dragging ? "#e8e4d8" : "#ede9e0", transition: "all .2s" }}
      >
        <div style={{ fontSize: 20 }}>🖼️</div>
        <div style={{ fontSize: 12, color: "#888", textAlign: "center" }}>Перетягніть або клікніть для вибору фото</div>
      </div>
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple style={{ display: "none" }} onChange={e => { processFiles(e.target.files); e.target.value = ""; }} />
      {photos.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {photos.map((p, i) => (
            <div key={i} style={{ position: "relative", display: "inline-block" }}>
              <img src={`data:${p.type};base64,${p.b64}`} alt={p.name} style={{ height: 56, width: 56, objectFit: "cover", borderRadius: 4, border: "1px solid #c4bfb4" }} />
              <button onClick={() => onRemove(i)} style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%", background: "#8a1a1a", color: "#fff", border: "none", cursor: "pointer", fontSize: 11, lineHeight: "18px", padding: 0 }}>×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ClientPlanInput({ onExtracted, extracted }) {
  const fileRef = useRef();
  const [extracting, setExtracting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [previewSrc, setPreviewSrc] = useState(null);

  async function handlePhoto(file) {
    if (!file || !file.type.startsWith("image/")) return;
    setExtracting(true);
    try {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = e => { setPreviewSrc(e.target.result); res(e.target.result.split(",")[1]); };
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      const raw = await callClaude([{
        role: "user", content: [
          { type: "image", source: { type: "base64", media_type: file.type, data: b64 } },
          { type: "text", text: "Extract the table of contents / plan from this image. Copy all lines exactly as they appear (chapter numbers, subsection numbers, titles). Return only the plain text of the plan, no explanations." }
        ]
      }], null, "Return only plain text, no markdown.", 800, null, MODEL_FAST);
      onExtracted(raw.trim());
    } catch (e) {
      console.warn("plan photo extract failed:", e.message);
    } finally {
      setExtracting(false);
      setDragging(false);
    }
  }

  function onDrop(e) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handlePhoto(file);
  }

  return <>
    <div
      onClick={() => !extracting && fileRef.current.click()}
      onDrop={onDrop}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      style={{ minHeight: 90, border: `1.5px dashed ${dragging ? "#5a8a30" : "#c4bfb4"}`, borderRadius: 6, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, cursor: extracting ? "wait" : "pointer", padding: 14, background: dragging ? "#e8e4d8" : "#ede9e0", transition: "all .2s" }}
    >
      {extracting
        ? <><div style={{ fontSize: 22 }}>⏳</div><div style={{ fontSize: 12, color: "#888" }}>Розпізнаю план...</div></>
        : previewSrc && extracted
          ? <><img src={previewSrc} alt="" style={{ maxHeight: 56, maxWidth: "100%", borderRadius: 4, objectFit: "contain" }} /><div style={{ fontSize: 11, color: "#5a8a30" }}>✓ План розпізнано</div><div style={{ fontSize: 10, color: "#aaa" }}>(клікніть щоб замінити)</div></>
          : <><div style={{ fontSize: 22 }}>📷</div><div style={{ fontSize: 12, color: "#888", textAlign: "center" }}>Перетягніть або клікніть для вибору фото плану</div></>
      }
    </div>
    <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
      onChange={e => { const f = e.target.files[0]; if (f) handlePhoto(f); e.target.value = ""; }} />
  </>;
}

// ─────────────────────────────────────────────
// Firestore helpers
// ─────────────────────────────────────────────
function serializeForFirestore(obj) {
  // Firestore не приймає undefined — замінюємо на null
  return JSON.parse(JSON.stringify(obj, (_, v) => v === undefined ? null : v));
}

// ─────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────
export default function AcademAssist({ orderId, onOrderCreated, onBack }) {
  const { user } = useAuth();

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
  const [citInputs, setCitInputs] = useState({});
  const [docxLoading, setDocxLoading] = useState(false);
  const [planDocxLoading, setPlanDocxLoading] = useState(false);
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
  // For regenerating a single section
  const [regenId, setRegenId] = useState(null);
  const [regenPrompt, setRegenPrompt] = useState("");
  const [regenLoading, setRegenLoading] = useState(false);
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
  const [showMissingSources, setShowMissingSources] = useState(false);
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
  useEffect(() => { contentRef.current = content; }, [content]);

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
          if (d.refList) setRefList(d.refList);
          if (d.speechText) setSpeechText(d.speechText);
          if (d.appendicesText) setAppendicesText(d.appendicesText);
          if (d.titlePage) setTitlePage(d.titlePage);
          if (d.slideJson) setSlideJson(d.slideJson);
          if (d.presentationReady) setPresentationReady(true);
          if (d.stage) { setStage(d.stage); setMaxStageIdx(Math.max(0, STAGE_KEYS.indexOf(d.stage))); }
          if (d.genIdx !== undefined) setGenIdx(d.genIdx);
        }
      } catch (e) { console.error("Load error:", e); }
      setDbLoading(false);
    };
    load();
  }, [orderId, user]);

  // Оновлюємо maxStageIdx коли просуваємось вперед
  useEffect(() => {
    const idx = STAGE_KEYS.indexOf(stage);
    if (idx >= 0) setMaxStageIdx(prev => Math.max(prev, idx));
  }, [stage]);

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
      setTimeout(() => setSaved(false), 3000);
    } catch (e) { console.error("Save error:", e); }
    setSaving(false);
  };

  const handleFile = (name, b64, type) => { setFileLabel(name); setFileB64(b64); setFileType(type); };

  // ── Аналіз шаблону ──
  const doAnalyze = async () => {
    setRunning(true); runningRef.current = true; setLoadMsg("Аналізую шаблон...");

    // КРОК 1: Аналіз шаблону замовлення (тільки текст, без PDF)
    const msgs = [];
    msgs.push({ type: "text", text: `Проаналізуй шаблон замовлення.\n\nШАБЛОН:\n${tplText}\n${comment ? "\nКОМЕНТАР: " + comment : ""}\n\nПоверни ТІЛЬКИ JSON (без markdown):\n{"type":"","pages":"","topic":"","subject":"","direction":"","uniqueness":"","language":"Українська","deadline":"","extras":"","methodNotes":"","sourceCount":"30-40"}` });
    let newInfo;
    try {
      const raw = await callClaude([{ role: "user", content: msgs }], null, "Respond only with valid JSON. No markdown, no explanation.", 1000, null, MODEL_FAST);
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
        {
          type: "text", text: `Уважно прочитай методичку повністю і витягни всю структурну та оформлювальну інформацію.

Поверни ТІЛЬКИ JSON (без markdown, без коментарів):
{
  "totalPages": 30,
  "introPages": null,
  "conclusionsPages": null,
  "chaptersCount": 2,
  "subsectionsPerChapter": 2,
  "hasChapterConclusions": false,
  "chapterTypes": ["theory","analysis"],
  "exampleTOC": "ВСТУП\nРОЗДІЛ 1. Назва\n1.1 Підрозділ\n1.2 Підрозділ\nРОЗДІЛ 2. Назва\n2.1 Підрозділ\n2.2 Підрозділ\nВИСНОВКИ\nСПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ",
  "introComponents": ["актуальність теми", "мета дослідження", "завдання", "об'єкт", "предмет", "методи", "матеріал дослідження", "наукова новизна", "структура роботи"],
  "theoryRequirements": "огляд літератури, теоретичні засади, закінчується висновком про необхідність дослідження",
  "analysisRequirements": "результати власних досліджень, лінгвістичне обґрунтування",
  "chapterConclusionRequirements": "коротка суть результатів, до 1 сторінки",
  "conclusionsRequirements": "пронумерований список конкретних результатів, без загальних формулювань",
  "sourcesMinCount": null,
  "sourcesStyle": "APA",
  "sourcesOrder": "alphabetical",
  "sourcesGrouping": "спочатку українські, потім англійські/польські/чеські, наприкінці східною мовою",
  "citationStyle": "(Автор, рік) або (Автор, рік, с. 25)",
  "formatting": {
    "font": "Times New Roman",
    "fontSize": 14,
    "lineSpacing": 1.5,
    "margins": {"left": 20, "right": 10, "top": 20, "bottom": 20},
    "indent": 1.25,
    "pageNumbers": "правий верхній кут, арабські цифри",
    "chapterHeading": "великими літерами, по центру, напівжирний, РОЗДІЛ 1 з нового рядка потім назва",
    "subsectionHeading": "малі літери (перша велика), з абзацного відступу, по ширині, після номера крапка напр. 2.3.",
    "tableFormat": "Таблиця 1.2 у правому верхньому куті, назва жирним по центру після номера",
    "figureFormat": "Рис. 1.2 під ілюстрацією, нумерація в межах розділу",
    "noLongDash": true
  },
  "requiredSections": ["титульний аркуш", "зміст", "вступ", "основна частина", "висновки", "список використаних джерел"],
  "optionalSections": ["перелік умовних позначень", "анотація іноземною мовою", "додатки"],
  "otherRequirements": "виклад від першої особи множини (ми вважаємо) або безособові конструкції",
  "recommendedSources": "Список рекомендованих джерел з методички: конкретні автори, видання, підручники, журнали. null якщо не вказано",
  "titlePageTemplate": "МІНІСТЕРСТВО ОСВІТИ І НАУКИ УКРАЇНИ\nНазва університету\nКафедра назва\n\nКУРСОВА РОБОТА\nна тему:\n[ТЕМА]\n\nВиконав(ла): студент(ка) групи\nПрізвище Ім'я По-батькові\n\nНауковий керівник:\nПосада, ПІБ\n\nМісто – рік",
  "requiredTables": null,
  "requiredFormulas": null
}

Правила:
- totalPages: загальний обсяг роботи в сторінках (число, не рахуючи додатки і список джерел)
- introPages: обсяг вступу в сторінках (null якщо не вказано явно)
- conclusionsPages: обсяг висновків в сторінках (null якщо не вказано явно)
- chaptersCount: к-сть розділів (null якщо не вказано)
- subsectionsPerChapter: порахуй к-сть підрозділів в одному розділі з exampleTOC (null якщо не вказано)
- hasChapterConclusions: true ВИКЛЮЧНО якщо в методичці є явна пряма вимога "висновки до розділу" або "висновки до кожного розділу". Якщо немає такого тексту — завжди false
- introComponents: точний перелік елементів вступу згідно методички
- sourcesStyle: "APA", "ДСТУ 8302:2015", "MLA" або інший — точно як у методичці
- sourcesOrder: "alphabetical" або "citation_order"
- sourcesGrouping: якщо є правила групування джерел за мовами — вкажи
- citationStyle: як оформляти посилання в тексті (в дужках, у виносках тощо)
- recommendedSources: якщо в методичці є список рекомендованої літератури або конкретні автори/видання для використання — перелічи їх одним рядком через крапку з комою. null якщо таких рекомендацій немає
- titlePageTemplate: якщо в методичці є зразок титульної сторінки — відтвори його структуру як plain text, кожен рядок з нового рядка (\n). Де має бути тема роботи — постав плейсхолдер [ТЕМА]. Якщо зразка немає — поверни null (НЕ вигадуй)
- formatting: всі деталі оформлення — шрифт, розміри, поля, відступи, нумерація
- exampleTOC: шукай ВИКЛЮЧНО розділ/додаток зі словами "зразок змісту", "зразок плану", "приклад змісту", "приклад плану", "зразок оформлення змісту" — тобто явний приклад структури СТУДЕНТСЬКОЇ роботи. Просто "ЗМІСТ" на початку документа (зміст самої методички) — ІГНОРУЙ повністю. Якщо знайшов справжній зразок — скопіюй лише рядки плану (ВСТУП, РОЗДІЛ 1, 1.1, 1.2, ВИСНОВКИ тощо). Якщо такого зразка НЕ знайшов — поверни null (не вигадуй).
- Якщо exampleTOC = null: тоді уважно проаналізуй розділ "Структура роботи" або "Структура та зміст роботи" і витягни з нього: chaptersCount (к-сть розділів), subsectionsPerChapter (к-сть підрозділів), hasChapterConclusions (чи потрібні висновки до розділів), chapterTypes (теоретичний/аналітичний/практичний тощо), otherRequirements (що має бути в кожному розділі)
- requiredTables: шукай таблиці які СТУДЕНТ МАЄ ЗАПОВНИТИ у своїй роботі (не таблиці всередині самої методички з критеріями/шкалами). Якщо знайшов — поверни масив об'єктів: [{"name":"назва таблиці","structure":"markdown рядок заголовків таблиці з плейсхолдерами наприклад |Показник|Рік 1|Рік 2|","section":"analysis або recommendations — в якому типі розділу має з'явитись","instructions":"що саме заповнювати в цю таблицю"}]. null якщо таких таблиць немає.
- requiredFormulas: шукай формули/розрахунки які студент має виконати у роботі. Поверни масив: [{"name":"назва показника","formula":"формула у вигляді plain text, наприклад β = Σ(kij × pi) / (m × n)","variables":"опис кожної змінної через крапку з комою","interpretation":"шкала інтерпретації результату якщо є в методичці","section":"analysis або recommendations"}]. null якщо формул немає.` }
      ];
      try {
        const raw = await callGemini([{ role: "user", content: methodMsgs }], null, "Respond only with valid JSON. No markdown, no comments.", 8000, (s) => setLoadMsg(`Читаю методичку... зачекайте ${s}с`), "gemini-2.5-flash", true);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
        setMethodInfo(parsed);
        if (parsed.titlePageTemplate) {
          const filled = parsed.titlePageTemplate.replace(/\[ТЕМА\]/g, newInfo?.topic || "[ТЕМА]");
          setTitlePage(filled);
          await saveToFirestore({ tplText, comment, clientPlan, info: newInfo, methodInfo: parsed, fileLabel, titlePage: filled, stage: "parsed", status: "new" });
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
        caContent.push({
          type: "text", text: `Проаналізуй${photos.length > 0 ? " фото та" : ""} коментар клієнта до академічної роботи на тему "${newInfo?.topic || ""}". Витягни конкретні підказки для виконавця.${comment?.trim() ? `\nКОМЕНТАР КЛІЄНТА:\n${comment}` : ""}${photos.length > 0 ? `\n\nФОТО: ${photos.length} зображень.` : ""}

Поверни ТІЛЬКИ JSON (без markdown):
{"planHints":"підказки для СТРУКТУРИ ПЛАНУ: к-сть розділів, назви розділів, висновки до розділів тощо. null якщо немає","textStructureHints":"підказки для СТРУКТУРИ ТЕКСТУ: що має бути у вступі чи висновках, вимоги до обсягів розділів у сторінках, особливі акценти. null якщо немає","writingHints":"підказки для СТИЛЮ ТА ЗМІСТУ написання: термінологія, підходи, що підкреслити, на що звернути увагу. null якщо немає","sourcesHints":"підказки для ДЖЕРЕЛ ТА ОФОРМЛЕННЯ: к-сть джерел, мова джерел, стиль цитування, конкретні автори або видання. null якщо немає","photoTOC":"якщо на фото є готовий план/зміст роботи (рядки виду Chapter 1 / Розділ 1, 1.1, 1.2, Introduction тощо) — скопіюй його текст дослівно. Якщо плану на фото немає — null"}` });
        const caRaw = await callClaude([{ role: "user", content: caContent }],
          null, "Respond only with valid JSON. No markdown.", 600, null, MODEL_FAST);
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
  const parseClientPlan = (text, totalPages) => {
    const normalized = text
      .replace(/([^\n])\s+(Розділ\s)/gi, "$1\n$2")
      .replace(/([^\n])\s+(Chapter\s)/gi, "$1\n$2")
      .replace(/([^\n])\s+(висновк\w*)/gi, "$1\n$2")
      .replace(/([^\n])\s+(список\s)/gi, "$1\n$2")
      .replace(/([^\n])\s+(вступ\s|вступ$)/gi, "$1\n$2");
    const lines = normalized.split("\n").map(l => l.trim()).filter(Boolean);
    const chapters = []; let current = null;
    for (const line of lines) {
      const isChapter = /^розділ\s/i.test(line) || /^chapter\s/i.test(line) || /^\d+[\.\)]\s+[А-ЯҐЄІЇа-яґєії]/i.test(line);
      const isSubsection = /^\d+\.\d+/.test(line) || /^[-–•]\s+/.test(line);
      const isChapterConclusion = /^висновк\w*\s+до\s+(\d+\s+|\w+\s+)?(розділ|chapter)/i.test(line);
      const isSpecial = !isChapterConclusion && /^(вступ[\s,\.!]?$|вступ\s|висновк|список|загальн|практичн|додатк|зміст)/i.test(line);
      if (isSpecial) continue;
      if (isChapterConclusion && current) { current.hasConclusion = true; continue; }
      if (isChapter) { current = { title: line.trim(), subsections: [], hasConclusion: false }; chapters.push(current); }
      else if (isSubsection && current) current.subsections.push(line.replace(/^[-–•]\s+/, "").trim());
    }
    if (!chapters.length) return null;
    const mainPages = Math.round(totalPages * 0.80);
    const pagesPerChapter = Math.max(1, Math.round(mainPages / chapters.length));
    const introPages = 2;
    const concPages = totalPages > 40 ? 3 : 2;
    const sections = []; let chapNum = 0;
    for (const ch of chapters) {
      chapNum++;
      const subs = ch.subsections;
      const pagesPerSub = Math.max(1, Math.round(pagesPerChapter / Math.max(subs.length, 1)));
      const chType = chapNum === 1 ? "theory" : chapNum === 2 ? "analysis" : "recommendations";
      if (subs.length === 0) {
        sections.push({ id: `${chapNum}`, label: ch.title, sectionTitle: ch.title.toUpperCase(), pages: pagesPerChapter, type: chType });
      } else {
        for (let i = 0; i < subs.length; i++) {
          const hasNum = /^\d+\.\d+/.test(subs[i]);
          sections.push({ id: `${chapNum}.${i + 1}`, label: hasNum ? subs[i] : `${chapNum}.${i + 1} ${subs[i]}`, sectionTitle: ch.title.toUpperCase(), pages: pagesPerSub, type: chType });
        }
      }
      if (ch.hasConclusion) {
        sections.push({ id: `${chapNum}.conclusions`, label: `Висновки до розділу ${chapNum}`, sectionTitle: ch.title.toUpperCase(), pages: 1, type: "chapter_conclusion", chapterNum: String(chapNum) });
      }
    }
    sections.push({ id: "intro", label: "ВСТУП", pages: introPages, type: "intro" });
    sections.push({ id: "conclusions", label: "ВИСНОВКИ", pages: concPages, type: "conclusions" });
    sections.push({ id: "sources", label: "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", pages: 1, type: "sources" });
    return sections;
  };

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
      const withPrompts = secs.map(s => ({ ...s, prompts: s.type === "sources" ? 0 : Math.max(1, Math.ceil((s.pages || 1) / 3)) }));
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
        const chapConclCount = (toc.match(/висновк\w*\s+до\s+розділ|conclusions?\s+to\s+chapter/gi) || []).length;
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
        const raw = await callGemini([{ role: "user", content: photoTplPrompt }], null, "Respond only with valid JSON. No markdown.", 3000);
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
        const chapConclCount = (comment.match(/висновки до розділ/gi) || []).length;
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
  {"id":"1.conclusions","label":"${L.chapConclLabel(1)}","sectionTitle":"${L.chapterWord} 1. CHAPTER TITLE","pages":1,"type":"chapter_conclusion"},
  {"id":"intro","label":"${L.intro}","pages":3,"type":"intro"},
  {"id":"conclusions","label":"${L.conclusions}","pages":3,"type":"conclusions"},
  {"id":"sources","label":"${L.sources}","pages":2,"type":"sources"}
]}`;
        await new Promise(r => setTimeout(r, 1000));
        const raw = await callGemini([{ role: "user", content: templatePrompt }], null, "Respond only with valid JSON. No markdown.", 3000);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
        const secs = parsed.sections || parsed;
        if (Array.isArray(secs) && secs.length > 3) { await finalizeSections(secs); return; }
      } catch (e) { console.warn("comment template plan failed:", e.message); }
    }

    const commentHasConcl = commentAnalysis?.planHints ? /висновк\w*\s+до\s+розділ/i.test(commentAnalysis.planHints) : false;

    if (methodInfo) {
      // Маємо готову структурну інфу з методички — генеруємо план без PDF
      const chapCount = methodInfo.chaptersCount || (totalPages >= 40 ? 3 : 2);
      const hasConcl = methodInfo.hasChapterConclusions === true || commentHasConcl || false;
      const chTypes = methodInfo.chapterTypes?.length ? methodInfo.chapterTypes : ["theory", "analysis", "recommendations"].slice(0, chapCount);
      const chapConclP = hasConcl ? chapCount : 0;

      // Парсимо кількість підрозділів PER CHAPTER з exampleTOC (JS, не AI)
      const parseSubsPerChapter = (toc) => {
        if (!toc) return null;
        const lines = toc.split('\n').map(l => l.trim()).filter(Boolean);
        const chapters = [];
        let cur = null;
        for (const line of lines) {
          if (/^(вступ|висновки|список|додатки)/i.test(line)) continue;
          const isChHead = /^(розділ|chapter|section)/i.test(line) || /^\d+\.\s+[^\d]/.test(line);
          const isNumSub = /^\d+\.\d+/.test(line);
          if (isChHead) { cur = { subs: 0 }; chapters.push(cur); }
          else if (isNumSub && cur) cur.subs++;
        }
        return chapters.length ? chapters : null;
      };

      const subsPerChap = methodInfo.exampleTOC ? parseSubsPerChapter(methodInfo.exampleTOC) : null;
      const totalSubsCount = subsPerChap ? subsPerChap.reduce((s, c) => s + c.subs, 0) : (chapCount * (methodInfo.subsectionsPerChapter || 3));
      const pagesPerSub = Math.max(3, Math.round((totalPages - introP - conclP - chapConclP) / totalSubsCount));

      // Якщо є зразок плану з методички — використовуємо його як шаблон структури
      // Будуємо явний перелік структури по розділах (JS вже порахував)
      const chapterStructureHint = subsPerChap
        ? subsPerChap.map((ch, i) => `- Розділ ${i + 1}: ${ch.subs} підрозділ${ch.subs === 1 ? " (може бути без номера, як проєктний модуль)" : "и"}`).join('\n')
        : null;

      const planPrompt = methodInfo.exampleTOC
        ? `Create a plan for ${d.type} on topic: "${d.topic}". Field: ${d.subject}. Pages: ${totalPages}.
Language of work: ${d.language || "Ukrainian"} — all labels and titles must be in this language.
${commentAnalysis?.planHints ? `\nCLIENT HINTS:\n${commentAnalysis.planHints}\n` : ""}
STRUCTURE (fixed, from methodical guide — do NOT change subsection counts):
${chapterStructureHint || `- ${chapCount} chapters`}
- Chapter conclusions: ${hasConcl ? "YES" : "NO"}

EXAMPLE TOC FROM GUIDE (do NOT copy titles, structure already counted above):
${methodInfo.exampleTOC}
${methodInfo.otherRequirements ? `\nGUIDE REQUIREMENTS:\n${methodInfo.otherRequirements}` : ""}

PAGE DISTRIBUTION (must sum to exactly ${totalPages}):
- ${L.intro}: ${introP} p.
- ${L.conclusions}: ${conclP} p.
- Chapter conclusions: 1 p. each (if present)
- Each subsection: ~${pagesPerSub} p. (total: ${totalSubsCount})

Allowed type values: "theory" | "analysis" | "recommendations" | "chapter_conclusion" | "intro" | "conclusions" | "sources"
Chapter conclusion id format: "1.conclusions", "2.conclusions", "3.conclusions"

Return ONLY JSON without markdown:
{"sections":[
  {"id":"1.1","label":"1.1 Section title","sectionTitle":"${L.chapterWord} 1. CHAPTER TITLE","pages":8,"type":"theory"},
  {"id":"1.conclusions","label":"${L.chapConclLabel(1)}","sectionTitle":"${L.chapterWord} 1. CHAPTER TITLE","pages":1,"type":"chapter_conclusion"},
  {"id":"intro","label":"${L.intro}","pages":3,"type":"intro"},
  {"id":"conclusions","label":"${L.conclusions}","pages":3,"type":"conclusions"},
  {"id":"sources","label":"${L.sources}","pages":2,"type":"sources"}
]}
Order: subsections grouped by chapter (with chapter conclusions if needed), then intro, conclusions, sources.`
        : `Create a plan for ${d.type} on topic: "${d.topic}". Field: ${d.subject}. Pages: ${totalPages}.
Language of work: ${d.language || "Ukrainian"} — all labels and titles must be in this language.
${commentAnalysis?.planHints ? `\nCLIENT HINTS:\n${commentAnalysis.planHints}\n` : ""}
GUIDE REQUIREMENTS:
- Chapters: ${chapCount}
- Subsections per chapter: ${Math.round(totalSubsCount / chapCount)}
- Chapter conclusions: ${hasConcl ? "YES — add after last subsection of each chapter" : "NO — do not add"}
- Chapter types: ${chTypes.join(", ")}
${methodInfo.otherRequirements ? `- Other requirements: ${methodInfo.otherRequirements}` : ""}

PAGE DISTRIBUTION (must sum to exactly ${totalPages}):
- ${L.intro}: ${introP} p.
- ${L.conclusions}: ${conclP} p.
- Each subsection: ~${pagesPerSub} p. (total: ${totalSubsCount})
${hasConcl ? `- Chapter conclusions: 1 p. each (${chapCount} total)` : ""}

Allowed type values: "theory" | "analysis" | "recommendations" | "chapter_conclusion" | "intro" | "conclusions" | "sources"
Chapter conclusion id format: "1.conclusions", "2.conclusions" etc.

Return ONLY JSON without markdown:
{"sections":[
  {"id":"1.1","label":"1.1 Section title","sectionTitle":"${L.chapterWord} 1. CHAPTER TITLE","pages":8,"type":"theory"},
  {"id":"1.2","label":"1.2 Section title","sectionTitle":"${L.chapterWord} 1. CHAPTER TITLE","pages":7,"type":"theory"},${hasConcl ? `
  {"id":"1.conclusions","label":"${L.chapConclLabel(1)}","sectionTitle":"${L.chapterWord} 1. CHAPTER TITLE","pages":1,"type":"chapter_conclusion"},` : ""}
  {"id":"2.1","label":"2.1 Section title","sectionTitle":"${L.chapterWord} 2. CHAPTER TITLE","pages":8,"type":"analysis"},
  {"id":"intro","label":"${L.intro}","pages":3,"type":"intro"},
  {"id":"conclusions","label":"${L.conclusions}","pages":3,"type":"conclusions"},
  {"id":"sources","label":"${L.sources}","pages":2,"type":"sources"}
]}
Order: subsections grouped by chapter, then intro, conclusions, sources.`;

      try {
        await new Promise(r => setTimeout(r, 3000)); // пауза після аналізу методички
        const raw = await callGemini([{ role: "user", content: planPrompt }], null, "Respond only with valid JSON. No markdown, no explanation.", 3000);
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
      const raw = await callClaude([{ role: "user", content: namingPrompt }], null, "Respond only with valid JSON. No markdown, no explanation.", 1000, null, MODEL_FAST);
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
      const raw = await callClaude([{ role: "user", content: prompt }], null, "Respond only with valid JSON. No markdown.", 1200, null, MODEL_FAST);
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

  const startGen = () => {
    const ORDER = ["theory", "analysis", "recommendations", "chapter_conclusion", "intro", "conclusions", "sources"];
    setSections(prev => [...prev].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type)));
    setContent({}); setGenIdx(0); setPaused(false); setStage("writing");
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
      const raw = await callClaude([{ role: "user", content: prompt }], null, "Respond only with valid JSON array. No markdown.", 2000, null, MODEL_FAST);
      const parsed = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || "[]");
      setFigureKeywords(parsed);
    } catch (e) { console.error(e); }
    setFigKwLoading(false);
  };

  // ── Генерація тексту ──
  useEffect(() => {
    if (stage !== "writing" || paused) return;
    if (runningRef.current) return;
    if (genIdx >= sections.length) { playDoneSound(); setStage("done"); saveToFirestore({ stage: "done", status: "done", content, citInputs }); return; }
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
    const prevCtx = Object.entries(contentRef.current).slice(-2).map(([k, v]) => `[${k}]: ${v.substring(0, 500)}...`).join("\n\n");
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

      instruction = `Напиши ВСТУП для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.

СТРУКТУРА ВСТУПУ (дотримуватись суворо, кожен елемент з нового абзацу):

${componentLines.map((l, i) => `${i + 1}. ${l}`).join("\n\n")}
${methodInfo?.otherRequirements ? `\nВИМОГИ МЕТОДИЧКИ: ${methodInfo.otherRequirements}` : ""}${commentAnalysis?.textStructureHints ? `\nПІДКАЗКИ ЩОДО СТРУКТУРИ (з коментаря клієнта): ${commentAnalysis.textStructureHints}` : ""}

ВАЖЛИВО: кожен абзац починається так, як вказано вище — НЕ писати окремо мітку ("Мета.") і потім знову те саме слово ("Метою роботи..."). Назви НЕ виділяй жирним. НЕ додавай посилань. Пиши суцільним текстом абзацами.`;

    } else if (sec.type === "conclusions") {
      const conclusionsParas = isLarge ? "10-12" : "7";
      const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
      // Беремо короткий контекст усіх підрозділів для висновків
      const allCtx = mainSecs.map(s => contentRef.current[s.id]
        ? `[${s.label}]: ${contentRef.current[s.id].substring(0, 300)}...`
        : "").filter(Boolean).join("\n\n");

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
- Без посилань. Без жирного. Без нумерації.

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
Без нової інформації. Без посилань. Без жирного.
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

      if (isEmpChapter) {
        empiricalBlock = `

КОНТЕКСТ (психолого-педагогічне емпіричне дослідження):
Цей підрозділ є частиною емпіричного дослідження. Визнач за назвою підрозділу що саме писати:
- якщо підрозділ про організацію або методику дослідження: опиши вибірку (20-30 респондентів: вік, категорія, умови відбору), метод анкетування, мету та структуру анкети, принцип проведення. Додай речення: "Анкета наведена у Додатку А."
- якщо підрозділ про аналіз або результати: подай результати у вигляді таблиці markdown (|---|---| формат) з відсотковими показниками по запитаннях або категоріях, проаналізуй дані, зроби висновки
- якщо підрозділ про рекомендації або практичні висновки: спирайся на результати анкетування вже описані в попередніх підрозділах, не повторюй опис анкети та вибірки`;
      } else if (isEmpAnchor) {
        empiricalBlock = `

ОБОВ'ЯЗКОВО для цього підрозділу (психолого-педагогічне дослідження):
Цей підрозділ має містити емпіричне дослідження:
1. Вибірка: 25-30 респондентів (вік, категорія, умови відбору).
2. Метод: анкетування. Мета анкети, структура (кількість і типи запитань, блоки).
3. Принцип проведення: умови та порядок анкетування.
4. Результати: таблиця markdown (|---|---| формат) з відсотковими показниками.
5. Аналіз: інтерпретація результатів таблиці, зв'язок із темою.
6. В тексті додай: "Анкета наведена у Додатку А."`;
      }

      instruction = `Напиши підрозділ "${sec.label}" для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.
Тип підрозділу: ${typeHints[sec.type] || "основний"}.
${methodReq ? `ВИМОГИ МЕТОДИЧКИ ДО ЦЬОГО РОЗДІЛУ: ${methodReq}` : ""}${empiricalBlock}${econBlock}

ПЛАН РОБОТИ (для розуміння структури та уникнення повторів):
${planSummary}

${prevCtx ? `КОНТЕКСТ ПОПЕРЕДНІХ ПІДРОЗДІЛІВ:\n${prevCtx}\n` : ""}Обсяг: ~${approxParas} абзаців (~${sec.pages} стор.).
Не обривай текст. Завершуй підсумковим абзацом. Без посилань [1],[2]. Без жирного.
Абзаци мають різнитись за довжиною: чергуй короткі (2-3 речення) з довшими (5-7 речень).`;
    }
    if (commentAnalysis?.writingHints) instruction += `\n\nПІДКАЗКИ З КОМЕНТАРЯ КЛІЄНТА (врахуй при написанні):\n${commentAnalysis.writingHints}`;
    const sectionMaxTokens = Math.min(60000, Math.max(8000, Math.round((sec.pages || 1) * 3000)));
    try {
      const raw = await callClaude([{ role: "user", content: instruction }], ctrl.signal, buildSYS(lang), sectionMaxTokens, (s) => setLoadMsg(`Генерую: ${sec.label}... зачекайте ${s}с`));
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
      const raw = await callClaude([{ role: "user", content: instruction }], null, buildSYS(lang), regenMaxTokens);
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
        null, "gemini-2.5-flash"
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
      const empSecs = getEmpiricalSections(sections, info);
      const anchorId = empSecs.anchorId || empSecs.chapterSectionIds[0] || null;
      const anchorCtx = anchorId && content[anchorId]
        ? `КОНТЕКСТ ДОСЛІДЖЕННЯ:\n${content[anchorId].substring(0, 800)}`
        : "";

      // Збираємо контекст вже згенерованого тексту роботи
      const generatedCtx = sections
        .filter(s => content[s.id] && !["sources"].includes(s.type))
        .map(s => `[${s.label}]\n${content[s.id].substring(0, 600)}`)
        .join("\n\n");
      const contentBlock = generatedCtx
        ? `ТЕКСТ РОБОТИ (скорочено для контексту):\n${generatedCtx.substring(0, 3000)}`
        : "";

      const customBlock = appendicesCustomPrompt.trim()
        ? `\nДОДАТКОВІ ІНСТРУКЦІЇ КОРИСТУВАЧА:\n${appendicesCustomPrompt.trim()}`
        : "";

      const prompt = isPsychoPed(info) && !appendicesCustomPrompt.trim()
        ? `Згенеруй Додаток А для ${info?.type || "наукової роботи"} на тему "${info?.topic}". Галузь: ${info?.subject}.

Додаток А містить анкету яка використовувалась для емпіричного дослідження.
${anchorCtx}

Вимоги:
- Перший рядок: ДОДАТОК А
- Другий рядок: назва анкети відповідно до теми
- Звернення до респондента та інструкція (2-3 речення)
- 12-15 запитань закритого типу з варіантами відповідей: а), б), в), г)
- Запитання охоплюють різні аспекти теми дослідження
- В кінці: "Дякуємо за участь у дослідженні!"
- Мова: ${lang}
- БЕЗ markdown, зірочок, жирного. Звичайний текст.`
        : `Згенеруй розділ "Додатки" для ${info?.type || "наукової роботи"} на тему "${info?.topic}". Галузь: ${info?.subject || ""}.
${contentBlock}
${customBlock || `Включи один або два додатки що логічно доповнюють роботу (таблиці, схеми, зразки документів тощо).`}
Мова: ${lang}. БЕЗ markdown, зірочок, жирного. Кожен додаток починається з нового рядка: ДОДАТОК А, ДОДАТОК Б тощо.`;

      const raw = await callClaude(
        [{ role: "user", content: prompt }], null, buildSYS(lang), 6000, null, MODEL
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
        "Respond only with valid JSON. No markdown, no code blocks, no comments.", 4000,
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

      const claudePrompt = `На основі аналізу наукової роботи згенеруй зміст 13 слайдів презентації для захисту.

МЕТАДАНІ РОБОТИ:
- Тип: ${info?.type || "наукова робота"}
- Тема: ${info?.topic || ""}
- Галузь: ${info?.direction || info?.subject || ""}
- Мова виступу: ${lang}

АНАЛІЗ РОБОТИ (від Gemini):
${JSON.stringify(analysis, null, 2)}

СТРУКТУРА — рівно 13 слайдів, суворо в такому порядку:
1.  layout "hero"            — title: тема роботи, subtitle: тип · рік
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
        "Respond only with valid JSON. No markdown, no comments.", 5000,
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
    const prompt = `Проаналізуй текст підрозділів академічної роботи на тему "${info?.topic}" і для кожного підрозділу визнач пошукові ключові слова для Google Scholar, Scopus, eLibrary Ukraine. Ключові слова мають відображати конкретні терміни, концепції та підходи з тексту — не загальні назви розділів.\n\nПІДРОЗДІЛИ:\n${secBlocks}\n\nПоверни JSON об'єкт: {"keywords":{"1.1":["фраза укр","english phrase"],...}}`;
    try {
      const res = await fetch("/api/gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _model: "gemini-2.5-flash",
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 3000, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data).slice(0, 200));
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const parsed = JSON.parse(raw);
      setKeywords(parsed.keywords || {});
    } catch (e) { console.error(e); setApiError(e.message); }
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

    // Будуємо карту "номер → текст посилання" відповідно до стилю
    const refCiteText = {};
    allRefs.forEach((ref, i) => {
      const n = i + 1;
      if (isAPA) {
        // Витягуємо прізвище першого автора і рік для APA: (Прізвище, рік)
        const authorMatch = ref.match(/^([А-ЯҐЄІЇA-Z][а-яґєіїa-z\-A-Za-z]+)/);
        const yearMatch = ref.match(/[\(\.\s](\d{4})[\)\.\,\s]/);
        const author = authorMatch?.[1] || `Автор${n}`;
        const year = yearMatch?.[1] || "б.р.";
        refCiteText[n] = `(${author}, ${year})`;
      } else if (isMLA) {
        const authorMatch = ref.match(/^([А-ЯҐЄІЇA-Z][а-яґєіїa-z\-A-Za-z]+)/);
        refCiteText[n] = `(${authorMatch?.[1] || `Автор${n}`})`;
      } else {
        // ДСТУ та інші нумеровані стилі
        // Витягуємо номер першої сторінки статті (С. 56 або С. 56–74), але НЕ загальний обсяг книги (210 с.)
        const articlePageMatch = ref.match(/[Сс]\.\s*(\d+)\s*[–\-—]/); // діапазон С. 56–74
        const singlePageMatch = !articlePageMatch && ref.match(/[Сс]\.\s*(\d+)(?!\d*\s*с\.)/); // одна сторінка С. 56, але не "210 с."
        const engPageMatch = ref.match(/pp?\.\s*(\d+)/i); // англійські pp. 56
        const startPage = articlePageMatch?.[1] || singlePageMatch?.[1] || engPageMatch?.[1];
        refCiteText[n] = startPage ? `[${n}, с. ${startPage}]` : `[${n}]`;
      }
    });

    // ── Допоміжні функції ──
    const isTableRow = p => p.includes("|") || (p.match(/\t/g) || []).length >= 2;
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
          "Respond only with valid JSON. No markdown.", 2000, null, MODEL_FAST);
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

    // ── Форматування списку джерел (Gemini, до 100+ джерел без батчингу) ──
    const today = new Date();
    const accessDate = `${String(today.getDate()).padStart(2, "0")}.${String(today.getMonth() + 1).padStart(2, "0")}.${today.getFullYear()}`;
    const isAlphabeticalOrder = methodInfo?.sourcesOrder === "alphabetical";
    const sourcesOrder = isAlphabeticalOrder ? "Список відсортований за алфавітом." : "Список у порядку першої появи у тексті.";
    const defaultGrouping = "спочатку українські джерела (кирилиця) за алфавітом, потім англійські (латиниця) за алфавітом";
    const sourcesGrouping = methodInfo?.sourcesGrouping ? `Групування: ${methodInfo.sourcesGrouping}.` : (isAlphabeticalOrder ? `Групування: ${defaultGrouping}.` : "");
    const isApaStyle = /APA/i.test(sourcesStyle);
    const isDstu = /ДСТУ/i.test(sourcesStyle);
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
- Між містом і видавцем — пробіл двокрапка пробіл ( : ).`
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

    setContent(newContent);
    setCitInputsSnapshot(JSON.stringify(citInputs));
    await saveToFirestore({ content: newContent, citInputs, refList: fmtResult?.split("\n").filter(Boolean) || [], stage: "sources", status: "writing" });
    setAllCitLoading(false);
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
      `}</style>

      {/* Header */}
      <div style={{ background: "#1a1a14", color: "#f5f2eb", padding: "15px 32px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
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
          <StagePills stage={stage} maxStageIdx={maxStageIdx} onNavigate={running ? null : (s) => setStage(s === "input" && info ? "parsed" : s)} />
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px clamp(16px, 3vw, 48px)" }}>

        {/* ══ STEP 1: ДАНІ ══ */}
        {stage === "input" && (
          <div className="fade">
            <Heading>01 / Введіть дані замовлення</Heading>
            <FieldBox label="Шаблон замовлення *">
              <textarea value={tplText} onChange={e => setTplText(e.target.value)}
                placeholder={"№ замовлення - 34455\nТип - Магістерська\n⏰Дедлайн - 06.03.2026\n⚡️Напрям - Гуманітарне\n📌Тематика - Психологія\n✈️Тема - Вплив гаджетів на когнітивну поведінку дітей\n⚙️К-кість стр. - 100-120\n⚙️Унікальність - 70-80%"}
                style={{ ...TA, minHeight: 200 }} />
            </FieldBox>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
              <FieldBox label="Готовий план від клієнта (необов'язково)">
                <textarea value={clientPlan} onChange={e => setClientPlan(e.target.value)}
                  placeholder="Вставте план клієнта якщо є. Порожньо = план згенерується автоматично."
                  style={{ ...TA, minHeight: 90 }} />
              </FieldBox>
              <FieldBox label="Або фото плану">
                <ClientPlanInput onExtracted={setClientPlan} extracted={clientPlan} />
              </FieldBox>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
              <FieldBox label="Коментар">
                <textarea value={comment} onChange={e => setComment(e.target.value)}
                  placeholder="Додаткові побажання..." style={{ ...TA, minHeight: 90 }} />
              </FieldBox>
              <FieldBox label="Методичка (тільки PDF)">
                <DropZone fileLabel={fileLabel} onFile={handleFile} />
                {methodInfo && !fileB64 && (
                  <div style={{ fontSize: 11, color: "#7a8a5a", marginTop: 5 }}>
                    ✓ Методичку вже проаналізовано. Завантажте PDF знову лише якщо потрібно перепроаналізувати.
                  </div>
                )}
              </FieldBox>
            </div>
            <FieldBox label="Фото як додатковий матеріал (необов'язково)">
              <PhotoDropZone
                photos={photos}
                onAdd={p => setPhotos(prev => [...prev, p])}
                onRemove={i => setPhotos(prev => prev.filter((_, idx) => idx !== i))}
              />
            </FieldBox>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <PrimaryBtn onClick={doAnalyze} disabled={!tplText.trim()} loading={running} msg={loadMsg} label="Аналізувати →" />
              {info && !running && (
                <button onClick={() => setStage("parsed")}
                  style={{ background: "transparent", border: "1.5px solid #555", color: "#555", borderRadius: 8, padding: "11px 22px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                  Продовжити без повторного аналізу →
                </button>
              )}
            </div>
          </div>
        )}

        {/* ══ STEP 2: ПЕРЕВІРКА ══ */}
        {stage === "parsed" && info && (
          <div className="fade">
            <Heading>02 / Перевірте дані</Heading>
            <p style={{ fontSize: 13, color: "#888", marginBottom: 20 }}>Клікніть на значення щоб змінити</p>

            {/* Напрям роботи */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, padding: "10px 16px", background: "#f0ece2", borderRadius: 8, border: "1.5px solid #d4cfc4" }}>
              <div style={{ fontSize: 11, color: "#888", letterSpacing: "1px", textTransform: "uppercase", whiteSpace: "nowrap" }}>Напрям роботи</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {["Гуманітарне", "Економічне", "Технічне", "Біологічне"].map(cat => (
                  <button key={cat} onClick={() => setInfo(p => ({ ...p, workCategory: cat }))}
                    style={{ padding: "5px 16px", borderRadius: 20, fontSize: 12, cursor: "pointer", fontFamily: "inherit", border: "1.5px solid", transition: "all .15s",
                      background: info.workCategory === cat ? "#1a1a14" : "transparent",
                      color: info.workCategory === cat ? "#e8ff47" : "#555",
                      borderColor: info.workCategory === cat ? "#1a1a14" : "#ccc" }}>
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
              {Object.entries(FIELD_LABELS).map(([k, l], i, arr) => (
                <div key={k} style={{ display: "grid", gridTemplateColumns: "200px 1fr", borderBottom: i < arr.length - 1 ? "1px solid #e4dfd4" : "none" }}>
                  <div style={{ padding: "11px 16px", fontSize: 11, color: "#888", letterSpacing: "1px", textTransform: "uppercase", borderRight: "1px solid #e4dfd4", display: "flex", alignItems: "center", background: "#ede9e0" }}>{l}</div>
                  <input value={info[k] || ""} onChange={e => setInfo(p => ({ ...p, [k]: e.target.value }))}
                    style={{ padding: "11px 16px", background: "transparent", border: "none", fontSize: 14, color: "#1a1a14", width: "100%", fontFamily: "'Spectral',serif" }} />
                </div>
              ))}
            </div>
            {info.pages?.includes("-") && <div style={{ fontSize: 12, color: "#888", marginBottom: 16, fontStyle: "italic" }}>Діапазон "{info.pages}" → середнє: {parsePagesAvg(info.pages)} стор.</div>}

            {/* Карточка методички або помилка */}
            {!methodInfo && fileB64 && apiError && (
              <div style={{ border: "1.5px solid #f5c6c6", borderRadius: 8, overflow: "hidden", marginBottom: 20 }}>
                <div style={{ background: "#8a1a1a", color: "#ffd0d0", padding: "9px 16px", fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 2 }}>
                  ⚠ ПОМИЛКА АНАЛІЗУ МЕТОДИЧКИ
                </div>
                <div style={{ padding: "12px 16px", background: "#fff5f5", fontSize: 13, color: "#8a1a1a" }}>{apiError}</div>
              </div>
            )}
            {methodInfo && (
              <div style={{ border: "1.5px solid #c8dfa0", borderRadius: 8, overflow: "hidden", marginBottom: 20 }}>
                <div style={{ background: "#2a3a1a", color: "#a8d060", padding: "9px 16px", fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 2 }}>
                  📋 ВИТЯГНУТО З МЕТОДИЧКИ
                </div>
                <div style={{ padding: "14px 18px", background: "#f5faf0", display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {methodInfo.totalPages && <span style={{ fontSize: 12, background: "#eef5e4", color: "#3a6010", padding: "3px 10px", borderRadius: 10 }}>📄 Обсяг: {methodInfo.totalPages} стор.</span>}
                  {methodInfo.chaptersCount && <span style={{ fontSize: 12, background: "#eef5e4", color: "#3a6010", padding: "3px 10px", borderRadius: 10 }}>📑 Розділів: {methodInfo.chaptersCount}</span>}
                  <span
                    onClick={() => setMethodInfo(p => ({ ...p, hasChapterConclusions: !p.hasChapterConclusions }))}
                    title="Клікніть щоб увімкнути/вимкнути"
                    style={{ fontSize: 12, background: methodInfo.hasChapterConclusions ? "#eef5e4" : "#f0ece2", color: methodInfo.hasChapterConclusions ? "#3a6010" : "#888", padding: "3px 10px", borderRadius: 10, cursor: "pointer", userSelect: "none", border: "1px dashed " + (methodInfo.hasChapterConclusions ? "#a8d060" : "#ccc") }}
                  >
                    {methodInfo.hasChapterConclusions ? "✓ Висновки до розділів" : "✗ Без висновків до розділів"}
                  </span>
                  {methodInfo.sourcesStyle && <span style={{ fontSize: 12, background: "#e4f0ff", color: "#1a5a8a", padding: "3px 10px", borderRadius: 10 }}>📚 Стиль: {methodInfo.sourcesStyle}</span>}
                  {methodInfo.sourcesOrder && <span style={{ fontSize: 12, background: "#e4f0ff", color: "#1a5a8a", padding: "3px 10px", borderRadius: 10 }}>{methodInfo.sourcesOrder === "alphabetical" ? "🔤 За алфавітом" : "🔢 За появою"}</span>}
                  {methodInfo.formatting?.font && <span style={{ fontSize: 12, background: "#f0ece2", color: "#555", padding: "3px 10px", borderRadius: 10 }}>🖋 {methodInfo.formatting.font} {methodInfo.formatting.fontSize}pt</span>}
                  {methodInfo.formatting?.margins && <span style={{ fontSize: 12, background: "#f0ece2", color: "#555", padding: "3px 10px", borderRadius: 10 }}>📐 Поля: Л{methodInfo.formatting.margins.left}мм П{methodInfo.formatting.margins.right}мм</span>}
                  {methodInfo.citationStyle && <span style={{ fontSize: 12, background: "#f5e4ff", color: "#8a1a8a", padding: "3px 10px", borderRadius: 10 }}>🔗 {methodInfo.citationStyle}</span>}
                </div>
                {methodInfo.exampleTOC && (
                  <div style={{ padding: "10px 18px", background: "#f0faf0", borderTop: "1px solid #c8dfa0" }}>
                    <div style={{ fontSize: 11, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>Зразок змісту з методички:</div>
                    <pre style={{ fontSize: 12, color: "#3a6010", whiteSpace: "pre-wrap", fontFamily: "'Spectral',serif", lineHeight: 1.8, margin: 0 }}>{methodInfo.exampleTOC}</pre>
                  </div>
                )}
              </div>
            )}

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <NavBtn onClick={() => setStage("input")}>← Назад</NavBtn>
              {sections.length > 0 && <NavBtn onClick={() => setStage("plan")}>Вперед (збережений план) →</NavBtn>}
              <PrimaryBtn onClick={doGenPlan} label={sections.length > 0 ? "Перегенерувати план →" : "Генерувати план →"} />
            </div>
          </div>
        )}

        {/* ══ STEP 3: ПЛАН ══ */}
        {stage === "plan" && (
          <div className="fade">
            <Heading>03 / План роботи</Heading>
            {planLoading ? (
              <>{clientPlan ? (
                <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 18 }}>
                  <div style={{ background: "#1a1a14", color: "#e8ff47", padding: "10px 18px", fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 3 }}>ПЛАН КЛІЄНТА (обробляється...)</div>
                  <div style={{ padding: "14px 18px", background: "#faf8f3" }}><pre style={{ fontFamily: "'Spectral',serif", fontSize: 13, color: "#888", whiteSpace: "pre-wrap", lineHeight: 1.8 }}>{clientPlan}</pre></div>
                </div>
              ) : null}
                <PlanLoadingSkeleton /></>
            ) : sections.length > 0 ? (
              <>
                <p style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>Відредагуйте назви та к-сть сторінок. Після затвердження плану — починайте написання.</p>

                {/* Plan text block */}
                <div style={{ background: "#1a1a14", color: "#f5f2eb", borderRadius: 8, padding: 20, marginBottom: 18 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                    <div style={{ fontFamily: "'Spectral SC'", fontSize: 11, color: "#e8ff47", letterSpacing: 3 }}>ПЛАН ДЛЯ КОПІЮВАННЯ</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => navigator.clipboard.writeText(planDisplay)} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 5, padding: "4px 12px", fontSize: 11, cursor: "pointer", fontFamily: "'Spectral',serif", letterSpacing: 1 }}>COPY</button>
                      <button
                        disabled={planDocxLoading}
                        onClick={async () => { setPlanDocxLoading(true); try { await exportPlanToDocx({ sections, info }); } catch (e) { alert("Помилка: " + e.message); } setPlanDocxLoading(false); }}
                        style={{ background: planDocxLoading ? "#444" : "#2a3a1a", color: "#a8d060", border: "none", borderRadius: 5, padding: "4px 14px", fontSize: 11, cursor: "pointer", fontFamily: "'Spectral',serif", letterSpacing: 1, display: "inline-flex", alignItems: "center", gap: 6 }}>
                        {planDocxLoading ? <><SpinDot light />...</> : "⬇ .docx"}
                      </button>
                    </div>
                  </div>
                  <pre style={{ fontFamily: "'Spectral',serif", fontSize: 13, lineHeight: "2.1", whiteSpace: "pre-wrap", color: "#e0ddd4", margin: 0 }}>{planDisplay}</pre>
                </div>

                {/* Sections table */}
                <div style={{ fontSize: 12, color: "#888", marginBottom: 10, padding: "8px 12px", background: "#f0ece2", borderRadius: 6, lineHeight: "1.6" }}>
                  ✏️ Редагуй назви та сторінки прямо в таблиці. Кнопка <strong>+</strong> — додати підрозділ, <strong>✕</strong> — видалити.
                </div>
                <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 22 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "36px 1fr 70px 54px 36px", background: "#1a1a14", color: "#e8ff47", padding: "9px 14px", fontSize: 11, letterSpacing: "1.5px", textTransform: "uppercase" }}>
                    <div>#</div><div>Підрозділ</div><div style={{ textAlign: "center" }}>Стор.</div><div style={{ textAlign: "center" }}>Промти</div><div />
                  </div>
                  {(() => {
                    let lastChapterTitle = null;
                    let rowNum = 0;
                    const rows = [];
                    sections.forEach((s, i) => {
                      const isSpecial = ["intro", "conclusions", "sources"].includes(s.type);
                      const isChapterConclusion = s.type === "chapter_conclusion";
                      const isMainSub = !isSpecial && !isChapterConclusion && s.sectionTitle;
                      if (isMainSub && s.sectionTitle !== lastChapterTitle) {
                        lastChapterTitle = s.sectionTitle;
                        rows.push(
                          <div key={`chhead-${s.sectionTitle}`} style={{ display: "grid", gridTemplateColumns: "36px 1fr 70px 54px 36px", borderBottom: "1px solid #e4dfd4", background: "#ddd8c8", alignItems: "center" }}>
                            <div style={{ padding: "8px 10px" }} />
                            <div style={{ padding: "8px 8px", fontSize: 12, fontWeight: "bold", color: "#1a1a14", letterSpacing: "0.5px", gridColumn: "2 / 6", textTransform: "uppercase" }}>{s.sectionTitle}</div>
                          </div>
                        );
                      }
                      rowNum++;
                      rows.push(
                        <div key={s.id} className="sec-row" style={{ display: "grid", gridTemplateColumns: "36px 1fr 70px 54px 36px", borderBottom: i < sections.length - 1 ? "1px solid #e4dfd4" : "none", background: isSpecial ? "#ede9e0" : rowNum % 2 === 0 ? "#f5f2eb" : "#f0ece2", alignItems: "center", transition: "background .15s" }}>
                          <div style={{ padding: "9px 10px", fontSize: 12, color: "#bbb" }}>{rowNum}</div>
                          <input value={s.label} onChange={e => { const val = e.target.value; setSections(p => { const next = p.map((x, j) => j === i ? { ...x, label: val } : x); setPlanDisplay(buildPlanText(next)); return next; }); }} style={{ background: "transparent", border: "none", fontSize: 13, padding: "9px 8px", color: isSpecial ? "#888" : "#1a1a14", fontStyle: isSpecial ? "italic" : "normal", width: "100%", fontFamily: "'Spectral',serif" }} />
                          <input type="number" min="1" value={s.pages} onChange={e => { const v = parseInt(e.target.value) || 1; setSections(p => { const next = p.map((x, j) => j === i ? { ...x, pages: v, prompts: x.type === "sources" ? 0 : Math.max(1, Math.ceil(v / 3)) } : x); setPlanDisplay(buildPlanText(next)); const { dist, total } = calcSourceDist(next); setSourceDist(dist); setSourceTotal(total); return next; }); }} style={{ background: "transparent", border: "none", fontSize: 13, padding: "9px 4px", color: "#1a1a14", textAlign: "center", width: "100%", fontFamily: "'Spectral',serif" }} />
                          <div style={{ textAlign: "center", fontSize: 12, color: "#888", padding: "9px" }}>{s.type === "sources" ? "—" : s.prompts}</div>
                          <div style={{ display: "flex", justifyContent: "center" }}>
                            <button onClick={() => setSections(p => { const next = p.filter((_, j) => j !== i); setPlanDisplay(buildPlanText(next)); const { dist, total } = calcSourceDist(next); setSourceDist(dist); setSourceTotal(total); return next; })} style={{ background: "transparent", border: "none", color: "#bbb", fontSize: 15, cursor: "pointer", padding: "2px 4px", borderRadius: 4 }} onMouseEnter={e => e.currentTarget.style.color = "#c03030"} onMouseLeave={e => e.currentTarget.style.color = "#bbb"}>✕</button>
                          </div>
                        </div>
                      );
                    });
                    return rows;
                  })()}
                  <div style={{ padding: "10px 14px", background: "#f5f2eb", borderTop: "1px solid #e4dfd4", display: "flex", gap: 8 }}>
                    <button onClick={() => {
                      const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
                      const lastId = mainSecs.length ? mainSecs[mainSecs.length - 1].id : "1.0";
                      const [ch, sub] = lastId.split(".").map(Number);
                      const newId = `${ch}.${(sub || 0) + 1}`;
                      const newSec = { id: newId, label: `${newId} Новий підрозділ`, sectionTitle: mainSecs[mainSecs.length - 1]?.sectionTitle || "", pages: Math.max(1, Math.round(totalPagesNum * 0.1)), prompts: 1, type: mainSecs[mainSecs.length - 1]?.type || "theory" };
                      setSections(p => { const introIdx = p.findIndex(s => s.type === "intro"); const next = introIdx >= 0 ? [...p.slice(0, introIdx), newSec, ...p.slice(introIdx)] : [...p, newSec]; setPlanDisplay(buildPlanText(next)); return next; });
                    }} style={{ background: "transparent", border: "1.5px dashed #bbb4a0", color: "#888", borderRadius: 6, padding: "7px 20px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer", flex: 1, letterSpacing: "1px" }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = "#1a1a14"; e.currentTarget.style.color = "#1a1a14"; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = "#bbb4a0"; e.currentTarget.style.color = "#888"; }}>
                      + Підрозділ
                    </button>
                    <button onClick={addNewChapter} style={{ background: "transparent", border: "1.5px dashed #8ab060", color: "#6a9030", borderRadius: 6, padding: "7px 20px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer", flex: 1, letterSpacing: "1px" }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = "#3a6010"; e.currentTarget.style.color = "#3a6010"; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = "#8ab060"; e.currentTarget.style.color = "#6a9030"; }}>
                      + Розділ
                    </button>
                    <button onClick={recalcPages} style={{ background: "transparent", border: "1.5px dashed #a0a0a0", color: "#888", borderRadius: 6, padding: "7px 14px", fontFamily: "'Spectral',serif", fontSize: 11, cursor: "pointer", letterSpacing: "0.5px", whiteSpace: "nowrap" }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = "#555"; e.currentTarget.style.color = "#555"; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = "#a0a0a0"; e.currentTarget.style.color = "#888"; }}>
                      ⟳ стор.
                    </button>
                  </div>
                </div>


                {sections.some(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type) && /\[|\bновий\b/i.test(s.label)) && (
                  <div style={{ marginBottom: 14 }}>
                    <GreenBtn
                      onClick={doNamePlaceholders}
                      loading={namingLoading}
                      msg="Генерую назви..."
                      label="✨ Придумати назви для заглушок"
                    />
                  </div>
                )}
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <NavBtn onClick={() => setStage("parsed")}>← Назад</NavBtn>
                  {Object.keys(content).length > 0 && <NavBtn onClick={() => setStage("writing")}>Вперед (до написання) →</NavBtn>}
                  <PrimaryBtn onClick={startGen} label={Object.keys(content).length > 0 ? "Почати заново →" : "Розпочати написання →"} />
                </div>
              </>
            ) : (
              <div style={{ color: "#888", fontSize: 14 }}>
                Помилка генерації.{" "}
                <button onClick={doGenPlan} style={{ background: "none", border: "none", color: "#1a1a14", textDecoration: "underline", cursor: "pointer", fontSize: 14, fontFamily: "inherit" }}>Спробувати ще раз</button>
              </div>
            )}
          </div>
        )}

        {/* ══ STEP 4: НАПИСАННЯ ══ */}
        {stage === "writing" && (
          <div className="fade">
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 10, flexWrap: "wrap" }}>
              <Heading style={{ margin: 0 }}>04 / Генерація тексту</Heading>
              {running && <button onClick={stopGen} style={{ background: "#7a1010", color: "#fff", border: "none", borderRadius: 6, padding: "6px 18px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer" }}>⏹ Зупинити</button>}
              {!running && paused && genIdx < sections.length && <button onClick={resumeGen} style={{ background: "#0a4a0a", color: "#e8ff47", border: "none", borderRadius: 6, padding: "6px 18px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer" }}>▶ Продовжити</button>}
            </div>
            <div style={{ marginBottom: 22 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12, color: "#888" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>{running && <SpinDot />}{running ? loadMsg : Object.keys(content).length + " / " + sections.length + " блоків готово"}</span>
                <span style={{ fontWeight: 600, color: "#1a1a14" }}>{progress}%</span>
              </div>
              <div style={{ height: 3, background: "#d4cfc4", borderRadius: 2 }}>
                <div style={{ height: "100%", width: progress + "%", background: "#1a1a14", borderRadius: 2, transition: "width .6s ease" }} />
              </div>
            </div>

            {apiError && paused && (
              <div style={{ background: apiError.includes("💳") ? "#1a0a00" : "#1a0000", border: `1.5px solid ${apiError.includes("💳") ? "#8a4a00" : "#8a1a1a"}`, borderRadius: 8, padding: "14px 18px", marginBottom: 18, fontSize: 13, color: apiError.includes("💳") ? "#f0a060" : "#f08080", lineHeight: 1.6 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{apiError.includes("💳") ? "💳 Закінчився баланс API" : "⚠ Помилка генерації"}</div>
                <div>{apiError}</div>
                {apiError.includes("💳") && <div style={{ marginTop: 8, fontSize: 12, color: "#c08040" }}>Поповніть баланс на console.anthropic.com, після чого натисніть "Продовжити".</div>}
                <button onClick={() => setApiError("")} style={{ marginTop: 10, background: "transparent", border: "1px solid #555", color: "#888", borderRadius: 5, padding: "3px 12px", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>✕ Закрити</button>
              </div>
            )}

            {displayOrder.map(sec => {
              const txt = content[sec.id];
              const isGen = running && sections[genIdx]?.id === sec.id;
              const isRegen = regenId === sec.id;
              return (
                <div key={sec.id} style={{ border: "1.5px solid " + (txt ? "#aaa49a" : isGen ? "#1a1a14" : "#ddd9d0"), borderRadius: 8, marginBottom: 10, overflow: "hidden", transition: "border-color .3s" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", background: txt ? "#1a1a14" : "#f0ece2", borderBottom: txt ? "1px solid #2a2a20" : "none" }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: txt ? "#e8ff47" : isGen ? "#555" : "#ccc", animation: isGen ? "pl 1.2s ease-in-out infinite" : "none" }} />
                    <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: txt ? "#f5f2eb" : "#1a1a14" }}>{sec.label}</div>
                    <div style={{ fontSize: 11, color: txt ? "#666" : "#aaa", marginRight: 4 }}>{sec.pages} стор.</div>
                    {txt && <>
                      <button onClick={() => navigator.clipboard.writeText(txt)} style={{ background: "transparent", border: "1px solid #555", color: "#999", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer", fontFamily: "'Spectral',serif", letterSpacing: 1 }}>COPY</button>
                      {!["sources"].includes(sec.type) && (
                        <button onClick={() => setRegenId(isRegen ? null : sec.id)} style={{ background: isRegen ? "#e8ff47" : "transparent", color: isRegen ? "#111" : "#aaa", border: "1px solid " + (isRegen ? "#e8ff47" : "#555"), borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer", fontFamily: "'Spectral',serif" }}>✏️ Переписати</button>
                      )}
                    </>}
                  </div>

                  {/* Regen panel */}
                  {isRegen && (
                    <div style={{ padding: "12px 16px", background: "#1a1a14", borderBottom: "1px solid #2a2a20" }}>
                      <div style={{ fontSize: 11, color: "#888", marginBottom: 6, letterSpacing: 1 }}>ДОДАТКОВІ ВИМОГИ (необов'язково):</div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <input value={regenPrompt} onChange={e => setRegenPrompt(e.target.value)}
                          placeholder="Наприклад: більше прикладів, акцент на практичну частину..."
                          style={{ flex: 1, background: "#2a2a20", border: "1px solid #444", borderRadius: 5, color: "#f5f2eb", fontSize: 12, padding: "7px 10px", fontFamily: "'Spectral',serif" }} />
                        <button onClick={() => doRegenSection(sec)} disabled={regenLoading} style={{ background: regenLoading ? "#444" : "#e8ff47", color: "#111", border: "none", borderRadius: 5, padding: "7px 18px", fontSize: 12, cursor: regenLoading ? "default" : "pointer", fontFamily: "'Spectral',serif", display: "inline-flex", alignItems: "center", gap: 6 }}>
                          {regenLoading ? <><SpinDot />Генерую...</> : "Переписати →"}
                        </button>
                      </div>
                    </div>
                  )}

                  {txt && <div style={{ padding: "16px 20px", fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", whiteSpace: "pre-wrap", maxHeight: 360, overflowY: "auto", background: "#faf8f3" }}>{txt}</div>}
                  {isGen && !txt && <div style={{ padding: "14px 20px", fontSize: 13, color: "#888", display: "flex", alignItems: "center", gap: 8, background: "#faf8f3" }}><SpinDot />Генерується...</div>}
                </div>
              );
            })}

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 24 }}>
              <NavBtn onClick={() => setStage("plan")} disabled={running}>← План</NavBtn>
              {!running && progress === 100 && <PrimaryBtn onClick={() => setStage("sources")} label="Перейти до джерел →" />}
            </div>
          </div>
        )}

        {/* ══ STEP 5: ДЖЕРЕЛА ══ */}
        {stage === "sources" && (() => {
          const { allRefs } = globalRefData;
          let runningIdx = 0;
          const missingSections = mainSections.filter(s => !(citInputs[s.id] || "").trim());
          const visibleSections = showMissingSources ? missingSections : mainSections;
          return (
            <div className="fade">
              <Heading>05 / Джерела</Heading>
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
                <div style={{ fontSize: 13, color: "#888" }}>Загальна к-сть джерел: <strong style={{ color: "#1a1a14" }}>{sourceTotal}</strong>{methodInfo?.sourcesMinCount ? <span style={{ marginLeft: 8, fontSize: 11, color: "#8a5a1a" }}>(мін. {methodInfo.sourcesMinCount} за методичкою)</span> : null}</div>
                {methodInfo && (methodInfo.sourcesStyle || methodInfo.sourcesOrder) && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {methodInfo.sourcesStyle && <span style={{ fontSize: 11, background: "#e4f0ff", color: "#1a5a8a", padding: "2px 10px", borderRadius: 10 }}>📋 {methodInfo.sourcesStyle}</span>}
                    {methodInfo.sourcesOrder && <span style={{ fontSize: 11, background: "#eef5e4", color: "#3a6010", padding: "2px 10px", borderRadius: 10 }}>{methodInfo.sourcesOrder === "alphabetical" ? "🔤 За алфавітом" : "🔢 За порядком появи"}</span>}
                  </div>
                )}
                <GreenBtn onClick={doGenKeywords} loading={kwLoading} msg="Генерую ключові слова..." label={Object.keys(keywords).length > 0 ? "Оновити ключові слова" : "Генерувати ключові слова →"} />
              </div>
              <div style={{ padding: "12px 16px", background: "#f0f5e8", border: "1px solid #c8dfa0", borderRadius: 8, marginBottom: 20, fontSize: 13, color: "#3a6010", lineHeight: "1.7" }}>
                <strong>Як це працює:</strong> Вставте знайдені джерела до кожного підрозділу (кожне з нового рядка). Після заповнення натисніть <em>"Розставити всі посилання"</em>.
                <div style={{ marginTop: 8 }}>
                  <a
                    href={`https://scholar.google.com/scholar?hl=uk&as_sdt=0%2C5&as_ylo=2021&q=${encodeURIComponent(info?.topic || "")}&btnG=`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#1a5a8a", textDecoration: "none", background: "#e4f0ff", padding: "4px 12px", borderRadius: 6, border: "1px solid #b0d0f0" }}
                  >
                    🎓 Шукати джерела на Google Scholar →
                  </a>
                </div>
              </div>
              {(methodInfo?.recommendedSources || commentAnalysis?.sourcesHints) && (
                <div style={{ padding: "12px 16px", background: "#fff8e8", border: "1px solid #e8d48a", borderRadius: 8, marginBottom: 20, fontSize: 13, color: "#5a3a00", lineHeight: "1.7" }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Рекомендації щодо джерел:</div>
                  {methodInfo?.recommendedSources && (
                    <div style={{ marginBottom: commentAnalysis?.sourcesHints ? 8 : 0 }}>
                      <span style={{ fontSize: 11, color: "#8a6010", textTransform: "uppercase", letterSpacing: "0.5px" }}>З методички: </span>
                      {methodInfo.recommendedSources}
                    </div>
                  )}
                  {commentAnalysis?.sourcesHints && (
                    <div>
                      <span style={{ fontSize: 11, color: "#8a6010", textTransform: "uppercase", letterSpacing: "0.5px" }}>Від клієнта: </span>
                      {commentAnalysis.sourcesHints}
                    </div>
                  )}
                </div>
              )}
              {allRefs.length > 0 && (
                <div style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 20 }}>
                  <div style={{ background: "#2a3a1a", color: "#a8d060", padding: "9px 16px", fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 2 }}>ПОПЕРЕДНІЙ СПИСОК ДЖЕРЕЛ ({allRefs.length} позицій)</div>
                  <div style={{ padding: "12px 16px", background: "#faf8f3", maxHeight: 180, overflowY: "auto" }}>
                    {allRefs.map((r, i) => (
                      <div key={i} style={{ fontSize: 12, color: "#444", marginBottom: 4, lineHeight: "1.5" }}>
                        <span style={{ color: "#e8ff47", background: "#1a1a14", padding: "1px 6px", borderRadius: 4, marginRight: 8, fontSize: 11 }}>{i + 1}</span>{r}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {visibleSections.map(sec => {
                const secRefs = (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
                const startIdx = runningIdx + 1; runningIdx += secRefs.length;
                const hasSources = secRefs.length > 0;
                return (
                  <div key={sec.id} style={{ border: `1.5px solid ${hasSources ? "#d4cfc4" : "#e8a050"}`, borderRadius: 8, overflow: "hidden", marginBottom: 14 }}>
                    <div style={{ background: "#1a1a14", padding: "11px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: hasSources ? "#5ad060" : "#e8a050", flexShrink: 0, display: "inline-block" }} />
                        <span style={{ fontSize: 13, fontWeight: 600, color: "#f5f2eb" }}>{sec.label}</span>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        {secRefs.length > 0 && <div style={{ fontSize: 11, color: "#888" }}>джерела [{startIdx}–{startIdx + secRefs.length - 1}]</div>}
                        <div style={{ fontSize: 12, color: "#e8ff47", background: "#2a2a1a", padding: "2px 10px", borderRadius: 10 }}>потрібно: {sourceDist[sec.id] || "?"} дж.</div>
                      </div>
                    </div>
                    <div style={{ padding: "14px 18px", background: "#faf8f3" }}>
                      {keywords[sec.id] && (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ fontSize: 11, color: "#888", letterSpacing: "1px", textTransform: "uppercase", marginBottom: 5 }}>Шукайте за фразами:</div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                            {keywords[sec.id].map((kw, ki) => <span key={ki} onClick={() => navigator.clipboard.writeText(kw)} title="Клікни щоб скопіювати" style={{ fontSize: 11, background: "#eef5e4", color: "#3a6010", padding: "2px 9px", borderRadius: 10, border: "1px solid #c8dfa0", cursor: "pointer", userSelect: "none" }}>{kw}</span>)}
                          </div>
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: "#888", letterSpacing: "1px", textTransform: "uppercase", marginBottom: 5 }}>Вставте джерела (кожне з нового рядка):</div>
                      <textarea value={citInputs[sec.id] || ""}
                        onChange={e => { setCitInputs(p => ({ ...p, [sec.id]: e.target.value })); e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
                        onFocus={e => { e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
                        onPaste={e => {
                          e.preventDefault();
                          const pasted = e.clipboardData.getData("text");
                          const el = e.target;
                          const start = el.selectionStart;
                          const end = el.selectionEnd;
                          const prev = citInputs[sec.id] || "";
                          const next = prev.slice(0, start) + pasted + "\n" + prev.slice(end);
                          setCitInputs(p => ({ ...p, [sec.id]: next }));
                          requestAnimationFrame(() => {
                            el.style.height = "auto";
                            el.style.height = el.scrollHeight + "px";
                            const pos = start + pasted.length + 1;
                            el.setSelectionRange(pos, pos);
                          });
                        }}
                        placeholder={"Петренко В.І. Психологія навчання. Київ: Наука, 2020. 245 с.\nSmirnova O. Child development. Oxford: OUP, 2019."}
                        style={{ ...TA_WHITE, minHeight: 80, overflow: "hidden", resize: "none" }} />
                      {secRefs.length > 0 && <div style={{ fontSize: 11, color: "#5a8a2a", marginTop: 4 }}>✓ {secRefs.length} джерело(а) введено → [{startIdx}–{startIdx + secRefs.length - 1}]</div>}
                    </div>
                  </div>
                );
              })}
              <div style={{ padding: "16px 18px", background: "#f0f5e8", border: "1.5px solid #c8dfa0", borderRadius: 8, marginBottom: 16 }}>
                <div style={{ fontSize: 13, color: "#3a6010", marginBottom: 12 }}>
                  Всього введено: <strong>{allRefs.length}</strong> з {sourceTotal} рекомендованих.
                </div>
                {(() => {
                  const alreadyDone = refList.length > 0 && citInputsSnapshot !== null;
                  const sourcesChanged = alreadyDone && JSON.stringify(citInputs) !== citInputsSnapshot;
                  if (!alreadyDone) return <GreenBtn onClick={doAddAllCitations} disabled={allRefs.length === 0} loading={allCitLoading} msg="Обробляю підрозділи..." label="Розставити всі посилання та сформувати список літератури →" />;
                  if (sourcesChanged) return <GreenBtn onClick={doAddAllCitations} disabled={allRefs.length === 0} loading={allCitLoading} msg="Обробляю підрозділи..." label="Джерела змінились — перерозставити посилання →" />;
                  return null;
                })()}
              </div>
              {refList.length > 0 && (
                <div style={{ border: "1.5px solid #2a3a1a", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
                  <div style={{ background: "#2a3a1a", color: "#a8d060", padding: "9px 16px", fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 2, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ ({methodInfo?.sourcesStyle || "ДСТУ 8302:2015"})</span>
                    <button onClick={() => navigator.clipboard.writeText(refList.join("\n"))} style={{ background: "transparent", border: "1px solid #5a7a3a", color: "#a8d060", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer", fontFamily: "'Spectral',serif" }}>COPY</button>
                  </div>
                  <div style={{ padding: "14px 18px", background: "#faf8f3", maxHeight: 300, overflowY: "auto" }}>
                    {refList.map((r, i) => <div key={i} style={{ fontSize: 13, color: "#2a2a1e", marginBottom: 6, lineHeight: "1.7" }}>{r}</div>)}
                  </div>
                </div>
              )}
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
                <NavBtn onClick={() => setStage("writing")}>← До тексту</NavBtn>
                <PrimaryBtn onClick={async () => { await saveToFirestore({ stage: "done", status: "done", content, citInputs, refList }); setStage("done"); }} label="Завершити роботу →" />
              </div>
            </div>
          );
        })()}

        {/* ══ STEP 6: ГОТОВО ══ */}
        {stage === "done" && (
          <div className="fade">
            <Heading>✓ Роботу завершено!</Heading>
            <p style={{ fontSize: 13, color: "#888", marginBottom: 24 }}>Текст згенеровано. Скопіюйте або завантажте Word-файл.</p>

            {/* ── ТИТУЛЬНА СТОРІНКА ── */}
            <div style={{ border: "1.5px solid #aaa49a", borderRadius: 8, marginBottom: 10, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", background: "#1a1a14", borderBottom: "1px solid #2a2a20" }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#e8ff47", flexShrink: 0 }} />
                <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "#f5f2eb" }}>ТИТУЛЬНА СТОРІНКА</div>
                {titlePage && <button onClick={() => navigator.clipboard.writeText(titlePage)} style={{ background: "transparent", border: "1px solid #555", color: "#999", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer", fontFamily: "'Spectral',serif", letterSpacing: 1 }}>COPY</button>}
              </div>
              <div style={{ padding: "14px 18px", background: "#faf8f3" }}>
                {titlePage ? (
                  <textarea
                    value={titlePage}
                    onChange={e => { setTitlePage(e.target.value); e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
                    onBlur={e => saveToFirestore({ titlePage: e.target.value })}
                    onFocus={e => { e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
                    style={{ width: "100%", minHeight: 200, fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", background: "#f5f2ea", borderRadius: 6, padding: "12px 14px", border: "1px solid #d4cfc4", fontFamily: "'Spectral',serif", resize: "vertical", boxSizing: "border-box", overflow: "hidden" }}
                  />
                ) : (
                  <div style={{ fontSize: 12, color: "#888", lineHeight: 1.6 }}>
                    Шаблон титульної сторінки не знайдено в методичці. Введіть текст вручну:
                    <textarea
                      value={titlePage}
                      onChange={e => setTitlePage(e.target.value)}
                      onBlur={e => saveToFirestore({ titlePage: e.target.value })}
                      placeholder={"МІНІСТЕРСТВО ОСВІТИ І НАУКИ УКРАЇНИ\nНазва університету\n\nКУРСОВА РОБОТА\nна тему:\n" + (info?.topic || "[ТЕМА]")}
                      style={{ width: "100%", minHeight: 160, fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", background: "#f5f2ea", borderRadius: 6, padding: "12px 14px", border: "1px solid #d4cfc4", fontFamily: "'Spectral',serif", resize: "vertical", boxSizing: "border-box", marginTop: 8 }}
                    />
                  </div>
                )}
              </div>
            </div>

            {displayOrder.map(sec => {
              const txt = content[sec.id];
              if (!txt) return null;
              const isRegen = regenId === sec.id;
              return (
                <div key={sec.id} style={{ border: "1.5px solid #aaa49a", borderRadius: 8, marginBottom: 10, overflow: "hidden" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", background: "#1a1a14", borderBottom: "1px solid #2a2a20" }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#e8ff47", flexShrink: 0 }} />
                    <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "#f5f2eb" }}>{sec.label}</div>
                    <button onClick={() => navigator.clipboard.writeText(txt)} style={{ background: "transparent", border: "1px solid #555", color: "#999", borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer", fontFamily: "'Spectral',serif", letterSpacing: 1 }}>COPY</button>
                    {!["sources"].includes(sec.type) && (
                      <button onClick={() => setRegenId(isRegen ? null : sec.id)} style={{ background: isRegen ? "#e8ff47" : "transparent", color: isRegen ? "#111" : "#aaa", border: "1px solid " + (isRegen ? "#e8ff47" : "#555"), borderRadius: 5, padding: "3px 10px", fontSize: 10, cursor: "pointer", fontFamily: "'Spectral',serif" }}>✏️ Переписати</button>
                    )}
                  </div>
                  {isRegen && (
                    <div style={{ padding: "12px 16px", background: "#1a1a14", borderBottom: "1px solid #2a2a20" }}>
                      <div style={{ fontSize: 11, color: "#888", marginBottom: 6, letterSpacing: 1 }}>ДОДАТКОВІ ВИМОГИ:</div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <input value={regenPrompt} onChange={e => setRegenPrompt(e.target.value)} placeholder="Наприклад: більше прикладів, змінити акцент..." style={{ flex: 1, background: "#2a2a20", border: "1px solid #444", borderRadius: 5, color: "#f5f2eb", fontSize: 12, padding: "7px 10px", fontFamily: "'Spectral',serif" }} />
                        <button onClick={() => doRegenSection(sec)} disabled={regenLoading} style={{ background: regenLoading ? "#444" : "#e8ff47", color: "#111", border: "none", borderRadius: 5, padding: "7px 18px", fontSize: 12, cursor: regenLoading ? "default" : "pointer", fontFamily: "'Spectral',serif", display: "inline-flex", alignItems: "center", gap: 6 }}>
                          {regenLoading ? <><SpinDot />Генерую...</> : "Переписати →"}
                        </button>
                      </div>
                    </div>
                  )}
                  <div style={{ padding: "16px 20px", fontSize: 13, lineHeight: "1.85", color: "#2a2a1e", whiteSpace: "pre-wrap", maxHeight: 280, overflowY: "auto", background: "#faf8f3" }}>{txt}</div>
                </div>
              );
            })}

            {/* ══ ДОДАТКИ ══ */}
            <div style={{ marginTop: 24, border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden" }}>
              <div style={{ background: "#1a1a14", color: "#e8ff47", padding: "11px 18px", fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 2, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>ДОДАТКИ</span>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  {isPsychoPed(info) && <span style={{ fontSize: 10, color: "#888", letterSpacing: 1, marginRight: 8 }}>Додаток А: Анкета дослідження</span>}
                  <button onClick={() => navigator.clipboard.writeText(appendicesText)}
                    style={{ background: "transparent", color: "#d4d0c8", border: "1px solid #666", borderRadius: 5, padding: "5px 12px", fontFamily: "'Spectral',serif", fontSize: 11, letterSpacing: "0.5px", cursor: "pointer" }}>
                    COPY
                  </button>
                  <button onClick={async () => { setAppendicesLoading(true); try { await exportAppendixToDocx(appendicesText, info); } catch (e) { alert("Помилка: " + e.message); } setAppendicesLoading(false); }} disabled={appendicesLoading}
                    style={{ background: appendicesLoading ? "#555" : "#1a4a1a", color: appendicesLoading ? "#aaa" : "#a8e060", border: "none", borderRadius: 5, padding: "5px 12px", fontFamily: "'Spectral',serif", fontSize: 11, cursor: appendicesLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {appendicesLoading ? <><SpinDot light />...</> : <><svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginRight: 5 }}><path d="M6.5 1v7M6.5 8l-2.5-2.5M6.5 8l2.5-2.5" stroke="#a8e060" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><path d="M2 11h9" stroke="#a8e060" strokeWidth="1.5" strokeLinecap="round" /></svg>.docx</>}
                  </button>
                  <button onClick={() => { setAppendicesText(""); saveToFirestore({ appendicesText: "" }); }}
                    style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 5, padding: "5px 10px", fontFamily: "'Spectral',serif", fontSize: 11, cursor: "pointer" }}>
                    Очистити
                  </button>
                  <button onClick={doGenAppendices} disabled={appendicesLoading}
                    style={{ background: "transparent", border: "1px solid #555", color: "#ccc", borderRadius: 5, padding: "5px 10px", fontFamily: "'Spectral',serif", fontSize: 11, cursor: appendicesLoading ? "default" : "pointer" }}>
                    Переробити
                  </button>
                </div>
              </div>
              <div style={{ padding: "16px 18px", background: "#faf8f3" }}>
                {!appendicesText ? (
                  <div>
                    <div style={{ fontSize: 12, color: "#888", marginBottom: 12, lineHeight: 1.6 }}>
                      {isPsychoPed(info)
                        ? "Анкета яка використовувалась у дослідженні. Генерується на основі теми та змісту роботи."
                        : "Додайте матеріали для додатків або згенеруйте автоматично."}
                    </div>
                    <textarea
                      value={appendicesCustomPrompt}
                      onChange={e => setAppendicesCustomPrompt(e.target.value)}
                      placeholder="Ваші інструкції для додатків (необов'язково). Наприклад: «Зроби додаток з порівняльною таблицею методів» або «Додай зразок анкети і схему дослідження»."
                      style={{ width: "100%", minHeight: 72, fontSize: 12, lineHeight: "1.7", color: "#2a2a1e", background: "#f5f2ea", borderRadius: 6, padding: "10px 14px", border: "1px solid #d4cfc4", fontFamily: "'Spectral',serif", resize: "vertical", boxSizing: "border-box", marginBottom: 10 }}
                    />
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button onClick={doGenAppendices} disabled={appendicesLoading}
                        style={{ background: appendicesLoading ? "#aaa" : "#1a1a14", color: appendicesLoading ? "#eee" : "#e8ff47", border: "none", borderRadius: 6, padding: "9px 20px", fontFamily: "'Spectral',serif", fontSize: 12, letterSpacing: "1px", cursor: appendicesLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                        {appendicesLoading ? <><SpinDot light />Генерую...</> : "Генерувати →"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <textarea
                      value={appendicesText}
                      onChange={e => setAppendicesText(e.target.value)}
                      style={{ width: "100%", minHeight: 220, fontSize: 12, lineHeight: "1.85", color: "#2a2a1e", background: "#f5f2ea", borderRadius: 6, padding: "12px 14px", border: "1px solid #d4cfc4", fontFamily: "'Spectral',serif", resize: "vertical", boxSizing: "border-box" }}
                    />
                    <textarea
                      value={appendicesCustomPrompt}
                      onChange={e => setAppendicesCustomPrompt(e.target.value)}
                      placeholder="Інструкції для переробки (необов'язково)..."
                      style={{ width: "100%", minHeight: 56, fontSize: 12, lineHeight: "1.7", color: "#2a2a1e", background: "#f5f2ea", borderRadius: 6, padding: "10px 14px", border: "1px solid #d4cfc4", fontFamily: "'Spectral',serif", resize: "vertical", boxSizing: "border-box", marginTop: 8 }}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* ── Рисунки ── */}
            <div style={{ marginTop: 20, border: "1.5px solid #e8c84a", borderRadius: 8, overflow: "hidden" }}>
              <button onClick={() => setFigPanelOpen(p => !p)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", background: "#fff8e8", border: "none", cursor: "pointer", fontFamily: "'Spectral',serif" }}>
                <span style={{ fontWeight: 600, fontSize: 13, color: "#7a5000" }}>Рисунки у роботі</span>
                <span style={{ fontSize: 11, color: "#b08020" }}>{figPanelOpen ? "▲ згорнути" : "▼ розгорнути"}</span>
              </button>
              {figPanelOpen && (
                <div style={{ padding: "12px 16px", background: "#fffdf5" }}>
                  {figureKeywords.length === 0 && Object.keys(figureRefs).length === 0 ? (
                    <button onClick={doScanAndGenFigures} disabled={figKwLoading} style={{ fontSize: 12, background: "#e8c84a", border: "none", borderRadius: 6, padding: "6px 16px", cursor: "pointer", color: "#3a2000", fontFamily: "'Spectral',serif" }}>
                      {figKwLoading ? "Шукаю..." : "Перевірити рисунки у роботі →"}
                    </button>
                  ) : figKwLoading ? (
                    <div style={{ fontSize: 13, color: "#888" }}>Шукаю рисунки...</div>
                  ) : Object.values(figureRefs).every(a => a.length === 0) ? (
                    <div style={{ fontSize: 13, color: "#888", fontStyle: "italic" }}>Рисунків у роботі не виявлено</div>
                  ) : (
                    <>
                      {sections.flatMap(sec => (figureRefs[sec.id] || []).map(f => ({ ...f, secLabel: sec.label }))).map((f, i) => {
                        const kw = figureKeywords.find(k => k.label?.toLowerCase() === f.label?.toLowerCase());
                        return (
                          <div key={i} style={{ fontSize: 12, color: "#5a3a00", marginBottom: 10, lineHeight: "1.6", paddingLeft: 10, borderLeft: "3px solid #e8c84a" }}>
                            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                              <span style={{ fontWeight: 600 }}>{f.label}</span>
                              <span style={{ color: "#888", fontSize: 11 }}>{f.secLabel}</span>
                            </div>
                            {kw ? (
                              <>
                                <div style={{ color: "#3a6010", fontSize: 11, marginTop: 2 }}>{kw.name}</div>
                                <div style={{ color: "#1a5a8a", fontSize: 11, marginTop: 2 }}>Пошук: <span style={{ fontStyle: "italic" }}>{kw.keywords}</span></div>
                              </>
                            ) : (
                              <div style={{ color: "#7a5a20", marginTop: 2 }}>...{f.context}...</div>
                            )}
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 24 }}>
              <NavBtn onClick={() => setStage("sources")}>← Джерела</NavBtn>
              <button onClick={copyAll} style={{ background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, padding: "11px 30px", fontFamily: "'Spectral',serif", fontSize: 13, letterSpacing: "1.5px", cursor: "pointer" }}>Скопіювати текст</button>
              <button disabled={docxLoading} onClick={async () => { setDocxLoading(true); try { await exportToDocx({ sections, content, info, displayOrder, appendicesText, titlePage }); } catch (e) { alert("Помилка: " + e.message); } setDocxLoading(false); }}
                style={{ background: docxLoading ? "#aaa" : "#1a4a1a", color: docxLoading ? "#eee" : "#a8e060", border: "none", borderRadius: 7, padding: "11px 30px", fontFamily: "'Spectral',serif", fontSize: 13, letterSpacing: "1.5px", cursor: docxLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                {docxLoading ? <><SpinDot light />Генерую Word...</> : "⬇ Завантажити .docx"}
              </button>
              <button onClick={resetAll} style={{ background: "transparent", border: "1.5px solid #c4bfb4", color: "#777", borderRadius: 7, padding: "11px 22px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: "pointer" }}>Нове замовлення</button>
            </div>

            {/* ── Додаткові матеріали ── */}
            <div style={{ marginTop: 32, borderTop: "1.5px solid #d4cfc4", paddingTop: 24 }}>
              <div style={{ fontSize: 11, color: "#888", letterSpacing: "2px", textTransform: "uppercase", marginBottom: 16 }}>Додаткові матеріали</div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>

                {/* Презентація */}
                <div style={{ flex: 1, minWidth: 220, border: "1.5px solid #d4cfc4", borderRadius: 8, padding: "16px 18px" }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Презентація (.pptx)</div>
                  <div style={{ fontSize: 12, color: "#888", marginBottom: 14 }}>13 слайдів для захисту з дизайном</div>
                  <button
                    onClick={generatePresentation}
                    disabled={presentationLoading}
                    style={{ background: presentationLoading ? "#aaa" : "#1a1a14", color: presentationLoading ? "#eee" : "#e8ff47", border: "none", borderRadius: 6, padding: "9px 20px", fontFamily: "'Spectral',serif", fontSize: 12, letterSpacing: "1px", cursor: presentationLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                    {presentationLoading
                      ? <><SpinDot light />{presentationMsg || "Генерую..."}</>
                      : presentationReady ? "Генерувати знову" : "Генерувати"}
                  </button>
                  {presentationReady && !presentationLoading && (
                    <div style={{ marginTop: 10, fontSize: 12, color: "#2a6a2a", display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 14 }}>✓</span> Файл завантажено
                    </div>
                  )}
                  {!presentationReady && !presentationLoading && (
                    <div style={{ marginTop: 10, fontSize: 11, color: "#aaa", lineHeight: 1.5 }}>
                      Gemini аналізує текст, Claude генерує слайди
                    </div>
                  )}
                </div>

                {/* Доповідь */}
                <div style={{ flex: 1, minWidth: 220, border: "1.5px solid #d4cfc4", borderRadius: 8, padding: "16px 18px" }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Доповідь (.docx)</div>
                  <div style={{ fontSize: 12, color: "#888", marginBottom: 14 }}>Текст виступу на захист (5-7 хвилин)</div>
                  {!speechText ? (
                    <button onClick={generateSpeech} disabled={speechLoading}
                      style={{ background: speechLoading ? "#aaa" : "#1a1a14", color: speechLoading ? "#eee" : "#e8ff47", border: "none", borderRadius: 6, padding: "9px 20px", fontFamily: "'Spectral',serif", fontSize: 12, letterSpacing: "1px", cursor: speechLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {speechLoading ? <><SpinDot light />Генерую...</> : "Генерувати"}
                    </button>
                  ) : (
                    <div>
                      <div style={{ fontSize: 12, lineHeight: "1.8", color: "#444", maxHeight: 150, overflowY: "auto", background: "#f5f2ea", borderRadius: 6, padding: "10px 12px", marginBottom: 10, whiteSpace: "pre-wrap" }}>
                        {speechText.substring(0, 450)}...
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button onClick={async () => { setSpeechLoading(true); try { await exportSpeechToDocx(speechText, info); } catch (e) { alert("Помилка: " + e.message); } setSpeechLoading(false); }} disabled={speechLoading}
                          style={{ background: speechLoading ? "#aaa" : "#1a4a1a", color: speechLoading ? "#eee" : "#a8e060", border: "none", borderRadius: 6, padding: "9px 18px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: speechLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                          {speechLoading ? <><SpinDot light />...</> : "⬇ Завантажити .docx"}
                        </button>
                        <button onClick={() => setSpeechText("")}
                          style={{ background: "transparent", border: "1.5px solid #d4cfc4", color: "#888", borderRadius: 6, padding: "9px 14px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer" }}>
                          Переробити
                        </button>
                      </div>
                    </div>
                  )}
                </div>

              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
