import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { db } from "./firebase";
import { useAuth } from "./AuthContext";
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp,
} from "firebase/firestore";

// ─────────────────────────────────────────────
// Word export
// ─────────────────────────────────────────────
async function exportToDocx({ content, info, displayOrder }) {
  if (!window.docx) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js";
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  const { Document, Packer, Paragraph, TextRun, AlignmentType, PageNumber, Header, HeadingLevel, TableOfContents } = window.docx;
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

  function sourcePara(text) {
    const cleaned = text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").trim();
    if (!cleaned) return null;
    return new Paragraph({
      spacing: { line: LINE, lineRule: "auto", before: 0, after: Math.round(LINE * 0.3) },
      alignment: AlignmentType.BOTH,
      indent: { left: INDENT, hanging: INDENT },
      children: [new TextRun({ text: cleaned, font: FONT, size: SIZE, color: "000000" })],
    });
  }


  const children = [];

  // ── Сторінка 1: порожня ──
  children.push(new Paragraph({ spacing: { before: 0, after: 0, line: LINE, lineRule: "auto" }, children: [] }));

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
    children.push(...makeParas(txt, sec.label));
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
  // Title
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { line: LINE, lineRule: "auto", before: 0, after: LINE * 2 },
    children: [new TextRun({ text: "ПЛАН РОБОТИ", font: FONT, size: SIZE, bold: true, color: "000000" })],
  }));
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
// Constants
// ─────────────────────────────────────────────
const MODEL = "claude-sonnet-4-6";        // для генерації тексту
const MODEL_FAST = "claude-haiku-4-5-20251001"; // для JSON-задач (аналіз, план, ключові слова)

// ── Звукове сповіщення ──
// Щоб замінити на свій звук: покладіть файл (mp3/wav/ogg) в папку /public
// і замініть CUSTOM_SOUND_URL на шлях, наприклад "/sounds/done.mp3"
const CUSTOM_SOUND_URL = "/sounds/hi.mp3"; // або "/sounds/done.mp3"

function playDoneSound() {
  if (CUSTOM_SOUND_URL) {
    try { new Audio(CUSTOM_SOUND_URL).play(); } catch { }
    return;
  }
  // Дефолтний звук (Web Audio API)
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

## ФОРМАТУВАННЯ (суворо)
НЕ використовуй markdown розмітку: жодних #, ##, **, *, - на початку рядка. Пиши звичайний текст.
НЕ виділяй нічого жирним шрифтом у тексті підрозділів.
НЕ повторюй назву підрозділу на початку тексту — одразу починай зміст.
НЕ додавай посилання на джерела у тексті підрозділів. Список джерел буде окремо в кінці.
КАТЕГОРИЧНО ЗАБОРОНЕНО використовувати довге тире "—" (em dash). Замість нього використовуй кому, крапку з комою, або перебудуй речення. Символ "—" не повинен з'являтися в тексті ЖОДНОГО разу.

## ЗАБОРОНЕНІ СЛОВА
${forbiddenWords}

## СТИЛЬ ПИСЬМА
Починай кожен підрозділ із захоплюючого гачка, що одразу вводить у тему.
Пиши короткими, чіткими реченнями. Використовуй активний стан дієслів.
Замінюй жаргон і складні терміни на повсякденні слова. Використовуй мінімум скорочень.
Уникай крапок з комою та надмірно довгих речень. Розбивай довгі речення на менші шматки.
Чергуй довжину речень для природного ритму читання.
Додавай короткі, зрозумілі приклади для пояснення теоретичних положень.
Використовуй неформальні сполучники: "тож", "тоді", "отже", "водночас".
Використовуй окремі короткі фрагменти, коли це здається природним.
Вставляй прості метафори для ясності там, де це доречно.
Перетворюй категоричні твердження на м'які пропозиції. Вставляй короткі переходи між абзацами.
Використовуй фразові дієслова (наприклад, "розпочати", "виявити", "розглянути").
Зменшуй драматичну терміновість і пафос.
Зберігай усі ключові факти недоторканими.
Прийми теплий, розмовний але академічний тон. Малюй яскраві образи простою мовою.
Зберігай оригінальну структуру підрозділу, але послаблюй формальність.
Кожен підрозділ завершується логічно, повним реченням та підсумковою думкою. Не обривай текст.`;
}

const FIELD_LABELS = {
  type: "Тип роботи", pages: "К-сть сторінок", topic: "Тема роботи",
  subject: "Тематика / предмет", direction: "Галузь / напрям", uniqueness: "Унікальність",
  language: "Мова роботи", deadline: "Дедлайн", extras: "Додаткові матеріали",
  methodNotes: "Вимоги методички",
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
  let delay = 12000; // 12 сек початкова затримка при 429
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch("/api/claude", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model || MODEL, max_tokens: maxTokens || 8000, system: systemPrompt || buildSYS(), messages }),
    });
    if (res.status === 429) {
      if (attempt === MAX_RETRIES) throw new Error("Rate limit: спробуйте через хвилину");
      // Зворотний відлік
      const waitSec = Math.ceil(delay / 1000);
      for (let s = waitSec; s > 0; s--) {
        if (onWait) onWait(s);
        await new Promise(r => setTimeout(r, 1000));
        if (signal?.aborted) throw new Error("AbortError");
      }
      delay = Math.min(delay * 1.5, 60000); // збільшуємо затримку, але не більше 60 сек
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
    const data = await res.json();
    if (!data.content) {
      console.error("Claude API unexpected response:", JSON.stringify(data).slice(0, 300));
      throw new Error("No content in response: " + JSON.stringify(data).slice(0, 200));
    }
    return data.content.map(b => b.text || "").join("") || "";
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
      <div style={{ fontSize: 12, color: "#888", textAlign: "center" }}>{fileLabel || "Перетягніть або клікніть для вибору PDF / DOCX"}</div>
      {fileLabel && <div style={{ fontSize: 10, color: "#aaa" }}>(клікніть щоб замінити)</div>}
    </div>
    <input ref={fileRef} type="file" accept=".pdf,.docx" style={{ display: "none" }} onChange={e => { const f = e.target.files[0]; if (f) processFile(f); }} />
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
  const [allCitLoading, setAllCitLoading] = useState(false);
  const [refList, setRefList] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dbLoading, setDbLoading] = useState(false);
  // For regenerating a single section
  const [regenId, setRegenId] = useState(null);
  const [regenPrompt, setRegenPrompt] = useState("");
  const [regenLoading, setRegenLoading] = useState(false);
  const [apiError, setApiError] = useState("");

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
          if (d.content) setContent(d.content);
          if (d.citInputs) setCitInputs(d.citInputs);
          if (d.refList) setRefList(d.refList);
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
    setInfo(newInfo);

    // КРОК 2: Якщо є методичка — пауза між запитами щоб не перевищити rate limit
    if (fileB64) {
      setLoadMsg("Читаю методичку...");
      await new Promise(r => setTimeout(r, 2000)); // пауза між двома API-викликами
      const methodMsgs = [
        { type: "document", source: { type: "base64", media_type: fileType || "application/pdf", data: fileB64 } },
        {
          type: "text", text: `Уважно прочитай методичку повністю і витягни всю структурну та оформлювальну інформацію.

Поверни ТІЛЬКИ JSON (без markdown, без коментарів):
{
  "totalPages": 30,
  "chaptersCount": 2,
  "subsectionsPerChapter": 2,
  "hasChapterConclusions": true,
  "chapterTypes": ["theory","analysis"],
  "exampleTOC": "ВСТУП\nРОЗДІЛ 1. Назва\n1.1 Підрозділ\nВисновки до Розділу 1\nРОЗДІЛ 2...",
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
  "otherRequirements": "виклад від першої особи множини (ми вважаємо) або безособові конструкції"
}

Правила:
- totalPages: загальний обсяг роботи в сторінках (число, не рахуючи додатки і список джерел)
- chaptersCount: к-сть розділів (null якщо не вказано)
- subsectionsPerChapter: порахуй к-сть підрозділів в одному розділі з exampleTOC (null якщо не вказано)
- hasChapterConclusions: true ТІЛЬКИ якщо методичка явно вимагає висновки до кожного розділу
- introComponents: точний перелік елементів вступу згідно методички
- sourcesStyle: "APA", "ДСТУ 8302:2015", "MLA" або інший — точно як у методичці
- sourcesOrder: "alphabetical" або "citation_order"
- sourcesGrouping: якщо є правила групування джерел за мовами — вкажи
- citationStyle: як оформляти посилання в тексті (в дужках, у виносках тощо)
- formatting: всі деталі оформлення — шрифт, розміри, поля, відступи, нумерація
- exampleTOC: якщо є зразок змісту в додатках — скопіюй його структуру` }
      ];
      try {
        const raw = await callClaude([{ role: "user", content: methodMsgs }], null, "Respond only with valid JSON. No markdown, no comments.", 4000, (s) => setLoadMsg(`Читаю методичку... зачекайте ${s}с`));
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
        setMethodInfo(parsed);
        await saveToFirestore({ tplText, comment, clientPlan, info: newInfo, methodInfo: parsed, stage: "parsed", status: "new" });
      } catch (e) {
        console.warn("methodInfo extract failed:", e.message);
        setApiError(e.message);
        setMethodInfo(null);
        await saveToFirestore({ tplText, comment, clientPlan, info: newInfo, stage: "parsed", status: "new" });
      }
    } else {
      setMethodInfo(null);
      await saveToFirestore({ tplText, comment, clientPlan, info: newInfo, stage: "parsed", status: "new" });
    }

    setRunning(false); runningRef.current = false; setLoadMsg(""); setStage("parsed");
  };

  // ── Парсинг плану клієнта ──
  const parseClientPlan = (text, totalPages) => {
    const normalized = text
      .replace(/([^\n])\s+(Розділ\s+\d+)/gi, "$1\n$2")
      .replace(/([^\n])\s+(висновк\w*)/gi, "$1\n$2")
      .replace(/([^\n])\s+(список\s)/gi, "$1\n$2")
      .replace(/([^\n])\s+(вступ\b)/gi, "$1\n$2");
    const lines = normalized.split("\n").map(l => l.trim()).filter(Boolean);
    const chapters = []; let current = null;
    for (const line of lines) {
      const isChapter = /^(розділ\s*\d+|chapter\s*\d+|\d+[\.\)]\s+[А-ЯҐЄІЇа-яґєії])/i.test(line);
      const isSubsection = /^\d+\.\d+/.test(line) || /^[-–•]\s+/.test(line);
      const isSpecial = /^(вступ\b|висновк|список)/i.test(line);
      if (isSpecial) continue;
      if (isChapter) { current = { title: line.trim(), subsections: [] }; chapters.push(current); }
      else if (isSubsection && current) current.subsections.push(line.replace(/^[-–•]\s+/, "").trim());
      else if (current && !isSubsection && line.length > 3) current.subsections.push(line);
      else if (!current && line.length > 3) { current = { title: line.trim(), subsections: [] }; chapters.push(current); }
    }
    if (!chapters.length) return null;
    const mainPages = Math.round(totalPages * 0.80);
    const pagesPerChapter = Math.max(1, Math.round(mainPages / chapters.length));
    const introPages = Math.max(1, Math.round(totalPages * 0.05));
    const concPages = Math.max(1, Math.round(totalPages * 0.05));
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
    }
    sections.push({ id: "intro", label: "ВСТУП", pages: introPages, type: "intro" });
    sections.push({ id: "conclusions", label: "ВИСНОВКИ", pages: concPages, type: "conclusions" });
    sections.push({ id: "sources", label: "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", pages: 1, type: "sources" });
    return sections;
  };

  const buildDefaultPlan = (totalPages) => {
    const needThirdChapter = totalPages >= 40;
    const mainPages = Math.round(totalPages * 0.80);
    const chapCount = needThirdChapter ? 3 : 2;
    const pagesPerCh = Math.max(1, Math.round(mainPages / chapCount));
    const pagesPerSub = Math.max(1, Math.round(pagesPerCh / 3));
    const introPages = Math.max(1, Math.round(totalPages * 0.05));
    const concPages = Math.max(1, Math.round(totalPages * 0.05));
    const chapterNames = [`РОЗДІЛ 1. ТЕОРЕТИЧНІ ОСНОВИ ДОСЛІДЖЕННЯ`, `РОЗДІЛ 2. АНАЛІЗ ТА ПРАКТИЧНА ЧАСТИНА`, ...(needThirdChapter ? [`РОЗДІЛ 3. РЕКОМЕНДАЦІЇ ТА ПРОПОЗИЦІЇ`] : [])];
    const chTypes = ["theory", "analysis", "recommendations"];
    const sections = [];
    chapterNames.forEach((chName, ci) => {
      const chapNum = ci + 1;
      for (let i = 1; i <= 3; i++) sections.push({ id: `${chapNum}.${i}`, label: `${chapNum}.${i} [підрозділ ${chapNum}.${i}]`, sectionTitle: chName, pages: pagesPerSub, type: chTypes[ci] });
    });
    sections.push({ id: "intro", label: "ВСТУП", pages: introPages, type: "intro" });
    sections.push({ id: "conclusions", label: "ВИСНОВКИ", pages: concPages, type: "conclusions" });
    sections.push({ id: "sources", label: "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", pages: 1, type: "sources" });
    return sections;
  };

  // ── Генерація плану ──
  const doGenPlan = async () => {
    setPlanLoading(true); setSections([]); setPlanDisplay(""); setStage("plan");
    const d = info; const totalPages = parsePagesAvg(d.pages);

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

    if (methodInfo) {
      // Маємо готову структурну інфу з методички — генеруємо план без PDF
      const chapCount = methodInfo.chaptersCount || (totalPages >= 40 ? 3 : 2);
      const hasConcl = methodInfo.hasChapterConclusions || false;
      const chTypes = methodInfo.chapterTypes?.length ? methodInfo.chapterTypes : ["theory", "analysis", "recommendations"].slice(0, chapCount);
      // Якщо не витягнулось — рахуємо з exampleTOC (підрозділи виду "1.1", "1.2" тощо)
      const subsFromTOC = methodInfo.exampleTOC
        ? (methodInfo.exampleTOC.match(/^\s*1\.\d+/gm) || []).length || null
        : null;
      const subsCount = methodInfo.subsectionsPerChapter || subsFromTOC || 3;

      const planPrompt = `Склади план ${d.type} на тему: "${d.topic}". Галузь: ${d.subject}. Обсяг: ${totalPages} стор.

ВИМОГИ З МЕТОДИЧКИ:
- К-сть розділів: ${chapCount}
- Підрозділів у кожному розділі: ${subsCount}
- Висновки до розділів: ${hasConcl ? "ТАК — додай після останнього підрозділу кожного розділу" : "НІ — не додавай"}
- Типи розділів: ${chTypes.join(", ")}
${methodInfo.exampleTOC ? `- Приклад змісту з методички (використай як шаблон структури):\n${methodInfo.exampleTOC}` : ""}
${methodInfo.otherRequirements ? `- Інші вимоги: ${methodInfo.otherRequirements}` : ""}

РОЗПОДІЛ СТОРІНОК:
- Вступ: ${Math.max(2, Math.round(totalPages * 0.05))} стор.
- Висновки: ${Math.max(2, Math.round(totalPages * 0.05))} стор.
- Основна частина: ${Math.round(totalPages * 0.87)} стор. рівномірно між підрозділами
${hasConcl ? "- Висновки до розділу: 1 стор." : ""}

ДОПУСТИМІ type: "theory" | "analysis" | "recommendations" | "chapter_conclusion" | "intro" | "conclusions" | "sources"
chapter_conclusion id формат: "1.conclusions", "2.conclusions" тощо.

Поверни ТІЛЬКИ JSON без markdown:
{"sections":[
  {"id":"1.1","label":"1.1 Назва підрозділу","sectionTitle":"РОЗДІЛ 1. НАЗВА РОЗДІЛУ","pages":8,"type":"theory"},
  {"id":"1.2","label":"1.2 Назва підрозділу","sectionTitle":"РОЗДІЛ 1. НАЗВА РОЗДІЛУ","pages":7,"type":"theory"},
  {"id":"1.conclusions","label":"Висновки до розділу 1","sectionTitle":"РОЗДІЛ 1. НАЗВА РОЗДІЛУ","pages":1,"type":"chapter_conclusion"},
  {"id":"2.1","label":"2.1 Назва підрозділу","sectionTitle":"РОЗДІЛ 2. НАЗВА РОЗДІЛУ","pages":8,"type":"analysis"},
  {"id":"intro","label":"ВСТУП","pages":3,"type":"intro"},
  {"id":"conclusions","label":"ВИСНОВКИ","pages":3,"type":"conclusions"},
  {"id":"sources","label":"СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ","pages":2,"type":"sources"}
]}
Порядок: підрозділи згруповані по розділах, потім intro, conclusions, sources.`;

      try {
        await new Promise(r => setTimeout(r, 3000)); // пауза після аналізу методички
        const raw = await callClaude([{ role: "user", content: planPrompt }], null, "Respond only with valid JSON. No markdown, no explanation.", 3000, null, MODEL_FAST);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
        const secs = parsed.sections || parsed;
        if (Array.isArray(secs) && secs.length > 3) { await finalizeSections(secs); return; }
        console.warn("methodInfo plan: unexpected shape", parsed);
      } catch (e) { console.error("methodInfo plan error:", e); }
    }

    const defaultSecs = buildDefaultPlan(totalPages);
    const namingPrompt = `Для ${d.type} на тему "${d.topic}" (галузь: ${d.subject}) придумай назви підрозділів.\nСтруктура фіксована:\n${defaultSecs.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type)).map(s => `${s.id} [${s.sectionTitle}]`).join("\n")}\n\nПоверни ТІЛЬКИ JSON без markdown:\n{"titles":{"1.1":"Назва","1.2":"Назва","2.1":"Назва","2.2":"Назва"}}`;
    try {
      await new Promise(r => setTimeout(r, 2000)); // пауза перед запитом
      const raw = await callClaude([{ role: "user", content: namingPrompt }], null, "Respond only with valid JSON. No markdown, no explanation.", 1000, null, MODEL_FAST);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
      const namedSecs = defaultSecs.map(s => { const name = parsed.titles?.[s.id]; return name ? { ...s, label: `${s.id} ${name}` } : s; });
      await finalizeSections(namedSecs);
    } catch (e) {
      console.error("Naming error:", e);
      await finalizeSections(defaultSecs);
    }
  };

  const startGen = () => {
    const ORDER = ["theory", "analysis", "recommendations", "chapter_conclusion", "intro", "conclusions", "sources"];
    setSections(prev => [...prev].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type)));
    setContent({}); setGenIdx(0); setPaused(false); setStage("writing");
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
      // Кількість абзаців актуальності залежить від обсягу роботи
      const actualityParas = isLarge ? "10-12" : "6";
      const conclusionsParas = isLarge ? "10-12" : "7";

      // Завдань — зазвичай стільки скільки підрозділів основної частини
      const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
      const tasksCount = Math.min(mainSecs.length, isLarge ? 8 : 5);

      // Додаткові компоненти з методички
      const extraComponents = methodInfo?.introComponents?.filter(c =>
        !/(актуальність|мета|завдання|об.єкт|предмет)/i.test(c)
      ) || [];
      const extraStr = extraComponents.length > 0
        ? `\nДОДАТКОВІ ЕЛЕМЕНТИ З МЕТОДИЧКИ: ${extraComponents.join(", ")}.`
        : "";

      instruction = `Напиши ВСТУП для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.

СТРУКТУРА ВСТУПУ (дотримуватись суворо, кожен елемент з нового абзацу):

1. АКТУАЛЬНІСТЬ ТЕМИ (${actualityParas} абзаців):
   - Починай без слів "Актуальність" на початку — одразу з сильного речення про проблему
   - Покажи чому тема важлива сьогодні, які наукові прогалини існують
   - Згадай стан дослідженості теми у вітчизняній та зарубіжній науці
   - Плавно підведи до мети дослідження

2. МЕТА ДОСЛІДЖЕННЯ (1 абзац):
   Мета дослідження — [чітко сформульована мета, що відповідає темі "${d.topic}"].

3. ЗАВДАННЯ ДОСЛІДЖЕННЯ (1 абзац, ${tasksCount} завдань):
   Для досягнення мети поставлено такі завдання: 1) ...; 2) ...; 3) ...; [далі за потребою].
   Завдання мають відповідати підрозділам роботи:
${mainSecs.map((s, i) => `   ${i + 1}) підрозділ "${s.label}"`).join("\n")}

4. ОБ'ЄКТ ДОСЛІДЖЕННЯ (1 абзац):
   Об'єкт дослідження — [що саме досліджується, явище або процес].

5. ПРЕДМЕТ ДОСЛІДЖЕННЯ (1 абзац):
   Предмет дослідження — [конкретний аспект об'єкта, який аналізується у роботі].
${extraStr}

6. МЕТОДИ ДОСЛІДЖЕННЯ (1 абзац):
   Для вирішення поставлених завдань використано такі методи: [перелік методів відповідно до теми].

7. СТРУКТУРА РОБОТИ (1 абзац):
   Робота складається з вступу, [к-сть] розділів, висновків та списку використаних джерел. Загальний обсяг роботи — [обсяг] сторінок.
${methodInfo?.otherRequirements ? `\nВИМОГИ МЕТОДИЧКИ: ${methodInfo.otherRequirements}` : ""}

НЕ додавай посилань. НЕ виділяй жирним. Пиши суцільним текстом абзацами без нумерації та заголовків.`;

    } else if (sec.type === "conclusions") {
      const conclusionsParas = isLarge ? "10-12" : "7";
      const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
      // Беремо короткий контекст усіх підрозділів для висновків
      const allCtx = mainSecs.map(s => contentRef.current[s.id]
        ? `[${s.label}]: ${contentRef.current[s.id].substring(0, 300)}...`
        : "").filter(Boolean).join("\n\n");

      const conclReq = methodInfo?.conclusionsRequirements || "";

      instruction = `Напиши ВИСНОВКИ для ${d.type} на тему "${d.topic}".
${conclReq ? `ВИМОГИ МЕТОДИЧКИ: ${conclReq}\n` : ""}
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

      instruction = `Напиши підрозділ "${sec.label}" для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.
Тип підрозділу: ${typeHints[sec.type] || "основний"}.
${methodReq ? `ВИМОГИ МЕТОДИЧКИ ДО ЦЬОГО РОЗДІЛУ: ${methodReq}` : ""}

ПЛАН РОБОТИ (для розуміння структури та уникнення повторів):
${planSummary}

${prevCtx ? `КОНТЕКСТ ПОПЕРЕДНІХ ПІДРОЗДІЛІВ:\n${prevCtx}\n` : ""}Обсяг: ~${approxParas} абзаців (~${sec.pages} стор.).
Не обривай текст. Завершуй підсумковим абзацом. Без посилань [1],[2]. Без жирного.`;
    }
    try {
      const raw = await callClaude([{ role: "user", content: instruction }], ctrl.signal, buildSYS(lang), 8000, (s) => setLoadMsg(`Генерую: ${sec.label}... зачекайте ${s}с`));
      // Видаляємо довге тире на всякий випадок (модель іноді ігнорує заборону)
      const result = raw.replace(/ — /g, ", ").replace(/— /g, "").replace(/ —/g, "");
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
      const actualityParas = isLarge ? "10-12" : "6";
      const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
      const tasksCount = Math.min(mainSecs.length, isLarge ? 8 : 5);
      const extraComponents = methodInfo?.introComponents?.filter(c =>
        !/(актуальність|мета|завдання|об.єкт|предмет)/i.test(c)
      ) || [];
      const extraStr = extraComponents.length > 0 ? `\nДОДАТКОВІ ЕЛЕМЕНТИ З МЕТОДИЧКИ: ${extraComponents.join(", ")}.` : "";

      instruction = `Перепиши ВСТУП для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.
${origSnippet}
СТРУКТУРА ВСТУПУ (суворо дотримуватись):

1. АКТУАЛЬНІСТЬ (${actualityParas} абзаців) — без слова "Актуальність" на початку, одразу з проблеми
2. МЕТА ДОСЛІДЖЕННЯ (1 абзац): Мета дослідження — ...
3. ЗАВДАННЯ (1 абзац, ${tasksCount} завдань): Для досягнення мети поставлено такі завдання: 1)...; 2)...;
4. ОБ'ЄКТ ДОСЛІДЖЕННЯ (1 абзац): Об'єкт дослідження — ...
5. ПРЕДМЕТ ДОСЛІДЖЕННЯ (1 абзац): Предмет дослідження — ...${extraStr}
6. МЕТОДИ ДОСЛІДЖЕННЯ (1 абзац)
7. СТРУКТУРА РОБОТИ (1 абзац)
${methodInfo?.otherRequirements ? `ВИМОГИ МЕТОДИЧКИ: ${methodInfo.otherRequirements}` : ""}
Без посилань. Без жирного. Без нумерації у тексті.${customInstructions}`;

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
      instruction = `Перепиши підрозділ "${sec.label}" для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.
${origSnippet}Обсяг: ~${approxParas} абзаців (~${sec.pages} стор.).
Не обривай текст. Завершуй підсумковим абзацом. Без посилань. Без жирного.${customInstructions}`;
    }
    try {
      const raw = await callClaude([{ role: "user", content: instruction }], null, buildSYS(lang), 8000);
      const result = raw.replace(/ — /g, ", ").replace(/— /g, "").replace(/ —/g, "");
      const newContent = { ...contentRef.current, [sec.id]: result };
      setContent(newContent);
      setRegenId(null); setRegenPrompt("");
      saveToFirestore({ content: newContent });
    } catch (e) { console.error(e); }
    setRegenLoading(false);
  };

  const stopGen = () => { abortRef.current?.abort(); runningRef.current = false; setRunning(false); setPaused(true); setLoadMsg(""); };
  const resumeGen = () => setPaused(false);

  // ── Ключові слова ──
  const doGenKeywords = async () => {
    setKwLoading(true);
    const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const lang = info?.language || "Українська";
    const prompt = `Для кожного підрозділу роботи на тему "${info?.topic}" надай пошукові ключові слова для Google Scholar, Scopus, eLibrary Ukraine.\n\nПідрозділи:\n${mainSecs.map(s => `- ${s.label} (потрібно ${sourceDist[s.id] || 3} джерела)`).join("\n")}\n\nПоверни ТІЛЬКИ JSON:\n{"keywords":{"1.1":["фраза укр","фраза укр","english phrase","english phrase"]}}`;
    try {
      const raw = await callClaude([{ role: "user", content: prompt }], null, "Respond only with valid JSON.", 3000, null, MODEL_FAST);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
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
        const normalized = line.toLowerCase().replace(/\s+/g, " ").replace(/[.,;:]/g, "").trim();
        if (!seenRefs.has(normalized)) { rawRefs.push(line); seenRefs.set(normalized, rawRefs.length - 1); }
        secRefMapRaw[sec.id].push(seenRefs.get(normalized));
      });
    });

    // Якщо алфавітний порядок — сортуємо і перебудовуємо індекси
    let allRefs, indexMap;
    if (isAlphabetical) {
      const sorted = [...rawRefs].sort((a, b) => a.localeCompare(b, "uk"));
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
    const { allRefs, secRefMap } = buildGlobalRefList();
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
        refCiteText[n] = `[${n}]`;
      }
    });

    // ── ОДИН ЗАПИТ на всі підрозділи ──
    const secsWithRefs = mainSecs.filter(sec => secRefMap[sec.id]?.length && content[sec.id]);

    if (secsWithRefs.length > 0) {
      const exampleCite = isAPA ? "(Автор, рік)" : isMLA ? "(Автор)" : "[N]";
      const secsSummary = secsWithRefs.map(sec => {
        const uniqueNums = [...new Set(secRefMap[sec.id])];
        const paragraphs = content[sec.id].split("\n").filter(p => p.trim()).map((p, idx) => `${idx}: ${p.substring(0, 180)}`);
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
5. Формат відповіді — JSON де значення це НОМЕР джерела (ціле число), а не текст посилання.

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
          const paragraphs = content[sec.id].split("\n");
          let nonEmptyIdx = 0;
          const result = paragraphs.map((p) => {
            if (!p.trim()) return p;
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
      } catch (e) { console.error("Citation batch error:", e); }
    }

    // ── Форматування списку джерел (один запит, Haiku) ──
    const today = new Date();
    const accessDate = `${String(today.getDate()).padStart(2, "0")}.${String(today.getMonth() + 1).padStart(2, "0")}.${today.getFullYear()}`;
    const sourcesOrder = methodInfo?.sourcesOrder === "alphabetical" ? "Список відсортований за алфавітом." : "Список у порядку першої появи у тексті.";
    const sourcesGrouping = methodInfo?.sourcesGrouping ? `Групування: ${methodInfo.sourcesGrouping}.` : "";
    const fmtPrompt = `Оформ список джерел відповідно до стилю ${sourcesStyle}. ${sourcesOrder} ${sourcesGrouping} Збережи номери. Поверни ТІЛЬКИ список без заголовка.\nСьогодні: ${accessDate}. Для онлайн-джерел додай "URL: [посилання] (дата звернення: ${accessDate})". НЕ використовуй "[Електронний ресурс]" — замість нього завжди пиши URL.\n\n${allRefs.map((r, i) => `${i + 1}. ${r}`).join("\n")}`;
    let fmtResult;
    try {
      fmtResult = await callClaude([{ role: "user", content: fmtPrompt }], null,
        "You are a helpful assistant. Format the reference list exactly as requested.", 3000, null, MODEL_FAST);
      setRefList(fmtResult.split("\n").filter(Boolean));
      const srcSec = sections.find(s => s.type === "sources");
      if (srcSec) newContent[srcSec.id] = fmtResult;
    } catch (e) { console.error(e); }

    setContent(newContent);
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
    setPaused(false); setPlanLoading(false); setMethodInfo(null); setSourceDist({}); setSourceTotal(0);
    setKeywords({}); setCitInputs({}); setAllCitLoading(false); setRefList([]);
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
        <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 19, letterSpacing: 5, color: "#e8ff47" }}>ACADEM</div>
        <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 19, letterSpacing: 5 }}>ASSIST</div>
        {info?.topic && <div style={{ fontSize: 12, color: "#666", marginLeft: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 300 }}>{info.topic}</div>}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
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
            <FieldBox label="Готовий план від клієнта (необов'язково)">
              <textarea value={clientPlan} onChange={e => setClientPlan(e.target.value)}
                placeholder="Вставте план клієнта якщо є. Порожньо = план згенерується автоматично."
                style={{ ...TA, minHeight: 90 }} />
            </FieldBox>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
              <FieldBox label="Коментар">
                <textarea value={comment} onChange={e => setComment(e.target.value)}
                  placeholder="Додаткові побажання..." style={{ ...TA, minHeight: 90 }} />
              </FieldBox>
              <FieldBox label="Методичка / приклад роботи">
                <DropZone fileLabel={fileLabel} onFile={handleFile} />
              </FieldBox>
            </div>
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

            {/* Карточка методички */}
            {methodInfo && (
              <div style={{ border: "1.5px solid #c8dfa0", borderRadius: 8, overflow: "hidden", marginBottom: 20 }}>
                <div style={{ background: "#2a3a1a", color: "#a8d060", padding: "9px 16px", fontFamily: "'Spectral SC',serif", fontSize: 11, letterSpacing: 2 }}>
                  📋 ВИТЯГНУТО З МЕТОДИЧКИ
                </div>
                <div style={{ padding: "14px 18px", background: "#f5faf0", display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {methodInfo.totalPages && <span style={{ fontSize: 12, background: "#eef5e4", color: "#3a6010", padding: "3px 10px", borderRadius: 10 }}>📄 Обсяг: {methodInfo.totalPages} стор.</span>}
                  {methodInfo.chaptersCount && <span style={{ fontSize: 12, background: "#eef5e4", color: "#3a6010", padding: "3px 10px", borderRadius: 10 }}>📑 Розділів: {methodInfo.chaptersCount}</span>}
                  {methodInfo.hasChapterConclusions && <span style={{ fontSize: 12, background: "#eef5e4", color: "#3a6010", padding: "3px 10px", borderRadius: 10 }}>✓ Висновки до розділів</span>}
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
              ) : <StructurePreview totalPages={totalPagesNum} />}
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
                  {sections.map((s, i) => {
                    const isSpecial = ["intro", "conclusions", "sources"].includes(s.type);
                    return (
                      <div key={s.id} className="sec-row" style={{ display: "grid", gridTemplateColumns: "36px 1fr 70px 54px 36px", borderBottom: i < sections.length - 1 ? "1px solid #e4dfd4" : "none", background: isSpecial ? "#ede9e0" : i % 2 === 0 ? "#f5f2eb" : "#f0ece2", alignItems: "center", transition: "background .15s" }}>
                        <div style={{ padding: "9px 10px", fontSize: 12, color: "#bbb" }}>{i + 1}</div>
                        <input value={s.label} onChange={e => { const val = e.target.value; setSections(p => { const next = p.map((x, j) => j === i ? { ...x, label: val } : x); setPlanDisplay(buildPlanText(next)); return next; }); }} style={{ background: "transparent", border: "none", fontSize: 13, padding: "9px 8px", color: isSpecial ? "#888" : "#1a1a14", fontStyle: isSpecial ? "italic" : "normal", width: "100%", fontFamily: "'Spectral',serif" }} />
                        <input type="number" min="1" value={s.pages} onChange={e => { const v = parseInt(e.target.value) || 1; setSections(p => { const next = p.map((x, j) => j === i ? { ...x, pages: v, prompts: x.type === "sources" ? 0 : Math.max(1, Math.ceil(v / 3)) } : x); setPlanDisplay(buildPlanText(next)); const { dist, total } = calcSourceDist(next); setSourceDist(dist); setSourceTotal(total); return next; }); }} style={{ background: "transparent", border: "none", fontSize: 13, padding: "9px 4px", color: "#1a1a14", textAlign: "center", width: "100%", fontFamily: "'Spectral',serif" }} />
                        <div style={{ textAlign: "center", fontSize: 12, color: "#888", padding: "9px" }}>{s.type === "sources" ? "—" : s.prompts}</div>
                        <div style={{ display: "flex", justifyContent: "center" }}>
                          <button onClick={() => setSections(p => { const next = p.filter((_, j) => j !== i); setPlanDisplay(buildPlanText(next)); const { dist, total } = calcSourceDist(next); setSourceDist(dist); setSourceTotal(total); return next; })} style={{ background: "transparent", border: "none", color: "#bbb", fontSize: 15, cursor: "pointer", padding: "2px 4px", borderRadius: 4 }} onMouseEnter={e => e.currentTarget.style.color = "#c03030"} onMouseLeave={e => e.currentTarget.style.color = "#bbb"}>✕</button>
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ padding: "10px 14px", background: "#f5f2eb", borderTop: "1px solid #e4dfd4" }}>
                    <button onClick={() => {
                      const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
                      const lastId = mainSecs.length ? mainSecs[mainSecs.length - 1].id : "1.0";
                      const [ch, sub] = lastId.split(".").map(Number);
                      const newId = `${ch}.${(sub || 0) + 1}`;
                      const newSec = { id: newId, label: `${newId} Новий підрозділ`, sectionTitle: mainSecs[mainSecs.length - 1]?.sectionTitle || "", pages: Math.max(1, Math.round(totalPagesNum * 0.1)), prompts: 1, type: mainSecs[mainSecs.length - 1]?.type || "theory" };
                      setSections(p => { const introIdx = p.findIndex(s => s.type === "intro"); const next = introIdx >= 0 ? [...p.slice(0, introIdx), newSec, ...p.slice(introIdx)] : [...p, newSec]; setPlanDisplay(buildPlanText(next)); return next; });
                    }} style={{ background: "transparent", border: "1.5px dashed #bbb4a0", color: "#888", borderRadius: 6, padding: "7px 20px", fontFamily: "'Spectral',serif", fontSize: 12, cursor: "pointer", width: "100%", letterSpacing: "1px" }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = "#1a1a14"; e.currentTarget.style.color = "#1a1a14"; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = "#bbb4a0"; e.currentTarget.style.color = "#888"; }}>
                      + Додати підрозділ
                    </button>
                  </div>
                </div>

                {/* Save plan reminder */}
                <div style={{ padding: "12px 16px", background: "#f0f5e8", border: "1px solid #c8dfa0", borderRadius: 8, marginBottom: 18, fontSize: 13, color: "#3a6010" }}>
                  💡 Скинули план на затвердження? Збережіть і поверніться пізніше — все буде тут.
                  <button onClick={() => saveToFirestore({ sections, stage: "plan", status: "plan_ready" })} style={{ marginLeft: 12, background: "#2a3a1a", color: "#a8d060", border: "none", borderRadius: 5, padding: "4px 14px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                    {saving ? "Збереження..." : "Зберегти план"}
                  </button>
                </div>

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
              </div>
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
              {mainSections.map(sec => {
                const secRefs = (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
                const startIdx = runningIdx + 1; runningIdx += secRefs.length;
                return (
                  <div key={sec.id} style={{ border: "1.5px solid #d4cfc4", borderRadius: 8, overflow: "hidden", marginBottom: 14 }}>
                    <div style={{ background: "#1a1a14", padding: "11px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#f5f2eb" }}>{sec.label}</div>
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
                            {keywords[sec.id].map((kw, ki) => <span key={ki} style={{ fontSize: 11, background: "#eef5e4", color: "#3a6010", padding: "2px 9px", borderRadius: 10, border: "1px solid #c8dfa0" }}>{kw}</span>)}
                          </div>
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: "#888", letterSpacing: "1px", textTransform: "uppercase", marginBottom: 5 }}>Вставте джерела (кожне з нового рядка):</div>
                      <textarea value={citInputs[sec.id] || ""}
                        onChange={e => { setCitInputs(p => ({ ...p, [sec.id]: e.target.value })); e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
                        onFocus={e => { e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
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
                <GreenBtn onClick={doAddAllCitations} disabled={allRefs.length === 0} loading={allCitLoading} msg="Обробляю підрозділи..." label="Розставити всі посилання та сформувати список літератури →" />
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

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 24 }}>
              <NavBtn onClick={() => setStage("sources")}>← Джерела</NavBtn>
              <button onClick={copyAll} style={{ background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, padding: "11px 30px", fontFamily: "'Spectral',serif", fontSize: 13, letterSpacing: "1.5px", cursor: "pointer" }}>Скопіювати текст</button>
              <button disabled={docxLoading} onClick={async () => { setDocxLoading(true); try { await exportToDocx({ sections, content, info, displayOrder }); } catch (e) { alert("Помилка: " + e.message); } setDocxLoading(false); }}
                style={{ background: docxLoading ? "#aaa" : "#1a4a1a", color: docxLoading ? "#eee" : "#a8e060", border: "none", borderRadius: 7, padding: "11px 30px", fontFamily: "'Spectral',serif", fontSize: 13, letterSpacing: "1.5px", cursor: docxLoading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                {docxLoading ? <><SpinDot light />Генерую Word...</> : "⬇ Завантажити .docx"}
              </button>
              <button onClick={resetAll} style={{ background: "transparent", border: "1.5px solid #c4bfb4", color: "#777", borderRadius: 7, padding: "11px 22px", fontFamily: "'Spectral',serif", fontSize: 13, cursor: "pointer" }}>Нове замовлення</button>
            </div>
            <div style={{ marginTop: 12, padding: "10px 14px", background: "#f0ece2", borderRadius: 6, fontSize: 12, color: "#888" }}>
              Word: Times New Roman 14, міжрядковий 1.5, поля ліво 3см / право 1.5см / верх-низ 2см, абзац 1.25см, нумерація сторінок справа зверху.
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
