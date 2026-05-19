export function getLangLabels(lang = "Українська") {
  const l = (lang || "").toLowerCase();
  // latinScript: true = мова використовує латиницю (не забороняємо її в тексті)
  if (/англ|english/.test(l))      return { intro: "INTRODUCTION",  conclusions: "CONCLUSIONS",      sources: "REFERENCES",                 chapConclLabel: n => `Conclusions to Chapter ${n}`,       chapterWord: "CHAPTER",   subsWord: "subsection",  chapterTemplate: ["CHAPTER 1. THEORETICAL FOUNDATIONS", "CHAPTER 2. ANALYSIS AND PRACTICAL PART", "CHAPTER 3. RECOMMENDATIONS AND PROPOSALS"],  tableWord: "Table",    figWord: "Fig.",   tableRef: "shown in Table",            figRef: "shown in Fig.",            forbiddenWords: "aspect, important, special, significant, key, critical, fundamental",  latinScript: true, toc: "TABLE OF CONTENTS", appendixWord: "APPENDICES", introLabels: { actuality: "Relevance of the topic.", goal: "The purpose of the study –", tasks: "Research objectives:", object: "Object of study –", subject: "Subject of study –", methods: "Research methods:", novelty: "Scientific novelty –", practical: "Practical significance:", approbation: "Approbation of results –", structure: "Structure of the work:", theoryBasis: "The theoretical basis is" }, defaultIntroComponents: ["relevance of the topic", "purpose of the study", "research objectives", "object of study", "subject of study", "research methods", "practical significance", "structure of the work"] };
  if (/польськ|polish/.test(l))    return { intro: "WSTĘP",         conclusions: "WNIOSKI",          sources: "BIBLIOGRAFIA",               chapConclLabel: n => `Wnioski do rozdziału ${n}`,          chapterWord: "ROZDZIAŁ",  subsWord: "podrozdział", chapterTemplate: ["ROZDZIAŁ 1. PODSTAWY TEORETYCZNE BADANIA", "ROZDZIAŁ 2. ANALIZA I CZĘŚĆ PRAKTYCZNA", "ROZDZIAŁ 3. WNIOSKI I ZALECENIA"],             tableWord: "Tabela",   figWord: "Rys.",   tableRef: "przedstawiono w Tabeli",    figRef: "pokazano na Rys.",         forbiddenWords: "aspekt, ważny, szczególny, znaczący, kluczowy, krytyczny, fundamentalny", latinScript: true, toc: "SPIS TREŚCI", appendixWord: "DODATKI", introLabels: { actuality: "Aktualność tematu.", goal: "Cel badania –", tasks: "Zadania badania:", object: "Przedmiot badania –", subject: "Obiekt badania –", methods: "Metody badania:", novelty: "Naukowa nowość badania –", practical: "Znaczenie praktyczne:", approbation: "Aprobata wyników –", structure: "Struktura pracy:", theoryBasis: "Podstawy teoretyczno-metodologiczne stanowią" }, defaultIntroComponents: ["aktualność tematu", "cel badania", "zadania badania", "przedmiot badania", "obiekt badania", "metody badania", "znaczenie praktyczne badania", "struktura pracy"] };
  if (/іспан|spanish|español|espanol/.test(l)) return { intro: "INTRODUCCIÓN", conclusions: "CONCLUSIONES", sources: "BIBLIOGRAFÍA",        chapConclLabel: n => `Conclusiones del capítulo ${n}`,    chapterWord: "CAPÍTULO",  subsWord: "sección",     chapterTemplate: ["CAPÍTULO 1. FUNDAMENTOS TEÓRICOS DE LA INVESTIGACIÓN", "CAPÍTULO 2. ANÁLISIS Y PARTE PRÁCTICA", "CAPÍTULO 3. RECOMENDACIONES Y PROPUESTAS"], tableWord: "Tabla",    figWord: "Fig.",   tableRef: "se muestra en la Tabla",    figRef: "se muestra en la Fig.",    forbiddenWords: "aspecto, importante, especial, significativo, clave, crítico, fundamental", latinScript: true, toc: "ÍNDICE", appendixWord: "APÉNDICES", introLabels: { actuality: "Relevancia del tema.", goal: "El objetivo del estudio –", tasks: "Tareas de investigación:", object: "Objeto de estudio –", subject: "Sujeto de estudio –", methods: "Métodos de investigación:", novelty: "Novedad científica –", practical: "Significado práctico:", approbation: "Aprobación de resultados –", structure: "Estructura del trabajo:", theoryBasis: "La base teórico-metodológica es" }, defaultIntroComponents: ["relevancia del tema", "objetivo del estudio", "tareas de investigación", "objeto de estudio", "sujeto de estudio", "métodos de investigación", "significado práctico", "estructura del trabajo"] };
  if (/нім|german|deutsch/.test(l)) return { intro: "EINLEITUNG",   conclusions: "SCHLUSSFOLGERUNGEN", sources: "LITERATURVERZEICHNIS",     chapConclLabel: n => `Schlussfolgerungen zu Kapitel ${n}`, chapterWord: "KAPITEL",   subsWord: "Unterkapitel",chapterTemplate: ["KAPITEL 1. THEORETISCHE GRUNDLAGEN DER UNTERSUCHUNG", "KAPITEL 2. ANALYSE UND PRAKTISCHER TEIL", "KAPITEL 3. EMPFEHLUNGEN UND VORSCHLÄGE"],       tableWord: "Tabelle",  figWord: "Abb.",   tableRef: "in Tabelle dargestellt",    figRef: "in Abb. gezeigt",          forbiddenWords: "Aspekt, wichtig, besonders, bedeutend, entscheidend, kritisch, grundlegend", latinScript: true, toc: "INHALTSVERZEICHNIS", appendixWord: "ANHÄNGE", introLabels: { actuality: "Relevanz des Themas.", goal: "Das Ziel der Arbeit –", tasks: "Forschungsaufgaben:", object: "Untersuchungsobjekt –", subject: "Untersuchungsgegenstand –", methods: "Forschungsmethoden:", novelty: "Wissenschaftliche Neuheit –", practical: "Praktische Bedeutung:", approbation: "Approbation der Ergebnisse –", structure: "Struktur der Arbeit:", theoryBasis: "Die theoretisch-methodologische Grundlage bilden" }, defaultIntroComponents: ["Relevanz des Themas", "Ziel der Arbeit", "Forschungsaufgaben", "Untersuchungsobjekt", "Untersuchungsgegenstand", "Forschungsmethoden", "Praktische Bedeutung", "Struktur der Arbeit"] };
  if (/чеськ|czech/.test(l))       return { intro: "ÚVOD",          conclusions: "ZÁVĚR",            sources: "SEZNAM POUŽITÉ LITERATURY",  chapConclLabel: n => `Závěry ke kapitole ${n}`,           chapterWord: "KAPITOLA",  subsWord: "podkapitola", chapterTemplate: ["KAPITOLA 1. TEORETICKÉ ZÁKLADY VÝZKUMU", "KAPITOLA 2. ANALÝZA A PRAKTICKÁ ČÁST", "KAPITOLA 3. DOPORUČENÍ A NÁVRHY"],                     tableWord: "Tabulka",  figWord: "Obr.",   tableRef: "uvedeno v Tabulce",         figRef: "znázorněno na Obr.",       forbiddenWords: "aspekt, důležitý, zvláštní, významný, klíčový, kritický, základní", latinScript: true, toc: "OBSAH", appendixWord: "PŘÍLOHY", introLabels: { actuality: "Aktuálnost tématu.", goal: "Cíl práce –", tasks: "Úkoly výzkumu:", object: "Objekt výzkumu –", subject: "Předmět výzkumu –", methods: "Výzkumné metody:", novelty: "Vědecká novost –", practical: "Praktický přínos:", approbation: "Aprobace výsledků –", structure: "Struktura práce:", theoryBasis: "Teoreticko-metodologickým základem je" }, defaultIntroComponents: ["aktuálnost tématu", "cíl práce", "úkoly výzkumu", "objekt výzkumu", "předmět výzkumu", "výzkumné metody", "praktický přínos", "struktura práce"] };
  if (/словацьк|slovak/.test(l))   return { intro: "ÚVOD",          conclusions: "ZÁVER",            sources: "ZOZNAM POUŽITEJ LITERATÚRY", chapConclLabel: n => `Závery ku kapitole ${n}`,           chapterWord: "KAPITOLA",  subsWord: "podkapitola", chapterTemplate: ["KAPITOLA 1. TEORETICKÉ ZÁKLADY VÝSKUMU", "KAPITOLA 2. ANALÝZA A PRAKTICKÁ ČASŤ", "KAPITOLA 3. ODPORÚČANIA A NÁVRHY"],                   tableWord: "Tabuľka",  figWord: "Obr.",   tableRef: "uvedené v Tabuľke",         figRef: "znázornené na Obr.",       forbiddenWords: "aspekt, dôležitý, špeciálny, významný, kľúčový, kritický, základný", latinScript: true, toc: "OBSAH", appendixWord: "PRÍLOHY", introLabels: { actuality: "Aktuálnosť témy.", goal: "Cieľ práce –", tasks: "Úlohy výskumu:", object: "Objekt výskumu –", subject: "Predmet výskumu –", methods: "Výskumné metódy:", novelty: "Vedecká novosť –", practical: "Praktický prínos:", approbation: "Aprobácia výsledkov –", structure: "Štruktúra práce:", theoryBasis: "Teoreticko-metodologickým základom je" }, defaultIntroComponents: ["aktuálnosť témy", "cieľ práce", "úlohy výskumu", "objekt výskumu", "predmet výskumu", "výskumné metódy", "praktický prínos", "štruktúra práce"] };
  if (/китайськ|chinese|中文/.test(l)) return { intro: "引言",      conclusions: "结论",             sources: "参考文献",                    chapConclLabel: n => `第${n}章结论`,                      chapterWord: "第",        subsWord: "小节",        chapterTemplate: ["第1章. 研究的理论基础", "第2章. 分析与实践部分", "第3章. 建议与对策"],                                                                              tableWord: "表",       figWord: "图",     tableRef: "如表所示",                  figRef: "如图所示",                 forbiddenWords: "方面, 重要, 特殊, 显著, 关键, 批判, 基本", latinScript: false, toc: "目录", appendixWord: "附录", introLabels: { actuality: "选题意义：", goal: "研究目的：", tasks: "研究任务：", object: "研究对象：", subject: "研究主题：", methods: "研究方法：", novelty: "科学新颖性：", practical: "实践意义：", approbation: "成果鉴定：", structure: "论文结构：", theoryBasis: "理论方法论基础为" }, defaultIntroComponents: ["选题意义", "研究目的", "研究任务", "研究对象", "研究主题", "研究方法", "实践意义", "论文结构"] };
  return { intro: "ВСТУП", conclusions: "ВИСНОВКИ", sources: "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", chapConclLabel: n => `Висновки до розділу ${n}`, chapterWord: "РОЗДІЛ", subsWord: "підрозділ", chapterTemplate: ["РОЗДІЛ 1. ТЕОРЕТИЧНІ ОСНОВИ ДОСЛІДЖЕННЯ", "РОЗДІЛ 2. АНАЛІЗ ТА ПРАКТИЧНА ЧАСТИНА", "РОЗДІЛ 3. РЕКОМЕНДАЦІЇ ТА ПРОПОЗИЦІЇ"], tableWord: "Таблиця", figWord: "Рис.", tableRef: "наведено в Таблиці", figRef: "показано на Рис.", forbiddenWords: "аспект, важливий, особливий, значущий, ключовий, критичний, фундаментальний", latinScript: false, toc: "ЗМІСТ", appendixWord: "ДОДАТКИ", introLabels: { actuality: "Актуальність теми.", goal: "Мета дослідження –", tasks: "Завдання дослідження:", object: "Об'єкт дослідження –", subject: "Предмет дослідження –", methods: "Методи дослідження:", novelty: "Наукова новизна дослідження –", practical: "Практична значущість:", approbation: "Апробація результатів дослідження –", structure: "Структура роботи:", theoryBasis: "Теоретико-методологічну основу дослідження становлять" }, defaultIntroComponents: ["актуальність теми", "мета дослідження", "завдання дослідження", "об'єкт дослідження", "предмет дослідження", "методи дослідження", "практичне значення дослідження", "структура роботи"] };
}

export const FIELD_LABELS = {
  type: "Тип роботи", pages: "К-сть сторінок", topic: "Тема роботи",
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

export const STAGES_SOURCES_FIRST = ["Дані", "Перевірка", "План", "Джерела", "Написання", "Готово", "Чек-лист", "Правки"];
export const STAGE_KEYS_SOURCES_FIRST = ["input", "parsed", "plan", "sources", "writing", "done", "checklist", "corrections"];

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
  corrections: "corrections",
};

// Дефолт 80 — для великих академічних робіт (курсова, дипломна). Мала версія в shared.jsx має дефолт 20.
export function parsePagesAvg(str) {
  if (!str) return 80;
  const nums = String(str).match(/\d+/g);
  if (!nums) return 80;
  if (nums.length === 1) return parseInt(nums[0]);
  return Math.round(nums.reduce((a, b) => a + parseInt(b), 0) / nums.length);
}

export function parseTemplate(text) {
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
      current = { title: line.trim(), subsections: [], hasConclusion: false };
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
    if (ch.hasConclusion) {
      sections.push({ id: `${chapNum}.conclusions`, label: chapConclLabel(chapNum), sectionTitle: ch.title.toUpperCase(), pages: 1, type: "chapter_conclusion", chapterNum: String(chapNum) });
    }
  }
  sections.push({ id: "intro", label: introLabel, pages: introPages, type: "intro" });
  sections.push({ id: "conclusions", label: conclLabel, pages: concPages, type: "conclusions" });
  sections.push({ id: "sources", label: srcLabel, pages: 1, type: "sources" });
  return sections;
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

export function calcSourceDist(secs, overallPages) {
  const mainSecs = secs.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
  const secPagesSum = mainSecs.reduce((sum, s) => sum + (s.pages || 0), 0);
  if (!secPagesSum) return { dist: {}, total: 0 };
  const total = Math.max(mainSecs.length * 2, overallPages || secPagesSum);
  const minPerSec = Math.max(1, Math.floor(total / mainSecs.length / 2));
  const dist = {}; let assigned = 0;
  mainSecs.forEach((s, i) => {
    if (i === mainSecs.length - 1) { dist[s.id] = Math.max(minPerSec, total - assigned); }
    else { const share = Math.max(minPerSec, Math.round((s.pages / secPagesSum) * total)); dist[s.id] = share; assigned += share; }
  });
  return { dist, total: Object.values(dist).reduce((a, b) => a + b, 0) };
}

export function buildWorkConfig({ info, methodInfo, commentAnalysis }) {
  const totalPages = parsePagesAvg(info?.pages);

  let introPages = 2;
  if (methodInfo?.introPages) {
    introPages = methodInfo.introPages;
  } else if (commentAnalysis?.textStructureHints) {
    const m = commentAnalysis.textStructureHints.match(/вступ[^.\d]{0,20}(\d+)\s*стор/i);
    if (m) introPages = parseInt(m[1]);
  }

  let conclusionsPages = totalPages > 40 ? 3 : 2;
  if (methodInfo?.conclusionsPages) {
    conclusionsPages = methodInfo.conclusionsPages;
  } else if (commentAnalysis?.textStructureHints) {
    const m = commentAnalysis.textStructureHints.match(/висновк[^.\d]{0,20}(\d+)\s*стор/i);
    if (m) conclusionsPages = parseInt(m[1]);
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
