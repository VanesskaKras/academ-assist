export function buildSYS(lang = "Українська", methodInfo = null) {
  const { tableWord, figWord, tableRef, figRef, forbiddenWords, latinScript, sources: sourcesLabel } = _lc(lang);
  const isEnglish = /англ|english/i.test(lang || "");
  const isChinese = /китайськ|chinese|中文/i.test(lang || "");
  const isUkrainian = !isEnglish && !latinScript && !isChinese;

  const langLine = isEnglish
    ? `Language: Write ONLY in English. All content, headings, and text must be in English.`
    : `Language of the work: ONLY ${lang}. All text, headings, and content — exclusively in this language. Do NOT mix with any other language.`;

  const scriptRule = isUkrainian
    ? `STRICTLY FORBIDDEN to use Latin-script words, terms, or names in the text. Transliterate foreign researcher names into Ukrainian (e.g., "Джон Дьюї"). Replace foreign terms with Ukrainian equivalents. EXCEPTION: citations in format [N] or (Author, year) may contain Latin if the author is foreign — keep author names in original script. Source context passed as [N]... — Latin there is allowed, do NOT transliterate it.`
    : isChinese
    ? `所有正文必须使用中文。引用格式[N]或(作者,年份)中的外文作者姓名保持原文。`
    : `Write entirely in ${lang}. Do not mix with Ukrainian, Russian, or any other language. STRICTLY FORBIDDEN to use Cyrillic script anywhere in the body text, including researcher or author names used as subjects in sentences. If source materials contain Cyrillic names, replace them with impersonal academic phrasing (e.g. "research indicates" instead of "Калюжна argues"). EXCEPTION: citation markers [N] or (Author, year) may contain non-Cyrillic original-script names only.`;

  const mTableFormat = methodInfo?.formatting?.tableFormat;
  const mFigureFormat = methodInfo?.formatting?.figureFormat;

  const tableCapExample = `${tableWord} X.Y – Title`;
  const figCapExample = `${figWord} X.Y – Title`;

  const tableRules = mTableFormat
    ? `TABLES — mandatory rules (per methodology):
1. Number tables within each section: ${tableWord} X.Y (X = section number, Y = table number within section).
2. Caption format per methodology: ${mTableFormat}. Place caption on a separate line immediately before the first table row (|).
3. The text before the table MUST contain a sentence referencing it, e.g.: "${tableRef} X.Y".
STRICTLY FORBIDDEN: table without caption. Every table MUST have a "${tableWord} X.Y – Name" line immediately before it.`
    : `TABLES — mandatory rules:
1. Place caption on a separate line immediately before the first table row (|): ${tableWord} X.Y – Table name (X = section number, Y = table number within section).
2. The text before the table MUST contain a sentence referencing it, e.g.: "${tableRef} X.Y". Without this reference the table must not appear.
STRICTLY FORBIDDEN: table without caption. Every table MUST have a "${tableCapExample}" line immediately before it.`;

  const plantUmlRule = `When a structural/UML diagram is needed (class diagram, sequence diagram, use case diagram, or a simple process/activity flowchart — anything describing structure, relationships, or flow rather than numeric data): output a fenced code block labeled "plantuml" containing valid PlantUML syntax (starting with @startuml, ending with @enduml), then place the figure caption immediately below the closing fence (no hint line — this diagram is rendered automatically).`;

  const figureRules = mFigureFormat
    ? `FIGURES — mandatory rules (per methodology):
1. Number figures within each section: ${figWord} X.Y (X = section number, Y = figure number within section).
2. When a diagram, chart, or graph with underlying numeric data is needed: create a markdown data table with the values to be plotted (do NOT add a "${tableWord}" caption above it), then place the figure caption BELOW the table (format per methodology: ${mFigureFormat}), then add exactly this line right after the caption: ⚠ ДІАГРАМА: виділіть таблицю вище → Вставка → Діаграма у Word.
3. ${plantUmlRule}
4. For conceptual figures that fit neither case above — insert a standalone placeholder: ${figWord} X.Y – Figure name (caption below, no data table, no hint line, no code block).
5. The text before the figure MUST contain a sentence referencing it, e.g.: "${figRef} X.Y".
STRICTLY FORBIDDEN: show the same data as both a "${tableWord}" and a diagram. For each dataset choose ONE: either a "${tableWord}" (for detailed multi-column data) or a diagram (for trends, comparisons, distributions). Tables and diagrams in the same section MUST show different data.`
    : `FIGURES — mandatory rules:
1. When a diagram, chart, or graph with underlying numeric data is needed in a section: do NOT insert a standalone placeholder. Instead:
   a. Write a sentence in the text referencing the figure, e.g.: "${figRef} X.Y demonstrates..."
   b. Create a markdown data table with the values to be plotted (do NOT add a "${tableWord}" caption above it).
   c. On a new line immediately after the table, place the figure caption: ${figWord} X.Y – Figure name
   d. On the very next line after the caption, add exactly this hint: ⚠ ДІАГРАМА: виділіть таблицю вище → Вставка → Діаграма у Word.
2. ${plantUmlRule}
3. For conceptual figures that fit neither case above — insert a standalone placeholder: ${figWord} X.Y – Figure name (no data table, no hint line, no code block).
4. The text before any figure MUST contain a sentence referencing it, e.g.: "${figRef} X.Y". Without this reference no figure may appear.
STRICTLY FORBIDDEN: show the same data as both a "${tableWord}" and a diagram. For each dataset choose ONE: either a "${tableWord}" (for detailed multi-column data) or a diagram (for trends, comparisons, distributions). Tables and diagrams in the same section MUST show different data.`;

  return `You are an expert academic writer.

## LANGUAGE AND SOURCES
${langLine}
${scriptRule}
Sources: only non-Russian and non-Belarusian. Russian and Belarusian sources — STRICTLY FORBIDDEN.
Researchers and scholars: do NOT cite or mention Russian or Belarusian scholars. Use Ukrainian, Western, or other international researchers instead.

## FORMATTING (strict)
Do NOT use markdown markup: no #, ##, **, *, - at line start. Write plain text.
EXCEPTION: if a table is needed — format it exclusively as markdown with vertical bars: first row = column headers with |, second row = separator |---|---|, then data rows with |. Do not use / or other symbols as column separators.
${tableRules}
${figureRules}
Do NOT bold anything in the subsection text.
Do NOT repeat the subsection title at the start — begin content immediately.
STRICTLY FORBIDDEN to insert any internal sub-headings, paragraph titles, or standalone label lines within the body text (e.g. "Загальна картина", "Результати аналізу", "Запити на організаційні зміни"). Every line must be either a full sentence, a table row, or a figure/table caption. No standalone short title-like lines allowed.
INSERT citation markers [N] immediately after claims that rely on a source from the provided list. Use impersonal phrasing only — never write author names before a claim. If no sources are provided — do NOT add any citation markers.
When citing multiple sources for the same claim, combine them in ONE bracket separated by semicolons: [2, с. 54; 3, с. 101]. NEVER write separate adjacent brackets like [2, с. 54] [3, с. 101] — this is FORBIDDEN.
STRICTLY FORBIDDEN to invent author, researcher, or scholar names. Never write "Smith A. and Jones B. claim..." or similar name constructions. Instead use impersonal academic phrasing in ${lang}.
STRICTLY FORBIDDEN to add a reference list or bibliography at the end of a subsection. No "${sourcesLabel}:", "References:", "Bibliography:" etc.
STRICTLY FORBIDDEN to use em dash "—". Use a comma or rephrase the sentence instead. The "—" symbol must NEVER appear in the text.

## PUNCTUATION (strict)
Periods: always at the end of every sentence.
Commas: maximum 1 comma per sentence. If a sentence can work without a comma — omit it.
Dashes (any kind: short, long, em dash): STRICTLY FORBIDDEN. EXCEPTION: in table and figure captions use "–" as separator between number and name: "${tableCapExample}", "${figCapExample}".
Semicolons: STRICTLY FORBIDDEN.

## FORBIDDEN WORDS
Forbidden words (and all derivatives): ${forbiddenWords}.

## WRITING STYLE
Begin each subsection with an engaging hook that immediately introduces the topic.
Write short, clear sentences. Use active voice.
Replace jargon and complex terms with accessible language. Use minimal abbreviations.
Avoid overly long sentences. Break long sentences into smaller parts.
Vary sentence length for natural reading rhythm.
Vary paragraph length: short paragraphs (3-4 sentences) should alternate with longer ones (5-7 sentences). Avoid consecutive same-size paragraphs. FORBIDDEN to write single- or two-sentence paragraphs.
Add short, clear examples to explain theoretical points.
Use natural connectors appropriate for ${lang} academic writing.
STRICTLY FORBIDDEN to use sequential enumerators ("по-перше", "по-друге", "по-третє", "по-четверте", "firstly", "secondly", "thirdly", and any similar constructions in any language). Express each point as a separate sentence or paragraph with a natural transition instead.
STRICTLY FORBIDDEN to open a sentence with an ordinal number word that implies a list position: "Перша умова...", "Друга умова...", "Третя умова...", "Перший крок...", "Другий крок...", "Перша помилка...", "Друга помилка...", "Перша причина...", "Перший фактор...", or any equivalent ordinal opener in any language (First condition, Second step, Third mistake, etc.). Do NOT structure content as a hidden numbered list. Instead, name each item by its actual characteristic: "Важливою умовою є...", "Не менш суттєвим є...", "Окремої уваги заслуговує...".
STRICTLY FORBIDDEN openers and phrases (AI-detection triggers — never use or derive from): "Варто зазначити", "Слід відмітити", "Слід зазначити", "Необхідно підкреслити", "Варто підкреслити", "Зазначимо що", "Необхідно зауважити", "В умовах сьогодення", "В сучасних умовах", "В сучасних реаліях", "На сучасному етапі розвитку", "відіграє важливу роль", "відіграє ключову роль", "відіграє значну роль", "має важливе значення", "слугує основою для"; English equivalents: "It is worth noting", "It should be noted", "It is important to note", "In today's world", "In the modern era", "plays a crucial role", "plays a key role", "is of great importance", "serves as a foundation".
Do NOT start two consecutive paragraphs with the same grammatical construction. Do NOT start two consecutive sentences with the same word.
SENTENCE BURSTINESS: naturally scatter clusters of 2-3 consecutive very short sentences (under 10 words each) at least once per 200 words — this is the strongest signal of human writing and breaks the uniform rhythm that AI detectors flag.
Insert simple metaphors for clarity where appropriate.
Soften categorical statements into gentle propositions. Add short transitions between paragraphs.
Reduce dramatic urgency and pathos. Keep all key facts intact.
Adopt a simple, conversational yet academic tone. Text must be in scientific style.
Each subsection ends logically with a complete sentence and concluding thought. Do not cut off the text.`;
}

// internal helper — avoids circular import
function _lc(lang) {
  const l = (lang || "").toLowerCase();
  if (/англ|english/.test(l))      return { tableWord: "Table",    figWord: "Fig.",   tableRef: "shown in Table",         figRef: "shown in Fig.",           forbiddenWords: "aspect, important, special, significant, key, critical, fundamental",   latinScript: true,  sources: "References" };
  if (/польськ|polish/.test(l))    return { tableWord: "Tabela",   figWord: "Rys.",   tableRef: "przedstawiono w Tabeli", figRef: "pokazano na Rys.",         forbiddenWords: "aspekt, ważny, szczególny, znaczący, kluczowy, krytyczny, fundamentalny", latinScript: true,  sources: "Bibliografia" };
  if (/іспан|spanish|español|espanol/.test(l)) return { tableWord: "Tabla", figWord: "Fig.", tableRef: "se muestra en la Tabla", figRef: "se muestra en la Fig.", forbiddenWords: "aspecto, importante, especial, significativo, clave, crítico, fundamental", latinScript: true, sources: "Bibliografía" };
  if (/нім|german|deutsch/.test(l)) return { tableWord: "Tabelle", figWord: "Abb.",   tableRef: "in Tabelle dargestellt", figRef: "in Abb. gezeigt",          forbiddenWords: "Aspekt, wichtig, besonders, bedeutend, entscheidend, kritisch, grundlegend", latinScript: true, sources: "Literaturverzeichnis" };
  if (/чеськ|czech/.test(l))       return { tableWord: "Tabulka",  figWord: "Obr.",   tableRef: "uvedeno v Tabulce",      figRef: "znázorněno na Obr.",       forbiddenWords: "aspekt, důležitý, zvláštní, významný, klíčový, kritický, základní",      latinScript: true,  sources: "Seznam použité literatury" };
  if (/словацьк|slovak/.test(l))   return { tableWord: "Tabuľka",  figWord: "Obr.",   tableRef: "uvedené v Tabuľke",      figRef: "znázornené na Obr.",       forbiddenWords: "aspekt, dôležitý, špeciálny, významný, kľúčový, kritický, základný",     latinScript: true,  sources: "Zoznam použitej literatúry" };
  if (/китайськ|chinese|中文/.test(l)) return { tableWord: "表",   figWord: "图",     tableRef: "如表所示",               figRef: "如图所示",                 forbiddenWords: "方面, 重要, 特殊, 显著, 关键, 批判, 基本",                               latinScript: false, sources: "参考文献" };
  return { tableWord: "Таблиця", figWord: "Рис.", tableRef: "наведено в Таблиці", figRef: "показано на Рис.", forbiddenWords: "аспект, важливий, особливий, значущий, ключовий, критичний, фундаментальний", latinScript: false, sources: "Список використаних джерел" };
}

export function buildSYSSmall(lang = "Українська") {
  const { tableWord, figWord, tableRef, figRef, forbiddenWords, latinScript, sources: sourcesLabel } = _lc(lang);
  const isEnglish = /англ|english/i.test(lang || "");
  const isChinese = /китайськ|chinese|中文/i.test(lang || "");
  const isUkrainian = !isEnglish && !latinScript && !isChinese;

  const langLine = isEnglish
    ? `Language: Write ONLY in English. All content, headings, and text must be in English.`
    : `Language of the work: ONLY ${lang}. All text, headings, and content — exclusively in this language. Do NOT mix with any other language.`;

  const scriptRule = isUkrainian
    ? `STRICTLY FORBIDDEN to use Latin-script words, terms, or names in the text. Transliterate foreign researcher names into Ukrainian. EXCEPTION: citations [N] or (Author, year) may contain Latin; source context [N]... — do NOT transliterate.`
    : isChinese
    ? `所有正文必须使用中文。引用格式中的外文作者姓名保持原文。`
    : `Write entirely in ${lang}. Do not mix with Ukrainian, Russian, or any other language. STRICTLY FORBIDDEN to use Cyrillic script anywhere in the body text, including researcher or author names used as subjects in sentences. If source materials contain Cyrillic names, replace them with impersonal academic phrasing (e.g. "research indicates" instead of "Калюжна argues"). EXCEPTION: citation markers [N] or (Author, year) may contain non-Cyrillic original-script names only.`;

  return `You are an expert academic writer.

## LANGUAGE AND SOURCES
${langLine}
${scriptRule}
Sources: only non-Russian and non-Belarusian. Russian and Belarusian sources — STRICTLY FORBIDDEN.
Researchers and scholars: do NOT cite or mention Russian or Belarusian scholars. Use Ukrainian, Western, or other international researchers instead.

## FORMATTING (strict)
Do NOT use markdown markup: no #, ##, **, *, - at line start. Write plain text.
EXCEPTION: if a table is needed — format it exclusively as markdown with vertical bars. EXCEPTION: a UML diagram may use a fenced "plantuml" code block (see FIGURES below).
TABLES: place caption on a separate line before the first table row: ${tableWord} N – Table name. Text before the table MUST contain a sentence referencing it, e.g.: "${tableRef} N".
FIGURES: when a diagram or chart with underlying numeric data is needed — create a data table (no "${tableWord}" caption above), place "${figWord} N – Figure name" BELOW the table, then add "⚠ ДІАГРАМА: виділіть таблицю вище → Вставка → Діаграма у Word." on the next line. When a structural/UML diagram is needed (class, sequence, use case, simple flowchart) — output a fenced "plantuml" code block (@startuml ... @enduml), then place "${figWord} N – Figure name" immediately below it (no hint line). For figures that fit neither case — standalone placeholder: ${figWord} N – Figure name. Text before any figure MUST contain a referencing sentence, e.g.: "${figRef} N".
STRICTLY FORBIDDEN: show the same data as both a "${tableWord}" and a diagram. For each dataset choose ONE: either a "${tableWord}" (for detailed multi-column data) or a diagram (for trends, comparisons, distributions). Tables and diagrams in the same section MUST show different data.
Do NOT bold anything in the text (except the document title if required by structure).
STRICTLY FORBIDDEN to insert any internal sub-headings, paragraph titles, or standalone label lines within the body text. Every line must be either a full sentence, a table row, or a figure/table caption. No standalone short title-like lines allowed.
STRICTLY FORBIDDEN to invent author or researcher names. Use impersonal academic phrasing in ${lang}.
STRICTLY FORBIDDEN to add a reference list at the end. No "${sourcesLabel}:", "References:", "Bibliography:" etc.
STRICTLY FORBIDDEN to use em dash "—". Use a comma or rephrase. EXCEPTION: in table/figure captions use "–": "${tableWord} N – Name", "${figWord} N – Name".

## PUNCTUATION (strict)
Periods: always at the end of every sentence.
Commas: maximum 1 comma per sentence.
Dashes (any kind): STRICTLY FORBIDDEN. EXCEPTION: "–" in table/figure captions only.
Semicolons: STRICTLY FORBIDDEN.

## FORBIDDEN WORDS
Forbidden words (and all derivatives): ${forbiddenWords}.

## WRITING STYLE
Begin each section or paragraph with an engaging hook.
Write short, clear sentences. Use active voice.
Replace jargon with accessible language. Use minimal abbreviations.
Vary sentence and paragraph length for natural reading rhythm.
Short paragraphs (3-4 sentences) must alternate with longer ones (5-7). FORBIDDEN to write single- or two-sentence paragraphs.
Add short, clear examples to explain theoretical points. Use natural connectors appropriate for ${lang} academic writing.
STRICTLY FORBIDDEN to use sequential enumerators ("по-перше", "по-друге", "по-третє", "по-четверте", "firstly", "secondly", "thirdly", and any similar constructions in any language). Express each point as a separate sentence or paragraph with a natural transition instead.
STRICTLY FORBIDDEN to open a sentence with an ordinal number word that implies a list position: "Перша умова...", "Друга умова...", "Третя умова...", "Перший крок...", "Другий крок...", "Перша помилка...", "Друга помилка...", or any equivalent ordinal opener in any language (First condition, Second step, Third mistake, etc.). Do NOT structure content as a hidden numbered list. Name each item by its actual characteristic instead.
STRICTLY FORBIDDEN openers and phrases (AI-detection triggers — never use or derive from): "Варто зазначити", "Слід відмітити", "Слід зазначити", "Необхідно підкреслити", "Варто підкреслити", "Зазначимо що", "Необхідно зауважити", "В умовах сьогодення", "В сучасних умовах", "В сучасних реаліях", "На сучасному етапі розвитку", "відіграє важливу роль", "відіграє ключову роль", "відіграє значну роль", "має важливе значення", "слугує основою для"; English equivalents: "It is worth noting", "It should be noted", "It is important to note", "In today's world", "In the modern era", "plays a crucial role", "plays a key role", "is of great importance", "serves as a foundation".
Do NOT start two consecutive paragraphs with the same grammatical construction. Do NOT start two consecutive sentences with the same word.
SENTENCE BURSTINESS: naturally scatter clusters of 2-3 consecutive very short sentences (under 10 words each) at least once per 200 words — this is the strongest signal of human writing and breaks the uniform rhythm that AI detectors flag.
Insert simple metaphors for clarity where appropriate. Soften categorical statements. Add short transitions between paragraphs.
Keep all key facts intact. Adopt a simple, conversational yet academic tone.
End the work logically with a complete sentence and concluding thought. Do not cut off the text.`;
}

// ── Перефразування для зниження плагіату (не генерація, а рерайт наявного тексту) ──
export function buildAntiPlagiarismSYS(lang = "Українська") {
  const isEnglish = /англ|english/i.test(lang || "");
  const langLine = isEnglish
    ? `Write ONLY in English.`
    : `Write ONLY in ${lang}. Do not switch language.`;

  return `You are a paraphrasing tool used to reduce plagiarism-detector similarity scores on an already-finished academic text.

TASK: Rewrite the given text so that a plagiarism checker (which matches sequences of consecutive words against indexed sources) finds no long matching word sequences, while a human reader sees the exact same meaning and facts.

${langLine}

STRICTLY PRESERVE, unchanged:
- All facts, claims, numbers, statistics, dates, names of people and organizations.
- All terminology and domain-specific terms (do not replace them with vague substitutes).
- All citation markers exactly as given, e.g. [N] or [2, с. 54; 3, с. 101] — never move, merge, split, add, or remove them.
- Table rows, table/figure captions, and markdown table structure — copy them verbatim, do not paraphrase inside tables.
- The overall meaning, argument order, and number of distinct points made.
- Approximate text length (±10%). Do not summarize, shorten, or expand with new content.

REWRITE, aggressively, at the sentence level:
- Change sentence structure: reorder clauses, switch active ↔ passive voice, split one long sentence into two shorter ones or merge two short ones into one.
- Replace connecting words and transitions with different ones of the same function.
- Replace non-technical, non-term words with different phrasing (not just single-word synonym swaps — restructure the phrase around the word).
- Change the opening words of sentences and paragraphs so they don't start the same way as the original.
- Never leave a run of 5 or more consecutive words identical to the source text, except inside citation markers, table content, or terminology that cannot be reworded without changing meaning.

FORBIDDEN:
- Do not add commentary, notes, or explanations of what you changed. Output only the rewritten text.
- Do not add or remove citation markers, tables, or factual content.
- Do not use em dash "—" or semicolons, consistent with the rest of this document's style.`;
}

// ── Системні промпти для JSON-задач ──
export const SYS_JSON = "Respond only with valid JSON. No markdown, no explanation.";
export const SYS_JSON_SHORT = "Respond only with valid JSON. No markdown.";
export const SYS_JSON_ARRAY = "Respond only with valid JSON array. No markdown.";

// ── Промпт крок 1: тільки структура (chain-of-thought) ──
export const STRUCTURE_READING_PROMPT = `Уважно прочитай методичку. Знайди опис структури студентської роботи.

КРОК 1 — знайди початок опису розділів:
Шукай слова: "Перший розділ", "Перша частина", "Розділ 1", "Основна частина містить", "робота складається з".

КРОК 2 — знайди кінець опису розділів:
Читай далі поки не зустрінеш будь-який з цих маркерів кінця:
- "Висновки" (як окремий розділ)
- "Список використаних джерел" / "Список літератури"
- "Загальні вимоги до оформлення" / "Оформлення роботи"
- "Правила оформлення"
- Будь-який новий великий розділ методички що НЕ є описом розділів студентської роботи
Якщо жоден маркер не знайдено — читай тільки параграфи де є слова "підрозділ", "розділ" або нумерація виду 1.1, 2.3.

КРОК 3 — у знайденому діапазоні для КОЖНОГО розділу окремо порахуй підрозділи:
Підрозділи позначаються: "перший підрозділ", "другий підрозділ", "третій підрозділ", "четвертий підрозділ" АБО нумерацією 1.1, 1.2, 2.1, 2.3 тощо.

Поверни ТІЛЬКИ JSON (без markdown):
{
  "totalPages": 30,
  "introPages": null,
  "conclusionsPages": null,
  "chaptersCount": 2,
  "subsectionsPerChapter": 3,
  "subsectionsPerChapterOverrides": null,
  "hasChapterConclusions": false,
  "chapterTypes": ["theory","analysis"]
}

Правила:
- totalPages: загальний обсяг роботи в сторінках (без додатків і списку джерел)
- introPages: обсяг вступу в сторінках. null якщо не вказано явно
- conclusionsPages: обсяг висновків в сторінках. null якщо не вказано явно
- chaptersCount: к-сть основних розділів. null якщо не вказано явно
- subsectionsPerChapter: к-сть підрозділів на розділ — ТІЛЬКИ якщо у методичці явно вказане конкретне число (наприклад "3 підрозділи", "два підрозділи", "чотири підрозділи"). Розмиті слова "декілька", "кілька", "ряд підрозділів" — НЕ вважаються явною вказівкою, повертай null. null також якщо к-сть взагалі не згадана
- subsectionsPerChapterOverrides: якщо розділи мають РІЗНУ явно вказану к-сть підрозділів — об'єкт де ключ це номер розділу рядком, значення — к-сть. Тільки ті розділи що відрізняються від subsectionsPerChapter. Приклад: розділ 1 має 2 підрозділи, розділ 2 має 4 — subsectionsPerChapter=2, subsectionsPerChapterOverrides={"2":4}. null якщо всі однакові або к-сть не вказана явно
- hasChapterConclusions: true якщо методичка вимагає висновків наприкінці кожного розділу. Сюди відносяться будь-які формулювання: "висновки до розділу", "розділ завершується висновками", "у кінці кожного розділу", "наприкінці кожного розділу", "автор формулює висновки", "короткі висновки та підсумки", "підсумки розділу", "стислі висновки розділу", "висновки по розділу" або будь-яке інше формулювання що вказує на обов'язкові підсумки в кінці кожного розділу
- chapterTypes: масив довжиною chaptersCount. "theory" — теоретичний, "analysis" — практичний/емпіричний, "recommendations" — рекомендаційний/розробка`;

// ── Промпт крок 2: повне читання методички з попередньо визначеною структурою ──
export function buildMethodologyReadingPrompt(structureInfo) {
  const s = structureInfo || {};
  const chapCount = s.chaptersCount ?? 2;
  const subsPerChap = s.subsectionsPerChapter ?? 2;
  const chTypes = s.chapterTypes?.length ? s.chapterTypes : ["theory", "analysis"].slice(0, chapCount);

  const structureLock = structureInfo
    ? `СТРУКТУРА РОБОТИ ВИЗНАЧЕНА НА ПОПЕРЕДНЬОМУ КРОЦІ — ВИКОРИСТАЙ ЦІ ЗНАЧЕННЯ ТОЧНО, НЕ ЗМІНЮЙ:
chaptersCount: ${s.chaptersCount ?? 'null'}
subsectionsPerChapter: ${s.subsectionsPerChapter ?? 'null'}
subsectionsPerChapterOverrides: ${s.subsectionsPerChapterOverrides ? JSON.stringify(s.subsectionsPerChapterOverrides) : 'null'}
hasChapterConclusions: ${s.hasChapterConclusions}
chapterTypes: ${JSON.stringify(chTypes)}
totalPages: ${s.totalPages ?? 'null'}
introPages: ${s.introPages ?? 'null'}
conclusionsPages: ${s.conclusionsPages ?? 'null'}

`
    : '';

  return `${structureLock}Уважно прочитай методичку і витягни оформлювальну та вимогову інформацію (форматування, джерела, зміст розділів, титульна сторінка тощо).

Поверни ТІЛЬКИ JSON (без markdown, без коментарів):
{
  "totalPages": ${s.totalPages ?? 30},
  "introPages": ${s.introPages ?? 'null'},
  "conclusionsPages": ${s.conclusionsPages ?? 'null'},
  "chaptersCount": ${s.chaptersCount ?? 2},
  "subsectionsPerChapter": ${s.subsectionsPerChapter ?? 2},
  "hasChapterConclusions": ${s.hasChapterConclusions ?? false},
  "chapterTypes": ${JSON.stringify(chTypes)},
  "exampleTOC": "ВСТУП\\nРОЗДІЛ 1. Назва\\n1.1 Підрозділ\\n1.2 Підрозділ\\nРОЗДІЛ 2. Назва\\n2.1 Підрозділ\\n2.2 Підрозділ\\nВИСНОВКИ\\nСПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ",
  "annotationExample": null,
  "introComponents": null,
  "theoryRequirements": "огляд літератури, теоретичні засади, закінчується висновком про необхідність дослідження",
  "analysisRequirements": "результати власних досліджень, лінгвістичне обґрунтування",
  "chapterConclusionRequirements": "коротка суть результатів, до 1 сторінки",
  "conclusionsRequirements": "пронумерований список конкретних результатів, без загальних формулювань",
  "sourcesMinCount": null,
  "sourcesStyle": "ДСТУ 8302:2015",
  "sourcesOrder": "alphabetical",
  "sourcesGrouping": "спочатку українські, потім англійські/польські/чеські, наприкінці східною мовою",
  "citationStyle": "(Автор, рік) або (Автор, рік, с. 25)",
  "sourcesFormatRules": "Джерела розміщуються в алфавітному порядку за прізвищем автора або назвою документа. Законодавчі та підзаконні акти подаються у хронологічному порядку. Бібліографічний опис складається відповідно до чинних стандартів.",
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
    "tableNumberRight": true,
    "tableTitleBold": true,
    "tableTitleCenter": true,
    "figureFormat": "Рис. 1.2 під ілюстрацією, нумерація в межах розділу",
    "noLongDash": true,
    "codeFont": "Courier New",
    "codeFontSize": 10,
    "codeLineSpacing": 1.0
  },
  "requiredSections": ["титульний аркуш", "зміст", "вступ", "основна частина", "висновки", "список використаних джерел"],
  "optionalSections": ["перелік умовних позначень", "анотація іноземною мовою", "додатки"],
  "otherRequirements": "виклад від першої особи множини (ми вважаємо) або безособові конструкції",
  "recommendedSources": "Список рекомендованих джерел з методички: конкретні автори, видання, підручники, журнали. null якщо не вказано",
  "titlePageTemplate": [{"text":"МІНІСТЕРСТВО ОСВІТИ І НАУКИ УКРАЇНИ","align":"center","bold":true,"spaceBefore":0},{"text":"Назва університету","align":"center","bold":true,"spaceBefore":0},{"text":"Кафедра назва","align":"center","bold":false,"spaceBefore":60},{"text":"","align":"center","bold":false,"spaceBefore":0},{"text":"КУРСОВА РОБОТА","align":"center","bold":true,"fontSize":16,"spaceBefore":200},{"text":"на тему:","align":"center","bold":false,"spaceBefore":0},{"text":"[ТЕМА]","align":"center","bold":true,"spaceBefore":0},{"text":"","align":"center","bold":false,"spaceBefore":0},{"text":"Виконав(ла): студент(ка) групи","align":"right","bold":false,"spaceBefore":200},{"text":"Прізвище Ім’я По-батькові","align":"right","bold":false,"spaceBefore":0},{"text":"","align":"center","bold":false,"spaceBefore":0},{"text":"Науковий керівник:","align":"right","bold":false,"spaceBefore":0},{"text":"Посада, ПІБ","align":"right","bold":false,"spaceBefore":0},{"text":"","align":"center","bold":false,"spaceBefore":0},{"text":"Місто – [РІК]","align":"center","bold":false,"spaceBefore":400}],
  "requiredTables": null,
  "requiredFormulas": null
}

Правила:
- totalPages: загальний обсяг роботи в сторінках (число, не рахуючи додатки і список джерел)
- introPages: обсяг вступу в сторінках (null якщо не вказано явно)
- conclusionsPages: обсяг висновків в сторінках (null якщо не вказано явно)
- chaptersCount, subsectionsPerChapter, hasChapterConclusions, chapterTypes, totalPages, introPages, conclusionsPages: ці поля ВЖЕ ВИЗНАЧЕНІ на попередньому кроці — використай значення з заголовку цього промпту БЕЗ ЗМІН
- introComponents: перевір які з наведених елементів явно згадані у тексті методички у розділі про вступ. Поверни ТІЛЬКИ ті що реально є — у вигляді масиву їх канонічних назв. Якщо елемент не згадано — не включай. Якщо методичка взагалі не описує структуру вступу — поверни null. НЕ копіюй приклад JSON. Список елементів для перевірки (канонічна назва → можливі варіанти у тексті):
  * "актуальність теми" → "актуальність теми", "актуальність проблеми", "актуальність дослідження", "актуальність"
  * "мета дослідження" → "мета дослідження", "мета роботи", "мета курсової"
  * "завдання дослідження" → "завдання дослідження", "завдання роботи", "основні завдання"
  * "об'єкт дослідження" → "об'єкт дослідження", "об'єкт роботи", "об'єкт"
  * "предмет дослідження" → "предмет дослідження", "предмет роботи", "предмет"
  * "методи дослідження" → "методи дослідження", "методи роботи", "методи", "методологія"
  * "практичне значення дослідження" → "практичне значення дослідження", "практичне значення", "практична значущість", "практична цінність", "практичне значення результатів"
  * "наукова новизна" → "наукова новизна", "наукова новизна дослідження", "наукова новизна роботи"
  * "структура роботи" → "структура роботи", "структура дослідження", "структура курсової"
  * "теоретико-методологічна основа" → "теоретична основа", "методологічна основа", "теоретико-методологічна основа", "теоретичні засади"
  * "матеріал дослідження" → "матеріал дослідження", "база дослідження", "емпірична база", "вибірка"
  * "апробація результатів" → "апробація", "апробація результатів", "апробація результатів дослідження"
  * "гіпотеза дослідження" → "гіпотеза", "гіпотеза дослідження", "робоча гіпотеза"
- sourcesStyle: "APA", "ДСТУ 8302:2015", "MLA" або інший — точно як у методичці. null якщо стиль явно не вказано (НЕ вигадуй і НЕ припускай)
- sourcesOrder: "alphabetical" або "citation_order"
- sourcesGrouping: якщо є правила групування джерел за мовами — вкажи
- citationStyle: як оформляти посилання в тексті (в дужках, у виносках тощо)
- sourcesFormatRules: якщо в методичці є конкретні вимоги до оформлення/порядку списку джерел (порядок розміщення, особливості для нормативних актів, вимоги до бібліографічного опису тощо) — скопіюй їх точно одним рядком. null якщо таких вимог немає окрім стилю
- recommendedSources: якщо в методичці є список рекомендованої літератури або конкретні автори/видання для використання — перелічи їх одним рядком через крапку з комою. null якщо таких рекомендацій немає
- titlePageTemplate: якщо в методичці є зразок титульної сторінки — відтвори її структуру як масив JSON-об’єктів з полями: "text" (рядок тексту), "align" ("center"|"left"|"right"), "bold" (true/false — визнач за зразком: назви міністерства/університету/тип роботи/назва теми зазвичай жирні), "fontSize" (розмір у pt — вкажи лише якщо рядок явно більший/менший за основний текст 14pt; найчастіше null), "spaceBefore" (відступ перед рядком у twips: 0 для щільних блоків, 200-240 для відступу між блоками, 400+ для великого відступу). Порожній рядок між блоками — {"text":"","align":"center","bold":false,"spaceBefore":0}. Де має бути тема роботи (будь-який плейсхолдер: "(найменування теми)", "(назва теми)", "______" тощо) — ОБОВ’ЯЗКОВО заміни на [ТЕМА]. Де має бути рік — ОБОВ’ЯЗКОВО заміни на [РІК] (НЕ пиши конкретний рік і НЕ розбивай рік на кілька рядків). Рядок "Місто – рік" або "Місто, рік" ЗАВЖДИ має бути ОДНИМ рядком: {"text":"Київ – [РІК]","align":"center","bold":false,"spaceBefore":400}. Вирівнювання визнач за зразком: типово центр, але блоки "Виконав", "Науковий керівник", "Допущено" тощо — right або left залежно від зразка. Якщо зразка немає — поверни null (НЕ вигадуй)
- formatting: всі деталі оформлення — шрифт, розміри, поля, відступи, нумерація. Поля tableNumberRight/tableTitleBold/tableTitleCenter: true якщо методичка вимагає номер таблиці справа, назву жирним, назву по центру відповідно — інакше false
- formatting.codeFont/codeFontSize/codeLineSpacing: вимоги до оформлення лістингів програмного коду (шрифт, розмір, інтервал). Якщо методичка явно вказує інші значення — використай їх; якщо не вказано — залиш дефолт "Courier New" / 10 / 1.0
- exampleTOC: ДРУГОРЯДНЕ поле. Шукай ТІЛЬКИ в Додатках розділ зі словами "зразок змісту", "зразок оформлення змісту", "приклад змісту" — це лише приклад оформлення. КАТЕГОРИЧНО ІГНОРУЙ: (1) "ЗМІСТ" на початку методички; (2) пункти виду "1. Загальні вимоги...", "2. Оформлення..." — це розділи методички. Якщо знайшов справжній зразок (містить ВСТУП, РОЗДІЛ 1, 1.1, ВИСНОВКИ) — скопіюй рядки. Якщо не знайшов — поверни null
- annotationExample: шукай в методичці (в т.ч. в Додатках) зразок або вимоги до розділу-анотації — В ДЕЯКИХ МЕТОДИЧКАХ ЦЕЙ РОЗДІЛ НАЗИВАЄТЬСЯ "РЕФЕРАТ" замість "АНОТАЦІЯ" (це та сама сторінка перед змістом з коротким викладом суті роботи, обсягом, ключовими словами — НЕ окремий вид роботи). Шукай ОБИДВА варіанти: слова "зразок анотації"/"зразок реферату", "приклад анотації"/"приклад реферату", "анотація повинна містити"/"реферат повинен містити", "структура анотації"/"структура реферату", а також будь-який розділ методички що починається зі слова "РЕФЕРАТ" і описує/ілюструє обсяг роботи, кількість джерел/додатків, ключові слова. Якщо знайшов — скопіюй текст зразка або опис вимог до його структури одним блоком, ОБОВ'ЯЗКОВО зберігаючи оригінальний заголовок розділу як він є в методичці ("АНОТАЦІЯ" або "РЕФЕРАТ") та переноси рядків через \\n. Якщо методичка взагалі не згадує ні анотацію, ні реферат у цьому значенні — поверни null
- requiredTables: шукай таблиці які СТУДЕНТ МАЄ ЗАПОВНИТИ у своїй роботі (не таблиці всередині самої методички з критеріями/шкалами). Якщо знайшов — поверни масив об’єктів: [{"name":"назва таблиці","structure":"markdown рядок заголовків таблиці з плейсхолдерами наприклад |Показник|Рік 1|Рік 2|","section":"analysis або recommendations — в якому типі розділу має з’явитись","instructions":"що саме заповнювати в цю таблицю"}]. null якщо таких таблиць немає.
- requiredFormulas: шукай формули/розрахунки які студент має виконати у роботі. Поверни масив: [{"name":"назва показника","formula":"формула у вигляді plain text, наприклад β = Σ(kij × pi) / (m × n)","variables":"опис кожної змінної через крапку з комою","interpretation":"шкала інтерпретації результату якщо є в методичці","section":"analysis або recommendations"}]. null якщо формул немає.`;
}

// ── Промпт для генерації анотації (укр + англ) для магістерських/бакалаврських робіт ──
export function buildAnnotationPrompt(info, methodInfo, statsText, introText, conclusionsText) {
  const exampleBlock = methodInfo?.annotationExample
    ? `ЗРАЗОК/ВИМОГИ ДО АНОТАЦІЇ З МЕТОДИЧКИ (відтвори структуру, порядок блоків і стиль формулювань зразка, але з власним змістом цієї роботи; якщо зразок називає цей розділ "РЕФЕРАТ" — використай саме цей заголовок українською, а не "АНОТАЦІЯ"):\n${methodInfo.annotationExample}\n\n`
    : `СТАНДАРТНА СТРУКТУРА (методичка не містить зразка анотації — використай цей формат):
АНОТАЦІЯ

Тема роботи: «[тема]»

Кваліфікаційна робота на здобуття освітнього ступеня [магістра/бакалавра] за спеціальністю «[спеціальність]».

[Робота складається зі вступу, N розділів, висновків, списку використаних джерел (M найменувань)[, K додатків]. Загальний обсяг роботи – P сторінок.] — встав ці факти без змін

[Короткий виклад суті роботи: актуальність теми, мета й завдання дослідження, використані методи, основні результати — 100-150 слів]

Ключові слова: [5-8 термінів через кому].

`;

  return `Напиши анотацію до кваліфікаційної роботи на тему «${info?.topic || ""}» (${info?.type || "кваліфікаційна робота"}) — ДВОМА МОВАМИ: українською та англійською.

${exampleBlock}ФАКТИ ДЛЯ ВСТАВКИ (цифри й факти бери ТІЛЬКИ звідси, нічого не вигадуй і не змінюй):
${statsText}

ВСТУП РОБОТИ (для розуміння суті дослідження):
${(introText || "").slice(0, 3000)}

ВИСНОВКИ РОБОТИ (для розуміння результатів):
${(conclusionsText || "").slice(0, 3000)}

Поверни ТІЛЬКИ JSON (без markdown):
{"uk": "повний текст анотації українською, включно з заголовком (АНОТАЦІЯ або РЕФЕРАТ — залежно від зразка методички), фактами і ключовими словами, як суцільний текст з переносами рядків через \\n", "en": "full English ABSTRACT text (heading ABSTRACT — завжди ABSTRACT, незалежно від того чи укр. заголовок АНОТАЦІЯ чи РЕФЕРАТ), mirroring the same structure, facts translated, English keywords, as plain text with \\n line breaks"}

Правила:
- Текст анотації — суцільний, без markdown-розмітки (без **, без #, без списків).
- Виклад суті роботи: 100-150 слів, по суті, без води і загальних фраз.
- Ключові слова: 5-8 термінів з теми роботи.
- Англійська версія — природна академічна англійська, не дослівний переклад українського тексту. Заголовок англійської версії — завжди "ABSTRACT".
- НЕ вигадуй назву закладу освіти, ПІБ студента чи керівника — їх в анотації не вказуй.
- Тире (будь-які: коротке, довге, "—") — СУВОРО ЗАБОРОНЕНІ. Замінюй комою або перебудовуй речення.
- Кома: максимум 1 на речення. Крапка з комою — заборонена.`;
}

// ── Точкове редагування вже згенерованої анотації за коментарем користувача ──
export function buildAnnotationRegenPrompt(currentUk, currentEn, comment) {
  return `Ось поточний варіант анотації до кваліфікаційної роботи (двома мовами).

АНОТАЦІЯ (УКР):
${currentUk}

ABSTRACT (ENG):
${currentEn}

КОМЕНТАР/ВИМОГИ ДО ПРАВОК: ${comment}

Перепиши анотацію відповідно до коментаря, зберігаючи структуру (заголовок, факти про роботу, виклад суті, ключові слова) і узгодженість між мовами. Те, чого коментар не стосується, залиш по суті без змін.

Тире (будь-які: коротке, довге, "—") — СУВОРО ЗАБОРОНЕНІ, замінюй комою або перебудовуй речення. Кома: максимум 1 на речення. Крапка з комою — заборонена.

Поверни ТІЛЬКИ JSON (без markdown):
{"uk": "повний оновлений текст анотації українською з переносами рядків через \\n", "en": "full updated English ABSTRACT text with \\n line breaks"}`;
}

// ── Промпт для аналізу шаблону замовлення ──
export function buildTemplateAnalysisPrompt(tplText, comment) {
  return `Проаналізуй шаблон замовлення.\n\nШАБЛОН:\n${tplText}\n${comment ? "\nКОМЕНТАР: " + comment : ""}\n\nПоверни ТІЛЬКИ JSON (без markdown):\n{"type":"","pages":"","topic":"","subject":"","direction":"","uniqueness":"","language":"Українська","deadline":"","orderNumber":"","extras":"","methodNotes":"","sourceCount":"30-40","course":null}\n\nПравила:\n- course: номер курсу (1, 2, 3, 4) якщо вказано в шаблоні (поле "курс"). null якщо не вказано або тип роботи не курсова.`;
}

// ── Промпт для аналізу коментаря клієнта ──
export function buildCommentAnalysisPrompt({ topic, comment, photoCount }) {
  const hasPhotos = photoCount > 0;
  return `Проаналізуй${hasPhotos ? " фото та" : ""} коментар клієнта до академічної роботи на тему "${topic || ""}". Витягни конкретні підказки для виконавця.${comment?.trim() ? `\nКОМЕНТАР КЛІЄНТА:\n${comment}` : ""}${hasPhotos ? `\n\nФОТО: ${photoCount} зображень.` : ""}

Поверни ТІЛЬКИ JSON (без markdown):
{"planHints":"підказки для СТРУКТУРИ ПЛАНУ: к-сть розділів, назви розділів, висновки до розділів тощо. null якщо немає","textStructureHints":"підказки для СТРУКТУРИ ТЕКСТУ: що має бути у вступі чи висновках, вимоги до обсягів розділів у сторінках, особливі акценти. null якщо немає","writingHints":"підказки для СТИЛЮ ТА ЗМІСТУ написання: термінологія, підходи, що підкреслити, на що звернути увагу. null якщо немає","sourcesHints":"підказки для ДЖЕРЕЛ ТА ОФОРМЛЕННЯ: к-сть джерел, мова джерел, стиль цитування, конкретні автори або видання. null якщо немає","researchDesign":"ВАЖЛИВО: якщо в коментарі є будь-які ознаки емпіричного дослідження (анкетування, опитування, тестування, методика, вибірка, групи учасників, порівняння груп) — ОБОВ’ЯЗКОВО заміни цей рядок на JSON-обʼєкт (не рядок): {\"instrumentType\":\"questionnaire або psycho_scale або fitness_test або pedagogical_experiment або mixed\",\"groups\":[{\"name\":\"назва групи\",\"minN\":30,\"criteria\":\"критерії або null\"}],\"biographicalFields\":[\"ПІБ\",\"вік\",\"стаж\"],\"comparisonRequired\":true,\"statisticalMinN\":30}. instrumentType: questionnaire — анкета/опитування, psycho_scale — психологічна методика/шкала, fitness_test — фізичні тести/нормативи, pedagogical_experiment — педагогічний експеримент, mixed — кілька методів. groups — масив груп з кількістю та критеріями. biographicalFields — поля біографічного блоку якщо згадані. Якщо ознак дослідження немає — null","practicalApproach":"визнач тип практичної частини для педагогічних та гуманітарних робіт ТІЛЬКИ з теми роботи: questionnaire (тема вказує на анкетування, опитування, ставлення або мотивацію учасників), textbook_analysis (тема вказує на аналіз підручників або навчальних посібників), lesson_observation (тема вказує на аналіз або спостереження уроків, методику проведення уроків), materials_development (тема вказує на розробку вправ, план-конспект, дидактичні матеріали або систему завдань). null якщо тип не визначається або якщо тема не педагогічна","practicalApproachDetails":"якщо визначено practicalApproach: для textbook_analysis — які підручники і за якими критеріями якщо зазначено; для lesson_observation — скільки уроків і який клас якщо зазначено; для materials_development — що саме розробляється і для якого класу якщо зазначено. null якщо немає деталей або practicalApproach є questionnaire або null","photoTOC":"якщо на фото є готовий план/зміст роботи (рядки виду Chapter 1 / Розділ 1, 1.1, 1.2, Introduction тощо) — скопіюй його текст дослівно. Якщо плану на фото немає — null","formattingHints":{"margins":{"left":"ліве поле мм або null","right":"праве поле мм або null","top":"верхнє поле мм або null","bottom":"нижнє поле мм або null"}}}`;
}

// ── Промпт для опису ілюстрацій клієнта ──
export function buildIllustrationsPrompt({ topic, illustrations, planSections = [], lang = "Українська" }) {
  const captionLines = illustrations.map((ill, i) =>
    `Рис. ${i + 1}: ${ill.caption?.trim() || "(без підпису)"}`
  ).join("\n");
  const sectionsBlock = planSections.length
    ? `\nПЛАН РОБОТИ (підрозділи):\n${planSections.map(s => `${s.id}: ${s.label}`).join("\n")}\n`
    : "";
  return `Ти аналізуєш ілюстрації для академічної роботи на тему "${topic || ""}".

ІЛЮСТРАЦІЇ (${illustrations.length} шт.):
${captionLines}
${sectionsBlock}
ЗАВДАННЯ: для кожної ілюстрації:
1. Напиши академічний опис (2-3 речення, мова: ${lang}) — що зображено, яка наукова цінність для роботи
2. Визнач id підрозділу плану куди найбільше підходить (напр. "1.2" або "2.3"). Якщо плану немає — вкажи номер глави (напр. "2")

Поверни ТІЛЬКИ JSON масив (без markdown):
[{"figureNum":1,"description":"...","suggestedSection":"1.2"}, ...]`;
}

// ── Промпт для опису ілюстрацій із PDF ──
export function buildIllustrationsPdfPrompt({ topic, planSections = [], lang = "Українська" }) {
  const sectionsBlock = planSections.length
    ? `\nПЛАН РОБОТИ (підрозділи):\n${planSections.map(s => `${s.id}: ${s.label}`).join("\n")}\n`
    : "";
  return `Ти аналізуєш PDF-документ із ілюстраціями для академічної роботи на тему "${topic || ""}".
${sectionsBlock}
ЗАВДАННЯ: знайди всі ілюстрації (графіки, схеми, діаграми, таблиці, фото, рисунки). Для кожної:
1. Присвій порядковий номер figureNum (1, 2, 3...)
2. Напиши академічний опис (2–3 речення, мова: ${lang}) — що зображено, яка наукова цінність для роботи
3. Витягни підпис якщо він є у документі, або null
4. Визнач id підрозділу плану куди найбільше підходить (напр. "1.2" або "2.3"). Якщо плану немає — вкажи номер глави (напр. "2")

Поверни ТІЛЬКИ JSON масив (без markdown):
[{"figureNum":1,"description":"...","caption":"підпис або null","suggestedSection":"1.2"}, ...]`;
}

// ── Промпт для аналізу матеріалів клієнта ──
export function buildClientMaterialsAnalysisPrompt({ topic, materialsText }) {
  return `Ти аналізуєш матеріали клієнта для академічної роботи на тему "${topic || ""}".
Нижче — текст документів або дані дослідження, надані клієнтом.

МАТЕРІАЛИ КЛІЄНТА:
${materialsText}

Твоє завдання — структурувати ці матеріали так, щоб виконавець міг точно використати їх при написанні кожного розділу.
ВАЖЛИВО: всі числа, відсотки, дати, назви, власні імена — зберігай ДОСЛІВНО, без округлення і переформулювання.

Поверни ТІЛЬКИ JSON (без markdown):
{"rawText":"повний текст матеріалів клієнта — скопіюй дослівно, до 20000 символів. Якщо довший — скопіюй найважливіші частини зберігаючи всі цифри і таблиці","keyFacts":["конкретний факт або цифра 1 — дослівно","конкретний факт або цифра 2 — дослівно"],"tablesMd":"якщо є таблиці з даними — відтвори їх точно у markdown (| col | col |). null якщо таблиць немає","sectionHints":"загальна підказка: для яких розділів роботи ці матеріали найбільш корисні (1-2 речення). null якщо незрозуміло"}`;
}

// ── Промпт для аналізу правок від викладача ──
export function buildCorrectionsAnalysisPrompt({ topic, subject, direction, sections, correctionsText }) {
  const sectionsList = sections
    .filter(s => !["sources"].includes(s.type))
    .map(s => `- id: "${s.id}", назва: "${s.label}"`)
    .join("\n");

  return `Ти аналізуєш зауваження викладача до академічної роботи.

ТЕМА РОБОТИ: "${topic || ""}"
НАПРЯМ: "${direction || ""}", ПРЕДМЕТ: "${subject || ""}"

РОЗДІЛИ РОБОТИ:
${sectionsList}

ЗАУВАЖЕННЯ ВИКЛАДАЧА:
${correctionsText}

Визнач які розділи потребують виправлення на основі зауважень.
Поверни ТІЛЬКИ JSON масив (без markdown):
[{"sectionId":"id розділу","issue":"коротко що саме не так (1-2 речення)","suggestion":"конкретно що треба зробити для виправлення (1-2 речення)"}]

Якщо зауваження стосується всієї роботи і не прив’язане до конкретного розділу — віднеси його до найбільш відповідного розділу. Повертай ТІЛЬКИ ті розділи що реально потребують змін.`;
}

// ── Промпт для виправлення одного розділу за правками ──
export function buildCorrectionRewritePrompt({ section, originalText, issue, suggestion, info, methodInfo, lang }) {
  const isEnglish = /англ|english/i.test(lang || "");
  const langLine = isEnglish
    ? "Write ONLY in English."
    : `Мова відповіді: ТІЛЬКИ ${lang || "українська"}.`;

  const methodContext = methodInfo
    ? `\nВИМОГИ МЕТОДИЧКИ: ${[methodInfo.theoryRequirements, methodInfo.analysisRequirements, methodInfo.otherRequirements].filter(Boolean).join(". ")}`
    : "";

  return `${langLine}
Ти виправляєш розділ академічної роботи відповідно до зауважень викладача.

ТЕМА РОБОТИ: "${info?.topic || ""}"
НАПРЯМ: "${info?.direction || ""}", ПРЕДМЕТ: "${info?.subject || ""}", ТИП: "${info?.type || ""}"${methodContext}

РОЗДІЛ: "${section.label}"

ОРИГІНАЛЬНИЙ ТЕКСТ РОЗДІЛУ:
${originalText}

ЗАУВАЖЕННЯ ВИКЛАДАЧА ДО ЦЬОГО РОЗДІЛУ:
Проблема: ${issue}
Що виправити: ${suggestion}

ВАЖЛИВО:
- Тема, напрям і загальний зміст роботи НЕ змінюються — тільки виправляй зазначені проблеми
- Збережи структуру та обсяг розділу
- Виправ конкретно те про що написано в зауваженні
- Поверни ТІЛЬКИ текст розділу без жодних пояснень`;
}

// ── Розбивка завантаженого файлу по розділах замовлення ──
export function buildFileToSectionsPrompt({ sections, documentText }) {
  const sectionsList = sections
    .filter(s => s.type !== "sources")
    .map(s => `- id: "${s.id}", назва: "${s.label}"`)
    .join("\n");

  return `Розбий текст академічної роботи по розділах відповідно до структури.

СТРУКТУРА РОБОТИ:
${sectionsList}

ПОВНИЙ ТЕКСТ РОБОТИ:
${documentText}

Визнач до якого розділу належить кожен фрагмент тексту.
Поверни результат у ТАКОМУ текстовому форматі (без JSON, без markdown-блоків) — для кожного id зі структури вище, в тому самому порядку:

@@@SECTION id="1.1"@@@
повний текст цього розділу, без скорочень і без змін
@@@END@@@

Правила:
- Кожен id з переліку вище повинен утворювати рівно один такий блок
- Якщо розділу немає в тексті — залиш блок порожнім (нічого між SECTION і END)
- Включай ВЕСЬ текст розділу без скорочень
- Не додавай нічого поза цими блоками (жодних пояснень, заголовків, markdown)`;
}

// ── Вигадати назви розділів/підрозділів, яких БРАКУЄ в готовій частині роботи клієнта (продовження) ──
export function buildContinuationPlanPrompt({ topic, subject, type, lang, existingChapterTitles, newChapters, otherRequirements }) {
  const chaptersBlock = newChapters
    .map(c => `Розділ ${c.num}: рівно ${c.subsCount} підрозділ(и/ів)${c.forcedType ? `, тип "${c.forcedType}" (обов'язково саме такий, не змінюй)` : ""}`)
    .join("\n");
  return `Для ${type} на тему "${topic}" (галузь: ${subject}) вже написано розділ(и): ${existingChapterTitles.join("; ") || "немає"}.
Придумай назви для розділів-ПРОДОВЖЕННЯ, яких ще бракує, логічно продовжуючи тему й не повторюючи вже написане.
Мова роботи: ${lang || "Українська"} — усі назви цією мовою.
${otherRequirements ? `\nВИМОГИ МЕТОДИЧКИ (обов'язково врахувати): ${otherRequirements}\n` : ""}
ПОТРІБНО СТВОРИТИ:
${chaptersBlock}

Поверни ТІЛЬКИ JSON без markdown:
{"chapters":[{"num":2,"title":"РОЗДІЛ 2. НАЗВА","type":"analysis","subsections":["2.1 Назва підрозділу","2.2 Назва підрозділу"]}]}

Правила:
- type: "theory" (теоретичний), "analysis" (аналітичний/практичний) або "recommendations" (рекомендаційний) — якщо вище вказано обов'язковий тип для розділу, постав саме його
- Кількість підрозділів у кожному розділі — точно як вказано вище
- Назви підрозділів мають починатися з номера (наприклад "2.1 ...")`;
}

// ── Витягнути РЕАЛЬНУ структуру (заголовки розділів/підрозділів) з готової частини роботи клієнта, а не вигадувати нову ──
export function buildExtractStructurePrompt({ documentText }) {
  return `Розбий наданий текст академічної роботи на розділи й підрозділи ЗА ЗАГОЛОВКАМИ, ЯКІ РЕАЛЬНО Є В ЦЬОМУ ТЕКСТІ. Не вигадуй нову структуру і не перейменовуй заголовки — використовуй їх точно так, як написано в тексті.

ТЕКСТ РОБОТИ:
${documentText}

Поверни результат у ТАКОМУ текстовому форматі (без JSON, без markdown-блоків) — один блок на кожен знайдений розділ або підрозділ, у тому порядку, в якому вони йдуть у тексті:

@@@SECTION id="1.1" title="1.1 Точна назва підрозділу з тексту" chapterTitle="РОЗДІЛ 1. ТОЧНА НАЗВА РОЗДІЛУ З ТЕКСТУ" type="theory"@@@
повний текст цього підрозділу (без самого заголовка), з уніфікованими [N] замість цитувань, без скорочень
@@@SOURCES@@@
Джерело 1 — повний бібліографічний опис
@@@END@@@

Правила визначення id і типу:
- Підрозділи нумеруй за їх реальними номерами з тексту (1.1, 1.2, 2.1 тощо). Якщо в тексті вони не пронумеровані явно — нумеруй послідовно в межах розділу, до якого вони належать
- Вступ: id="intro", title="Вступ" (або відповідник мовою тексту), type="intro"
- Загальні висновки роботи (в самому кінці, не до окремого розділу): id="conclusions", type="conclusions"
- Проміжні висновки до розділу N (якщо є в кінці розділу): id="N.conclusions", type="chapter_conclusion"
- Список використаних джерел у кінці документа: id="sources", type="sources" — увесь список постав як текст цього блоку, SOURCES залиш порожнім
- type підрозділів основної частини: "theory" (теоретичний), "analysis" (аналітичний/практичний) або "recommendations" (рекомендаційний) — за змістом
- chapterTitle однаковий для всіх підрозділів одного розділу — точна назва розділу з тексту, включно з "РОЗДІЛ N." якщо так написано
- Якщо в розділі немає підрозділів з окремими заголовками, а є суцільний текст — постав title як стислу назву (2-6 слів) за змістом цього фрагмента

Правила по джерелах (тільки для підрозділів, не для блоку "sources"):
- Знайди джерела, на які посилається текст (у будь-якому форматі), у порядку появи в тексті підрозділу. Знайди повний бібліографічний опис у списку літератури в кінці документа, якщо він є
- Перепиши позначки цитувань у тексті в уніфікований формат [N], де N — порядковий номер джерела в SOURCES цього підрозділу (перше за появою — [1] і т.д., повторні цитування того самого джерела — той самий номер). Решту тексту НЕ змінюй
- Якщо в підрозділі немає цитувань — залиш SOURCES порожнім
- Не вигадуй джерела, яких немає в тексті чи списку літератури

Включай ВЕСЬ текст кожного підрозділу без скорочень. Не додавай нічого поза цими блоками (без пояснень, без markdown).`;
}

// ── Аналіз правок для власного файлу (повний текст документа) ──
export function buildFileCorrectionsAnalysisPrompt({ documentText, correctionsText }) {
  return `Ти аналізуєш зауваження викладача до академічної роботи.

ТЕКСТ РОБОТИ:
${documentText}

ЗАУВАЖЕННЯ ВИКЛАДАЧА:
${correctionsText}

На основі зауважень визнач конкретні завдання для виправлення.
Поверни ТІЛЬКИ JSON масив (без markdown):
[{"id":"task_1","location":"назва частини/розділу де проблема","issue":"коротко що не так (1-2 речення)","suggestion":"конкретно що треба зробити (1-2 речення)"}]

Правила:
- Кожне зауваження = окремий елемент масиву
- location: назва розділу, «Вступ», «Висновки», «Список літератури» або «Весь текст»
- Якщо зауваження загальне — розбий на конкретні підзавдання
- Повертай ТІЛЬКИ JSON`;
}

// ── Виправлення виділеного або прокоментованого фрагменту (Варіант А) ──
export function buildAnnotationCorrectionPrompt({ documentText, annotatedText, context, instruction }) {
  const instrLine = instruction
    ? `ІНСТРУКЦІЯ: ${instruction}`
    : "ІНСТРУКЦІЯ: Виправте або перепишіть виділений фрагмент, зберігаючи стиль і мову оригіналу.";

  return `Ти виправляєш фрагмент академічної роботи.

ПОВНИЙ ТЕКСТ РОБОТИ:
${documentText}

ФРАГМЕНТ ЩО ПОТРЕБУЄ ВИПРАВЛЕННЯ: "${annotatedText}"
${context && context !== annotatedText ? `КОНТЕКСТ (абзац): "${context}"` : ""}
${instrLine}

Знайди цей фрагмент у тексті роботи і виправ його.

Поверни ТІЛЬКИ JSON (без markdown):
{"original":"точний фрагмент з тексту роботи який треба замінити (скопіюй дослівно)","replacement":"виправлений варіант цього фрагменту"}

Правила:
- "original" — дослівна цитата з документа, без змін
- "replacement" — виправлений варіант, зберігаючи стиль і мову оригіналу
- Якщо виділення підлягає видаленню — "replacement" пустий рядок
- НЕ повертай весь документ — тільки JSON з двома полями`;
}

// ── Промпти для звіту з практики ──

export function buildPracticePlanPrompt(info, methodInfo) {
  const { practiceText = "", practiceCategory = "economy", pages = 30, practiceGuidance } = info;
  const total = parseInt(pages) || 30;
  const main = total - 5;

  // Шаблони структури по категоріях
  const templates = {
    economy: [
      { id: "ch1", label: "1. ЗАГАЛЬНА ХАРАКТЕРИСТИКА ПІДПРИЄМСТВА", w: 0.18 },
      { id: "ch2", label: "2. АНАЛІЗ ОСНОВНИХ НАПРЯМІВ ДІЯЛЬНОСТІ ПІДПРИЄМСТВА", w: 0.18 },
      { id: "ch3", label: "3. ВИКОНАНІ ЗАВДАННЯ ПІД ЧАС ПРАКТИКИ", w: 0.28 },
      { id: "ch4", label: "4. ІНДИВІДУАЛЬНЕ ЗАВДАННЯ", w: 0.25 },
    ],
    pedagogy: [
      { id: "ch1", label: "1. ХАРАКТЕРИСТИКА НАВЧАЛЬНОГО ЗАКЛАДУ", w: 0.15 },
      { id: "ch2", label: "2. АНАЛІЗ НАВЧАЛЬНО-ВИХОВНОГО ПРОЦЕСУ", w: 0.20 },
      { id: "ch3", label: "3. ПРОВЕДЕНІ УРОКИ ТА ВИХОВНІ ЗАХОДИ", w: 0.28 },
      { id: "ch4", label: "4. ПОЗАКЛАСНА ТА ВИХОВНА РОБОТА", w: 0.15 },
      { id: "ch5", label: "5. ІНДИВІДУАЛЬНЕ ЗАВДАННЯ", w: 0.11 },
    ],
    law: [
      { id: "ch1", label: "1. ХАРАКТЕРИСТИКА УСТАНОВИ ТА ЇЇ ПРАВОВОГО СТАТУСУ", w: 0.18 },
      { id: "ch2", label: "2. АНАЛІЗ НОРМАТИВНО-ПРАВОВОЇ БАЗИ ДІЯЛЬНОСТІ УСТАНОВИ", w: 0.20 },
      { id: "ch3", label: "3. ПРАКТИЧНА ЮРИДИЧНА ДІЯЛЬНІСТЬ", w: 0.25 },
      { id: "ch4", label: "4. СКЛАДЕНІ ДОКУМЕНТИ ТА ПРАВОВІ ВИСНОВКИ", w: 0.15 },
      { id: "ch5", label: "5. ІНДИВІДУАЛЬНЕ ЗАВДАННЯ", w: 0.11 },
    ],
    it: [
      { id: "ch1", label: "1. ХАРАКТЕРИСТИКА ПІДПРИЄМСТВА ТА IT-ІНФРАСТРУКТУРИ", w: 0.15 },
      { id: "ch2", label: "2. АНАЛІЗ ТЕХНОЛОГІЧНОГО СТЕКУ ТА АРХІТЕКТУРИ", w: 0.18 },
      { id: "ch3", label: "3. ВИКОНАНІ ТЕХНІЧНІ ЗАВДАННЯ", w: 0.30 },
      { id: "ch4", label: "4. ІНДИВІДУАЛЬНЕ ЗАВДАННЯ", w: 0.26 },
    ],
    medicine: [
      { id: "ch1", label: "1. ХАРАКТЕРИСТИКА КЛІНІЧНОЇ БАЗИ ПРАКТИКИ", w: 0.15 },
      { id: "ch2", label: "2. ОРГАНІЗАЦІЯ ЛІКУВАЛЬНО-ПРОФІЛАКТИЧНОЇ РОБОТИ", w: 0.20 },
      { id: "ch3", label: "3. ВИКОНАНІ МАНІПУЛЯЦІЇ ТА КЛІНІЧНА ДІЯЛЬНІСТЬ", w: 0.30 },
      { id: "ch4", label: "4. ІНДИВІДУАЛЬНЕ ЗАВДАННЯ", w: 0.24 },
    ],
    psychology: [
      { id: "ch1", label: "1. ХАРАКТЕРИСТИКА БАЗИ ПРАКТИКИ ТА ПСИХОЛОГІЧНОЇ СЛУЖБИ", w: 0.15 },
      { id: "ch2", label: "2. АНАЛІЗ ПСИХОЛОГІЧНОГО СУПРОВОДУ В ОРГАНІЗАЦІЇ", w: 0.18 },
      { id: "ch3", label: "3. ПСИХОДІАГНОСТИЧНА РОБОТА (МЕТОДИКИ, РЕЗУЛЬТАТИ)", w: 0.28 },
      { id: "ch4", label: "4. КОРЕКЦІЙНА ТА КОНСУЛЬТАТИВНА ДІЯЛЬНІСТЬ", w: 0.18 },
      { id: "ch5", label: "5. ІНДИВІДУАЛЬНЕ ЗАВДАННЯ", w: 0.10 },
    ],
    other: [
      { id: "ch1", label: "1. ЗАГАЛЬНА ХАРАКТЕРИСТИКА БАЗИ ПРАКТИКИ", w: 0.18 },
      { id: "ch2", label: "2. АНАЛІЗ ОСНОВНОЇ ДІЯЛЬНОСТІ ОРГАНІЗАЦІЇ", w: 0.20 },
      { id: "ch3", label: "3. ВИКОНАНІ ЗАВДАННЯ ПІД ЧАС ПРАКТИКИ", w: 0.30 },
      { id: "ch4", label: "4. ІНДИВІДУАЛЬНЕ ЗАВДАННЯ", w: 0.21 },
    ],
  };

  const tmpl = templates[practiceCategory] || templates.other;
  const mainSecs = tmpl.map(s => ({ ...s, pages: Math.max(3, Math.round(main * s.w)) }));
  const usedPages = mainSecs.reduce((a, s) => a + s.pages, 0);
  const concl = Math.max(2, total - 2 - usedPages);

  const sectionsJson = [
    `  {"id":"intro","label":"ВСТУП","pages":2}`,
    ...mainSecs.map(s => `  {"id":"${s.id}","label":"${s.label}","pages":${s.pages}}`),
    `  {"id":"conclusions","label":"ВИСНОВКИ","pages":${concl}}`,
    `  {"id":"sources","label":"СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ","pages":0}`,
  ].join(",\n");

  const guidanceBlock = practiceGuidance
    ? `\n\nОРІЄНТИР ЗА НАПРЯМОМ ТА ВИДОМ ПРАКТИКИ:
Мета практики: ${practiceGuidance.purpose}
Що має містити основна частина звіту: ${practiceGuidance.reportContent}
Особливість: ${practiceGuidance.feature}`
    : "";

  // Якщо в методичці є власний зразок змісту з підрозділами (1.1, 1.2 ...) —
  // будуємо структуру за ним замість плоского шаблону по категорії.
  const toc = methodInfo?.exampleTOC || "";
  const hasSubsections = /^\s*\d+\.\d+/m.test(toc);

  if (hasSubsections) {
    return `Склади структуру звіту з практики за зразком плану з методички.
Загальний обсяг: ${total} сторінок.

ДАНІ ПРАКТИКИ:
${practiceText}
${guidanceBlock}

ЗРАЗОК ПЛАНУ З МЕТОДИЧКИ (відтвори ЦЮ структуру розділів і підрозділів — кількість, порядок і рівень вкладеності, адаптувавши лише назви під конкретне підприємство/установу та тип практики):
${toc}

Поверни ТІЛЬКИ JSON (без markdown):
{"sections":[
  {"id":"intro","label":"ВСТУП","pages":2},
  {"id":"1.1","label":"1.1 Назва підрозділу","sectionTitle":"РОЗДІЛ 1. Назва розділу","pages":5},
  {"id":"1.2","label":"1.2 Назва підрозділу","sectionTitle":"РОЗДІЛ 1. Назва розділу","pages":5},
  {"id":"2.1","label":"2.1 Назва підрозділу","sectionTitle":"РОЗДІЛ 2. Назва розділу","pages":6},
  {"id":"conclusions","label":"ВИСНОВКИ","pages":3},
  {"id":"sources","label":"СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ","pages":0}
]}

Правила:
- Кожен підрозділ зі зразка — окремий елемент масиву з id виду "N.M" (номер розділу.номер підрозділу за порядком у зразку)
- "sectionTitle" — повна назва розділу з номером (напр. "РОЗДІЛ 1. ХАРАКТЕРИСТИКА БАЗИ ПРАКТИКИ"), ОДНАКОВА для всіх підрозділів одного розділу
- "label" — номер і назва підрозділу (напр. "1.1 Загальна характеристика підприємства (бази практики)")
- Якщо якийсь розділ зі зразка не має підрозділів — додай один елемент з id рівним номеру розділу (напр. "3", без крапки) і без "sectionTitle"
- pages розподіли пропорційно між усіма підрозділами/розділами так, щоб їх сума дорівнювала ${main}
- intro: 2 стор., conclusions: залишок сторінок (мінімум 2)
- id "intro"/"conclusions"/"sources" залишати незмінними; для решти використовуй нумерацію зі зразка`;
  }

  return `Склади структуру звіту з практики.
Загальний обсяг: ${total} сторінок.

ДАНІ ПРАКТИКИ:
${practiceText}
${guidanceBlock}

Поверни ТІЛЬКИ JSON (без markdown):
{"sections":[
${sectionsJson}
]}

Адаптуй назви розділів до конкретного підприємства/установи та типу практики. id залишати незмінними.`;
}

export function buildPracticeWritingPrompt(sec, info, methodInfo, clientMaterialsSummary, citInputs) {
  const {
    practiceText = "", language = "Українська", practiceGuidance,
    companyName, supervisorCompany, supervisorUniversity, individualTask,
  } = info;

  const isIntro = sec.id === "intro";
  const isConclusions = sec.id === "conclusions";
  const isIndividualTask = /індивідуальн.*завданн/i.test(sec.label || "");

  const hint = isIntro
    ? "Вступ: мета та завдання практики, місце проходження, керівники. Обсяг не більше 2 сторінок."
    : isConclusions
    ? "Висновки: підсумки практики, що виконано, набуті компетентності, рекомендації."
    : "";

  const methodReq = methodInfo
    ? [methodInfo.theoryRequirements, methodInfo.analysisRequirements, methodInfo.otherRequirements].filter(Boolean).join(". ")
    : "";

  const secCitLines = (citInputs?.[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
  const sourcesBlock = secCitLines.length
    ? `\nДЖЕРЕЛА для цього розділу (вставляй маркери [N] після відповідних тверджень, де N — номер зі списку нижче):\n${secCitLines.map((l, i) => `${i + 1}. ${l}`).join("\n")}`
    : "";

  const guidanceLine = practiceGuidance
    ? `\nОРІЄНТИР ЗА НАПРЯМОМ ПРАКТИКИ: ${practiceGuidance.reportContent}${practiceGuidance.feature ? ` (${practiceGuidance.feature})` : ""}`
    : "";

  const detailsLine = [
    companyName && `Місце практики: ${companyName}`,
    supervisorCompany && `Керівник від підприємства: ${supervisorCompany}`,
    supervisorUniversity && `Керівник від університету: ${supervisorUniversity}`,
  ].filter(Boolean).join("; ");

  const individualTaskLine = (isIndividualTask && individualTask)
    ? `\nІНДИВІДУАЛЬНЕ ЗАВДАННЯ (розкрий саме це завдання в розділі): ${individualTask}`
    : "";

  let instruction = `Напиши розділ "${sec.label}" звіту з практики. Мова: ${language}.

ДАНІ ПРАКТИКИ:
${practiceText}
${detailsLine ? `\n${detailsLine}` : ""}${individualTaskLine}
${hint ? `\nОСОБЛИВОСТІ РОЗДІЛУ: ${hint}` : ""}
${methodReq ? `\nВИМОГИ МЕТОДИЧКИ: ${methodReq}` : ""}${sourcesBlock}${guidanceLine}

Обсяг: приблизно ${sec.pages * 225} слів, ±10% (~${sec.pages} стор.).
Без markdown заголовків (#, ##). Не повторюй назву розділу на початку тексту.`;

  if (clientMaterialsSummary?.rawText) {
    instruction += `\n\nМАТЕРІАЛИ КЛІЄНТА (використовуй ці дані — не вигадуй, не замінюй):\n${clientMaterialsSummary.rawText.slice(0, 80000)}`;
  }
  return instruction;
}

export function buildPracticeDiaryPrompt(info) {
  const {
    practiceText = "", language = "Українська", practiceGuidance,
    companyName, individualTask, dateStart, dateEnd,
  } = info;
  const taskGuidance = practiceGuidance?.diaryTasks
    ? `\nТипові завдання для цього напряму та виду практики (орієнтуйся на них): ${practiceGuidance.diaryTasks}`
    : "";
  const periodLine = (dateStart && dateEnd)
    ? `\nПЕРІОД ПРАКТИКИ (використовуй саме ці дати): ${dateStart} – ${dateEnd}`
    : "";
  const detailsLine = [
    companyName && `Місце практики: ${companyName}`,
    individualTask && `Індивідуальне завдання: ${individualTask}`,
  ].filter(Boolean).join("; ");

  return `Склади щоденник практики у вигляді таблиці на основі наданих даних.
Мова: ${language}.

ДАНІ ПРАКТИКИ:
${practiceText}
${periodLine}
${detailsLine ? `\n${detailsLine}` : ""}
${taskGuidance}

Склади таблицю по робочих днях (понеділок–п'ятниця) у межах вказаних дат${periodLine ? "" : " (визнач дати з тексту вище)"}. Кожен день — окремий рядок.
Зміст роботи має бути конкретним і відповідати профілю підприємства та типу практики.
В останні 2-3 дні включи: оформлення звіту, перевірку документів.

Поверни ТІЛЬКИ markdown-таблицю:
| Дата | Зміст виконаної роботи | Підпис керівника |
|------|------------------------|-----------------|
| дд.мм.рррр | ... | |`;
}

export function buildPracticeDetailsPrompt(practiceText, comment) {
  return `Проаналізуй дані про практику нижче і витягни конкретні деталі.

ТЕКСТ:
${practiceText}
${comment ? `\nДОДАТКОВІ МАТЕРІАЛИ КЛІЄНТА:\n${comment}` : ""}

Поверни ТІЛЬКИ JSON (без markdown):
{"companyName":"","supervisorCompany":"","supervisorUniversity":"","individualTask":"","dateStart":"","dateEnd":"","sourceCount":null,"studentName":"","studentGroup":"","university":"","faculty":"","city":""}

Правила:
- companyName: назва підприємства/установи/закладу, де проходить практика. "" якщо не вказано.
- supervisorCompany: ПІБ та посада керівника від підприємства/бази практики. "" якщо не вказано.
- supervisorUniversity: ПІБ та посада керівника від університету/кафедри. "" якщо не вказано.
- individualTask: текст індивідуального завдання, якщо воно наведене як текст (не плутай із темою роботи). "" якщо не вказано.
- dateStart, dateEnd: дати початку і закінчення практики у форматі "дд.мм.рррр". "" якщо не вказано.
- sourceCount: кількість джерел літератури, ЯКЩО явно вказана в тексті або коментарі (наприклад "джерел: 20-25", "не менше 15 джерел", "список літератури 25 позицій"). Рядок як у тексті (наприклад "20-25" або "15"). null якщо явно не вказано — НЕ вигадуй і не став дефолтне значення.
- studentName: ПІБ студента, який проходить практику. "" якщо не вказано.
- studentGroup: номер курсу та/або назва групи студента (наприклад "3 курс, ФБС-31"). "" якщо не вказано.
- university: повна назва університету/закладу вищої освіти для титульної сторінки. "" якщо не вказано.
- faculty: назва факультету або кафедри. "" якщо не вказано.
- city: місто для титульної сторінки (напр. "Київ"). "" якщо не вказано.`;
}

export function buildPracticeSourcesKeywordsPrompt(sections, info) {
  const secList = sections.filter(s => s.id !== "sources").map(s => `- id:"${s.id}" → ${s.label}`).join("\n");
  return `Визнач пошукові фрази для наукових джерел до звіту з практики.

ДАНІ ПРАКТИКИ:
${info?.practiceText || ""}

Розділи:
${secList}

Поверни ТІЛЬКИ JSON (ключ — id розділу, значення — 3-4 пошукові фрази):
{"intro":"...","ch1":"...","ch2":"...","ch3":"...","ch4":"...","conclusions":"..."}`;
}

// ── Застосування одного виправлення до фрагменту тексту файлу ──
export function buildFileApplyCorrectionPrompt({ documentText, location, issue, suggestion }) {
  return `Ти виправляєш частину академічної роботи відповідно до зауваження викладача.

ПОВНИЙ ТЕКСТ РОБОТИ:
${documentText}

ЧАСТИНА ЯКА ПОТРЕБУЄ ВИПРАВЛЕННЯ: "${location}"
ПРОБЛЕМА: ${issue}
ЩО ВИПРАВИТИ: ${suggestion}

Знайди у тексті роботи фрагмент, який потребує виправлення, і виправ його.

Поверни ТІЛЬКИ JSON (без markdown):
{"original":"точний фрагмент з тексту роботи який треба замінити (скопіюй дослівно)","replacement":"виправлений варіант цього фрагменту"}

Правила:
- "original" — дослівна цитата з документа (від кількох речень до кількох абзаців), без змін
- "replacement" — виправлений варіант, зберігаючи стиль і мову оригіналу
- НЕ повертай весь документ — тільки JSON з двома полями`;
}
