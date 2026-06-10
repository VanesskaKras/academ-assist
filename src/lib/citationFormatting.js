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
  if (p.publisher) e.publisher = p.publisher;
  if (p.publisherLocation) e.city = p.publisherLocation;
  const url = p.url || (p.doi ? `https://doi.org/${p.doi}` : "");
  if (url) e.url = url;
  if (p.type === "book") e._docType = "book";
  return e;
}

// Замінює [oldN] / [oldN, с. X] у тексті на нові номери у фінальному форматі стилю
export function applyCitationRemap(text, oldToNew, refCiteText) {
  if (!text) return text;
  const citCount = {};
  let out = text.replace(/\[(\d+)(?:,\s*с\.\s*\d+)?\]/g, (match, oldN) => {
    const newN = oldToNew[Number(oldN)];
    if (!newN) return ""; // хибний (галюцинований) номер — прибираємо
    citCount[newN] = (citCount[newN] || 0) + 1;
    return citCount[newN] <= 1 ? `%%CIT${newN}%%` : "";
  });
  out = out.replace(/%%CIT(\d+)%%/g, (_, n) => refCiteText[Number(n)] || `[${n}]`);
  return out;
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
  callClaude,
}) {
  if (!citations?.length) return { refList: [], oldToNew: {}, refCiteText: {} };

  const sourcesStyleRaw = citStyle || "ДСТУ 8302:2015";
  const isAPA = /APA/i.test(sourcesStyleRaw);
  const isMLA = /MLA/i.test(sourcesStyleRaw);
  const isDstu = !isAPA && !isMLA;
  const sourcesStyle = isAPA ? "APA" : isMLA ? "MLA" : "ДСТУ 8302:2015";
  const isAlphabeticalOrder = !sourcesOrder || sourcesOrder === "alphabetical";

  const latinFirst = /англ|english|польськ|polish|нім|german|франц|french|іспан|spanish|італ|italian/i.test(language || "");

  // ── 1. Сортування (алфавіт + групування кирилиця/латиниця) ──
  let sorted;
  if (isAlphabeticalOrder || isDstu) {
    const langGroup = s => {
      const isCyrillic = /^[А-ЯҐЄІЇа-яґєії]/i.test(s);
      return latinFirst ? (isCyrillic ? 1 : 0) : (isCyrillic ? 0 : 1);
    };
    const groupLocales = latinFirst ? ["en", "uk"] : ["uk", "en"];
    sorted = [...citations].sort((a, b) => {
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

  // ── 3. Промпт форматування ──
  const today = new Date();
  const accessDate = `${String(today.getDate()).padStart(2, "0")}.${String(today.getMonth() + 1).padStart(2, "0")}.${today.getFullYear()}`;
  const sourcesOrderText = (isAlphabeticalOrder || isDstu) ? "Список відсортований за алфавітом." : "Список у порядку першої появи у тексті.";
  const defaultGrouping = latinFirst
    ? "спочатку законодавчі акти (закони, кодекси, постанови, накази тощо) за хронологією або номером; потім іноземні джерела (латиниця) за алфавітом; наприкінці кириличні джерела (українські та інші) за алфавітом"
    : "спочатку законодавчі акти (закони, кодекси, постанови, накази тощо) за хронологією або номером; потім книги та журнальні статті кирилицею (українські та інші кириличні) за алфавітом; потім українські електронні джерела (сайти, онлайн-матеріали кирилицею) за алфавітом; наприкінці іноземні джерела (латиниця) за алфавітом";
  const dstuGroupOrder = latinFirst
    ? "1) законодавчі акти (за хронологією/номером); 2) іноземні джерела латиницею за алфавітом; 3) книги та статті кирилицею за алфавітом; 4) кириличні електронні джерела за алфавітом."
    : "1) законодавчі акти (за хронологією/номером); 2) книги та статті кирилицею за алфавітом; 3) українські електронні джерела за алфавітом; 4) іноземні джерела латиницею за алфавітом.";
  const sourcesGroupingText = sourcesGrouping
    ? `Групування: ${sourcesGrouping}.`
    : (isDstu || isAlphabeticalOrder) ? `Групування за ДСТУ 8302:2015: ${defaultGrouping}.` : "";

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

  const methodSourcesRules = sourcesFormatRules ? `\nВИМОГИ МЕТОДИЧКИ ДО СПИСКУ ДЖЕРЕЛ: ${sourcesFormatRules}` : "";

  const fmtPrompt = `${styleRules}
${sourcesOrderText} ${sourcesGroupingText}${methodSourcesRules}
Збережи номери. Поверни ТІЛЬКИ список без заголовка. Для онлайн-джерел додай URL (дата звернення: ${accessDate}). НЕ використовуй "[Електронний ресурс]".

ФОРМАТ ВХІДНИХ ДАНИХ: кожен рядок — або JSON-об'єкт (_type:"structured") або сирий текст.
Для JSON (_type:"structured"):
- authors: [{family:"Прізвище", given:"Ім'я"}] → форматуй як "Прізвище І." (перша літера given). НЕ перекладай і НЕ транслітеруй.
- authorsRaw: масив рядків → нормалізуй порядок (прізвище перед ініціалами), додай крапки після ініціалів.
- journal + volume + issue → для ДСТУ: "Назва журналу. рік. Вип. N, № M. С. xx–xx."
- _docType:"book" → це монографія/книга (Місто : Видавець, рік. Nс.)
Для сирого тексту: нормалізуй порядок слів і розділові знаки за вимогами стилю.
КРИТИЧНО: НЕ перекладай і НЕ транслітеруй прізвища авторів та назви джерел. Переведення ВЕЛИКИХ ЛІТЕР у sentence case — дозволено і обов'язково.

${refLines.join("\n")}`;

  let fmtResult;
  try {
    fmtResult = await callClaude([{ role: "user", content: fmtPrompt }], null,
      `Ти — асистент з бібліографічного форматування. Форматуй джерела строго за стилем ${sourcesStyle}. Не змішуй стилі цитування. Не перекладай і не транслітеруй прізвища авторів та назви джерел — зберігай мову оригіналу (українські джерела — українською, англійські — англійською). Перестав компоненти імені відповідно до вимог стилю (для APA: "Ім'я Прізвище" → "Прізвище, І."). Назви повністю ВЕЛИКИМИ ЛІТЕРАМИ переводь у sentence case. Повертай тільки відформатований список, без зайвого тексту.`, 16000);
  } catch (e) { console.error("citation format error:", e); }

  const fmtLines = fmtResult
    ? fmtResult.split("\n").filter(Boolean).map(l => l.replace(/^\d+\.\s*/, ""))
    : sorted;

  // ── 4. Формат inline-посилань по стилю ──
  const refCiteText = {};
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
    } else {
      const rawRef = sorted[i] ?? ref;
      const articlePageMatch = rawRef.match(/[Сс]\.\s*(\d+)\s*[–\-—]/);
      const singlePageMatch = !articlePageMatch && rawRef.match(/[Сс]\.\s*(\d+)(?!\d*\s*с\.)/);
      const engPageMatch = rawRef.match(/pp?\.\s*(\d+)/i);
      const startPage = articlePageMatch?.[1] || singlePageMatch?.[1] || engPageMatch?.[1];
      refCiteText[n] = startPage ? `[${n}, с. ${startPage}]` : `[${n}]`;
    }
  });

  return { refList: fmtLines, oldToNew, refCiteText };
}
