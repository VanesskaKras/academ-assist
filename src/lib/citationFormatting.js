// ── Форматування списку джерел + перестановка посилань [N] у тексті ──
// Портовано з doRemapCitations (academic-assistant.jsx) для малих робіт,
// де [N] у тексті ЗАВЖДИ відповідає citations[N-1] (єдиний глобальний список,
// без посекційної локальної нумерації).
//
// Ключовий принцип конвеєра (дедуплікація → форматування → сортування):
// 1. Дедуплікація — на сирому тексті (робить викликач, до цього файлу).
// 2. Форматування стилю через ЛЛМ — ЛЛМ виправляє пунктуацію/порядок компонентів
//    імені в КОЖНОМУ джерелі окремо, але НІКОЛИ не переставляє, не додає й не вилучає
//    джерела. Відповідь звіряється за змістом (formatSourcesWithRetry), а не лише за
//    кількістю рядків — інакше галюцинація чи збита нумерація тихо ламають усі номери
//    цитат у тексті. (Раніше була ще гілка "довіряй порядку ЛЛМ" для кастомного
//    групування з методички — прибрана: майже кожна методичка згадує стандартну
//    вимогу "за алфавітом", тож ця гілка вмикалась майже завжди, а ЛЛМ ненадійна саме
//    в питаннях порядку — з цього й починалась уся ця історія багів.)
// 3. Сортування — код, ПІСЛЯ форматування, на вже правильно оформленому (прізвище
//    спереду) тексті. Раніше сортування йшло ДО форматування, на сирому тексті —
//    тому джерело на кшталт "В. О. Іванов" (ініціали спереду) сортувалось під "В",
//    а не під "І", як має бути за ДСТУ.

import { normalizeAuthorsScript, isCyrillicText } from "./transliteration.js";

// Абетка авторів має бути єдиною в межах ОДНОГО запису (і, за замовчуванням,
// відповідати абетці назви джерела) — інакше виходить "Savchuk I., Лисецька
// Ю. В." замість "Савчук І., Лисецька Ю. В.". Основна причина розсинхрону —
// автоімпорт з OpenAlex/CrossRef, де display_name часто дається лише
// латиницею навіть для українських авторів. normalizeAuthorsScript сама
// вирішує, чи є запис кириличним (за назвою АБО за іншими авторами того
// самого запису), тож достатньо передати сюди "необов'язковий" прапорець.
export function buildStructuredEntry(p) {
  const e = { _type: "structured" };
  const recordIsCyrillic = p.lang === "uk" || isCyrillicText(p.title);
  if (p.authorsStructured?.length) {
    const families = normalizeAuthorsScript(p.authorsStructured.map(a => a.family || ""), recordIsCyrillic);
    const givens = normalizeAuthorsScript(p.authorsStructured.map(a => a.given || ""), recordIsCyrillic);
    e.authors = p.authorsStructured.map((a, i) => ({ ...a, family: families[i], given: givens[i] }));
  } else if (p.authors?.length) {
    e.authorsRaw = normalizeAuthorsScript(p.authors, recordIsCyrillic);
  }
  if (p.title) e.title = p.title;
  if (p.year) e.year = p.year;
  const venue = p.venue && !/^[\w.-]+\.[a-zA-Z]{2,}$/.test(p.venue.trim()) ? p.venue : "";
  if (venue) e.journal = venue;
  if (p.volume) e.volume = p.volume;
  if (p.issue) e.issue = p.issue;
  if (p.pages) e.pages = p.pages;
  if (p.totalPages) e.totalPages = p.totalPages;
  if (p.publisher) e.publisher = p.publisher;
  if (p.publisherLocation) e.city = p.publisherLocation;
  const url = p.url || (p.doi ? `https://doi.org/${p.doi}` : "");
  if (url) e.url = url;
  if (p.type === "book") e._docType = "book";
  return e;
}

// Витягує валідний діапазон сторінок джерела для внутрітекстового цитування:
// - стаття/дисертація з "С. X–Y" (або "pp. X–Y") → діапазон статті;
// - книга без діапазону, але з відомим загальним обсягом (structuredPaper.totalPages
//   або власний рядок "N с."/"N p.") → діапазон [1, N] звужений на пару сторінок з
//   кожного краю (титул/зміст на початку, бібліографія/покажчик у кінці — не змістовні);
// - закон/сайт (немає ні того, ні іншого) → null, сторінка не показується.
export function extractPageRange(rawRef, structuredPaper) {
  const rangeMatch = rawRef.match(/[Сс]\.\s*(\d+)\s*[–\-—]\s*(\d+)/);
  if (rangeMatch) return { min: +rangeMatch[1], max: +rangeMatch[2] };
  const engRangeMatch = rawRef.match(/pp\.\s*(\d+)\s*[–\-—]\s*(\d+)/i);
  if (engRangeMatch) return { min: +engRangeMatch[1], max: +engRangeMatch[2] };
  const singlePageMatch = rawRef.match(/[Сс]\.\s*(\d+)(?!\d*\s*[сp]\.)/);
  if (singlePageMatch) return { min: +singlePageMatch[1], max: +singlePageMatch[1] };
  const engSingleMatch = rawRef.match(/pp?\.\s*(\d+)/i);
  if (engSingleMatch) return { min: +engSingleMatch[1], max: +engSingleMatch[1] };
  const totalPages = structuredPaper?.totalPages || rawRef.match(/(\d+)\s*[сp]\.\s*$/i)?.[1];
  if (totalPages) {
    const n = +totalPages;
    const buffer = Math.min(3, Math.max(1, Math.floor(n * 0.1)));
    const min = buffer + 1;
    const max = n - buffer;
    return min < max ? { min, max } : { min: 1, max: n };
  }
  return null;
}

// Обирає конкретну сторінку з діапазону для N-го за рахунком вживання джерела —
// щоб повторні цитування того самого джерела не показували щоразу однакову сторінку.
export function pickPageInRange(range, occurrenceIndex) {
  const span = range.max - range.min;
  if (span <= 0) return range.min;
  const fractions = [0, 0.5, 0.25, 0.75, 0.15, 0.85, 0.4, 0.6];
  const frac = fractions[(occurrenceIndex - 1) % fractions.length];
  return range.min + Math.round(span * frac);
}

// Замінює [oldN] / [oldN, с. X] / групові [oldN, oldM] у тексті на нові номери у
// фінальному форматі стилю. Групові цитати виникають при локалізації посилань готової
// частини клієнта (localizeCitations у readyWorkExtract.js) — там кілька старих
// глобальних номерів джерела можуть звестись в один локальний запис виду "[2, 3]".
// Сторінку, яку вписала сама модель під час написання, зберігаємо як є (якщо вона
// в межах відомого діапазону джерела); інакше підставляємо сторінку з діапазону.
// Кожна згадка джерела лишається окремою (виноски й так завжди були окремі,
// а для звичайних [N] повторне цитування — це нормально, не дублікат для видалення).
export function applyCitationRemap(text, oldToNew, refCiteText, { pageRanges = {} } = {}) {
  if (!text) return text;
  const citCount = {};
  let out = text.replace(/\[\s*(\d+(?:\s*[,;]\s*\d+)*)\s*(?:,\s*[сc]\.?\s*(\d+)?[^\]]*)?\s*\]/g, (match, oldNums, oldPage) => {
    const newNums = oldNums.split(/[,;]/).map(s => oldToNew[Number(s.trim())]).filter(Boolean);
    if (!newNums.length) return ""; // усі номери хибні (галюциновані) — прибираємо
    if (newNums.length === 1) {
      const newN = newNums[0];
      citCount[newN] = (citCount[newN] || 0) + 1;
      return `%%CIT${newN}_${oldPage || ""}_${citCount[newN]}%%`;
    }
    // групове цитування [N, M, ...] — сторінка в такому форматі не використовується
    const uniqueNewNums = [...new Set(newNums)];
    return `%%CITGRP${uniqueNewNums.join("-")}%%`;
  });
  out = out.replace(/%%CIT(\d+)_(\d*)_(\d+)%%/g, (_, nStr, oldPageStr, occStr) => {
    const n = Number(nStr);
    const base = refCiteText[n] || `[${n}]`;
    const range = pageRanges[n];
    if (!range) return base; // немає діапазону (закон/сайт, або APA/MLA/виноска — там base вже повний)
    let page = oldPageStr ? Number(oldPageStr) : null;
    if (page != null && (page < range.min || page > range.max)) page = null; // хибна сторінка поза діапазоном
    if (page == null) page = pickPageInRange(range, Number(occStr));
    return `[${n}, с. ${page}]`;
  });
  out = out.replace(/%%CITGRP([\d-]+)%%/g, (_, numsStr) => {
    const nums = numsStr.split("-").map(Number);
    const bases = nums.map(n => refCiteText[n] || `[${n}]`);
    if (bases.every(b => b.startsWith("[") && b.endsWith("]"))) {
      return `[${bases.map(b => b.slice(1, -1)).join(", ")}]`;
    }
    if (bases.every(b => b.startsWith("(") && b.endsWith(")"))) {
      return `(${bases.map(b => b.slice(1, -1)).join("; ")})`;
    }
    return bases.join(" ");
  });
  return out;
}

// ── Звірка змісту відформатованої відповіді ЛЛМ із вхідним списком ──

// Витягує "ідентифікаційні" токени (4+ символів) з рядка джерела для звірки змісту.
function sourceTokens(s) {
  return new Set((String(s).toLowerCase().match(/[a-zа-яґєіїʼ'0-9-]{4,}/g) || []));
}

function matchScore(tokenSet, text) {
  if (!tokenSet.size) return 1; // нема за чим звіряти — вважаємо збіг
  const lower = text.toLowerCase();
  let hits = 0;
  tokenSet.forEach(t => { if (lower.includes(t)) hits++; });
  return hits / tokenSet.size;
}

// Схожість двох СИРИХ текстів джерел за перетином ідентифікаційних токенів —
// відносно МЕНШОГО з двох наборів, щоб куций запис (мало токенів: лише автор+назва,
// без року/URL) коректно розпізнавався як підмножина повнішої версії того самого
// джерела, а не як зовсім інше джерело з нижчим відсотком збігу.
function rawTextSimilarity(a, b) {
  const ta = sourceTokens(a), tb = sourceTokens(b);
  if (!ta.size || !tb.size) return 0;
  const [smaller, larger] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let overlap = 0;
  smaller.forEach(t => { if (larger.has(t)) overlap++; });
  return overlap / smaller.size;
}

const DUPLICATE_SIMILARITY_THRESHOLD = 0.75;

const dedupeNormalize = str => str.toLowerCase()
  .replace(/\s*(url\s*:|https?:\/\/\S+|\(дата звернення[^)]*\))/gi, "")
  .replace(/[.,;:&–—\-«»"'()[\]]/g, "").replace(/\s+/g, " ").trim();

// Дедуплікатор сирих текстів джерел: спершу точний збіг (швидко, за нормалізованим
// текстом — як і раніше), а якщо точного нема — нечіткий збіг за rawTextSimilarity,
// щоб об'єднувати "майже дублікати" того самого джерела: той самий запис з кодом УДК
// чи без нього, куций стаб-запис із клієнтського списку і повна версія, знайдена
// пошуком, тощо. add(text) — ідемпотентний: повторний виклик із уже відомим (або
// схожим) текстом повертає ІНДЕКС того самого канонічного запису, не додає новий.
// canonicalRefs — унікальні тексти (довший/з URL варіант лишається як канонічний).
export function createReferenceDeduper() {
  const canonicalRefs = [];
  const seenKeys = new Map(); // нормалізований ключ → індекс у canonicalRefs

  function add(text) {
    const key = dedupeNormalize(text);
    const hasUrl = /https?:\/\/\S+/i.test(text);
    if (seenKeys.has(key)) {
      const idx = seenKeys.get(key);
      if (hasUrl && !/https?:\/\/\S+/i.test(canonicalRefs[idx])) canonicalRefs[idx] = text;
      return idx;
    }
    for (let i = 0; i < canonicalRefs.length; i++) {
      if (rawTextSimilarity(text, canonicalRefs[i]) >= DUPLICATE_SIMILARITY_THRESHOLD) {
        seenKeys.set(key, i);
        if (text.length > canonicalRefs[i].length) canonicalRefs[i] = text;
        return i;
      }
    }
    canonicalRefs.push(text);
    seenKeys.set(key, canonicalRefs.length - 1);
    return canonicalRefs.length - 1;
  }

  return { canonicalRefs, add };
}

// Зіставляє відформатовані рядки з вхідними ЗА ЗМІСТОМ (не за позицією) — формат і
// пунктуація змінюються, а автори/назва/рік мають лишитись впізнаваними. Жадібний
// найкращий-збіг-спершу підбір пар (i, j) за оцінкою перетину токенів. Повертає
// matchedIndex, де matchedIndex[i] — позиція в styledLines, що відповідає refLines[i],
// або null, якщо для когось не знайшлось впевненого унікального відповідника
// (галюцинація/пропуск/дублікат/переставляння від ЛЛМ — усе це заборонено).
function matchFormattedLines(refLines, styledLines) {
  const n = refLines.length;
  if (styledLines.length !== n) return null;
  const tokenSets = refLines.map(sourceTokens);
  const pairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) pairs.push({ i, j, score: matchScore(tokenSets[i], styledLines[j]) });
  }
  pairs.sort((a, b) => b.score - a.score);
  const matchedIndex = new Array(n).fill(-1);
  const usedJ = new Set();
  let assigned = 0;
  for (const { i, j, score } of pairs) {
    if (matchedIndex[i] !== -1 || usedJ.has(j)) continue;
    if (tokenSets[i].size > 0 && score < 0.3) continue; // недостатньо впевнено
    matchedIndex[i] = j; usedJ.add(j); assigned++;
    if (assigned === n) break;
  }
  return assigned === n ? matchedIndex : null;
}

// Фільтрує сиру відповідь ЛЛМ-форматування списку джерел до валідних пронумерованих
// рядків ("N. текст"), перевіряє їх кількість і зіставляє кожен з вхідним джерелом за
// ЗМІСТОМ (matchFormattedLines) — не за позицією, бо самої лише позиції недостатньо,
// щоб надійно відрізнити "ЛЛМ просто трохи перефразувала" від "ЛЛМ підмінила джерело".
// Якщо для когось не знайшлось впевненого унікального відповідника — це або
// преамбула/примітка, або вигадане/загублене джерело, або зіпсована/переставлена
// нумерація (усе це заборонено промптом); довіряти відповіді не можна.
// Повертає масив у порядку refLines (без права переставляти) або null.
export function sanitizeFormattedSourceLines(fmtResult, refLines) {
  if (!fmtResult) return null;
  const lines = fmtResult.split("\n").map(l => l.trim()).filter(l => /^\d+[.)]\s/.test(l));
  if (lines.length !== refLines.length) return null;
  const stripped = lines.map(l => l.replace(/^\d+[.)]\s*/, ""));
  const matchedIndex = matchFormattedLines(refLines, stripped);
  if (!matchedIndex) return null;
  return matchedIndex.map(j => stripped[j]);
}

// ── Детерміноване (кодове) визначення групи/мови джерела для сортування ──

const LAW_RE = /^(закон|кодекс|конституція|постанова|указ\s|декрет\s|наказ\s|розпорядження\s)/i;
export const isLawSource = s => LAW_RE.test(s.trim());

// Переважання кириличних чи латинських літер У ВСЬОМУ рядку — а не лише перший
// символ. Короткий латинський префікс на кшталт "ISSN 2409-1154" не повинен
// перетягувати переважно українське джерело в іноземну групу.
export function isMostlyCyrillic(text) {
  const cyr = (text.match(/[А-ЯҐЄІЇа-яґєії]/g) || []).length;
  const lat = (text.match(/[A-Za-z]/g) || []).length;
  return cyr >= lat;
}

// Мова джерела для угруповання ДСТУ визначається за ПІБ автора — першим словом
// запису (прізвище, бо на цьому етапі текст уже відформатовано "Прізвище І. І."),
// а НЕ за всім рядком: інакше джерело з українським автором, але з англомовною
// цитованою назвою чи установою в описі (наприклад, переклад іноземного документа),
// хибно потрапляє в іноземну групу через саму лише кількість латинських літер у
// назві. Джерела без автора (починаються з назви) класифікуються за мовою самої
// назви — тим самим першим словом.
function isForeignAuthorScript(text) {
  const m = text.trim().match(/^[«"']?([A-Za-zА-ЯҐЄІЇа-яґєії]+)/);
  if (!m) return false;
  const word = m[1];
  const lat = (word.match(/[A-Za-z]/g) || []).length;
  const cyr = (word.match(/[А-ЯҐЄІЇа-яґєії]/g) || []).length;
  return lat > cyr;
}

// Чи це "електронний ресурс" (сайт/сторінка без чіткої журнальної/книжкової
// структури) на противагу книзі/статті. Найнадійніше — за структурованими даними
// (є journal/volume/сторінки чи _docType:"book" → це НЕ електронний ресурс); для
// сирого тексту без структури — евристика за наявністю номера випуску/сторінок.
export function isElectronicResource(text, structuredPaper) {
  if (structuredPaper) {
    if (structuredPaper._docType === "book" || structuredPaper.journal || structuredPaper.pages || structuredPaper.volume || structuredPaper.issue) return false;
    return true;
  }
  const hasIssueOrPages = /№\s*\d+|Вип\.\s*\d+|Т\.\s*\d+|[Сс]\.\s*\d+/i.test(text);
  const hasUrl = /https?:\/\/\S+/i.test(text);
  return hasUrl && !hasIssueOrPages;
}

// Сортує вже ВІДФОРМАТОВАНИЙ (прізвище спереду) список джерел за групами ДСТУ
// 8302:2015: закони → кирилиця книги/статті → кирилиця електронні ресурси →
// іноземні (латиниця) для роботи українською мовою; або закони → іноземні →
// кирилиця книги/статті → кирилиця електронні ресурси для іноземної роботи.
// items: [{ text, structured }]
export function sortReferencesForDisplay(items, { latinFirst = false } = {}) {
  const groupOf = (item) => {
    if (isLawSource(item.text)) return 0;
    const foreign = isForeignAuthorScript(item.text);
    if (foreign) return latinFirst ? 1 : 3;
    const electronic = isElectronicResource(item.text, item.structured);
    return latinFirst ? (electronic ? 3 : 2) : (electronic ? 2 : 1);
  };
  const locale = (item) => isForeignAuthorScript(item.text) ? "en" : "uk";
  return items
    .map((item, idx) => ({ item, idx, group: groupOf(item) }))
    .sort((a, b) => a.group !== b.group ? a.group - b.group : a.item.text.localeCompare(b.item.text, locale(a.item)))
    .map(x => x.item);
}

// Будує правила стилю (ДСТУ/APA/MLA) + промпт форматування списку джерел, викликає
// ЛЛМ і валідує відповідь (sanitizeFormattedSourceLines). ЛЛМ переформатовує КОЖНЕ
// джерело окремо (пунктуація, порядок ініціалів, курсив тощо) — сортування й
// групування завжди робить код (sortReferencesForDisplay) ПІСЛЯ форматування, ЛЛМ
// ніколи не переставляє рядки. (Раніше довіра до "кастомного групування з
// методички" вмикалась майже завжди — типова методичка просто згадує стандартну
// вимогу "за алфавітом", і ЛЛМ, отримавши нечітку вказівку, часто взагалі нічого
// не переставляла, лишаючи список невідсортованим. Вимкнено, поки не буде
// надійнішого способу відрізнити справді нестандартну вимогу від типової.)
export async function formatSourcesViaLLM({
  refLines,             // string[] — вже побудовані рядки "N. ..." (raw text або JSON structured)
  sourcesStyle,         // "APA" | "MLA" | "ДСТУ 8302:2015"
  sourcesFormatRules,   // methodInfo?.sourcesFormatRules
  callClaude,
}) {
  const isAPA = sourcesStyle === "APA";
  const isMLA = sourcesStyle === "MLA";
  const isDstu = !isAPA && !isMLA;

  const today = new Date();
  const accessDate = `${String(today.getDate()).padStart(2, "0")}.${String(today.getMonth() + 1).padStart(2, "0")}.${today.getFullYear()}`;

  const orderInstruction = "НЕ переставляй рядки місцями, НЕ додавай і НЕ вилучай джерела — кожен вхідний рядок N має стати рівно одним вихідним рядком на позиції N (сортування й групування виконає код окремо, після твого форматування).";

  const styleRules = isAPA
    ? `СТИЛЬ: APA 7th edition. СУВОРО дотримуйся APA — НЕ змішуй з ДСТУ чи іншими стилями.
Правила APA:
- Книга: Прізвище, І. І. (рік). Назва книги курсивом. Видавець.
- Стаття: Прізвище, І. І. (рік). Назва статті. Назва журналу курсивом, том(номер), сторінки. https://doi.org/...
- Розділ у збірнику: Прізвище, І. І. (рік). Назва розділу. В І. І. Редактор (Ред.), Назва збірника (сс. xx–xx). Видавець.
- Онлайн-ресурс: Прізвище, І. І. (рік). Назва. Назва сайту. URL
- НЕ використовуй двокрапку між містом і видавцем (це ДСТУ, не APA).
- НЕ пиши "Київ:" або "Oxford:" перед видавцем (APA не вказує місто для більшості джерел після 7-го вид.).
- НЕ додавай "Вип.", "Т.", "С." у журнальних статтях — використовуй том і сторінки у форматі APA.
- ОБОВ'ЯЗКОВО: якщо автор вказаний як "Ім'я Прізвище" (ім'я першим) — переставляй у "Прізвище, І." (прізвище першим, ім'я скорочується до ініціалу). Це вимога APA, не зміна імені.
  Українські імена (перші слова, що НЕ є прізвищами): Олеся, Оксана, Тетяна, Наталія, Наталя, Марія, Ірина, Олена, Світлана, Валентина, Людмила, Галина, Ніна, Лариса, Юлія, Анна, Катерина, Вікторія, Андрій, Олег, Микола, Василь, Іван, Петро, Сергій, Олексій, Михайло, Дмитро, Юрій, Владислав, Богдан, Роман, Тарас, Євген. Якщо джерело починається з такого слова — це ім'я, і наступне слово є прізвищем; переставляй: "Олеся Коваль" → "Коваль, О."; "Тетяна Петренко" → "Петренко, Т."
- Назви джерел: sentence case (перша літера велика, решта малі, окрім власних назв та абревіатур). Якщо назва написана ВЕЛИКИМИ ЛІТЕРАМИ — обов'язково переводь у sentence case.`
    : isDstu
      ? `СТИЛЬ: ДСТУ 8302:2015. СУВОРО дотримуйся ДСТУ — НЕ змішуй з APA чи іншими стилями.
Правила ДСТУ 8302:2015:
- Книга: Прізвище І. І. Назва книги. Місто : Видавець, рік. Кількість с.
- Стаття: Прізвище І. І. Назва статті. *Назва журналу*. рік. № номер. С. xx–xx.
- Онлайн: Прізвище І. І. Назва. *Назва сайту або журналу*. URL: адреса (дата звернення: ${accessDate}).
- КАТЕГОРИЧНО ЗАБОРОНЕНО ставити ініціали ПЕРЕД прізвищем. НЕ "В. Андріяш" — лише "Андріяш В.". Ініціали ЗАВЖДИ після прізвища.
- Між ініціалами — пробіл: "М. В." а не "М.В.".
- Між містом і видавцем — пробіл двокрапка пробіл ( : ).
- КУРСИВ: назву журналу, збірника, серії або сайту ОБОВ'ЯЗКОВО обгортай в *зірочки* (*Назва журналу*). Назву статті та прізвища авторів — звичайний шрифт.`
      : `СТИЛЬ: ${sourcesStyle}. Точно дотримуйся цього стилю.`;

  const methodSourcesRulesText = sourcesFormatRules ? `\nВИМОГИ МЕТОДИЧКИ ДО СПИСКУ ДЖЕРЕЛ: ${sourcesFormatRules}` : "";

  const fmtPrompt = `${styleRules}
${orderInstruction}${methodSourcesRulesText}
Збережи номери. Поверни ТІЛЬКИ список без заголовка. Для онлайн-джерел додай URL (дата звернення: ${accessDate}), АЛЕ ЛИШЕ якщо цей URL явно присутній у вхідних даних джерела (поле "url" у JSON або адреса http(s):// у сирому тексті рядка). Якщо URL немає — НЕ вигадуй його і не підставляй замість нього якесь інше число чи ідентифікатор із запису (наприклад, рік чи DOI-суфікс): просто випусти частину "URL: ..." для цього джерела. НЕ використовуй "[Електронний ресурс]".

ФОРМАТ ВХІДНИХ ДАНИХ: кожен рядок — або JSON-об'єкт (_type:"structured") або сирий текст.
Для JSON (_type:"structured"):
- authors: [{family:"Прізвище", given:"Ім'я"}] → форматуй як "Прізвище І." (перша літера given). НЕ перекладай і НЕ транслітеруй.
- authorsRaw: масив рядків → нормалізуй порядок (прізвище перед ініціалами), додай крапки після ініціалів.
- journal + volume + issue → для ДСТУ: "Назва журналу. рік. Вип. N, № M. С. xx–xx."
- _docType:"book" → це монографія/книга (Місто : Видавець, рік. Nс., де N — totalPages якщо є)
Для сирого тексту: нормалізуй порядок слів і розділові знаки за вимогами стилю.
КРИТИЧНО: НЕ перекладай і НЕ транслітеруй прізвища авторів та назви джерел — не вигадуй переклад чи іноземний варіант того, що подано мовою оригіналу. Переведення ВЕЛИКИХ ЛІТЕР у sentence case — дозволено і обов'язково.
ОКРЕМИЙ ВИНЯТОК (це виправлення АБЕТКИ, а не перекладу): якщо в ОДНОМУ записі прізвища авторів подані РІЗНИМИ абетками (частина кирилицею, частина латиницею — типовий артефакт автоімпорту з OpenAlex/CrossRef, напр. "Savchuk I., Лисецька Ю. В., Савчук О. Р."), приведи латиничне прізвище до кирилиці за стандартною українською транслітерацією, щоб усі автори запису були однією абеткою (тут — "Савчук І."). Так само якщо ВЕСЬ запис українською (назва, журнал кириличні), а прізвище єдиного автора дано лише латиницею через той самий артефакт бази — теж поверни його кирилицею. Якщо є сумнів, що прізвище насправді іноземне (не українське/не транслітероване) — НЕ чіпай його.

${refLines.join("\n")}`;

  const systemPrompt = `Ти — асистент з бібліографічного форматування. Форматуй джерела строго за стилем ${sourcesStyle}. Не змішуй стилі цитування. Не перекладай і не транслітеруй прізвища авторів та назви джерел — зберігай мову оригіналу (українські джерела — українською, англійські — англійською). Виняток: якщо в одному записі співавтори подані різними абетками (частина кирилицею, частина латиницею — артефакт автоімпорту з баз даних), приведи латиничне до кирилиці, щоб абетка була єдиною в межах запису. Перестав компоненти імені відповідно до вимог стилю (для APA: "Ім'я Прізвище" → "Прізвище, І."). Назви повністю ВЕЛИКИМИ ЛІТЕРАМИ переводь у sentence case. Повертай тільки відформатований список, без зайвого тексту.`;

  let fmtResult;
  try {
    fmtResult = await callClaude([{ role: "user", content: fmtPrompt }], null, systemPrompt, 16000);
  } catch (e) { console.error("sources format error:", e); }

  return sanitizeFormattedSourceLines(fmtResult, refLines);
}

// Форматує список джерел через ЛЛМ з автоматичним відновленням: якщо відповідь не
// пройшла валідацію (ЛЛМ зсунула/вигадала/загубила джерело), замість відкидання
// ВСЬОГО списку ділимо його навпіл і пробуємо кожну половину окремо, рекурсивно, поки
// не ізолюємо конкретний проблемний фрагмент (у гіршому випадку — одне джерело, яке
// тоді лишається без стильового форматування, а решта — акуратно оформлена).
// У звичайному (успішному) випадку це один виклик на весь список — без подорожчання.
// Повертає масив рядків у ТОМУ Ж порядку, що й rawRefs (ЛЛМ ніколи не переставляє).
export async function formatSourcesWithRetry({
  rawRefs, findStructured, sourcesStyle, sourcesFormatRules, callClaude,
}) {
  if (!rawRefs.length) return [];

  const refLines = rawRefs.map((r, i) => {
    const sp = findStructured(r);
    return sp ? `${i + 1}. ${JSON.stringify(buildStructuredEntry(sp))}` : `${i + 1}. ${r}`;
  });

  const sanitized = await formatSourcesViaLLM({ refLines, sourcesStyle, sourcesFormatRules, callClaude });
  if (sanitized) return sanitized;

  if (rawRefs.length === 1) {
    // Нема куди ділити далі — лишаємо сирий текст як є, без стильового форматування.
    return [rawRefs[0]];
  }

  const mid = Math.ceil(rawRefs.length / 2);
  const [left, right] = await Promise.all([
    formatSourcesWithRetry({ rawRefs: rawRefs.slice(0, mid), findStructured, sourcesStyle, sourcesFormatRules, callClaude }),
    formatSourcesWithRetry({ rawRefs: rawRefs.slice(mid), findStructured, sourcesStyle, sourcesFormatRules, callClaude }),
  ]);
  return [...left, ...right];
}

// Будує фінальний (відформатований і відсортований) список джерел та мапу
// "індекс у rawRefs (дедуплікований сирий список, у порядку першої появи) →
// фінальний номер у списку". Порядок: форматування (formatSourcesWithRetry, без
// права переставляти) → сортування кодом на вже правильно оформленому тексті
// (sortReferencesForDisplay).
export async function buildFinalReferenceList({
  rawRefs, findStructured, sourcesStyle, isLatinWork, sourcesFormatRules, callClaude,
  skipSort = false, // true → зберегти порядок першої появи (обрано "порядок появи", не алфавітний; актуально лише для APA/MLA — ДСТУ завжди алфавітний)
}) {
  if (!rawRefs.length) return { finalTexts: [], indexMap: [] };

  const byInputOrder = await formatSourcesWithRetry({ rawRefs, findStructured, sourcesStyle, sourcesFormatRules, callClaude });

  let finalTexts, rawIdxOfFinal;
  if (skipSort) {
    finalTexts = byInputOrder;
    rawIdxOfFinal = byInputOrder.map((_, i) => i);
  } else {
    const items = byInputOrder.map((text, i) => ({ text, structured: findStructured(rawRefs[i]), rawIdx: i }));
    const sortedItems = sortReferencesForDisplay(items, { latinFirst: isLatinWork });
    finalTexts = sortedItems.map(it => it.text);
    rawIdxOfFinal = sortedItems.map(it => it.rawIdx);
  }

  const indexMap = new Array(rawRefs.length);
  rawIdxOfFinal.forEach((rawIdx, finalPos) => { indexMap[rawIdx] = finalPos + 1; });
  return { finalTexts, indexMap };
}

// Будує формат внутрітекстового посилання ("[N]" / "(Автор, рік)" / "%%FNn%%") і, для
// ДСТУ, діапазон сторінок джерела — для кожного фінального номера. Спільна для
// remapAndFormatCitations і doRemapCitations (academic-assistant.jsx).
export function buildCiteFormats({ finalTexts, rawRefs, indexMap, findStructured, isAPA, isMLA, isFootnoteMode }) {
  const rawIdxOfFinal = new Array(finalTexts.length);
  indexMap.forEach((finalPos, rawIdx) => { rawIdxOfFinal[finalPos - 1] = rawIdx; });

  const refCiteText = {};
  const pageRanges = {};
  finalTexts.forEach((ref, i) => {
    const n = i + 1;
    if (isAPA) {
      const commaIdx = ref.indexOf(",");
      const beforeComma = commaIdx > 0 ? ref.substring(0, commaIdx).trim() : "";
      let rawAuthor;
      if (beforeComma && !beforeComma.includes(" ") && beforeComma.length >= 3) {
        rawAuthor = beforeComma;
      } else {
        const surnameMatch = ref.match(/(?:^|[\s,&])([А-ЯҐЄІЇа-яґєіїA-Za-z]{3,})/);
        rawAuthor = surnameMatch?.[1] || `Автор${n}`;
      }
      const yearMatch = ref.match(/[(.\s](\d{4})[).,\s]/);
      const author = rawAuthor.charAt(0).toUpperCase() + rawAuthor.slice(1).toLowerCase();
      refCiteText[n] = `(${author}, ${yearMatch?.[1] || "б.р."})`;
    } else if (isMLA) {
      const commaIdx = ref.indexOf(",");
      const beforeComma = commaIdx > 0 ? ref.substring(0, commaIdx).trim() : "";
      const rawSurname = (beforeComma && !beforeComma.includes(" "))
        ? beforeComma
        : ref.match(/(?:^|[\s,])([А-ЯҐЄІЇа-яґєіїA-Za-z]{3,})/)?.[1];
      refCiteText[n] = `(${rawSurname || `Автор${n}`})`;
    } else if (isFootnoteMode) {
      // Маркер для exportDocx — буде замінений на справжню Word-виноску з повним
      // описом джерела (ref), узятим зі сформатованого списку.
      refCiteText[n] = `%%FN${n}%%`;
    } else {
      const rawIdx = rawIdxOfFinal[i];
      const rawRef = rawRefs[rawIdx] ?? ref;
      const sp = findStructured(rawRef);
      const range = extractPageRange(rawRef, sp);
      if (range) pageRanges[n] = range;
      refCiteText[n] = `[${n}]`;
    }
  });
  return { refCiteText, pageRanges };
}

// Форматує список джерел за стилем (ДСТУ/APA/MLA), сортує (закони/мова/тип ресурсу)
// і повертає мапу старий→новий номер та формат inline-посилання для кожного нового
// номера. Для малих робіт (small-works.jsx, PracticePage.jsx), де [N] у тексті
// ЗАВЖДИ відповідає citations[N-1] (єдиний глобальний список без посекційної
// локальної нумерації, на відміну від doRemapCitations в academic-assistant.jsx).
export async function remapAndFormatCitations({
  citations,           // string[] — tezyCitations
  citStructured,       // paper[] — плоский масив структурованих даних
  citStyle,            // info?.citStyle
  language,            // info?.language
  sourcesOrder,        // methodInfo?.sourcesOrder (опційно)
  sourcesFormatRules,  // methodInfo?.sourcesFormatRules (опційно)
  citFootnotes,        // true → ДСТУ-посилання у вигляді посторінкових виносок замість [N]
  callClaude,
}) {
  if (!citations?.length) return { refList: [], oldToNew: {}, refCiteText: {}, pageRanges: {} };

  const sourcesStyleRaw = citStyle || "ДСТУ 8302:2015";
  const isAPA = /APA/i.test(sourcesStyleRaw);
  const isMLA = /MLA/i.test(sourcesStyleRaw);
  const isDstu = !isAPA && !isMLA;
  const sourcesStyle = isAPA ? "APA" : isMLA ? "MLA" : "ДСТУ 8302:2015";
  const isAlphabeticalOrder = !sourcesOrder || sourcesOrder === "alphabetical";
  const latinFirst = /англ|english|польськ|polish|нім|german|франц|french|іспан|spanish|італ|italian/i.test(language || "");

  const structuredByTitle = {};
  (citStructured || []).forEach(p => {
    if (p?.title) structuredByTitle[p.title.toLowerCase().slice(0, 60)] = p;
  });
  const findStructured = (refText) => {
    const lower = refText.toLowerCase();
    for (const [key, paper] of Object.entries(structuredByTitle)) {
      if (lower.includes(key)) return paper;
    }
    return null;
  };

  const { finalTexts, indexMap } = await buildFinalReferenceList({
    rawRefs: citations, findStructured, sourcesStyle, isLatinWork: latinFirst,
    sourcesFormatRules, callClaude,
    skipSort: !isAlphabeticalOrder && !isDstu,
  });

  const oldToNew = {};
  citations.forEach((_, i) => { oldToNew[i + 1] = indexMap[i]; });

  const { refCiteText, pageRanges } = buildCiteFormats({
    finalTexts, rawRefs: citations, indexMap, findStructured,
    isAPA, isMLA, isFootnoteMode: citFootnotes,
  });

  return { refList: finalTexts, oldToNew, refCiteText, pageRanges };
}
