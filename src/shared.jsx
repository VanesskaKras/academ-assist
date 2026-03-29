// ─────────────────────────────────────────────
// shared.js — спільна логіка для academic-assistant та small-works
// ─────────────────────────────────────────────
import { useState, useRef, useCallback } from "react";
import { auth } from "./firebase";
import { Document, Packer, Paragraph, TextRun, AlignmentType, PageNumber, Header, HeadingLevel } from "docx";

// ── Моделі ──
export const MODEL = "claude-sonnet-4-6";
export const MODEL_FAST = "claude-haiku-4-5-20251001";

// ── Системний промпт ──
export function buildSYS(lang = "Українська") {
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

## ФОРМАТУВАННЯ (суворо)
НЕ використовуй markdown розмітку: жодних #, ##, **, *, - на початку рядка. Пиши звичайний текст.
НЕ виділяй нічого жирним шрифтом у тексті підрозділів.
НЕ повторюй назву підрозділу на початку тексту — одразу починай зміст.
НЕ додавай посилання на джерела у тексті підрозділів. Список джерел буде окремо в кінці.
НЕ використовуй тире "—" — заміни комою або перебудуй речення.

## ЗАБОРОНЕНІ СЛОВА
${forbiddenWords}

## СТИЛЬ ПИСЬМА
Починай кожен підрозділ із сильного вступного речення що одразу вводить у тему.
Пиши короткими, чіткими реченнями. Використовуй активний стан дієслів.
Уникай крапок з комою та надмірно довгих речень. Чергуй довжину речень для природного ритму читання.
Додавай короткі конкретні приклади для пояснення теоретичних положень.
Використовуй природні сполучники: "тож", "отже", "водночас", "при цьому".
Кожен підрозділ завершується логічно — повним реченням та підсумковою думкою. Не обривай текст.
Зберігай теплий але академічний тон. Науковий зміст — пріоритет.`;
}

// ── API ──
export async function callClaude(messages, signal, systemPrompt, maxTokens, onWait, model) {
  const MAX_RETRIES = 5;
  let delay = 12000;
  const token = await auth.currentUser?.getIdToken().catch(() => null);
  const authHeader = token ? { "Authorization": `Bearer ${token}` } : {};
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch("/api/claude", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", ...authHeader },
      body: JSON.stringify({ model: model || MODEL, max_tokens: maxTokens || 8000, system: systemPrompt || buildSYS(), messages }),
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
      try { errData = await res.json(); } catch {}
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
    const data = await res.json();
    if (!data.content) throw new Error("No content in response: " + JSON.stringify(data).slice(0, 200));
    return data.content.map(b => b.text || "").join("") || "";
  }
}

// ── Firestore ──
export function serializeForFirestore(obj) {
  return JSON.parse(JSON.stringify(obj, (_, v) => v === undefined ? null : v));
}

// ── Парсинг сторінок ──
export function parsePagesAvg(str) {
  if (!str) return 20;
  const nums = String(str).match(/\d+/g);
  if (!nums) return 20;
  if (nums.length === 1) return parseInt(nums[0]);
  return Math.round(nums.reduce((a, b) => a + parseInt(b), 0) / nums.length);
}

// ── Word export (спільний для обох) ──
export async function exportToDocx({ sections, content, info, displayOrder }) {
  const FONT = "Times New Roman", SIZE = 28, SIZE_NUM = 24;
  const L = 1701, R = 851, T = 1134, B = 1134, INDENT = 709, LINE = 360;

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
  function bodyPara(text) {
    return new Paragraph({
      indent: { firstLine: INDENT },
      spacing: { line: LINE, lineRule: "auto", before: 0, after: 0 },
      alignment: AlignmentType.BOTH,
      children: [new TextRun({ text: text || "", font: FONT, size: SIZE, color: "000000" })],
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
  function makeParas(text, secLabel) {
    if (!text) return [];
    const result = []; let firstContentLine = true;
    text.split("\n").forEach(line => {
      const raw = cleanMarkdown(line);
      if (!raw) return;
      if (firstContentLine && isDuplicateTitle(line, secLabel)) { firstContentLine = false; return; }
      firstContentLine = false;
      if (/^#{1,6}\s/.test(line.trim()) && raw) { result.push(headingSubsection(raw)); return; }
      result.push(bodyPara(raw));
    });
    return result;
  }

  const children = [];
  let lastChapter = null;
  for (let i = 0; i < displayOrder.length; i++) {
    const sec = displayOrder[i]; const txt = content[sec.id];
    if (!txt) continue;
    const isMain = !["intro", "conclusions", "sources"].includes(sec.type);
    const isSubsection = isMain && /^\d+\.\d+/.test(sec.id);
    const thisChapter = isSubsection ? sec.id.split(".")[0] : null;
    let needsPageBreak = i > 0;
    if (isSubsection) {
      const prevSec = displayOrder.slice(0, i).reverse().find(s => content[s.id]);
      const prevIsSubsection = prevSec && !["intro", "conclusions", "sources"].includes(prevSec.type) && /^\d+\.\d+/.test(prevSec.id || "");
      needsPageBreak = !prevIsSubsection || thisChapter !== prevSec?.id?.split(".")?.[0];
    }
    if (needsPageBreak && i > 0) children.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));
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
    children.push(...makeParas(txt, sec.label));
  }

  const doc = new Document({
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
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── Simple docx export для малих робіт (плоский текст без підрозділів) ──
export async function exportSimpleDocx({ title, sections, info }) {
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
  const a = document.createElement("a");
  const safeName = (info?.topic || title || "робота").replace(/[^\wА-ЯҐЄІЇа-яґєії\s]/g, "").trim().slice(0, 40);
  a.href = url; a.download = safeName + ".docx";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── Звукове сповіщення ──
// Щоб замінити на свій звук: покладіть файл (mp3/wav/ogg) в папку /public
// і замініть CUSTOM_SOUND_URL на шлях, наприклад "/sounds/done.mp3"
const CUSTOM_SOUND_URL = null; // або "/sounds/done.mp3"

export function playDoneSound() {
  if (CUSTOM_SOUND_URL) {
    try { new Audio(CUSTOM_SOUND_URL).play(); } catch {}
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
  } catch {}
}

// ── Загальні стилі ──
export const TA = { width: "100%", background: "#f0ece2", border: "1.5px solid #d4cfc4", borderRadius: 6, color: "#1a1a14", fontSize: 14, padding: "12px 14px", resize: "vertical", lineHeight: "1.75", fontFamily: "'Spectral',Georgia,serif" };
export const TA_WHITE = { ...TA, background: "#fff", fontSize: 13 };

// ── UI компоненти ──
export function SpinDot({ light }) {
  const c = light ? "#e8ff47" : "#1a1a14";
  return <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", border: `2px solid ${c}33`, borderTop: `2px solid ${c}`, animation: "spin .7s linear infinite", flexShrink: 0 }} />;
}

export function Shimmer({ width = "100%", height = 13 }) {
  return <div style={{ width, height, borderRadius: 4, background: "linear-gradient(90deg,#e8e4da 25%,#f5f2ea 50%,#e8e4da 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.4s infinite" }} />;
}

export function FieldBox({ label, children }) {
  return <div style={{ marginBottom: 16 }}>
    <div style={{ fontSize: 11, color: "#888", letterSpacing: "2px", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
    {children}
  </div>;
}

export function Heading({ children, style = {} }) {
  return <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 17, letterSpacing: 2, marginBottom: 20, ...style }}>{children}</div>;
}

export function NavBtn({ onClick, children, disabled }) {
  return <button onClick={onClick} disabled={disabled} style={{ background: "transparent", border: "1.5px solid #c4bfb4", color: disabled ? "#ccc" : "#777", borderRadius: 7, padding: "11px 22px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: disabled ? "default" : "pointer" }}>{children}</button>;
}

export function PrimaryBtn({ onClick, disabled, loading, msg, label }) {
  return <button onClick={onClick} disabled={disabled || loading} style={{ background: (disabled || loading) ? "#aaa" : "#1a1a14", color: (disabled || loading) ? "#eee" : "#e8ff47", border: "none", borderRadius: 7, padding: "11px 34px", fontFamily: "'Spectral',serif", fontSize: 13, letterSpacing: "1.5px", cursor: (disabled || loading) ? "default" : "pointer" }}>
    {loading ? <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><SpinDot light />{msg}</span> : label}
  </button>;
}

export function GreenBtn({ onClick, disabled, loading, msg, label }) {
  return <button onClick={onClick} disabled={disabled || loading} style={{ background: (disabled || loading) ? "#aaa" : "#2a3a1a", color: (disabled || loading) ? "#eee" : "#a8d060", border: "none", borderRadius: 7, padding: "10px 24px", fontFamily: "'Spectral',serif", fontSize: 12, letterSpacing: "1px", cursor: (disabled || loading) ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
    {loading ? <><SpinDot light />{msg}</> : label}
  </button>;
}

export function SaveIndicator({ saving, saved }) {
  if (saving) return <span style={{ fontSize: 11, color: "#aaa", display: "inline-flex", alignItems: "center", gap: 5 }}><SpinDot />Збереження...</span>;
  if (saved) return <span style={{ fontSize: 11, color: "#6a9000" }}>✓ Збережено</span>;
  return null;
}

export function DropZone({ fileLabel, onFile, accept = ".pdf,.docx,.jpg,.jpeg,.png" }) {
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef();
  const handleDrop = useCallback(e => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0]; if (f) processFile(f);
  }, []);
  function processFile(f) {
    const r = new FileReader();
    r.onload = ev => onFile(f.name, ev.target.result.split(",")[1], f.type);
    r.readAsDataURL(f);
  }
  return <>
    <div onClick={() => fileRef.current.click()} onDrop={handleDrop}
      onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
      style={{ minHeight: 90, border: `1.5px dashed ${dragging ? "#1a1a14" : "#c4bfb4"}`, borderRadius: 6, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, cursor: "pointer", padding: 14, background: dragging ? "#e8e4d8" : "#ede9e0", transition: "all .2s" }}>
      <div style={{ fontSize: 24 }}>{fileLabel ? "📄" : "⬆️"}</div>
      <div style={{ fontSize: 12, color: "#888", textAlign: "center" }}>{fileLabel || "Перетягніть або клікніть (PDF, DOCX, фото)"}</div>
      {fileLabel && <div style={{ fontSize: 10, color: "#aaa" }}>(клікніть щоб замінити)</div>}
    </div>
    <input ref={fileRef} type="file" accept={accept} style={{ display: "none" }}
      onChange={e => { const f = e.target.files[0]; if (f) processFile(f); }} />
  </>;
}

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
