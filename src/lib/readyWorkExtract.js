// ── Розбір готової частини роботи клієнта чистим кодом (без ШІ) ──
// Знаходить реальні заголовки розділів/підрозділів у тексті клієнта й розбиває
// текст саме за ними — тому текст завжди відповідає тому, що реально написано.
import { getLangLabels } from "./planUtils.js";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildPatterns(lang) {
  const L = getLangLabels(lang);
  const chapterWord = escapeRe(L.chapterWord);
  const introWord = escapeRe(L.intro);
  const conclWord = escapeRe(L.conclusions);
  const sourcesWord = escapeRe(L.sources);
  return {
    chapter: new RegExp(`^\\s*${chapterWord}\\s+(\\d+)\\.?\\s*(.*)$`, "i"),
    sub: /^\s*(\d+)\.(\d+)\.?\s+(.{1,150})$/,
    // "Висновки до розділу 1" / "Conclusions to Chapter 1" / інші мови — \w у JS не читає кирилицю, тому явний клас літер
    chapConcl: /^\s*(?:висновк[а-яґєії]*\s+до\s+розділ[а-яґєії]*|conclusions?\s+to\s+chapter|wnioski\s+do\s+rozdzia[łl]u|z[áa]v[eě]ry?\s+k[ue]\s+kapitole)\s*(\d+)\s*\.?\s*$/i,
    intro: new RegExp(`^\\s*${introWord}\\s*$`, "i"),
    concl: new RegExp(`^\\s*${conclWord}\\s*$`, "i"),
    sources: new RegExp(`^\\s*${sourcesWord}`, "i"),
  };
}

// Знаходить усі заголовки в тексті (за рядками) і повертає їх позиції
function detectHeadings(text, lang) {
  const P = buildPatterns(lang);
  const lines = text.split(/\r?\n/);
  const headings = [];
  let curChapNum = 0;
  let curChapTitle = "";

  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.length > 200) return;
    let m;
    if ((m = t.match(P.chapter))) {
      curChapNum = parseInt(m[1], 10);
      curChapTitle = t.replace(/\.$/, "");
      headings.push({ lineIdx: i, kind: "chapter", chapNum: curChapNum, chapterTitle: curChapTitle });
    } else if ((m = t.match(P.sub))) {
      const id = `${m[1]}.${m[2]}`;
      headings.push({ lineIdx: i, kind: "sub", id, title: `${id} ${m[3].trim()}`, chapNum: parseInt(m[1], 10) });
    } else if ((m = t.match(P.chapConcl))) {
      const n = parseInt(m[1], 10);
      headings.push({ lineIdx: i, kind: "chapter_conclusion", id: `${n}.conclusions`, chapNum: n });
    } else if (P.intro.test(t)) {
      headings.push({ lineIdx: i, kind: "intro", id: "intro" });
    } else if (P.concl.test(t)) {
      headings.push({ lineIdx: i, kind: "conclusions", id: "conclusions" });
    } else if (P.sources.test(t)) {
      headings.push({ lineIdx: i, kind: "sources", id: "sources" });
    }
  });
  return { headings, lines };
}

// Розбиває "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ" на пронумеровані записи { number: text }
function parseBibliography(sourcesText) {
  const bib = {};
  const lines = sourcesText.split(/\r?\n/);
  let curNum = null;
  lines.forEach(raw => {
    const t = raw.trim();
    if (!t) return;
    const m = t.match(/^(\d+)[.)]\s*(.+)$/);
    if (m) {
      curNum = parseInt(m[1], 10);
      bib[curNum] = m[2].trim();
    } else if (curNum !== null) {
      // продовження попереднього запису на новому рядку
      bib[curNum] += " " + t;
    }
  });
  return bib;
}

// Знаходить позначки цитувань [N] у тексті підрозділу, перенумеровує їх локально (1,2,3...)
// і повертає { text, sources[] } — sources у форматі "рядок на джерело", як citInputs
function localizeCitations(text, bibliography) {
  const numRe = /\[\s*(\d+(?:\s*[,;]\s*\d+)*)\s*(?:,\s*с\.?\s*\d+[-–]?\d*)?\s*\]/g;
  const localMap = new Map(); // globalNum → localIdx (1-based)
  const localSources = [];

  const rewritten = text.replace(numRe, (whole, nums) => {
    const globalNums = nums.split(/[,;]/).map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && bibliography[n]);
    if (!globalNums.length) return whole; // не змогли зіставити — лишаємо як є
    const localNums = globalNums.map(gn => {
      if (!localMap.has(gn)) {
        localSources.push(bibliography[gn]);
        localMap.set(gn, localSources.length);
      }
      return localMap.get(gn);
    });
    return `[${localNums.join(", ")}]`;
  });

  return { text: rewritten, sources: localSources };
}

// ── Головна функція: код-only розбір готової частини роботи клієнта ──
// planIds: опційний масив id/label з явного плану клієнта — якщо задано, назви беруться звідти,
// а текст зіставляється за номером розділу/підрозділу.
export function extractReadyWorkStructure({ documentText, lang = "Українська", planSections = null }) {
  const { headings, lines } = detectHeadings(documentText, lang);
  if (headings.length < 3) return null; // замало розпізнано — нехай викликач падає на ШІ-резерв

  // Знаходимо межі бібліографії окремо (щоб не рахувати її як звичайний текст розділу)
  const srcHeading = headings.find(h => h.kind === "sources");
  const bibliography = srcHeading
    ? parseBibliography(lines.slice(srcHeading.lineIdx + 1).join("\n"))
    : {};

  const sections = [];
  const content = {};
  const citInputs = {};
  const foundIds = [];

  const chapterTitleByNum = {};
  headings.forEach(h => { if (h.kind === "chapter") chapterTitleByNum[h.chapNum] = h.chapterTitle; });

  const planById = new Map((planSections || []).map(s => [s.id, s]));

  headings.forEach((h, idx) => {
    if (h.kind === "chapter") return; // сама назва розділу — лише контекст для підрозділів, не окрема секція
    const nextIdx = h.lineIdx + 1;
    const endIdx = idx + 1 < headings.length ? headings[idx + 1].lineIdx : lines.length;
    const rawText = lines.slice(nextIdx, endIdx).join("\n").trim();
    if (h.kind === "sources") return; // бібліографія вже розібрана окремо, не потрібна як content
    if (!rawText) return;

    const words = rawText.split(/\s+/).filter(Boolean).length;
    const pages = Math.max(1, Math.round(words / 270));
    const { text, sources } = localizeCitations(rawText, bibliography);

    let type = "intro";
    let label = "Вступ";
    let sectionTitle;
    if (h.kind === "sub") {
      type = h.chapNum === 1 ? "theory" : h.chapNum === 2 ? "analysis" : "recommendations";
      label = h.title;
      sectionTitle = chapterTitleByNum[h.chapNum];
      const planMatch = planById.get(h.id);
      if (planMatch) { label = planMatch.label; sectionTitle = planMatch.sectionTitle || sectionTitle; }
    } else if (h.kind === "chapter_conclusion") {
      type = "chapter_conclusion";
      label = `Висновки до розділу ${h.chapNum}`;
      sectionTitle = chapterTitleByNum[h.chapNum];
    } else if (h.kind === "conclusions") {
      type = "conclusions"; label = "Висновки";
    } else if (h.kind === "intro") {
      type = "intro"; label = "Вступ";
    }

    sections.push({ id: h.id, label, ...(sectionTitle ? { sectionTitle } : {}), pages, type });
    content[h.id] = text;
    foundIds.push(h.id);
    if (sources.length) citInputs[h.id] = sources.join("\n");
  });

  if (sections.length < 3) return null;
  return { sections, content, citInputs, foundIds };
}

// Швидкий розбір явного плану клієнта (текст) на список {id, label} — лише для зіставлення
// назв підрозділів під час імпорту готової частини роботи, без повного парсингу конфлікту сторінок.
export function quickParsePlanIds(planText) {
  const ids = [];
  const lines = (planText || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const subM = line.match(/^(\d+)\.(\d+)\.?\s+(.+)$/);
    if (subM) ids.push({ id: `${subM[1]}.${subM[2]}`, label: line.replace(/\.$/, ""), chapNum: parseInt(subM[1], 10) });
  }
  return ids;
}
