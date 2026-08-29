// Розширення файлів коду — читаються як звичайний текст у ClientMaterialsZone
// і розпізнаються як "вихідний код" для програмної збірки Додатку з лістингами
export const CODE_FILE_EXTENSIONS = [
  ".py", ".js", ".jsx", ".ts", ".tsx", ".java", ".c", ".cpp", ".cc", ".h", ".hpp",
  ".cs", ".php", ".rb", ".go", ".rs", ".sql", ".json", ".yaml", ".yml",
  ".html", ".htm", ".css", ".scss", ".sh", ".kt", ".swift", ".m", ".r", ".pl", ".lua",
];

const LATIN_APPENDIX_LETTERS = ["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z"];
// ДСТУ 3008: нумерація додатків українською абеткою без літер Ґ, Є, З, І, Ї, Й, О, Ч, Ь (схожі на цифри/інші літери)
const UKRAINIAN_APPENDIX_LETTERS = ["А","Б","В","Г","Д","Е","Ж","И","К","Л","М","Н","П","Р","С","Т","У","Ф","Х","Ц","Ш","Щ","Ю","Я"];

// Пропорційно підганяє масив сторінок під точну цільову суму — виправляє неточну
// арифметику ШІ (при генерації плану з багатьма підрозділами LLM часто не влучає
// точно в задану суму) і похибку округлення при рівному розподілі (recalcPages).
// minPerItem — бажаний мінімум на елемент, але якщо навіть по мінімуму сума вже
// перевищує targetSum, floor автоматично знижується до 1, щоб не ламати точну суму.
export function normalizePageDistribution(pagesArr, targetSum, minPerItem = 1) {
  const n = pagesArr.length;
  if (!n) return [];
  const floor = (minPerItem * n <= targetSum) ? minPerItem : 1;
  const nums = pagesArr.map(p => parseInt(p) || 0);
  const currentSum = nums.reduce((a, p) => a + p, 0);
  const scaled = currentSum > 0
    ? nums.map(p => Math.max(floor, Math.round(p * targetSum / currentSum)))
    : Array(n).fill(Math.max(floor, Math.round(targetSum / n)));
  // Залишок округлення розподіляємо по +1/-1 за раз (не одним стрибком на один
  // елемент) — інакше при великій похибці й малому floor корекція впирається в межу
  // одного елемента, і сума так і не збігається з ціллю.
  let diff = targetSum - scaled.reduce((a, p) => a + p, 0);
  let guard = 0;
  while (diff !== 0 && guard < 10000) {
    guard++;
    if (diff > 0) {
      const idx = scaled.indexOf(Math.min(...scaled));
      scaled[idx] += 1; diff -= 1;
    } else {
      const idx = scaled.indexOf(Math.max(...scaled));
      if (scaled[idx] <= floor) break; // нема куди далі знімати
      scaled[idx] -= 1; diff += 1;
    }
  }
  return scaled;
}

// Прибирає з плану "розділи", які насправді є формальними елементами документа
// (титульна сторінка, зміст, щоденник практики, список джерел) — вони вже існують
// як окремі фіксовані частини звіту й не повинні опинятись серед sections, де для
// кожного елемента система шукає джерела й генерує текст-переказ. Захист кодом на
// випадок, якщо LLM попри інструкцію в промпті все ж скопіює такий пункт із чек-листа
// складу документа (напр. з рекомендацій кафедри) як окремий розділ.
const NON_CONTENT_SECTION_RE = /^(титульна\s*сторінка|зміст|щоденник(\s+практики)?|список\s+(використаних\s+)?джерел)$/i;
export function stripNonContentSections(sections, fixedIds = ["intro", "conclusions", "sources"]) {
  return (sections || []).filter(s => {
    if (fixedIds.includes(s.id)) return true;
    const clean = (s.label || "").replace(/^[\d.)\s]+/, "").trim();
    return !NON_CONTENT_SECTION_RE.test(clean);
  });
}

// Виявлення посилань на рисунки в тексті ("Рис. 1.2", "Figure 3" тощо) — спільна для
// перевірки "чи є в розділі рисунок" у флоу курсових/дипломних (academic-assistant.jsx)
// і у флоу звітів з практики (PracticePage.jsx).
export function scanFigures(text) {
  const FIG_RE = /(?:рис(?:унок)?\.?\s*\d+(?:\.\d+)*|fig(?:ure)?\.?\s*\d+(?:\.\d+)*)/gi;
  const results = [];
  const lines = (text || "").split("\n");
  lines.forEach(line => {
    const matches = line.match(FIG_RE);
    if (matches) {
      const ctx = line.replace(/\s+/g, " ").trim().substring(0, 120);
      matches.forEach(m => results.push({ label: m, context: ctx }));
    }
  });
  const seen = new Set();
  return results.filter(r => { if (seen.has(r.label.toLowerCase())) return false; seen.add(r.label.toLowerCase()); return true; });
}

// Чи є в тексті розділу РЕАЛЬНО намальований рисунок (plantuml-блок або таблиця
// даних, одразу за якою йде підпис) — на відміну від scanFigures, яка ловить будь-
// яку словесну згадку "Рис. X" навіть без самого рисунка. Потрібна окремо для
// перевірки "чи розділ уже має рисунок" (mandatoryFigureNote у PracticePage.jsx і
// academic-assistant.jsx) — інакше підрозділ, що лише згадав рисунок словами,
// хибно "закриває" вимогу методички для решти розділу.
export function hasRealFigure(text) {
  if (!text) return false;
  if (/^\s*```\s*plantuml\s*$/im.test(text)) return true;
  const lines = text.split("\n");
  const FIG_CAP_RE = /^(рис(?:унок)?\.?|fig(?:ure)?\.?|rys\.?|abb\.?|obr\.?)\s*\d/i;
  let i = 0;
  while (i < lines.length) {
    if (/^\s*\|/.test(lines[i])) {
      let j = i;
      while (j < lines.length && /^\s*\|/.test(lines[j])) j++;
      let k = j;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k < lines.length && FIG_CAP_RE.test(lines[k].trim())) return true;
      i = j;
      continue;
    }
    i++;
  }
  return false;
}

// Знаходить речення в тексті, які посилаються на рисунок за номером ("...показано
// на Рис. X.Y"), але для цього номера немає реального рисунка (plantuml-блоку чи
// таблиці з підписом) — тобто ШІ написала посилання, так і не намалювавши сам
// рисунок. Повертає {number, sentence, kind:"missing"} для точкової фінальної
// добудови/прибирання (fixDanglingFigures у PracticePage.jsx).
//
// Окремо ловить і другий випадок: рисунок з таким номером У ТЕКСТІ Є, але стоїть
// задалеко від речення, яке на нього посилається (типово — ШІ згадала "Рис. X.Y"
// на початку абзацу, а саму схему домалювала аж у кінці підрозділу). Раніше такий
// рисунок вважався "закритим" лише за фактом існування десь у тексті, тож і
// опинявся систематично в кінці. Такі елементи повертаються з kind:"misplaced" і
// межами свого блоку (blockStart/blockEnd) — fixDanglingFigures переносить сам
// блок ближче до посилання кодом, без повторного виклику ШІ.
export function findDanglingFigureRefs(text, figWord) {
  if (!text) return [];
  const fwEsc = figWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const CAP_RE = new RegExp(`^\\s*${fwEsc}\\s*(\\d+(?:\\.\\d+)?)`, "i");
  const REF_RE = new RegExp(`${fwEsc}\\s*(\\d+(?:\\.\\d+)?)`, "gi");
  const FENCE_OPEN_RE = /^\s*```\s*plantuml\s*$/i;

  const lines = text.split("\n");
  const lineStarts = [];
  { let pos = 0; for (const l of lines) { lineStarts.push(pos); pos += l.length + 1; } }

  // Для кожного номера — межі його ПЕРШОГО реального блоку в тексті (fence чи
  // таблиця + підпис одразу після). Перенесення (kind:"misplaced") робимо лише
  // для plantuml-блоків: межі fence однозначні й переносяться безпечно, а межі
  // таблиці з даними прив'язані до сусіднього тексту сильніше — там ризикованіше.
  const resolvedBlocks = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(CAP_RE);
    if (!m) continue;
    let j = i - 1;
    while (j >= 0 && !lines[j].trim()) j--;
    const prevTrimmed = j >= 0 ? lines[j].trim() : "";
    const isFenceClose = prevTrimmed === "```";
    const isTableRow = /^\s*\|/.test(lines[j] || "");
    if (!isFenceClose && !isTableRow) continue;
    const num = m[1];
    if (resolvedBlocks.has(num)) continue; // лишаємо перший знайдений блок
    const capLineEnd = lineStarts[i] + lines[i].length + (i < lines.length - 1 ? 1 : 0);
    let blockStart;
    if (isFenceClose) {
      let k = j;
      while (k >= 0 && !FENCE_OPEN_RE.test(lines[k])) k--;
      blockStart = k >= 0 ? lineStarts[k] : lineStarts[j];
    } else {
      let k = j;
      while (k >= 0 && /^\s*\|/.test(lines[k])) k--;
      blockStart = lineStarts[k + 1];
    }
    resolvedBlocks.set(num, { blockStart, blockEnd: capLineEnd, isFence: isFenceClose });
  }

  // Межі речення шукаємо вручну (а не наївним split за крапками) — сам номер
  // рисунка вже містить крапку (X.Y), тож розбиття тексту на речення "по крапці"
  // ламало б збіг рівно на цьому місці. Замість цього йдемо від знайденого
  // посилання назад/вперед до найближчого справжнього кінця речення.
  const MAX_NEARBY_DIST = 600; // символів між кінцем речення-посилання й початком блоку
  const out = [];
  const seen = new Set();
  const globalRefRe = new RegExp(REF_RE.source, "gi");
  let m;
  while ((m = globalRefRe.exec(text))) {
    const num = m[1];
    if (seen.has(num)) continue;
    seen.add(num);
    let start = m.index;
    while (start > 0 && !".!?\n".includes(text[start - 1])) start--;
    let end = m.index + m[0].length;
    while (end < text.length && !".!?\n".includes(text[end])) end++;
    if (end < text.length) end++;
    const sentence = text.slice(start, end).trim();

    const block = resolvedBlocks.get(num);
    if (!block) {
      out.push({ number: num, sentence, kind: "missing" });
      continue;
    }
    // Саме це "посилання" і є рядком підпису блоку — не помилка позиціювання.
    if (m.index >= block.blockStart && m.index <= block.blockEnd) continue;
    const dist = block.blockStart - end;
    if (block.isFence && (dist < 0 || dist > MAX_NEARBY_DIST)) {
      out.push({ number: num, sentence, kind: "misplaced", blockStart: block.blockStart, blockEnd: block.blockEnd });
    }
  }
  return out;
}

// Витягує речення/фрагменти з конкретними числовими показниками (%, °C, градуси) з уже
// написаного тексту — для передачі як "вже зафіксовані цифри" в наступні розділи звіту з
// практики, щоб той самий показник (напр. концентрація сухих речовин, температура
// зберігання) не отримував різні значення в різних розділах.
export function extractNumericFacts(text) {
  if (!text) return [];
  const FACT_RE = /[^.!?\n]*\d+(?:[.,]\d+)?\s*(?:%|°C|градус[а-яії]*)[^.!?\n]*[.!?]/gi;
  const matches = text.match(FACT_RE) || [];
  const seen = new Set();
  const out = [];
  matches.forEach(m => {
    const trimmed = m.replace(/\s+/g, " ").trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase().replace(/[^0-9a-zа-яії%°]/g, "");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  });
  return out;
}

// Перші 3 речення вже написаного підрозділу — для передачі в промпт НАСТУПНИХ
// підрозділів тієї ж роботи як "уже використані початки, не повторюй". Генерація
// йде строго послідовно (runSection/doWrite), тож увесь попередній текст завжди
// вже готовий, просто досі ніде не передавався моделі: інструкція в buildSYS
// ("якщо попередні підрозділи показані тобі як контекст вище — обери інший
// стиль") була порожньою обіцянкою без реальних даних під нею. Три речення (а
// не одне) — щоб зловити не лише перше слово-гачок, а й ритм довжини речень і
// форму абзацу (теза-приклад-висновок тощо), які buildSYS також просить варіювати.
export function extractOpeningSentences(text, count = 3) {
  if (!text?.trim()) return "";
  const clean = text.trim();
  const SENT_RE = /[^.!?\n]*[.!?…]+/g;
  let lastEnd = 0, found = 0, m;
  while (found < count && (m = SENT_RE.exec(clean))) {
    lastEnd = m.index + m[0].length;
    found++;
  }
  return (lastEnd > 0 ? clean.slice(0, lastEnd) : clean.slice(0, 200)).trim();
}

export function getLangLabels(lang = "Українська") {
  const l = (lang || "").toLowerCase();
  // latinScript: true = мова використовує латиницю (не забороняємо її в тексті)
  if (/англ|english/.test(l))      return { intro: "INTRODUCTION",  conclusions: "CONCLUSIONS",      sources: "REFERENCES",                 chapConclLabel: n => `Conclusions to Chapter ${n}`,       chapterWord: "CHAPTER",   subsWord: "subsection",  chapterTemplate: ["CHAPTER 1. THEORETICAL FOUNDATIONS", "CHAPTER 2. ANALYSIS AND PRACTICAL PART", "CHAPTER 3. RECOMMENDATIONS AND PROPOSALS"],  tableWord: "Table",    figWord: "Fig.",   tableRef: "shown in Table",            figRef: "shown in Fig.",            forbiddenWords: "aspect, important, special, significant, key, critical, fundamental",  latinScript: true, toc: "TABLE OF CONTENTS", appendixWord: "APPENDICES", introLabels: { actuality: "Relevance of the topic.", goal: "The purpose of the study –", tasks: "Research objectives:", object: "Object of study –", subject: "Subject of study –", methods: "Research methods:", novelty: "Scientific novelty –", practical: "Practical significance:", approbation: "Approbation of results –", structure: "Structure of the work:", theoryBasis: "The theoretical basis is" }, defaultIntroComponents: ["relevance of the topic", "purpose of the study", "research objectives", "object of study", "subject of study", "research methods", "practical significance", "structure of the work"], appendixLetters: LATIN_APPENDIX_LETTERS };
  if (/польськ|polish/.test(l))    return { intro: "WSTĘP",         conclusions: "WNIOSKI",          sources: "BIBLIOGRAFIA",               chapConclLabel: n => `Wnioski do rozdziału ${n}`,          chapterWord: "ROZDZIAŁ",  subsWord: "podrozdział", chapterTemplate: ["ROZDZIAŁ 1. PODSTAWY TEORETYCZNE BADANIA", "ROZDZIAŁ 2. ANALIZA I CZĘŚĆ PRAKTYCZNA", "ROZDZIAŁ 3. WNIOSKI I ZALECENIA"],             tableWord: "Tabela",   figWord: "Rys.",   tableRef: "przedstawiono w Tabeli",    figRef: "pokazano na Rys.",         forbiddenWords: "aspekt, ważny, szczególny, znaczący, kluczowy, krytyczny, fundamentalny", latinScript: true, toc: "SPIS TREŚCI", appendixWord: "DODATKI", introLabels: { actuality: "Aktualność tematu.", goal: "Cel badania –", tasks: "Zadania badania:", object: "Przedmiot badania –", subject: "Obiekt badania –", methods: "Metody badania:", novelty: "Naukowa nowość badania –", practical: "Znaczenie praktyczne:", approbation: "Aprobata wyników –", structure: "Struktura pracy:", theoryBasis: "Podstawy teoretyczno-metodologiczne stanowią" }, defaultIntroComponents: ["aktualność tematu", "cel badania", "zadania badania", "przedmiot badania", "obiekt badania", "metody badania", "znaczenie praktyczne badania", "struktura pracy"], appendixLetters: LATIN_APPENDIX_LETTERS };
  if (/іспан|spanish|español|espanol/.test(l)) return { intro: "INTRODUCCIÓN", conclusions: "CONCLUSIONES", sources: "BIBLIOGRAFÍA",        chapConclLabel: n => `Conclusiones del capítulo ${n}`,    chapterWord: "CAPÍTULO",  subsWord: "sección",     chapterTemplate: ["CAPÍTULO 1. FUNDAMENTOS TEÓRICOS DE LA INVESTIGACIÓN", "CAPÍTULO 2. ANÁLISIS Y PARTE PRÁCTICA", "CAPÍTULO 3. RECOMENDACIONES Y PROPUESTAS"], tableWord: "Tabla",    figWord: "Fig.",   tableRef: "se muestra en la Tabla",    figRef: "se muestra en la Fig.",    forbiddenWords: "aspecto, importante, especial, significativo, clave, crítico, fundamental", latinScript: true, toc: "ÍNDICE", appendixWord: "APÉNDICES", introLabels: { actuality: "Relevancia del tema.", goal: "El objetivo del estudio –", tasks: "Tareas de investigación:", object: "Objeto de estudio –", subject: "Sujeto de estudio –", methods: "Métodos de investigación:", novelty: "Novedad científica –", practical: "Significado práctico:", approbation: "Aprobación de resultados –", structure: "Estructura del trabajo:", theoryBasis: "La base teórico-metodológica es" }, defaultIntroComponents: ["relevancia del tema", "objetivo del estudio", "tareas de investigación", "objeto de estudio", "sujeto de estudio", "métodos de investigación", "significado práctico", "estructura del trabajo"], appendixLetters: LATIN_APPENDIX_LETTERS };
  if (/нім|german|deutsch/.test(l)) return { intro: "EINLEITUNG",   conclusions: "SCHLUSSFOLGERUNGEN", sources: "LITERATURVERZEICHNIS",     chapConclLabel: n => `Schlussfolgerungen zu Kapitel ${n}`, chapterWord: "KAPITEL",   subsWord: "Unterkapitel",chapterTemplate: ["KAPITEL 1. THEORETISCHE GRUNDLAGEN DER UNTERSUCHUNG", "KAPITEL 2. ANALYSE UND PRAKTISCHER TEIL", "KAPITEL 3. EMPFEHLUNGEN UND VORSCHLÄGE"],       tableWord: "Tabelle",  figWord: "Abb.",   tableRef: "in Tabelle dargestellt",    figRef: "in Abb. gezeigt",          forbiddenWords: "Aspekt, wichtig, besonders, bedeutend, entscheidend, kritisch, grundlegend", latinScript: true, toc: "INHALTSVERZEICHNIS", appendixWord: "ANHÄNGE", introLabels: { actuality: "Relevanz des Themas.", goal: "Das Ziel der Arbeit –", tasks: "Forschungsaufgaben:", object: "Untersuchungsobjekt –", subject: "Untersuchungsgegenstand –", methods: "Forschungsmethoden:", novelty: "Wissenschaftliche Neuheit –", practical: "Praktische Bedeutung:", approbation: "Approbation der Ergebnisse –", structure: "Struktur der Arbeit:", theoryBasis: "Die theoretisch-methodologische Grundlage bilden" }, defaultIntroComponents: ["Relevanz des Themas", "Ziel der Arbeit", "Forschungsaufgaben", "Untersuchungsobjekt", "Untersuchungsgegenstand", "Forschungsmethoden", "Praktische Bedeutung", "Struktur der Arbeit"], appendixLetters: LATIN_APPENDIX_LETTERS };
  if (/чеськ|czech/.test(l))       return { intro: "ÚVOD",          conclusions: "ZÁVĚR",            sources: "SEZNAM POUŽITÉ LITERATURY",  chapConclLabel: n => `Závěry ke kapitole ${n}`,           chapterWord: "KAPITOLA",  subsWord: "podkapitola", chapterTemplate: ["KAPITOLA 1. TEORETICKÉ ZÁKLADY VÝZKUMU", "KAPITOLA 2. ANALÝZA A PRAKTICKÁ ČÁST", "KAPITOLA 3. DOPORUČENÍ A NÁVRHY"],                     tableWord: "Tabulka",  figWord: "Obr.",   tableRef: "uvedeno v Tabulce",         figRef: "znázorněno na Obr.",       forbiddenWords: "aspekt, důležitý, zvláštní, významný, klíčový, kritický, základní", latinScript: true, toc: "OBSAH", appendixWord: "PŘÍLOHY", introLabels: { actuality: "Aktuálnost tématu.", goal: "Cíl práce –", tasks: "Úkoly výzkumu:", object: "Objekt výzkumu –", subject: "Předmět výzkumu –", methods: "Výzkumné metody:", novelty: "Vědecká novost –", practical: "Praktický přínos:", approbation: "Aprobace výsledků –", structure: "Struktura práce:", theoryBasis: "Teoreticko-metodologickým základem je" }, defaultIntroComponents: ["aktuálnost tématu", "cíl práce", "úkoly výzkumu", "objekt výzkumu", "předmět výzkumu", "výzkumné metody", "praktický přínos", "struktura práce"], appendixLetters: LATIN_APPENDIX_LETTERS };
  if (/словацьк|slovak/.test(l))   return { intro: "ÚVOD",          conclusions: "ZÁVER",            sources: "ZOZNAM POUŽITEJ LITERATÚRY", chapConclLabel: n => `Závery ku kapitole ${n}`,           chapterWord: "KAPITOLA",  subsWord: "podkapitola", chapterTemplate: ["KAPITOLA 1. TEORETICKÉ ZÁKLADY VÝSKUMU", "KAPITOLA 2. ANALÝZA A PRAKTICKÁ ČASŤ", "KAPITOLA 3. ODPORÚČANIA A NÁVRHY"],                   tableWord: "Tabuľka",  figWord: "Obr.",   tableRef: "uvedené v Tabuľke",         figRef: "znázornené na Obr.",       forbiddenWords: "aspekt, dôležitý, špeciálny, významný, kľúčový, kritický, základný", latinScript: true, toc: "OBSAH", appendixWord: "PRÍLOHY", introLabels: { actuality: "Aktuálnosť témy.", goal: "Cieľ práce –", tasks: "Úlohy výskumu:", object: "Objekt výskumu –", subject: "Predmet výskumu –", methods: "Výskumné metódy:", novelty: "Vedecká novosť –", practical: "Praktický prínos:", approbation: "Aprobácia výsledkov –", structure: "Štruktúra práce:", theoryBasis: "Teoreticko-metodologickým základom je" }, defaultIntroComponents: ["aktuálnosť témy", "cieľ práce", "úlohy výskumu", "objekt výskumu", "predmet výskumu", "výskumné metódy", "praktický prínos", "štruktúra práce"], appendixLetters: LATIN_APPENDIX_LETTERS };
  if (/китайськ|chinese|中文/.test(l)) return { intro: "引言",      conclusions: "结论",             sources: "参考文献",                    chapConclLabel: n => `第${n}章结论`,                      chapterWord: "第",        subsWord: "小节",        chapterTemplate: ["第1章. 研究的理论基础", "第2章. 分析与实践部分", "第3章. 建议与对策"],                                                                              tableWord: "表",       figWord: "图",     tableRef: "如表所示",                  figRef: "如图所示",                 forbiddenWords: "方面, 重要, 特殊, 显著, 关键, 批判, 基本", latinScript: false, toc: "目录", appendixWord: "附录", introLabels: { actuality: "选题意义：", goal: "研究目的：", tasks: "研究任务：", object: "研究对象：", subject: "研究主题：", methods: "研究方法：", novelty: "科学新颖性：", practical: "实践意义：", approbation: "成果鉴定：", structure: "论文结构：", theoryBasis: "理论方法论基础为" }, defaultIntroComponents: ["选题意义", "研究目的", "研究任务", "研究对象", "研究主题", "研究方法", "实践意义", "论文结构"], appendixLetters: LATIN_APPENDIX_LETTERS };
  return { intro: "ВСТУП", conclusions: "ВИСНОВКИ", sources: "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", chapConclLabel: n => `Висновки до розділу ${n}`, chapterWord: "РОЗДІЛ", subsWord: "підрозділ", chapterTemplate: ["РОЗДІЛ 1. ТЕОРЕТИЧНІ ОСНОВИ ДОСЛІДЖЕННЯ", "РОЗДІЛ 2. АНАЛІЗ ТА ПРАКТИЧНА ЧАСТИНА", "РОЗДІЛ 3. РЕКОМЕНДАЦІЇ ТА ПРОПОЗИЦІЇ"], tableWord: "Таблиця", figWord: "Рис.", tableRef: "наведено в Таблиці", figRef: "показано на Рис.", forbiddenWords: "аспект, важливий, особливий, значущий, ключовий, критичний, фундаментальний", latinScript: false, toc: "ЗМІСТ", appendixWord: "ДОДАТКИ", introLabels: { actuality: "Актуальність теми.", goal: "Мета дослідження –", tasks: "Завдання дослідження:", object: "Об'єкт дослідження –", subject: "Предмет дослідження –", methods: "Методи дослідження:", novelty: "Наукова новизна дослідження –", practical: "Практична значущість:", approbation: "Апробація результатів дослідження –", structure: "Структура роботи:", theoryBasis: "Теоретико-методологічну основу дослідження становлять" }, defaultIntroComponents: ["актуальність теми", "мета дослідження", "завдання дослідження", "об'єкт дослідження", "предмет дослідження", "методи дослідження", "практичне значення дослідження", "структура роботи"], appendixLetters: UKRAINIAN_APPENDIX_LETTERS };
}

export const FIELD_LABELS = {
  type: "Тип роботи", course: "Курс", pages: "К-сть сторінок", topic: "Тема роботи",
  subject: "Тематика / предмет", direction: "Галузь / напрям", uniqueness: "Унікальність",
  language: "Мова роботи", deadline: "Дедлайн", extras: "Додаткові матеріали",
  methodNotes: "Вимоги методички",
};

// Визначає чи є робота з психології або педагогіки
export const isPsychoPed = (info) => {
  if (info?.workCategory === "Гуманітарне") {
    const dir = ((info?.direction || "") + " " + (info?.subject || "")).toLowerCase();
    return /психол|педагог/.test(dir);
  }
  if (info?.workCategory && info.workCategory !== "Гуманітарне") return false;
  const dir = ((info?.direction || "") + " " + (info?.subject || "")).toLowerCase();
  return /психол|педагог/.test(dir);
};

// Визначає чи є робота економічного спрямування
export const isEcon = (info) => {
  if (info?.workCategory === "Економічне") return true;
  if (info?.workCategory && info.workCategory !== "Економічне") return false;
  const dir = ((info?.direction || "") + " " + (info?.subject || "")).toLowerCase();
  return /економ|фінанс|менедж|облік|маркет|бізнес|бухгалт|аудит|логіст|підприємн|публічн.*управл|держ.*управл/.test(dir);
};

// Визначає чи є робота технічної спеціальності (інженерія/будівництво/IT/кібербезпека)
export const isTechnical = (info) => {
  if (info?.workCategory === "Технічне") return true;
  if (info?.workCategory && info.workCategory !== "Технічне") return false;
  const dir = ((info?.direction || "") + " " + (info?.subject || "")).toLowerCase();
  return /техн|інформ|програм|комп|it\b|кібер|електр|машин|буд|архіт/.test(dir);
};

// Визначає чи є в роботі емпіричне дослідження (з коментаря або методички)
export const hasEmpiricalResearch = (commentAnalysis, methodInfo) => {
  if (commentAnalysis?.researchDesign) return true;
  if (commentAnalysis?.empiricalHints) return true; // fallback для старих замовлень
  if (!methodInfo) return false;
  return /анкет|опитуванн|емпіричн|респондент|вибірк|тест|експеримент|методик/i.test(
    [methodInfo.analysisRequirements, methodInfo.otherRequirements, methodInfo.theoryRequirements].filter(Boolean).join(" ")
  );
};

// Визначає підрозділи що мають отримати інструкції емпіричного дослідження
export const getEmpiricalSections = (sections, info, commentAnalysis, methodInfo) => {
  const empty = { anchorId: null, chapterSectionIds: [] };
  if (!isPsychoPed(info) && !hasEmpiricalResearch(commentAnalysis, methodInfo)) return empty;

  const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
  const empiricalRe = /дослідженн|емпіричн|анкетуванн|практичн.*дослідж|вибірк|результат.*дослідж/i;

  // Варіант 2: є підрозділи з ключовими словами → беремо весь їх розділ
  const matchingChapNums = new Set(
    mainSecs
      .filter(s => empiricalRe.test(s.label) || empiricalRe.test(s.sectionTitle || ""))
      .map(s => s.id.split(".")[0])
  );
  if (matchingChapNums.size > 0) {
    const ids = mainSecs
      .filter(s => matchingChapNums.has(s.id.split(".")[0]))
      .map(s => s.id);
    return { anchorId: null, chapterSectionIds: ids };
  }

  // Варіант 1: ключових слів у назвах немає — anchor лише якщо є реальні ознаки емпіричного дослідження
  // (не просто "педагогічна робота" — без коментаря/методички, що підтверджує анкетування/опитування)
  if (!hasEmpiricalResearch(commentAnalysis, methodInfo)) return empty;
  const practicalSecs = mainSecs.filter(s => ["analysis", "recommendations"].includes(s.type));
  if (!practicalSecs.length) return empty;
  const softRe = /практичн|аналіз|результат|застосуванн/i;
  const best = practicalSecs.find(s => softRe.test(s.label)) || practicalSecs[practicalSecs.length - 1];
  return { anchorId: best.id, chapterSectionIds: [] };
};

// Повертає id підрозділів економічної роботи що мають містити таблиці/розрахунки
export const getEconSections = (sections, info) => {
  if (!isEcon(info)) return [];
  return sections
    .filter(s => ["analysis", "recommendations"].includes(s.type))
    .map(s => s.id);
};

// Повертає id підрозділів технічної роботи що мають містити розрахунки/формули/код
export const getTechnicalSections = (sections, info) => {
  if (!isTechnical(info)) return [];
  return sections
    .filter(s => ["analysis", "recommendations"].includes(s.type))
    .map(s => s.id);
};

export const STAGES_SOURCES_FIRST = ["Дані", "Перевірка", "План", "Джерела", "Написання", "Готово", "Чек-лист"];
export const STAGE_KEYS_SOURCES_FIRST = ["input", "parsed", "plan", "sources", "writing", "done", "checklist"];

export const STAGES     = STAGES_SOURCES_FIRST;
export const STAGE_KEYS = STAGE_KEYS_SOURCES_FIRST;

// Статуси для Firestore
export const ORDER_STATUS = {
  input: "new",
  parsed: "new",
  plan: "plan_ready",
  writing: "writing",
  sources: "writing",
  done: "done",
  checklist: "done",
};

// Дефолт 80 — для великих академічних робіт (курсова, дипломна). Мала версія в shared.jsx має дефолт 20.
export function parsePagesAvg(str) {
  if (!str) return 80;
  const s = String(str);
  const nums = s.match(/\d+/g);
  if (!nums) return 80;
  const avg = nums.length === 1 ? parseInt(nums[0]) : Math.round(nums.reduce((a, b) => a + parseInt(b), 0) / nums.length);
  // Якщо поруч із числом вказано "слів"/"слова"/"words" — це обсяг у словах, конвертуємо в сторінки (~230 слів/стор.)
  if (/слів|слова|слово|words?\b/i.test(s)) return Math.max(1, Math.round(avg / 230));
  return avg;
}

// Верхня межа діапазону сторінок ("65-85" → 85). Використовується як стеля
// для фінальної перевірки фактичного обсягу згенерованої роботи.
export function parsePagesMax(str) {
  if (!str) return null;
  const s = String(str);
  const nums = s.match(/\d+/g);
  if (!nums) return null;
  const max = Math.max(...nums.map(n => parseInt(n, 10)));
  if (/слів|слова|слово|words?\b/i.test(s)) return Math.max(1, Math.round(max / 230));
  return max;
}

// Явно вказаний клієнтом чи кафедрою обсяг вступу/висновків (у сторінках) для звіту
// з практики — регексом з вільного тексту (даних практики, вимог кафедри), без
// виклику ШІ. За відсутності явної вказівки — стандартний обсяг 2 сторінки для
// кожного (типовий для звітів з практики, на відміну від курсових/дипломних).
export function resolvePracticeFixedPages(practiceText, deptGuidanceText) {
  const combined = `${practiceText || ""} ${deptGuidanceText || ""}`;
  const extract = (keywordRe) => {
    const m = combined.match(keywordRe);
    return m ? parseInt(m[1], 10) : null;
  };
  const introPages = extract(/вступ[^.\d]{0,20}(\d+)\s*стор/i) || 2;
  const conclPages = extract(/висновк[^.\d]{0,20}(\d+)\s*стор/i) || 2;
  return { introPages, conclPages };
}

export function parseTemplate(text) {
  const g = (re, fb = "") => { const m = text.match(re); return m ? m[1].trim() : fb; };
  return {
    orderNumber: g(/№\s*замовлення\s*[-–—:]\s*(\S+)/i),
    type: g(/Тип\s*[-–:]\s*(.+?)(?=\n|⏰|📌|✈️|⚙️|⚡|$)/i),
    deadline: g(/Дедлайн\s*[-–:]\s*(.+?)(?=\n|⚡|📌|✈️|⚙️|$)/i),
    direction: g(/Напрям\s*[-–:]\s*(.+?)(?=\n|📌|✈️|⚙️|$)/i),
    subject: g(/Тематика\s*[-–:]\s*(.+?)(?=\n|✈️|⚙️|$)/i),
    topic: g(/Тема\s*[-–:]\s*(.+?)(?=\n|Презентація|⚙️|$)/i),
    pages: g(/К-кість стр\.\s*[-–:]\s*(.+?)(?=\n|⚙️|$)/i),
    uniqueness: g(/Унікальність\s*[-–:]\s*(.+?)(?=\n|$)/i),
    course: g(/Курс\s*[-–:]\s*(\d+)/i),
    extras: g(/Презентація(.+?)(?=\n|⚙️|$)/i),
    language: "Українська", methodNotes: "", sourceCount: "30-40",
  };
}

export function parseClientPlan(text, totalPages, lang = "Українська") {
  const { intro: introLabel, conclusions: conclLabel, sources: srcLabel, chapConclLabel } = getLangLabels(lang);

  const normalized = text
    .replace(/С(?=[Hh][Aa][Pp][Tt][Ee][Rr])/g, 'C')
    .replace(/([^\n])\s+(Розділ\s)/gi, "$1\n$2")
    .replace(/([^\n])\s+(Chapter\s)/gi, "$1\n$2")
    .replace(/([^\n])\s+(Rozdział\s)/gi, "$1\n$2")
    .replace(/([^\n])\s+(Cap[ií]tulo\s)/gi, "$1\n$2")
    .replace(/([^\n])\s+(Kapitol[ao]\s)/gi, "$1\n$2")
    .replace(/([^\n])\s+(Kapitel\s)/gi, "$1\n$2")
    .replace(/([^\n])\s+(висновк\w*)/gi, "$1\n$2")
    .replace(/([^\n])\s+(список\s)/gi, "$1\n$2")
    .replace(/([^\n])\s+(вступ\s|вступ$)/gi, "$1\n$2");
  const lines = normalized.split("\n").map(l => l.trim()).filter(Boolean);
  const chapters = []; let current = null;
  let expectingChapterTitle = false;
  for (const line of lines) {
    const isChapter = /^розділ\s/i.test(line) || /^chapter\s/i.test(line)
      || /^rozdział\s/i.test(line) || /^cap[ií]tulo\s/i.test(line)
      || /^kapitol[ao]\s/i.test(line) || /^kapitel\s/i.test(line)
      || /^第\d+章/.test(line)
      || /^\d+[\.\)]\s+[А-ЯҐЄІЇа-яґєіїA-ZÁÉÍÓÚÑÀÈÌÒÙÂÊÎÔÛÄËÏÖÜČŠŽŘÝŮÍÁÉÓÚ]/i.test(line);
    const isSubsection = /^\d+\.\d+/.test(line) || /^[-–•]\s+/.test(line);
    const isChapterConclusion = /^висновк[^\s]*\s+до\s+/i.test(line)
      || /^wnioski\s+do\s+/i.test(line) || /^conclusiones\s+(del|al)\s+/i.test(line)
      || /^závěry\s+ke\s+/i.test(line) || /^závery\s+ku\s+/i.test(line)
      || /^schlussfolgerungen\s+zu\s+/i.test(line);
    const isSpecial = !isChapterConclusion && /^(вступ[\s,\.!]?$|вступ\s|висновк|список|загальн|практичн|додатк|зміст|wstęp|wnioski|zakończenie|bibliografia|spis\s|introducción|introduccion|conclusiones|bibliografía|bibliografia|índice|indice|einleitung|schlussfolgerungen|fazit|literaturverzeichnis|inhaltsverzeichnis|úvod|závěr|záver|seznam\s|zoznam\s|引言|绪论|结论|参考文献|目录)/i.test(line);
    if (isSpecial) { expectingChapterTitle = false; continue; }
    if (isChapterConclusion && current) { current.hasConclusion = true; expectingChapterTitle = false; continue; }
    if (isChapter) {
      const numMatch = line.match(/^(?:розділ|chapter|rozdział|cap[ií]tulo|kapitol[ao]|kapitel)\s*(\d+)/i)
        || line.match(/^(\d+)[\.\)]\s+/) || line.match(/^第(\d+)章/);
      current = { title: line.trim(), subsections: [], hasConclusion: false, declaredNum: numMatch ? parseInt(numMatch[1], 10) : null };
      chapters.push(current);
      expectingChapterTitle = true;
    } else if (isSubsection) {
      expectingChapterTitle = false;
      if (current) current.subsections.push(line.replace(/^[-–•]\s+/, "").trim());
    } else if (expectingChapterTitle && current) {
      current.title = current.title + ". " + line.trim();
      expectingChapterTitle = false;
    }
  }
  // Fallback: no chapter headers found but subsections exist — auto-group by leading digit
  if (!chapters.length) {
    const subLines = lines.filter(l => /^\d+\.\d+/.test(l));
    if (!subLines.length) return null;
    const chapMap = {}; const chapOrder = [];
    for (const l of subLines) {
      const chapNum = l.match(/^(\d+)\./)[1];
      if (!chapMap[chapNum]) { chapMap[chapNum] = { title: chapNum, subsections: [], hasConclusion: false }; chapOrder.push(chapNum); }
      chapMap[chapNum].subsections.push(l.trim());
    }
    for (const n of chapOrder) chapters.push(chapMap[n]);
  }
  if (!chapters.length) return null;
  const mainPages = Math.round(totalPages * 0.80);
  const pagesPerChapter = Math.max(1, Math.round(mainPages / chapters.length));
  const introPages = 2;
  const concPages = totalPages > 40 ? 3 : 2;
  const sections = []; let chapCounter = 0;
  for (const ch of chapters) {
    chapCounter++;
    const chapNum = ch.declaredNum || chapCounter;
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
    if (ch.hasConclusion) {
      sections.push({ id: `${chapNum}.conclusions`, label: chapConclLabel(chapNum), sectionTitle: ch.title.toUpperCase(), pages: 1, type: "chapter_conclusion", chapterNum: String(chapNum) });
    }
  }
  sections.push({ id: "intro", label: introLabel, pages: introPages, type: "intro" });
  sections.push({ id: "conclusions", label: conclLabel, pages: concPages, type: "conclusions" });
  sections.push({ id: "sources", label: srcLabel, pages: 1, type: "sources" });
  return sections;
}

// Рахує chaptersCount/subsectionsPerChapter/hasChapterConclusions з реального
// змісту "приклада роботи" (exampleTOC), детерміновано кодом — без AI-виклику.
// Перевикористовує parseClientPlan лише як парсер тексту в розділи/підрозділи;
// самі назви розділів з нього НЕ беруться, тільки кількості.
export function deriveStructureFromExampleTOC(exampleTOC, lang = "Українська") {
  if (!exampleTOC?.trim()) return null;
  const sections = parseClientPlan(exampleTOC.trim(), 30, lang);
  if (!sections?.length) return null;

  const subsPerChap = {}; // "1" -> к-сть підрозділів
  let hasChapterConclusions = false;
  for (const s of sections) {
    const subMatch = s.id.match(/^(\d+)\.(\d+)$/);
    if (subMatch) {
      const chapNum = subMatch[1];
      subsPerChap[chapNum] = (subsPerChap[chapNum] || 0) + 1;
      continue;
    }
    if (/^\d+\.conclusions$/.test(s.id)) hasChapterConclusions = true;
  }
  const chapNums = Object.keys(subsPerChap);
  if (!chapNums.length) return null;

  const counts = chapNums.map(n => subsPerChap[n]);
  // Найчастіше значення — базове; розділи що відрізняються — в overrides
  const freq = {};
  counts.forEach(c => { freq[c] = (freq[c] || 0) + 1; });
  const subsectionsPerChapter = Number(Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]);
  const subsectionsPerChapterOverrides = {};
  for (const n of chapNums) {
    if (subsPerChap[n] !== subsectionsPerChapter) subsectionsPerChapterOverrides[n] = subsPerChap[n];
  }

  return {
    chaptersCount: chapNums.length,
    subsectionsPerChapter,
    subsectionsPerChapterOverrides: Object.keys(subsectionsPerChapterOverrides).length ? subsectionsPerChapterOverrides : null,
    hasChapterConclusions,
  };
}

// Зливає дані, витягнуті з "приклада роботи" (exampleInfo/exampleStructure), у
// methodInfo — ЛИШЕ для полів, які methodInfo лишив порожніми. Явні вимоги з
// методички завжди мають пріоритет над зразком.
const EXAMPLE_WORK_FIELDS = [
  "chaptersCount", "subsectionsPerChapter", "subsectionsPerChapterOverrides",
  "hasChapterConclusions", "titlePageTemplate", "taskSheetTemplate", "calendarPlanTable",
  "hasFigures", "formatting", "sourcesStyle",
  "sourcesOrder", "sourcesGrouping", "citationStyle", "sourcesFormatRules",
  "introComponents", "introStructureHasChapterDetail", "exampleTOC",
];
export function mergeExampleWorkIntoMethodInfo(methodInfo, exampleInfo, exampleStructure) {
  const source = { ...(exampleStructure || {}), ...(exampleInfo || {}) };
  const result = { ...(methodInfo || {}) };
  for (const key of EXAMPLE_WORK_FIELDS) {
    if (result[key] == null && source[key] != null) result[key] = source[key];
  }
  return result;
}

const CARDINAL_CHAPTER_WORDS = [
  [/\bодн[а-яії]*\s+розділ/i, 1],
  [/\bдв[аі][а-яії]*\s+розділ/i, 2],
  [/\bтр(?:и|ьох)\s+розділ/i, 3],
  [/\bчотир(?:и|ьох)\s+розділ/i, 4],
  [/\bп['ʼ’]?ят(?:ь|и)\s+розділ/i, 5],
  [/\bшіст(?:ь|и)\s+розділ/i, 6],
];
const ORDINAL_CHAPTER_WORDS = [
  [/\bперш[а-яії]*\s+розділ/i, 1],
  [/\bдруг[а-яії]*\s+розділ/i, 2],
  [/\bтрет[а-яії]*\s+розділ/i, 3],
  [/\bчетверт[а-яії]*\s+розділ/i, 4],
  [/\bп['ʼ’]?ят[а-яії]*\s+розділ/i, 5],
  [/\bшост[а-яії]*\s+розділ/i, 6],
];

// Розпізнає явно вказану клієнтом кількість розділів у вільному тексті (коментар/матеріали клієнта) —
// цифрою ("3 розділи"), кардинальним числівником ("три розділи") або порядковим числівником, що натякає
// на мінімальну кількість розділів ("третій розділ — ...", тобто розділів щонайменше 3).
export function detectRequestedChapterCount(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  const digitMatch = t.match(/(\d+)\s*розділ/i);
  if (digitMatch) return parseInt(digitMatch[1], 10);
  for (const [re, n] of CARDINAL_CHAPTER_WORDS) if (re.test(t)) return n;
  let maxOrdinal = 0;
  for (const [re, n] of ORDINAL_CHAPTER_WORDS) if (re.test(t)) maxOrdinal = Math.max(maxOrdinal, n);
  return maxOrdinal || null;
}

// Вставляє нові розділи/підрозділи в кінець "основних" розділів — перед Висновками
// чи Списком джерел (вони, на відміну від Вступу, завжди останні незалежно від
// попередніх переміщень стрілками ↑/↓), інакше в кінець масиву.
export function insertBeforeTail(sections, newItems) {
  let idx = sections.findIndex(s => s.type === "conclusions");
  if (idx < 0) idx = sections.findIndex(s => s.type === "sources");
  return idx >= 0
    ? [...sections.slice(0, idx), ...newItems, ...sections.slice(idx)]
    : [...sections, ...newItems];
}

export function buildPlanText(secs) {
  const intro = secs.find(s => s.type === "intro");
  const concs = secs.find(s => s.type === "conclusions");
  const srcs = secs.find(s => s.type === "sources");
  const main = secs.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
  // Auto-detect chapter word from existing section titles so we never mix languages
  const detectedChapWord = (() => {
    for (const s of main) {
      const m = (s.sectionTitle || "").match(/^(РОЗДІЛ|CHAPTER|ROZDZIAŁ|CAP[IÍ]TULO|CAPITULO|KAPITEL|KAPITOLA|第\d*章)/i);
      if (m) return m[1].toUpperCase();
    }
    return "РОЗДІЛ";
  })();
  const lines = [];
  if (intro) lines.push((intro.label || "ВСТУП") + "\n");
  const groups = {};
  for (const s of main) { const top = s.id.split(".")[0]; if (!groups[top]) groups[top] = []; groups[top].push(s); }
  for (const [num, items] of Object.entries(groups)) {
    const rawTitle = items[0].sectionTitle || items[0].label.replace(/^\d+\.\d+\s+/, "").split(" ").slice(0, 7).join(" ").toUpperCase();
    const alreadyHasPrefix = /^(РОЗДІЛ|CHAPTER|ROZDZIAŁ|CAP[IÍ]TULO|CAPITULO|KAPITEL|KAPITOLA|第\d*章)/i.test(rawTitle.trim());
    const secLabel = alreadyHasPrefix ? rawTitle.trim() : `${detectedChapWord} ${num}. ${rawTitle}`;
    lines.push(secLabel);
    for (const s of items) { if (/^\d+\.\d+/.test(s.id)) lines.push(`    ${s.label}`); }
    const chapConc = secs.find(s => s.type === "chapter_conclusion" && s.id === `${num}.conclusions`);
    if (chapConc) lines.push(`    ${chapConc.label}`);
    lines.push("");
  }
  if (concs) lines.push((concs.label || "ВИСНОВКИ") + "\n");
  if (srcs) lines.push(srcs.label || "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ");
  return lines.join("\n");
}

export function buildPreviewStructure(totalPages) {
  return [
    { label: "ВСТУП", sub: [] },
    { label: "РОЗДІЛ 1. Теоретичні основи дослідження", sub: ["1.1 [підрозділ 1.1]", "1.2 [підрозділ 1.2]", "1.3 [підрозділ 1.3]"] },
    { label: "РОЗДІЛ 2. Аналітично-практична частина", sub: ["2.1 [підрозділ 2.1]", "2.2 [підрозділ 2.2]", "2.3 [підрозділ 2.3]"] },
    ...(totalPages >= 70 ? [{ label: "РОЗДІЛ 3. Рекомендації та пропозиції", sub: ["3.1 [підрозділ 3.1]", "3.2 [підрозділ 3.2]"] }] : []),
    { label: "ВИСНОВКИ", sub: [] },
    { label: "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", sub: [] },
  ];
}

export function calcSourceDist(secs) {
  const mainSecs = secs.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
  const secPagesSum = mainSecs.reduce((sum, s) => sum + (s.pages || 0), 0);
  if (!secPagesSum) return { dist: {}, total: 0 };
  // 1 джерело на 1 сторінку ОСНОВНОГО тексту — усе від Розділу 1 до Висновків (не
  // включно): підрозділи розділів + "Висновки до розділу N", БЕЗ Вступу, Висновків
  // і Списку джерел (їх обсяг з кількістю використаної літератури не пов'язаний).
  const total = secs.reduce((sum, s) =>
    ["intro", "conclusions", "sources"].includes(s.type) ? sum : sum + (s.pages || 0), 0);
  const minPerSec = Math.max(1, Math.floor(total / mainSecs.length / 2));
  // Пропорційна частка (дробова) кожного підрозділу за обсягом сторінок, не нижче minPerSec
  const raw = mainSecs.map(s => Math.max(minPerSec, (s.pages / secPagesSum) * total));
  const floors = raw.map(v => Math.floor(v));
  let remainder = Math.round(total) - floors.reduce((a, b) => a + b, 0);
  // Метод найбільших остач: залишок від округлення розподіляємо по одному джерелу
  // підрозділам з найбільшою дробовою частиною — а не скидаємо все на останній підрозділ
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  const result = [...floors];
  for (let k = 0; k < order.length && remainder > 0; k++) { result[order[k].i] += 1; remainder--; }
  const dist = {};
  mainSecs.forEach((s, i) => { dist[s.id] = result[i]; });
  return { dist, total: Object.values(dist).reduce((a, b) => a + b, 0) };
}

// ── Перенумерація id/назв розділів і підрозділів після перебудови плану (переміщення,
// додавання, видалення) — розділи нумеруються за порядком першої появи їхнього
// sectionTitle у масиві, підрозділи — послідовно в межах свого розділу. Раніше жила
// лише в academic-assistant.jsx (для стрілок ↑/↓); винесена сюди, щоб її ж міг
// використати applyPlanEditOps нижче — без дублювання логіки.
export function renumberSections(sections) {
  const chapterTitles = [];
  sections.forEach(s => {
    if (!["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type) && s.sectionTitle) {
      if (!chapterTitles.includes(s.sectionTitle)) chapterTitles.push(s.sectionTitle);
    }
  });
  const chNumMap = {};
  chapterTitles.forEach((title, idx) => { chNumMap[title] = idx + 1; });
  const chTitleMap = {};
  chapterTitles.forEach(title => {
    const newN = chNumMap[title];
    const match = title.match(/^РОЗДІЛ\s+\d+[.:]?\s*(.*)/i);
    const rest = match ? match[1] : title;
    chTitleMap[title] = `РОЗДІЛ ${newN}. ${rest}`.trimEnd();
  });
  const subCount = {};
  let lastChNum = 1;
  return sections.map(s => {
    if (["intro", "conclusions", "sources"].includes(s.type)) return s;
    if (s.type === "chapter_conclusion") {
      const newTitle = chTitleMap[s.sectionTitle] || s.sectionTitle;
      return { ...s, id: `${lastChNum}.conclusions`, sectionTitle: newTitle };
    }
    const cn = chNumMap[s.sectionTitle] || 1;
    lastChNum = cn;
    if (!subCount[cn]) subCount[cn] = 0;
    subCount[cn]++;
    const newId = `${cn}.${subCount[cn]}`;
    const newTitle = chTitleMap[s.sectionTitle] || s.sectionTitle;
    const labelBody = s.label.replace(/^\d+\.\d+\s*/, "");
    return { ...s, id: newId, sectionTitle: newTitle, label: `${newId} ${labelBody}` };
  });
}

// ── Перезбирає повний масив sections з intro/conclusions/sources/висновків-до-розділу
// (взятих із prev) навколо нового порядку основних підрозділів (newMainSecs) —
// висновки до розділу прив'язуються позиційно до i-го розділу в новому порядку.
export function rebuildWithChapterConclusions(prev, newMainSecs) {
  const intro = prev.filter(s => s.type === "intro");
  const conclusions = prev.filter(s => s.type === "conclusions");
  const sources = prev.filter(s => s.type === "sources");
  const chapConcs = prev
    .filter(s => s.type === "chapter_conclusion")
    .sort((a, b) => (parseInt(a.id) || 0) - (parseInt(b.id) || 0));
  const chapTitles = [];
  const chapSecs = {};
  newMainSecs.forEach(s => {
    if (!chapSecs[s.sectionTitle]) { chapTitles.push(s.sectionTitle); chapSecs[s.sectionTitle] = []; }
    chapSecs[s.sectionTitle].push(s);
  });
  const result = [...intro];
  chapTitles.forEach((title, i) => {
    result.push(...chapSecs[title]);
    if (chapConcs[i]) result.push(chapConcs[i]);
  });
  result.push(...conclusions, ...sources);
  return result;
}

// ── Людський опис однієї операції правки плану (для прев'ю перед застосуванням) —
// формується кодом з полів операції й поточного sections, а не з тексту від ШІ,
// щоб опис завжди точно відповідав тому, що реально застосується.
export function describePlanEditOp(op, sections) {
  const findLabel = (id) => {
    if (id === "intro") return sections.find(s => s.type === "intro")?.label ?? null;
    if (id === "conclusions") return sections.find(s => s.type === "conclusions")?.label ?? null;
    if (id === "sources") return sections.find(s => s.type === "sources")?.label ?? null;
    return sections.find(s => s.id === id)?.label ?? null;
  };
  switch (op.op) {
    case "rename": {
      const old = findLabel(op.id);
      if (old == null) return { text: `Перейменувати ${op.id} — не знайдено в плані, пропущено`, invalid: true };
      return { text: `Перейменувати «${old}» → «${op.newLabel}»` };
    }
    case "rename_chapter": {
      const target = sections.find(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type) && s.id.split(".")[0] === String(op.chapterId));
      if (!target) return { text: `Перейменувати розділ ${op.chapterId} — не знайдено, пропущено`, invalid: true };
      return { text: `Перейменувати розділ ${op.chapterId}: «${target.sectionTitle}» → «${op.newTitle}»` };
    }
    case "resize": {
      const old = op.id === "intro" || op.id === "conclusions" || op.id === "sources"
        ? sections.find(s => s.type === op.id)
        : sections.find(s => s.id === op.id);
      if (!old) return { text: `Змінити обсяг ${op.id} — не знайдено, пропущено`, invalid: true };
      return { text: `Обсяг «${old.label}»: ${old.pages} → ${op.newPages} стор.` };
    }
    case "remove": {
      const old = findLabel(op.id);
      if (old == null) return { text: `Видалити ${op.id} — не знайдено, пропущено`, invalid: true };
      return { text: `Видалити: «${old}»` };
    }
    case "add_subsection":
      return { text: `Додати підрозділ у розділ ${op.chapterId}: «${op.label || "новий підрозділ"}» (${op.pages || 3} стор.)` };
    case "add_chapter":
      return { text: `Додати новий розділ: «${op.title || "новий розділ"}»${op.subsections?.length ? ` (${op.subsections.length} підрозділ.)` : ""}` };
    default:
      return { text: `Невідома операція «${op.op}»`, invalid: true };
  }
}

// ── Детерміноване застосування розпізнаних ШІ операцій правки плану до sections.
// ШІ лише перетворює вільний текст клієнта на структуровані операції (planUtils
// цього не вміє — це вимагає розуміння мови); саму мутацію масиву sections
// завжди виконує код нижче, а не ШІ, щоб результат був передбачуваним.
export function applyPlanEditOps(sections, ops, lang = "Українська") {
  const lc = getLangLabels(lang);
  let mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
  const special = {
    intro: sections.find(s => s.type === "intro") || null,
    conclusions: sections.find(s => s.type === "conclusions") || null,
    sources: sections.find(s => s.type === "sources") || null,
  };
  let chapConcs = sections.filter(s => s.type === "chapter_conclusion");
  let tmpCounter = 0;

  for (const op of ops) {
    switch (op.op) {
      case "rename": {
        if (["intro", "conclusions", "sources"].includes(op.id)) {
          if (special[op.id]) special[op.id] = { ...special[op.id], label: op.newLabel };
        } else {
          mainSecs = mainSecs.map(s => s.id === op.id ? { ...s, label: op.newLabel } : s);
        }
        break;
      }
      case "rename_chapter": {
        const target = mainSecs.find(s => s.id.split(".")[0] === String(op.chapterId));
        if (target) {
          const oldTitle = target.sectionTitle;
          const newTitle = `${lc.chapterWord} ${op.chapterId}. ${op.newTitle}`;
          mainSecs = mainSecs.map(s => s.sectionTitle === oldTitle ? { ...s, sectionTitle: newTitle } : s);
          chapConcs = chapConcs.map(s => s.sectionTitle === oldTitle ? { ...s, sectionTitle: newTitle } : s);
        }
        break;
      }
      case "resize": {
        const newPages = Math.max(1, parseInt(op.newPages) || 1);
        const resize = (s) => ({ ...s, pages: newPages, prompts: s.type === "sources" ? 0 : Math.max(1, Math.ceil(newPages / 3)) });
        if (["intro", "conclusions", "sources"].includes(op.id)) {
          if (special[op.id]) special[op.id] = resize(special[op.id]);
        } else {
          mainSecs = mainSecs.map(s => s.id === op.id ? resize(s) : s);
        }
        break;
      }
      case "remove": {
        mainSecs = mainSecs.filter(s => s.id !== op.id);
        break;
      }
      case "add_subsection": {
        const chapterSecs = mainSecs.filter(s => s.id.split(".")[0] === String(op.chapterId));
        if (!chapterSecs.length) break;
        const sectionTitle = chapterSecs[0].sectionTitle;
        const type = chapterSecs[0].type;
        const pages = Math.max(1, parseInt(op.pages) || 3);
        const newSec = { id: `_new_${tmpCounter++}`, label: op.label || `[${lc.subsWord}]`, sectionTitle, pages, prompts: Math.max(1, Math.ceil(pages / 3)), type };
        const afterIdx = op.afterId ? mainSecs.findIndex(s => s.id === op.afterId) : -1;
        if (afterIdx >= 0) {
          mainSecs = [...mainSecs.slice(0, afterIdx + 1), newSec, ...mainSecs.slice(afterIdx + 1)];
        } else {
          let lastIdx = -1;
          mainSecs.forEach((s, i) => { if (s.id.split(".")[0] === String(op.chapterId)) lastIdx = i; });
          mainSecs = lastIdx >= 0
            ? [...mainSecs.slice(0, lastIdx + 1), newSec, ...mainSecs.slice(lastIdx + 1)]
            : [...mainSecs, newSec];
        }
        break;
      }
      case "add_chapter": {
        const maxCh = mainSecs.reduce((m, s) => Math.max(m, parseInt(s.id.split(".")[0]) || 0), 0);
        const chapNum = maxCh + 1;
        const chTypes = ["theory", "analysis", "recommendations"];
        const chType = chTypes[Math.min(chapNum - 1, chTypes.length - 1)];
        const sectionTitle = `${lc.chapterWord} ${chapNum}. ${op.title || "[Назва розділу]"}`;
        const subsInput = op.subsections?.length ? op.subsections : [{}, {}, {}];
        const newSubs = subsInput.map((sub) => {
          const pages = Math.max(1, parseInt(sub.pages) || 3);
          return { id: `_new_${tmpCounter++}`, label: sub.label || `[${lc.subsWord}]`, sectionTitle, pages, prompts: Math.max(1, Math.ceil(pages / 3)), type: chType };
        });
        mainSecs = [...mainSecs, ...newSubs];
        break;
      }
      default: break;
    }
  }

  const pseudoPrev = [special.intro, special.conclusions, special.sources, ...chapConcs].filter(Boolean);
  const rebuilt = rebuildWithChapterConclusions(pseudoPrev, mainSecs);
  return renumberSections(rebuilt);
}

export function buildWorkConfig({ info, methodInfo, commentAnalysis }) {
  const totalPages = parsePagesAvg(info?.pages);

  let introPages = 2;
  if (methodInfo?.introPages) {
    introPages = methodInfo.introPages;
  } else if (commentAnalysis?.textStructureHints) {
    const m = commentAnalysis.textStructureHints.match(/вступ[^.\d]{0,20}(\d+)\s*стор/i);
    if (m && !/більше|максимум|перевищ/i.test(m[0])) introPages = parseInt(m[1]);
  }

  let conclusionsPages = totalPages > 40 ? 3 : 2;
  if (methodInfo?.conclusionsPages) {
    conclusionsPages = methodInfo.conclusionsPages;
  } else if (commentAnalysis?.textStructureHints) {
    const m = commentAnalysis.textStructureHints.match(/висновк[^.\d]{0,20}(\d+)\s*стор/i);
    if (m && !/більше|максимум|перевищ/i.test(m[0])) conclusionsPages = parseInt(m[1]);
  }

  const sourcesMinCount = methodInfo?.sourcesMinCount || (totalPages >= 40 ? 40 : 20);

  return {
    totalPages,
    introPages,
    conclusionsPages,
    chapConclusionPages: 1,
    sourcesMinCount,
    sourcesStyle: methodInfo?.sourcesStyle || (/APA/i.test((methodInfo?.otherRequirements || "") + " " + (methodInfo?.citationStyle || "")) ? "APA" : /MLA/i.test((methodInfo?.otherRequirements || "") + " " + (methodInfo?.citationStyle || "")) ? "MLA" : "ДСТУ 8302:2015"),
    sourcesOrder: methodInfo?.sourcesOrder || "alphabetical",
    sourcesGrouping: methodInfo?.sourcesGrouping || "",
    citationStyle: methodInfo?.citationStyle || "(Автор, рік)",
  };
}
