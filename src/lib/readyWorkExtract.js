// ── Розбір готової частини роботи клієнта чистим кодом (без ШІ) ──
// Знаходить реальні заголовки розділів/підрозділів у тексті клієнта й розбиває
// текст саме за ними — тому текст завжди відповідає тому, що реально написано.
import { getLangLabels } from "./planUtils.js";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ORDINAL_CHAPTER_STEMS = { "перш": 1, "друг": 2, "трет": 3, "четверт": 4 };
const ORDINAL_CHAPTER_STEMS_PL = { "pierwsz": 1, "drug": 2, "trzeci": 3, "czwart": 4 };
const ORDINAL_CHAPTER_STEMS_ES = { "prim": 1, "segund": 2, "tercer": 3, "cuart": 4 };
const ORDINAL_CHAPTER_STEMS_CS = { "prvn": 1, "druh": 2, "třet": 3, "čtvrt": 4 };
const ORDINAL_CHAPTER_STEMS_SK = { "prv": 1, "druh": 2, "tret": 3, "štvrt": 4 };
const CARDINAL_WORDS_EN = { "one": 1, "two": 2, "three": 3, "four": 4 };
const ORDINAL_WORDS_EN = { "first": 1, "second": 2, "third": 3, "fourth": 4 };
const CHAPTER_NUMERALS_ZH = { "一": 1, "二": 2, "三": 3, "四": 4 };

// Заголовок списку джерел клієнт/методичка можуть називати по-різному —
// розпізнаємо поширені варіанти, а не лише фразу, яку сам застосунок
// використовує для власного фінального списку.
const SOURCES_HEADING_SYNONYMS = [
  "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ",
  "СПИСОК ВИКОРИСТАНОЇ ЛІТЕРАТУРИ",
  "СПИСОК ЛІТЕРАТУРИ",
  "БІБЛІОГРАФІЧНИЙ СПИСОК",
  "ПЕРЕЛІК ВИКОРИСТАНИХ ДЖЕРЕЛ",
  "ПЕРЕЛІК ДЖЕРЕЛ",
  "REFERENCES",
  "BIBLIOGRAPHY",
  "WORKS CITED",
  "LIST OF REFERENCES",
  "REFERENCE LIST",
  "LIST OF WORKS CITED",
  // Польська
  "SPIS BIBLIOGRAFICZNY",
  "SPIS LITERATURY",
  "WYKAZ LITERATURY",
  "WYKAZ ŹRÓDEŁ",
  "SPIS WYKORZYSTANEJ LITERATURY",
  // Іспанська
  "REFERENCIAS BIBLIOGRÁFICAS",
  "LISTA DE REFERENCIAS",
  "FUENTES BIBLIOGRÁFICAS",
  "REFERENCIAS",
  // Чеська
  "SEZNAM POUŽITÝCH ZDROJŮ",
  "BIBLIOGRAFIE",
  "SEZNAM LITERATURY",
  // Словацька
  "ZOZNAM POUŽITÝCH ZDROJOV",
  "BIBLIOGRAFIA",
  // Китайська
  "参考书目",
  "文献目录",
  "引用文献",
];

function buildPatterns(lang) {
  const L = getLangLabels(lang);
  const chapterWord = escapeRe(L.chapterWord);
  const introWord = escapeRe(L.intro);
  const conclWord = escapeRe(L.conclusions);
  const sourcesWord = escapeRe(L.sources);
  const sourcesAlt = SOURCES_HEADING_SYNONYMS.map(escapeRe).join("|");
  return {
    // \s* (не \s+) між словом розділу і номером — у китайській немає пробілів між ієрогліфами й цифрою ("第1章")
    chapter: new RegExp(`^\\s*${chapterWord}\\s*(\\d+)\\.?\\s*(.*)$`, "i"),
    sub: /^\s*(\d+)\.(\d+)\.?\s+(.{1,150})$/,
    // "Висновки до розділу 1" / "Висновок до 1 розділу" / "Висновки до першого розділу" / "Conclusions to Chapter 1" /
    // Wnioski do rozdziału 1 (pl) / Conclusiones del capítulo 1 (es) / Závěry ke kapitole 1 (cs) / Závery ku kapitole 1 (sk) —
    // \w у JS не читає кирилицю/діакритику, тому явний клас літер; номер розділу може стояти до або після слова
    // "розділу"/"rozdziału"/"capítulo"/"kapitole", або бути порядковим числівником рідною мовою
    chapConcl: new RegExp(
      "^\\s*(?:" +
        "виснов(?:ок|ки|ків)\\s+до\\s+(?:" +
          "(?<num1>\\d+)\\s*розділ[а-яґєії]*" +
          "|розділ[а-яґєії]*\\s+(?<num2>\\d+)" +
          "|(?<ord>перш|друг|трет|четверт)[а-яґєії]*\\s+розділ[а-яґєії]*" +
        ")" +
        // Англійська: "Conclusions to Chapter 1" / "Conclusions to Chapter One" / "Conclusions to the First Chapter"
        // (зворотний порядок "Chapter 1 Conclusions" не підтримуємо — такий рядок завжди перехоплює звичайний
        // патерн заголовка розділу `chapter`, який перевіряється раніше)
        "|conclusions?\\s+(?:to|of)\\s+(?:the\\s+)?(?:" +
          "chapter\\s*(?<num3>\\d+)" +
          "|chapter\\s+(?<enCard1>one|two|three|four)\\b" +
          "|(?<enOrd1>first|second|third|fourth)\\s+chapter" +
        ")" +
        // Польська
        "|(?:wniosk(?:i|ów)?|wniosek)\\s+do\\s+(?:" +
          "(?<numPl1>\\d+)\\.?\\s*rozdzia[łl][a-ząćęłńóśźż]*" +
          "|rozdzia[łl][a-ząćęłńóśźż]*\\s+(?:(?<numPl2>\\d+)|(?<ordPl2>pierwsz|drug|trzeci|czwart)[a-ząćęłńóśźż]*)" +
          "|(?<ordPl1>pierwsz|drug|trzeci|czwart)[a-ząćęłńóśźż]*\\s+rozdzia[łl][a-ząćęłńóśźż]*" +
        ")" +
        // Іспанська
        "|conclusi(?:ones|ón)\\s+del\\s+(?:" +
          "cap[íi]tulo\\s+(?:(?<numEs1>\\d+)|(?<ordEs1>prim|segund|tercer|cuart)[a-záéíóúñ]*)" +
          "|(?<ordEs2>prim|segund|tercer|cuart)[a-záéíóúñ]*\\s+cap[íi]tulo" +
        ")" +
        // Чеська
        "|z[áa]v[eě]r(?:y)?\\s+ke?\\s+(?:" +
          "(?<numCs1>\\d+)\\.?\\s*kapitol[a-záčďéěíňóřšťúůýž]*" +
          "|kapitol[a-záčďéěíňóřšťúůýž]*\\s+(?<numCs2>\\d+)" +
          "|(?<ordCs>prvn|druh|třet|čtvrt)[a-záčďéěíňóřšťúůýž]*\\s+kapitol[a-záčďéěíňóřšťúůýž]*" +
        ")" +
        // Словацька
        "|z[áa]v[eě]r(?:y)?\\s+ku?\\s+(?:" +
          "(?<numSk1>\\d+)\\.?\\s*kapitol[a-záäčďéíĺľňóôŕšťúýž]*" +
          "|kapitol[a-záäčďéíĺľňóôŕšťúýž]*\\s+(?<numSk2>\\d+)" +
          "|(?<ordSk>prv|druh|tret|štvrt)[a-záäčďéíĺľňóôŕšťúýž]*\\s+kapitol[a-záäčďéíĺľňóôŕšťúýž]*" +
        ")" +
        // Китайська: "第1章结论" / "第一章总结" / "本章小结" (без пробілів — ієрогліфи не розділяються пробілом;
        // "本章..." — без явного номера, береться номер поточного розділу за контекстом)
        "|第(?:(?<numZh1>\\d+)|(?<ordZh>[一二三四]))章(?:的)?(?:结论|总结|小结)" +
        "|(?<zhCurrent>本章)(?:的)?(?:结论|总结|小结)" +
      ")\\s*\\.?\\s*.*$",
      "i"
    ),
    intro: new RegExp(`^\\s*${introWord}\\s*$`, "i"),
    concl: new RegExp(`^\\s*${conclWord}\\s*$`, "i"),
    sources: new RegExp(`^\\s*(?:${sourcesWord}|${sourcesAlt})`, "i"),
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
      const g = m.groups || {};
      const numGroups = ["num1", "num2", "num3", "numPl1", "numPl2", "numEs1", "numCs1", "numCs2", "numSk1", "numSk2", "numZh1"];
      const ordGroups = { ord: ORDINAL_CHAPTER_STEMS, ordPl1: ORDINAL_CHAPTER_STEMS_PL, ordPl2: ORDINAL_CHAPTER_STEMS_PL, ordEs1: ORDINAL_CHAPTER_STEMS_ES, ordEs2: ORDINAL_CHAPTER_STEMS_ES, ordCs: ORDINAL_CHAPTER_STEMS_CS, ordSk: ORDINAL_CHAPTER_STEMS_SK, enCard1: CARDINAL_WORDS_EN, enOrd1: ORDINAL_WORDS_EN, ordZh: CHAPTER_NUMERALS_ZH };
      let n = null;
      for (const key of numGroups) { if (g[key]) { n = parseInt(g[key], 10); break; } }
      if (n === null) {
        for (const key of Object.keys(ordGroups)) { if (g[key]) { n = ordGroups[key][g[key].toLowerCase()]; break; } }
      }
      if (n === null && g.zhCurrent) n = curChapNum || null; // "本章小结" — номер розділу береться з контексту
      if (n) headings.push({ lineIdx: i, kind: "chapter_conclusion", id: `${n}.conclusions`, chapNum: n });
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
  const numRe = /\[\s*(\d+(?:\s*[,;]\s*\d+)*)\s*(?:,\s*[сc]\.?\s*\d*[^\]]*)?\s*\]/g;
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
