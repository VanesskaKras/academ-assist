// ── Форматування списку джерел + перестановка посилань [N] у тексті ──
// Портовано з doRemapCitations (academic-assistant.jsx) для малих робіт,
// де [N] у тексті ЗАВЖДИ відповідає citations[N-1] (єдиний глобальний список,
// без посекційної локальної нумерації).

function buildStructuredEntry(p) {
  const e = { _type: "structured" };
  if (p.authorsStructured?.length) e.authors = p.authorsStructured;
  else if (p.authors?.length) e.authorsRaw = p.authors;
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

// Фільтрує сиру відповідь LLM-форматування списку джерел до валідних пронумерованих
// рядків ("N. текст") і звіряє їх кількість з очікуваною. LLM іноді додає преамбулу/
// примітку ("Нижче подано...", "---") або вигадує зайве джерело попри пряму заборону
// в промпті — тому будь-яка розбіжність кількості означає, що відповіді довіряти не
// можна, і викликач має fallback на сирий список джерел.
export function sanitizeFormattedSourceLines(fmtResult, expectedCount) {
  if (!fmtResult) return null;
  const lines = fmtResult.split("\n").map(l => l.trim()).filter(l => /^\d+[.)]\s/.test(l));
  return lines.length === expectedCount ? lines : null;
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

// Замінює [oldN] / [oldN, с. X] у тексті на нові номери у фінальному форматі стилю.
// Сторінку, яку вписала сама модель під час написання, зберігаємо як є (якщо вона
// в межах відомого діапазону джерела); інакше підставляємо сторінку з діапазону.
// Кожна згадка джерела лишається окремою (виноски й так завжди були окремі,
// а для звичайних [N] повторне цитування — це нормально, не дублікат для видалення).
export function applyCitationRemap(text, oldToNew, refCiteText, { pageRanges = {} } = {}) {
  if (!text) return text;
  const citCount = {};
  let out = text.replace(/\[(\d+)(?:,\s*с\.\s*(\d+))?\]/g, (match, oldN, oldPage) => {
    const newN = oldToNew[Number(oldN)];
    if (!newN) return ""; // хибний (галюцинований) номер — прибираємо
    citCount[newN] = (citCount[newN] || 0) + 1;
    return `%%CIT${newN}_${oldPage || ""}_${citCount[newN]}%%`;
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
  return out;
}

// Будує правила стилю (ДСТУ/APA/MLA) + промпт форматування списку джерел, викликає
// LLM і валідує відповідь (sanitizeFormattedSourceLines). Спільна для трьох місць, де
// раніше цей блок був продубльований майже дослівно: remapAndFormatCitations (тут),
// doAddAllCitations і doRemapCitations (academic-assistant.jsx).
// Викликач сам резолвить сирі значення стилю/порядку/групування (у них різні джерела —
// methodInfo, override, евристики) і будує refLines (бо форма citStructured різна);
// сюди приходять вже готові прості параметри.
export async function formatSourcesViaLLM({
  refLines,             // string[] — вже побудовані рядки "N. ..." (raw text або JSON structured)
  sourcesStyle,         // "APA" | "MLA" | "ДСТУ 8302:2015"
  isLatinWork,          // bool — робота іноземною мовою (англ./польськ./нім. тощо)
  isAlphabeticalOrder,  // bool
  sourcesGroupingRaw,   // methodInfo?.sourcesGrouping — сира вимога клієнта, або falsy
  sourcesFormatRules,   // methodInfo?.sourcesFormatRules
  callClaude,
}) {
  const isAPA = sourcesStyle === "APA";
  const isMLA = sourcesStyle === "MLA";
  const isDstu = !isAPA && !isMLA;

  const today = new Date();
  const accessDate = `${String(today.getDate()).padStart(2, "0")}.${String(today.getMonth() + 1).padStart(2, "0")}.${today.getFullYear()}`;

  const sourcesOrderText = (isAlphabeticalOrder || isDstu) ? "Список відсортований за алфавітом." : "Список у порядку першої появи у тексті.";
  const defaultGrouping = isLatinWork
    ? "спочатку законодавчі акти (закони, кодекси, постанови, накази тощо) за хронологією або номером; потім іноземні джерела (латиниця) за алфавітом; наприкінці кириличні джерела (українські та інші) за алфавітом"
    : "спочатку законодавчі акти (закони, кодекси, постанови, накази тощо) за хронологією або номером; потім книги та журнальні статті кирилицею (українські та інші кириличні) за алфавітом; потім українські електронні джерела (сайти, онлайн-матеріали кирилицею) за алфавітом; наприкінці іноземні джерела (латиниця) за алфавітом";
  const sourcesGroupingText = sourcesGroupingRaw
    ? `Групування: ${sourcesGroupingRaw}.`
    : (isDstu || isAlphabeticalOrder) ? `Групування за ДСТУ 8302:2015: ${defaultGrouping}.` : "";
  const dstuGroupOrder = isLatinWork
    ? "1) законодавчі акти (за хронологією/номером); 2) іноземні джерела латиницею за алфавітом; 3) книги та статті кирилицею за алфавітом; 4) кириличні електронні джерела за алфавітом."
    : "1) законодавчі акти (за хронологією/номером); 2) книги та статті кирилицею за алфавітом; 3) українські електронні джерела за алфавітом; 4) іноземні джерела латиницею за алфавітом.";

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
- КУРСИВ: назву журналу, збірника, серії або сайту ОБОВ'ЯЗКОВО обгортай в *зірочки* (*Назва журналу*). Назву статті та прізвища авторів — звичайний шрифт.
- ПОРЯДОК ГРУП: ${dstuGroupOrder}`
      : `СТИЛЬ: ${sourcesStyle}. Точно дотримуйся цього стилю.`;

  const methodSourcesRulesText = sourcesFormatRules ? `\nВИМОГИ МЕТОДИЧКИ ДО СПИСКУ ДЖЕРЕЛ: ${sourcesFormatRules}` : "";

  const fmtPrompt = `${styleRules}
${sourcesOrderText} ${sourcesGroupingText}${methodSourcesRulesText}
Збережи номери. Поверни ТІЛЬКИ список без заголовка. Для онлайн-джерел додай URL (дата звернення: ${accessDate}). НЕ використовуй "[Електронний ресурс]".

ФОРМАТ ВХІДНИХ ДАНИХ: кожен рядок — або JSON-об'єкт (_type:"structured") або сирий текст.
Для JSON (_type:"structured"):
- authors: [{family:"Прізвище", given:"Ім'я"}] → форматуй як "Прізвище І." (перша літера given). НЕ перекладай і НЕ транслітеруй.
- authorsRaw: масив рядків → нормалізуй порядок (прізвище перед ініціалами), додай крапки після ініціалів.
- journal + volume + issue → для ДСТУ: "Назва журналу. рік. Вип. N, № M. С. xx–xx."
- _docType:"book" → це монографія/книга (Місто : Видавець, рік. Nс., де N — totalPages якщо є)
Для сирого тексту: нормалізуй порядок слів і розділові знаки за вимогами стилю.
КРИТИЧНО: НЕ перекладай і НЕ транслітеруй прізвища авторів та назви джерел. Переведення ВЕЛИКИХ ЛІТЕР у sentence case — дозволено і обов'язково.

${refLines.join("\n")}`;

  let fmtResult;
  try {
    fmtResult = await callClaude([{ role: "user", content: fmtPrompt }], null,
      `Ти — асистент з бібліографічного форматування. Форматуй джерела строго за стилем ${sourcesStyle}. Не змішуй стилі цитування. Не перекладай і не транслітеруй прізвища авторів та назви джерел — зберігай мову оригіналу (українські джерела — українською, англійські — англійською). Перестав компоненти імені відповідно до вимог стилю (для APA: "Ім'я Прізвище" → "Прізвище, І."). Назви повністю ВЕЛИКИМИ ЛІТЕРАМИ переводь у sentence case. Повертай тільки відформатований список, без зайвого тексту.`, 16000);
  } catch (e) { console.error("sources format error:", e); }

  return sanitizeFormattedSourceLines(fmtResult, refLines.length);
}

// Форматує список джерел за стилем (ДСТУ/APA/MLA), сортує за алфавітом
// (з групуванням кирилиця/латиниця) і повертає мапу старий→новий номер
// та формат inline-посилання для кожного нового номера.
export async function remapAndFormatCitations({
  citations,           // string[] — tezyCitations
  citStructured,       // paper[] — плоский масив структурованих даних
  citStyle,            // info?.citStyle
  language,            // info?.language
  sourcesOrder,        // methodInfo?.sourcesOrder (опційно)
  sourcesGrouping,     // methodInfo?.sourcesGrouping (опційно)
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

  // ── 1. Сортування (алфавіт + групування кирилиця/латиниця + закони першими) ──
  let sorted;
  if (isAlphabeticalOrder || isDstu) {
    const isLaw = s => /^(закон|кодекс|конституція|постанова|указ\s|декрет\s|наказ\s|розпорядження\s)/i.test(s.trim());
    const langGroup = s => {
      const isCyrillic = /^[А-ЯҐЄІЇа-яґєії]/i.test(s);
      return latinFirst ? (isCyrillic ? 1 : 0) : (isCyrillic ? 0 : 1);
    };
    const groupLocales = latinFirst ? ["en", "uk"] : ["uk", "en"];
    sorted = [...citations].sort((a, b) => {
      const lawA = isLaw(a), lawB = isLaw(b);
      if (lawA !== lawB) return lawA ? -1 : 1;
      const ga = langGroup(a), gb = langGroup(b);
      if (ga !== gb) return ga - gb;
      return a.localeCompare(b, groupLocales[ga]);
    });
  } else {
    sorted = [...citations];
  }
  const oldToNew = {};
  citations.forEach((c, i) => { oldToNew[i + 1] = sorted.indexOf(c) + 1; });

  // ── 2. Lookup структурованих даних за назвою ──
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
  const refLines = sorted.map((r, i) => {
    const sp = findStructured(r);
    return sp ? `${i + 1}. ${JSON.stringify(buildStructuredEntry(sp))}` : `${i + 1}. ${r}`;
  });

  // ── 3. Промпт форматування + виклик LLM (спільна логіка — formatSourcesViaLLM) ──
  const sanitizedFmt = await formatSourcesViaLLM({
    refLines, sourcesStyle, isLatinWork: latinFirst, isAlphabeticalOrder,
    sourcesGroupingRaw: sourcesGrouping, sourcesFormatRules, callClaude,
  });
  const fmtLines = sanitizedFmt
    ? sanitizedFmt.map(l => l.replace(/^\d+[.)]\s*/, ""))
    : sorted;

  // ── 4. Формат inline-посилань по стилю ──
  const refCiteText = {};
  const pageRanges = {};
  fmtLines.forEach((ref, i) => {
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
    } else if (citFootnotes) {
      // Маркер для exportDocx — буде замінений на справжню Word-виноску
      // з повним описом джерела (ref), узятим зі сформатованого списку.
      refCiteText[n] = `%%FN${n}%%`;
    } else {
      const rawRef = sorted[i] ?? ref;
      const sp = findStructured(rawRef);
      const range = extractPageRange(rawRef, sp);
      if (range) pageRanges[n] = range;
      refCiteText[n] = `[${n}]`;
    }
  });

  return { refList: fmtLines, oldToNew, refCiteText, pageRanges };
}
