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

// Визначає підрозділи що мають отримати інструкції емпіричного дослідження
export const getEmpiricalSections = (sections, info) => {
  const empty = { anchorId: null, chapterSectionIds: [] };
  if (!isPsychoPed(info)) return empty;

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

  // Варіант 1: ключових слів немає → один найкращий підрозділ
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

export const STAGES = ["Дані", "Перевірка", "План", "Написання", "Джерела", "Готово"];
export const STAGE_KEYS = ["input", "parsed", "plan", "writing", "sources", "done"];

// Статуси для Firestore
export const ORDER_STATUS = {
  input: "new",
  parsed: "new",
  plan: "plan_ready",
  writing: "writing",
  sources: "writing",
  done: "done",
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

export function parseClientPlan(text, totalPages) {
  const normalized = text
    .replace(/([^\n])\s+(Розділ\s)/gi, "$1\n$2")
    .replace(/([^\n])\s+(Chapter\s)/gi, "$1\n$2")
    .replace(/([^\n])\s+(висновк\w*)/gi, "$1\n$2")
    .replace(/([^\n])\s+(список\s)/gi, "$1\n$2")
    .replace(/([^\n])\s+(вступ\s|вступ$)/gi, "$1\n$2");
  const lines = normalized.split("\n").map(l => l.trim()).filter(Boolean);
  const chapters = []; let current = null;
  for (const line of lines) {
    const isChapter = /^розділ\s/i.test(line) || /^chapter\s/i.test(line) || /^\d+[\.\)]\s+[А-ЯҐЄІЇа-яґєії]/i.test(line);
    const isSubsection = /^\d+\.\d+/.test(line) || /^[-–•]\s+/.test(line);
    const isChapterConclusion = /^висновк[^\s]*\s+до\s+/i.test(line);
    const isSpecial = !isChapterConclusion && /^(вступ[\s,\.!]?$|вступ\s|висновк|список|загальн|практичн|додатк|зміст)/i.test(line);
    if (isSpecial) continue;
    if (isChapterConclusion && current) { current.hasConclusion = true; continue; }
    if (isChapter) { current = { title: line.trim(), subsections: [], hasConclusion: false }; chapters.push(current); }
    else if (isSubsection && current) current.subsections.push(line.replace(/^[-–•]\s+/, "").trim());
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
      sections.push({ id: `${chapNum}.conclusions`, label: `Висновки до розділу ${chapNum}`, sectionTitle: ch.title.toUpperCase(), pages: 1, type: "chapter_conclusion", chapterNum: String(chapNum) });
    }
  }
  sections.push({ id: "intro", label: "ВСТУП", pages: introPages, type: "intro" });
  sections.push({ id: "conclusions", label: "ВИСНОВКИ", pages: concPages, type: "conclusions" });
  sections.push({ id: "sources", label: "СПИСОК ВИКОРИСТАНИХ ДЖЕРЕЛ", pages: 1, type: "sources" });
  return sections;
}

export function buildPlanText(secs) {
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
    sourcesStyle: methodInfo?.sourcesStyle || "ДСТУ 8302:2015",
    sourcesOrder: methodInfo?.sourcesOrder || "alphabetical",
    sourcesGrouping: methodInfo?.sourcesGrouping || "",
    citationStyle: methodInfo?.citationStyle || "(Автор, рік)",
  };
}
