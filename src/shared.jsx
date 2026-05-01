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
export async function exportSimpleDocx({ title, sections, info }) {
  if (!window.docx) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js";
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  const { Document, Packer, Paragraph, TextRun, AlignmentType, PageNumber, Header, HeadingLevel } = window.docx;
  const FONT = "Times New Roman", SIZE = 28, SIZE_NUM = 24;
  const L = 1701, R = 851, T = 1134, B = 1134, INDENT = 709, LINE = 360;

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
    sec.text.split("\n").forEach(line => {
      const raw = line.replace(/^#{1,6}\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").replace(/^[-*]\s+/, "").trim();
      if (!raw) return;
      children.push(new Paragraph({
        indent: { firstLine: INDENT },
        spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
        alignment: AlignmentType.BOTH,
        children: [new TextRun({ text: raw, font: FONT, size: SIZE, color: "000000" })],
      }));
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
    const prefix = info?.orderNumber ? info.orderNumber + "_" : "";
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
