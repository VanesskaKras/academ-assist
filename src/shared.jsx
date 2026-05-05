// ─────────────────────────────────────────────
// shared.js — утиліти спільні для small-works (docx export, стилі, парсинг)
// Логіка API, промпти, компоненти — в lib/ та components/
// ─────────────────────────────────────────────

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
export async function exportSimpleDocx({ title, sections, info, citations, orderId }) {
  if (!window.docx) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js";
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  const { Document, Packer, Paragraph, TextRun, AlignmentType, PageNumber, Header, HeadingLevel, ExternalHyperlink, InternalHyperlink, Bookmark } = window.docx;
  const FONT = "Times New Roman", SIZE = 28, SIZE_NUM = 24;
  const L = 1701, R = 851, T = 1134, B = 1134, INDENT = 709, LINE = 360;

  // [N] → внутрішнє гіперпосилання на закладку джерела
  function parseTextWithCitations(text, bold = false) {
    const CITE_RE = /\[(\d+)\]/g;
    const result = [];
    let lastIndex = 0, match;
    while ((match = CITE_RE.exec(text)) !== null) {
      if (match.index > lastIndex)
        result.push(new TextRun({ text: text.slice(lastIndex, match.index), font: FONT, size: SIZE, bold, color: "000000" }));
      result.push(new InternalHyperlink({
        anchor: `ref_${match[1]}`,
        children: [new TextRun({ text: match[0], font: FONT, size: SIZE, color: "000000" })],
      }));
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length)
      result.push(new TextRun({ text: text.slice(lastIndex), font: FONT, size: SIZE, bold, color: "000000" }));
    return result.length ? result : [new TextRun({ text, font: FONT, size: SIZE, bold, color: "000000" })];
  }

  // **жирний** inline + [N] для абзаців тексту
  function parseBodyLine(text) {
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
    return parts.flatMap(p => parseTextWithCitations(p.text, p.bold));
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
    sec.text.split("\n").forEach(line => {
      const trimmed = line.trim();
      const trimmedClean = trimmed.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");

      // Маркери пошуку рисунків — не потрапляють у docx
      if (FIG_MARKER_RE.test(trimmed)) return;

      // Якщо citations передано явно — пропускаємо вбудований блок джерел з тексту
      if (citations !== undefined && SOURCES_HEADER_RE.test(trimmedClean)) { inSources = true; return; }
      if (citations !== undefined && inSources) return;

      // Підпис рисунку: "Рис. N — Назва"
      if (FIG_CAPTION_RE.test(trimmed)) {
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          indent: { firstLine: 0 },
          spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.5) },
          children: [new TextRun({ text: trimmedClean, font: FONT, size: SIZE, color: "B85C00" })],
        }));
        return;
      }

      // Заголовок списку джерел (парсинг з тексту — лише якщо citations не передано)
      if (SOURCES_HEADER_RE.test(trimmedClean)) {
        inSources = true;
        children.push(new Paragraph({
          spacing: { line: LINE, lineRule: "auto", before: LINE, after: Math.round(LINE * 0.5) },
          alignment: AlignmentType.CENTER, indent: { firstLine: 0 },
          children: [new TextRun({ text: trimmedClean.replace(/[:\.]$/, ""), font: FONT, size: SIZE, bold: true, color: "000000" })],
        }));
        return;
      }

      // Рядки списку джерел (парсинг з тексту)
      if (inSources) {
        if (!trimmed) return;
        const numMatch = trimmedClean.match(/^(\d+)[\.\)]/);
        const p = numMatch ? sourceParaWithBookmark(trimmed, parseInt(numMatch[1])) : sourcePara(trimmed);
        if (p) children.push(p);
        return;
      }

      // Звичайний абзац тексту
      const raw = trimmed.replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/, "");
      const plain = raw.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");
      if (!plain) return;
      // Абзаци зі згадкою рисунку — помаранчевий текст
      const hasFig = FIG_INLINE_RE.test(plain);
      children.push(new Paragraph({
        indent: { firstLine: INDENT },
        spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
        alignment: AlignmentType.BOTH,
        children: hasFig
          ? [new TextRun({ text: plain, font: FONT, size: SIZE, color: "B85C00" })]
          : parseBodyLine(raw),
      }));
    });
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
