// Довідник по практиці: напрям (той самий список, що й SPECIALTY_MAP в academicDefaults.js)
// × вид практики (навчальна/виробнича/переддипломна) → мета, зміст звіту, завдання щоденника,
// додатки, особливість.
//
// PRACTICE_TABLE поки порожня — контент чекає на чистий (непошкоджений) текст довідника від
// користувача. getPracticeGuidance() безпечно повертає null, доки конкретний напрям не заповнено,
// і виклики в prompts.js це враховують.

export const PRACTICE_TYPES = [
  { key: "navchalna",      label: "Навчальна" },
  { key: "vyrobnycha",     label: "Виробнича" },
  { key: "perededyplomna", label: "Переддипломна" },
];

// Людські назви напрямів для UI (той самий перелік ключів, що й SPECIALTY_MAP)
export const CATEGORY_LABELS = {
  psychology:       { label: "Психологія",                              icon: "🧠" },
  sociology:        { label: "Соціологія",                              icon: "👥" },
  social_work:      { label: "Соціальна робота",                        icon: "🤝" },
  philology:        { label: "Філологія / Мовознавство",                icon: "📖" },
  translation:      { label: "Переклад",                                icon: "🌐" },
  history:          { label: "Історія",                                 icon: "🏛️" },
  philosophy:       { label: "Філософія",                               icon: "💭" },
  political_sci:    { label: "Політологія",                             icon: "🗳️" },
  intl_relations:   { label: "Міжнародні відносини",                    icon: "🌍" },
  journalism:       { label: "Журналістика / Медіа",                    icon: "📰" },
  cultural_studies: { label: "Культурологія / Релігієзнавство",         icon: "⛩️" },
  preschool:        { label: "Дошкільна освіта",                        icon: "🧸" },
  special_edu:      { label: "Спеціальна освіта / Логопедія",           icon: "🗣️" },
  pedagogy:         { label: "Педагогіка / Початкова освіта",           icon: "📚" },
  sport:            { label: "Фізична культура і спорт",                icon: "🏃" },
  law:              { label: "Право / Юриспруденція",                   icon: "⚖️" },
  public_admin:     { label: "Публічне управління / Держслужба",        icon: "🏢" },
  management:       { label: "Менеджмент",                              icon: "📈" },
  finance:          { label: "Фінанси / Облік",                         icon: "💰" },
  marketing:        { label: "Маркетинг / Реклама / PR",                icon: "📣" },
  economics:        { label: "Економіка",                               icon: "📊" },
  tourism:          { label: "Туризм / Готельно-ресторанна справа",     icon: "🧳" },
  cybersecurity:    { label: "Кібербезпека",                            icon: "🔒" },
  it:               { label: "ІТ / Комп'ютерні науки",                  icon: "💻" },
  engineering:      { label: "Інженерія",                               icon: "⚙️" },
  construction:     { label: "Будівництво / Архітектура",                icon: "🏗️" },
  natural_sci:      { label: "Природничі науки",                        icon: "🔬" },
  medicine:         { label: "Медицина / Фармація",                     icon: "⚕️" },
  agriculture:      { label: "Аграрні науки / Ветеринарія",              icon: "🌾" },
  design:           { label: "Дизайн",                                   icon: "🎨" },
  art:              { label: "Мистецтво / Музика / Театр",               icon: "🎭" },
};

export const OTHER_CATEGORY = "other";
CATEGORY_LABELS[OTHER_CATEGORY] = { label: "Інший напрям", icon: "📋" };

// TODO: заповнити реальним змістом (мета/reportContent/diaryTasks/appendices/feature)
// після отримання непошкодженого тексту довідника. Структура запису:
// { purpose, reportContent, diaryTasks, appendices, feature }
export const PRACTICE_TABLE = {};

export function getPracticeGuidance(cat, type) {
  return PRACTICE_TABLE?.[cat]?.[type] || null;
}

// Визначає вид практики з номера курсу та/або тексту типу роботи ("Тип" з шаблону замовлення)
export function detectPracticeType(course, typeText) {
  const t = (typeText || "").toLowerCase();
  if (/передипломн|переддипломн/.test(t)) return "perededyplomna";
  if (/навчальн|ознайомч/.test(t)) return "navchalna";
  if (/виробнич/.test(t)) return "vyrobnycha";
  const c = parseInt(course, 10);
  if (!c) return null;
  if (c <= 2) return "navchalna";
  if (c === 4) return "perededyplomna";
  return "vyrobnycha";
}

// Regex-фолбек для деталей практики (місце, керівники, дати, індивідуальне завдання) —
// орієнтується на формат підказки текстового поля "Дані практики" в PracticePage.jsx.
export function parsePracticeDetails(text) {
  const t = text || "";
  const g = (re, fb = "") => { const m = t.match(re); return m ? m[1].trim() : fb; };

  const period = g(/Строки\s*[-–:]\s*(.+?)(?=\n|$)/i);
  const dateRangeRe = /(\d{1,2}[./]\d{1,2}[./]\d{2,4})\s*[-–—]\s*(\d{1,2}[./]\d{1,2}[./]\d{2,4})/;
  const dates = period.match(dateRangeRe) || t.match(dateRangeRe);

  // Число/діапазон може стояти і до, і після слова "джерел" ("не менше 20-25 джерел" або "джерел: 20-25")
  const sourceCountMatch =
    t.match(/(\d+)\s*[-–]\s*(\d+)\s*джерел/i) ||
    t.match(/джерел[а-яіїєґ]*\s*[:\-–]?\s*(?:не менше\s*)?(\d+)\s*[-–]\s*(\d+)/i) ||
    t.match(/(\d+)\s*джерел/i) ||
    t.match(/джерел[а-яіїєґ]*\s*[:\-–]?\s*(?:не менше\s*)?(\d+)/i);

  return {
    companyName: g(/Місце практики\s*[-–:]\s*(.+?)(?=\n|$)/i),
    supervisorCompany: g(/Керівник від підприємства\s*[-–:]\s*(.+?)(?=\n|$)/i),
    supervisorUniversity: g(/Керівник від університету\s*[-–:]\s*(.+?)(?=\n|$)/i),
    individualTask: g(/Індивідуальне завдання\s*[-–:]\s*(.+?)(?=\n|$)/i),
    dateStart: dates ? dates[1] : "",
    dateEnd: dates ? dates[2] : "",
    sourceCount: sourceCountMatch ? (sourceCountMatch[2] ? `${sourceCountMatch[1]}-${sourceCountMatch[2]}` : sourceCountMatch[1]) : "",
    studentName: g(/Студент\s*[-–:]\s*([^,\n]+)/i),
    studentGroup: g(/груп[аи]\s*[-–:]?\s*([А-ЯІЇЄҐA-Z0-9-]+)/i),
    university: g(/(?:університет|заклад вищої освіти)\s*[-–:]\s*(.+?)(?=\n|$)/i),
    faculty: g(/факультет\s*[-–:]?\s*(.+?)(?=\n|$)/i),
    city: g(/м\.\s*([А-ЯІЇЄҐ][а-яіїєґ'’-]+)/i),
  };
}

// Будує рядки титульної сторінки звіту з практики (формат для exportToDocx({titlePageLines})).
// Використовується, лише якщо в методичці НЕ знайдено власного зразка титулки (methodInfo.titlePageTemplate).
const PRACTICE_TYPE_GENITIVE = {
  navchalna: "навчальної",
  vyrobnycha: "виробничої",
  perededyplomna: "переддипломної",
};

export function buildPracticeTitlePageLines(info) {
  const {
    university, faculty, companyName, supervisorCompany, supervisorUniversity,
    studentName, studentGroup, course, practiceType, city,
  } = info || {};
  const typeLabel = PRACTICE_TYPE_GENITIVE[practiceType] || "";

  const lines = [];
  lines.push({ text: "МІНІСТЕРСТВО ОСВІТИ І НАУКИ УКРАЇНИ", align: "center", bold: true, spaceBefore: 0 });
  lines.push({ text: university ? university.toUpperCase() : "[Назва університету]", align: "center", bold: true, spaceBefore: 200 });
  if (faculty) lines.push({ text: faculty, align: "center", bold: false, spaceBefore: 0 });
  lines.push({ text: "", align: "center", spaceBefore: 960 });
  lines.push({ text: "ЗВІТ", align: "center", bold: true, spaceBefore: 0 });
  lines.push({ text: `про проходження ${typeLabel ? typeLabel + " " : ""}практики`, align: "center", bold: false, spaceBefore: 0 });
  lines.push({ text: `на базі: ${companyName || "[Місце практики]"}`, align: "center", bold: false, spaceBefore: 200 });
  lines.push({ text: "", align: "center", spaceBefore: 2880 });

  const studentBits = [studentName || "[ПІБ студента]"];
  const groupBits = [course ? `${course} курс` : "", studentGroup ? `група ${studentGroup}` : ""].filter(Boolean).join(", ");
  if (groupBits) studentBits.push(groupBits);
  lines.push({ text: `Виконав(ла): ${studentBits.join(", ")}`, align: "right", bold: false, spaceBefore: 0 });
  lines.push({ text: `Керівник від підприємства: ${supervisorCompany || "[ПІБ, посада]"}`, align: "right", bold: false, spaceBefore: 0 });
  lines.push({ text: `Керівник від університету: ${supervisorUniversity || "[ПІБ, посада]"}`, align: "right", bold: false, spaceBefore: 0 });
  lines.push({ text: "", align: "center", spaceBefore: 3840 });
  lines.push({ text: `${city || "[Місто]"} – [РІК]`, align: "center", bold: false, spaceBefore: 0 });
  return lines;
}
