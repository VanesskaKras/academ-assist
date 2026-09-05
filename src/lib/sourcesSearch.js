// ── Пошук джерел ──
// OpenAlex  — CORS підтримується, викликаємо з браузера напряму
// CrossRef  — CORS підтримується, викликаємо з браузера напряму (добре індексує укр. журнали)
// Semantic Scholar — НЕ підтримує CORS, проксимо через /api/search-sources (Vercel)

import { normalizeAuthorsScript } from "./transliteration.js";
import { getApiBase } from "./api.js";

// window.dispatchEvent('apicost', ...) — браузерний спосіб донести вартість
// виклику до живого лічильника в UI. У Node-воркері window немає — там
// виклик передає onCost і отримує ті самі дані прямим викликом функції.
function reportCost(detail, onCost) {
  if (onCost) { onCost(detail); return; }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("apicost", { detail }));
}

// ── Стоп-слова: структурні/загальні слова що не несуть теми ──
const STOP_WORDS = new Set([
  'аналіз', 'дослідження', 'особливості', 'формування', 'удосконалення',
  'забезпечення', 'оцінка', 'оцінювання', 'підходи', 'методи', 'механізми',
  'розробка', 'обґрунтування', 'характеристика', 'сутність', 'визначення',
  'вдосконалення', 'підвищення', 'покращення', 'реалізація', 'впровадження',
  'практичний', 'практична', 'практичне', 'практичні', 'рекомендації',
  'рекомендація', 'теоретичний', 'теоретична', 'теоретичне', 'теоретичні',
  'загальний', 'основний', 'основні', 'основна', 'щодо', 'умовах', 'умови',
  'шляхи', 'напрями', 'напрямки', 'проблеми', 'проблема', 'питання',
  'розвиток', 'розвитку', 'підтримка', 'підтримки', 'види', 'вид', 'типи',
  'тип', 'форми', 'форма', 'роль', 'місце', 'значення', 'функції', 'функція',
  'властивості', 'поняття', 'концепція', 'концепції', 'система', 'суть',
  // Загальноструктурні терміни що зустрічаються в будь-якій галузі (A)
  'моделі', 'модель', 'методи', 'метод', 'підхід', 'підходи',
  'та', 'або', 'при', 'як', 'що', 'це', 'які', 'який', 'яка', 'яке',
  'його', 'її', 'їх', 'він', 'вона', 'воно', 'вони',
  'а', 'і', 'й', 'в', 'у', 'на', 'з', 'із', 'зі', 'до', 'від', 'про',
  'за', 'по', 'між', 'через', 'під', 'над', 'без', 'після', 'перед',
]);

const BLOCKED = [
  'russia', 'russian federation', 'москв', 'санкт-петербург', 'новосибирск',
  'екатеринбург', 'казань', 'самар', 'нижн', 'российск', 'росс', 'rsci',
  'elibrary.ru', 'cyberleninka', 'киберленинк',
  'белорус', 'беларус', 'minsk', 'минск', 'гродн', 'витебск', 'брест',
];

// ── Чужі студентські роботи (магістерські, дипломні, курсові тощо) — не беремо як джерела ──
const STUDENT_WORK_PATTERNS = [
  'магістерська робота', 'магістерська дисертація', 'магістерської роботи',
  'дипломна робота', 'дипломної роботи', 'кваліфікаційна робота', 'кваліфікаційної роботи',
  'випускна кваліфікаційна робота', 'бакалаврська робота', 'бакалаврської роботи',
  'курсова робота', 'курсової роботи',
  "master's thesis", 'master thesis', 'bachelor thesis', "bachelor's thesis",
  'diploma thesis', 'diploma work', 'coursework', 'term paper', 'graduation thesis',
];
const STUDENT_WORK_TYPES = new Set(['dissertation', 'thesis']);

function isStudentWork(obj) {
  const title = (Array.isArray(obj?.dctitle) ? obj.dctitle[0] : obj?.dctitle) || obj?.title || '';
  const titleLower = title.toLowerCase();
  if (STUDENT_WORK_PATTERNS.some(p => titleLower.includes(p))) return true;
  const type = (obj?.type || obj?.documentType || '').toLowerCase();
  if (STUDENT_WORK_TYPES.has(type)) return true;
  return false;
}

// ── Методичні матеріали (вказівки, рекомендації, посібники) — не містять
// достатньо фактажу/дослідження щоб бути джерелом цитування ──
const METHODICAL_PATTERNS = [
  'методичні вказівки', 'методичних вказівок', 'методичні рекомендації',
  'методичних рекомендацій', 'методичний посібник', 'методичного посібника',
  'методична розробка', 'методичної розробки', 'методичне видання',
  'навчально-методичний посібник', 'навчально-методичні рекомендації',
  'навчально-методична розробка', 'методичні матеріали',
];

function isMethodicalGuide(obj) {
  const title = (Array.isArray(obj?.dctitle) ? obj.dctitle[0] : obj?.dctitle) || obj?.title || '';
  const titleLower = title.toLowerCase();
  return METHODICAL_PATTERNS.some(p => titleLower.includes(p));
}

function isRussianUrl(url = '') {
  return /\.ru(\/|$)/i.test(url.toLowerCase());
}

function isRussianText(text = '') {
  // Символи наявні в російській, але відсутні в українській мові
  return /[ёъыэЁЪЫЭ]/.test(text);
}

function isBlocked(obj) {
  const t = JSON.stringify(obj).toLowerCase();
  if (BLOCKED.some(p => t.includes(p))) return true;
  // Блокуємо будь-який .ru домен
  const url = obj?.url || obj?.dclink || '';
  if (isRussianUrl(Array.isArray(url) ? url[0] : url)) return true;
  // Блокуємо джерела з мовою 'ru' (поле OpenAlex)
  if (obj?.language === 'ru') return true;
  // Блокуємо джерела з російськомовним заголовком
  const title = (Array.isArray(obj?.dctitle) ? obj.dctitle[0] : obj?.dctitle) || obj?.title || '';
  if (isRussianText(title)) return true;
  // Блокуємо чужі студентські роботи (магістерські, дипломні, курсові тощо)
  if (isStudentWork(obj)) return true;
  // Блокуємо методичні вказівки/рекомендації/посібники — не містять потрібної інформації
  if (isMethodicalGuide(obj)) return true;
  return false;
}

function hasCyrillic(text = '') {
  return /[А-ЯҐЄІЇа-яґєіїёЁ]/.test(text);
}

/**
 * Будує coreTerm з назви підрозділу + теми роботи:
 * бере перші 3 значущих слова (без стоп-слів) — зберігає повний контекст теми.
 * Напр.: sectionTitle "Інтерактивні технологій у вихованні дітей"
 *   → coreTerm = "інтерактивних технологій вихованні"
 */
function buildCoreTerm(sectionTitle = '', topic = '') {
  const extract = (text) => text.toLowerCase()
    .split(/[\s,.:;()–—\-/'"«»]+/)
    .filter(w => w.length > 4 && !STOP_WORDS.has(w));
  const seen = new Set();
  const words = [...extract(sectionTitle), ...extract(topic)]
    .filter(w => seen.has(w) ? false : seen.add(w));
  return words.slice(0, 3).join(' ');
}

/**
 * Пост-фільтр за галуззю (E): підвищує скор статей що містять слова
 * з теми роботи та назви підрозділу. Нерелевантні не видаляються —
 * лише опускаються вниз списку.
 */
function domainBoost(results, sectionTitle = '', topic = '') {
  const combined = `${sectionTitle} ${topic}`.toLowerCase();
  const domainWords = combined
    .split(/[\s,.:;()–—\-/]+/)
    .filter(w => w.length > 6 && !STOP_WORDS.has(w));
  if (!domainWords.length) return results;
  return results.map(p => ({
    ...p,
    _score: (p._score || 0) + domainWords.filter(w => p.title.toLowerCase().includes(w)).length * 3,
  })).sort((a, b) => b._score - a._score);
}

/**
 * Скоринг релевантності: скільки ключових фраз/слів зустрічається в назві статті.
 */
function scoreRelevance(titleLower, keywords) {
  let score = 0;
  for (const kw of keywords) {
    const k = kw.toLowerCase().trim();
    if (!k || k.length < 4) continue;
    // Повна фраза — більше балів
    if (titleLower.includes(k)) { score += k.includes(' ') ? 4 : 2; continue; }
    // Окремі слова фрази
    for (const w of k.split(/\s+/)) {
      if (w.length > 4 && !STOP_WORDS.has(w) && titleLower.includes(w)) score += 1;
    }
  }
  return score;
}

// ── Витягує сторінки з суфікса DOI: ...-191-199 → "191–199" ──
function extractPagesFromDoi(doi = '') {
  const m = doi.match(/-(\d{2,4})-(\d{2,4})$/);
  if (!m) return '';
  const first = parseInt(m[1], 10);
  const last = parseInt(m[2], 10);
  if (last <= first || last - first > 200) return '';
  return `${m[1]}–${m[2]}`;
}

/**
 * Отримує авторів і сторінки з CrossRef за DOI.
 * Використовується коли пошук повернув запис без авторів.
 */
export async function lookupDoiMetadata(doi) {
  if (!doi) return null;
  let result = null;
  try {
    const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=support@academ-assist.vercel.app`);
    if (r.ok) {
      const d = await r.json();
      const p = d.message;
      if (p) {
        const authorsStructured = (p.author || []).slice(0, 3)
          .map(a => ({ family: a.family || '', given: a.given || '' }))
          .filter(a => a.family);
        const authors = authorsStructured
          .map(a => [a.family, a.given?.[0]].filter(Boolean).join(' '))
          .filter(Boolean);
        result = {
          authorsStructured,
          authors,
          pages: p.page ? p.page.replace('-', '–') : extractPagesFromDoi(doi),
          volume: p.volume || '',
          issue: p.issue || '',
          journal: p['container-title']?.[0] || '',
          publisher: p.publisher || '',
          publisherLocation: p['publisher-location'] || '',
          year: p.published?.['date-parts']?.[0]?.[0] || '',
        };
      }
    }
  } catch { /* fallthrough to OpenAlex */ }

  // Якщо CrossRef не повернув авторів або не повернув сторінки — пробуємо OpenAlex
  if (!result?.authors?.length || !result?.pages) {
    try {
      const oaUrl = `https://api.openalex.org/works/https://doi.org/${doi}?select=authorships,biblio,publication_year`;
      const r2 = await fetch(oaUrl);
      if (r2.ok) {
        const w = await r2.json();
        const oaAuthors = (w.authorships || []).slice(0, 3)
          .map(a => a.author?.display_name || '').filter(Boolean);
        const oaPages = w.biblio?.first_page && w.biblio?.last_page
          ? `${w.biblio.first_page}–${w.biblio.last_page}`
          : w.biblio?.first_page || null;
        if (oaAuthors.length || oaPages || w.publication_year) {
          result = {
            ...(result || {}),
            // Автори — лише якщо CrossRef їх не дав
            ...(oaAuthors.length && !result?.authors?.length ? {
              authors: oaAuthors,
              authorsStructured: oaAuthors.map(n => {
                const parts = n.trim().split(/\s+/);
                return { family: parts[0] || '', given: parts.slice(1).join(' ') };
              }),
            } : {}),
            // Сторінки — беремо перше непорожнє значення
            pages: result?.pages || oaPages || extractPagesFromDoi(doi),
            year: result?.year || w.publication_year || '',
          };
        }
      }
    } catch { /* ignore */ }
  }

  return result;
}

/**
 * Витягує сторінки зі сторінки журналу через Google Scholar мета-теги.
 * Використовується як fallback коли CrossRef/OpenAlex не мають сторінок.
 */
export async function fetchPagesFromUrl(url) {
  if (!url) return null;
  try {
    const res = await fetch(`${getApiBase()}/api/fetch-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.pages || null;
  } catch {
    return null;
  }
}

/**
 * Перевіряє, що URL справді відкривається (для джерел без DOI — єдиний спосіб
 * підтвердити, що запис реально існує, а не лише має правдоподібну назву).
 * Використовує той самий проксі, що й fetchPagesFromUrl, але зчитує прапорець
 * urlOk окремо від pages — сторінка може відкриватись і не мати citation-мета-тегів.
 */
export async function verifyUrlOpens(url) {
  if (!url) return false;
  try {
    const res = await fetch(`${getApiBase()}/api/fetch-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.urlOk === true;
  } catch {
    return false;
  }
}

// ── Декодування abstract_inverted_index OpenAlex → plain text ──
function decodeAbstract(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const pos of positions) words[pos] = word;
  }
  return words.filter(Boolean).join(' ');
}

function snippetAbstract(text) {
  if (!text) return '';
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  const snippet = sentences.slice(0, 2).join(' ').trim();
  if (!snippet) return '';
  const words = snippet.split(/\s+/);
  return words.length > 100 ? words.slice(0, 100).join(' ') + '...' : snippet;
}

// CrossRef іноді повертає анотацію як JATS XML (<jats:p>текст</jats:p>) — знімаємо теги
function stripJatsAbstract(text) {
  if (!text) return '';
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Будує семантичні ключові слова з контексту роботи (не від AI).
 * Витягує значущі слова з назви підрозділу, теми, галузі та коментарів,
 * складає 2–3 пошукові комбінації.
 */
export function buildSemanticKeywords(sectionLabel = '', topic = '', direction = '', subject = '', commentHints = '', methodReq = '') {
  const freq = {};
  const addWords = (text, weight) => {
    if (!text) return;
    text.toLowerCase()
      .split(/[\s,.:;()–—\-/'"«»]+/)
      .filter(w => w.length > 4 && !STOP_WORDS.has(w))
      .forEach(w => { freq[w] = (freq[w] || 0) + weight; });
  };
  addWords(sectionLabel, 4);
  addWords(topic, 3);
  addWords(direction, 3);
  addWords(subject, 2);
  addWords(commentHints.slice(0, 300), 1);
  addWords(methodReq.slice(0, 300), 1);

  const topWords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
  if (topWords.length < 2) return [];

  const queries = [];
  if (topWords.length >= 2) queries.push(topWords.slice(0, 3).join(' '));
  if (topWords.length >= 4) queries.push(topWords.slice(2, 5).join(' '));
  if (topWords.length >= 6) queries.push([topWords[0], topWords[4], topWords[5]].join(' '));
  return queries;
}

// ── Фільтрація за роками (останні 5 років обов'язково, 6–10 — тільки якщо дуже релевантні) ──
const YEAR_STRICT = new Date().getFullYear() - 4; // >= поточний-4 (останні 5 років)
const YEAR_LOOSE  = new Date().getFullYear() - 9; // >= поточний-9 (останні 10 років)
const YEAR_LOOSE_MIN_SCORE = 2; // мінімальний скор для 6–10-річних джерел

// extraYears: під час добору при нестачі джерел межу "6-10 років" відсовуємо на +2/+3 роки за раунд
// matchableLangs: мови статей, для яких скор проти keywords взагалі щось означає (той самий алфавіт/мова,
// що й keywords) — лише для них має сенс вимагати YEAR_LOOSE_MIN_SCORE; інші мови пропускаємо без перевірки
// скору, бо збіг об'єктивно неможливий (напр. українська фраза проти англомовної назви)
function applyYearFilter(papers, keywords = [], extraYears = 0, matchableLangs = ['uk', 'pl']) {
  const looseFloor = YEAR_LOOSE - extraYears;
  return papers.map(p => ({
    ...p,
    _score: p._score ?? scoreRelevance((p.title || '').toLowerCase(), keywords),
  })).filter(p => {
    const yr = parseInt(p.year, 10) || 0;
    if (yr >= YEAR_STRICT) return true;
    if (yr >= looseFloor) {
      if (!matchableLangs.includes(p.lang)) return true;
      return (p._score || 0) >= YEAR_LOOSE_MIN_SCORE;
    }
    return false;
  });
}

// ── OpenAlex ──
// Анонімний пошук (search=/title.search) зараз обмежується OpenAlex 503-кою —
// потрібен api_key для стабільного доступу
const OA_KEY = typeof import.meta !== 'undefined' ? (import.meta.env?.VITE_OPENALEX_API_KEY || '') : '';
const OA_KEY_PARAM = OA_KEY ? `&api_key=${OA_KEY}` : '';
const OA_BASE = 'https://api.openalex.org/works';
const OA_FIELDS = 'title,authorships,publication_year,primary_location,doi,language,id,biblio,abstract_inverted_index,type';

const OA_MAILTO = '&mailto=support@academ-assist.vercel.app';

// api_key — платний рівень OpenAlex з передоплаченим бюджетом; коли бюджет вичерпано,
// OpenAlex повертає 429 на КОЖЕН запит із цим ключем, незалежно від навантаження.
// Тому: спершу пробуємо з ключем (якщо є), а при невдачі — одразу той самий запит
// без ключа (безкоштовний "polite pool" через mailto — там немає такого підводного каменя).
async function fetchOpenAlexJson(baseUrl) {
  if (OA_KEY_PARAM) {
    const withKey = await fetch(`${baseUrl}${OA_KEY_PARAM}`, { cache: 'no-store' });
    if (withKey.ok) return withKey.json();
  }
  const r = await fetch(baseUrl, { cache: 'no-store' });
  if (!r.ok) return null;
  return r.json();
}

async function openAlexSearch(query, filterStr, limit, page = 1) {
  const url = `${OA_BASE}?search=${encodeURIComponent(query)}&filter=${filterStr}&per_page=${limit}&page=${page}&select=${OA_FIELDS}${OA_MAILTO}`;
  const d = await fetchOpenAlexJson(url);
  if (!d) return [];
  return (d.results || []).filter(p => p.title && !isBlocked(p));
}

// Пошук тільки по заголовках — набагато точніший
// ВАЖЛИВО: OpenAlex ігнорує повторні query-параметри filter= (лишає лише останній) —
// усі умови мають бути об'єднані комою в ОДНОМУ filter= (AND), як і в openAlexSearch
async function openAlexTitleSearch(query, filters, limit, page = 1) {
  const filterStr = [`title.search:${encodeURIComponent(query)}`, ...filters].join(',');
  const url = `${OA_BASE}?filter=${filterStr}&per_page=${limit}&page=${page}&select=${OA_FIELDS}${OA_MAILTO}`;
  const d = await fetchOpenAlexJson(url);
  if (!d) return [];
  return (d.results || []).filter(p => p.title && !isBlocked(p));
}

function mapOpenAlex(p, forceLang) {
  const lang = forceLang || (p.language === 'uk' || hasCyrillic(p.title) ? 'uk' : 'en');
  const fp = p.biblio?.first_page;
  const lp = p.biblio?.last_page;
  const doi = p.doi ? p.doi.replace('https://doi.org/', '') : '';
  const pages = fp ? (lp && lp !== fp ? `${fp}–${lp}` : fp) : extractPagesFromDoi(doi);
  const abstract = snippetAbstract(decodeAbstract(p.abstract_inverted_index));
  const url = p.primary_location?.landing_page_url
    || (doi ? `https://doi.org/${doi}` : '')
    || (p.id?.startsWith('https://') ? p.id : '');
  const authors = (p.authorships || []).slice(0, 3)
    .map(a => a.author?.display_name || '').filter(Boolean);
  return {
    id: p.id || p.doi || String(Math.random()),
    title: p.title || '',
    authors: normalizeAuthorsScript(authors, lang === 'uk'),
    year: p.publication_year || '',
    venue: p.primary_location?.source?.display_name || '',
    doi,
    volume: p.biblio?.volume || '',
    issue: p.biblio?.issue || '',
    pages,
    lang,
    source: 'openalex',
    abstract,
    url,
  };
}

// ── Google Scholar через Serper.dev (проксі /api/search-scholar) ──
async function fetchScholar(query, limit, onCost) {
  try {
    const res = await fetch(`${getApiBase()}/api/search-scholar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const sources = (data.sources || []).filter(p => p.title && !isBlocked(p));
    if (sources.length > 0)
      reportCost({ cost: 0.001, model: 'serper', inTok: 1, outTok: 0 }, onCost);
    return sources;
  } catch { return []; }
}

// ── CORE.ac.uk — агрегатор відкритого доступу, індексує репозиторії ──
// Немає CORS у браузері — проксимо через /api/search-core (Vercel)
async function fetchCORE(query, limit) {
  try {
    const res = await fetch(`${getApiBase()}/api/search-core`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit }),
    });
    if (!res.ok) return [];
    const d = await res.json();
    return (d.results || []).filter(p => p.title && !isBlocked(p));
  } catch { return []; }
}

function mapCORE(result) {
  const title = result.title || '';
  const doi = result.doi || '';
  const urls = result.sourceFulltextUrls || [];
  // result.links — масив {type, url} у відповіді CORE API; беремо перший не-thumbnail
  const coLink = (result.links || []).find(l => l.url && l.type !== 'thumbnail')?.url || '';
  const coreId = result.id || '';
  const url = result.downloadUrl || urls[0] || coLink
    || (doi ? `https://doi.org/${doi}` : '')
    || (coreId ? `https://core.ac.uk/works/${coreId}` : '');
  const journal = (result.journals || [])[0];
  const lang = hasCyrillic(title) ? 'uk' : 'en';
  const authors = (result.authors || []).slice(0, 3).map(a => (typeof a === 'string' ? a : a.name || '')).filter(Boolean);
  return {
    id: coreId ? `core-${coreId}` : String(Math.random()),
    title,
    authors: normalizeAuthorsScript(authors, lang === 'uk'),
    year: result.yearPublished || '',
    venue: journal?.title || result.publisher || '',
    doi,
    volume: journal?.volume || '',
    issue: journal?.issue || '',
    pages: extractPagesFromDoi(doi),
    lang,
    source: 'core',
    abstract: snippetAbstract(result.abstract || ''),
    url,
  };
}

// ── DOAJ (Directory of Open Access Journals) — мультидисциплінарний, добре покриває укр. журнали ──
// Немає гарантованого CORS у браузері — проксимо через /api/search-doaj (Vercel)
async function fetchDOAJ(query, limit) {
  try {
    const res = await fetch(`${getApiBase()}/api/search-doaj`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit }),
    });
    if (!res.ok) return [];
    const d = await res.json();
    return (d.results || []).filter(p => p.bibjson?.title && !isBlocked(p));
  } catch { return []; }
}

function mapDOAJ(result) {
  const bj = result.bibjson || {};
  const title = bj.title || '';
  const identifiers = bj.identifier || [];
  const doi = identifiers.find(i => i.type === 'doi')?.id || '';
  const links = bj.link || [];
  const fulltextUrl = links.find(l => l.type === 'fulltext')?.url || links[0]?.url || '';
  const url = fulltextUrl || (doi ? `https://doi.org/${doi}` : '');
  const authors = (bj.author || []).slice(0, 3).map(a => a.name || '').filter(Boolean);
  const lang = hasCyrillic(title) ? 'uk' : 'en';
  return {
    id: result.id ? `doaj-${result.id}` : String(Math.random()),
    title,
    authors: normalizeAuthorsScript(authors, lang === 'uk'),
    year: bj.year || '',
    venue: bj.journal?.title || '',
    doi,
    volume: bj.journal?.volume || '',
    issue: bj.journal?.number || '',
    pages: extractPagesFromDoi(doi),
    lang,
    source: 'doaj',
    abstract: snippetAbstract(bj.abstract || ''),
    url,
  };
}

// ── OpenAlex книги (тип book/monograph, україномовні) ──
async function fetchOpenAlexBooks(query, limit) {
  try {
    const yr = `publication_year:>${YEAR_LOOSE - 1}`;
    const url = `${OA_BASE}?search=${encodeURIComponent(query)}&filter=type:book,language:uk,${yr}&per_page=${limit}&select=${OA_FIELDS}${OA_MAILTO}`;
    const d = await fetchOpenAlexJson(url);
    if (!d) return [];
    return (d.results || [])
      .filter(p => p.title && !isBlocked(p))
      .map(p => ({ ...mapOpenAlex(p, 'uk'), type: 'book' }));
  } catch { return []; }
}

// ── CrossRef монографії ──
async function fetchCrossRefBooks(query, limit) {
  try {
    const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&filter=type:monograph&rows=${Math.min(limit, 10)}&mailto=support@academ-assist.vercel.app`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.message?.items || [])
      .filter(p => p.title?.[0] && hasCyrillic(p.title[0]) && !isBlocked(p))
      .map(p => ({
        id: p.DOI || String(Math.random()),
        title: p.title[0],
        authors: normalizeAuthorsScript((p.author || []).slice(0, 3)
          .map(a => [a.family, a.given?.[0]].filter(Boolean).join(' ')).filter(Boolean), true),
        year: p.published?.['date-parts']?.[0]?.[0]
          || p['published-print']?.['date-parts']?.[0]?.[0] || '',
        venue: p['container-title']?.[0] || p.publisher || '',
        doi: p.DOI || '',
        pages: p.page ? p.page.replace('-', '–') : extractPagesFromDoi(p.DOI || ''),
        lang: 'uk',
        source: 'crossref',
        type: 'book',
        abstract: snippetAbstract(stripJatsAbstract(p.abstract || '')),
        url: p.DOI ? `https://doi.org/${p.DOI}` : '',
      }));
  } catch { return []; }
}

// ── Google Books через Serper.dev (проксі /api/search-books) ──
async function fetchBooksGoogle(query, limit) {
  try {
    const res = await fetch(`${getApiBase()}/api/search-books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.sources || []).filter(p => p.title && !isBlocked(p));
  } catch { return []; }
}

// ── CrossRef (добре покриває укр. журнали з DOI) ──
async function fetchCrossRefUkrainian(query, limit, extraYears = 0) {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&filter=from-pub-date:${YEAR_LOOSE - extraYears}&rows=${Math.min(limit * 2, 20)}&mailto=support@academ-assist.vercel.app`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.message?.items || [])
    .filter(p => {
      const title = p.title?.[0] || '';
      return title && hasCyrillic(title) && !isBlocked(p);
    })
    .map(p => ({
      id: p.DOI || String(Math.random()),
      title: p.title?.[0] || '',
      authors: normalizeAuthorsScript((p.author || []).slice(0, 3)
        .map(a => [a.family, a.given?.[0]].filter(Boolean).join(' ')).filter(Boolean), true),
      year: (p.published?.['date-parts']?.[0]?.[0]
        || p['published-print']?.['date-parts']?.[0]?.[0]
        || ''),
      venue: p['container-title']?.[0] || '',
      doi: p.DOI || '',
      pages: p.page ? p.page.replace('-', '–') : extractPagesFromDoi(p.DOI || ''),
      lang: 'uk',
      source: 'crossref',
      abstract: snippetAbstract(stripJatsAbstract(p.abstract || '')),
      url: p.DOI ? `https://doi.org/${p.DOI}` : '',
    }));
}

// ── Semantic Scholar через бекенд (немає CORS у браузері) ──
async function fetchEnglishViaBackend(enKeywords, limit) {
  try {
    const res = await fetch(`${getApiBase()}/api/search-sources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enKeywords, ukKeywords: [], needed: limit }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.sources || []).filter(p => p.lang === 'en' && !isBlocked(p));
  } catch {
    return [];
  }
}

// ── Пошук за однією фразою: BASE, Scholar (опційно), CORE, DOAJ, OpenAlex uk, CrossRef, OpenAlex pl, OpenAlex en, Semantic Scholar en ──
// enPhrase: англійський відповідник phrase (якщо є) — українська фраза не матчиться з англомовними
// статтями за текстом, тому EN-джерела (OpenAlex-en, Semantic Scholar) шукають саме за ним,
// а якщо enPhrase не передали — фолбек на phrase (як було раніше, краще ніж нічого)
export async function searchByPhrase(phrase, limit = 10, page = 1, useScholar = false, extraYears = 0, enPhrase = '') {
  const yr = `publication_year:>${YEAR_LOOSE - extraYears - 1}`;
  const enQuery = enPhrase || phrase;
  // BASE вимкнено: api.base-search.net вимагає окремої реєстрації IP/ключа
  // (звичайні запити повертають "Access denied"), яку свідомо вирішили не підключати.
  const [r2, r3, r4, r5, r6, r7, r8, r9] = await Promise.allSettled([
    useScholar ? fetchScholar(phrase, limit) : Promise.resolve([]),
    fetchCORE(phrase, limit),
    openAlexSearch(phrase, `language:uk,${yr}`, limit, page),
    fetchCrossRefUkrainian(phrase, limit, extraYears),
    openAlexSearch(phrase, `language:pl,${yr}`, limit, page),
    openAlexSearch(enQuery, `language:en,${yr}`, limit, page),
    enPhrase ? fetchEnglishViaBackend([enPhrase], limit) : Promise.resolve([]),
    fetchDOAJ(phrase, limit),
  ]);

  const scholarRaw = r2.status === 'fulfilled' ? r2.value : [];
  const coreRaw    = r3.status === 'fulfilled' ? r3.value.map(mapCORE) : [];
  const ukRaw      = r4.status === 'fulfilled' ? r4.value.map(p => mapOpenAlex(p, 'uk')) : [];
  const crRaw      = r5.status === 'fulfilled' ? r5.value.filter(p => hasCyrillic(p.title || '')) : [];
  const plRaw      = r6.status === 'fulfilled' ? r6.value.map(p => mapOpenAlex(p, 'pl')) : [];
  const enRaw      = r7.status === 'fulfilled' ? r7.value.map(p => mapOpenAlex(p, 'en')) : [];
  const ssRaw      = r8.status === 'fulfilled' ? r8.value : [];
  const doajRaw    = r9.status === 'fulfilled' ? r9.value.map(mapDOAJ) : [];

  const seen = new Set();
  const raw = [];
  for (const p of [...scholarRaw, ...coreRaw, ...ukRaw, ...crRaw, ...plRaw, ...enRaw, ...ssRaw, ...doajRaw]) {
    const key = (p.title || '').toLowerCase().slice(0, 60);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    raw.push(p);
  }
  const keywords = phrase.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  return applyYearFilter(raw, keywords, extraYears);
}

// ── Офіційні статистичні джерела для економічних/фінансових робіт ──
// OpenAlex/CrossRef/BASE/CORE не індексують державні статистичні портали як
// "статті", тому для econ-підрозділів додаємо їх окремим фіксованим списком —
// це лише нагадування-посилання, конкретний звіт/сторінку клієнт/виконавець
// уточнює сам перед фінальним оформленням цитати.
export const ECON_INSTITUTIONAL_SOURCES = [
  {
    id: 'institutional-ukrstat',
    title: 'Офіційна статистична інформація',
    authors: [],
    year: new Date().getFullYear(),
    venue: 'Державна служба статистики України',
    pages: '',
    lang: 'uk',
    source: 'institutional',
    abstract: 'Загальнодержавна статистика: виробництво, ціни, зовнішня торгівля, зайнятість тощо — оберіть конкретний розділ відповідно до теми.',
    url: 'https://www.ukrstat.gov.ua/',
  },
  {
    id: 'institutional-nbu',
    title: 'Статистика фінансового сектору',
    authors: [],
    year: new Date().getFullYear(),
    venue: 'Національний банк України',
    pages: '',
    lang: 'uk',
    source: 'institutional',
    abstract: 'Грошово-кредитна, банківська та платіжна статистика, курси валют — оберіть конкретний розділ відповідно до теми.',
    url: 'https://bank.gov.ua/ua/statistic',
  },
  {
    id: 'institutional-mof',
    title: 'Статистична та аналітична інформація',
    authors: [],
    year: new Date().getFullYear(),
    venue: 'Міністерство фінансів України',
    pages: '',
    lang: 'uk',
    source: 'institutional',
    abstract: 'Показники державного бюджету, боргу, оподаткування — оберіть конкретний розділ відповідно до теми.',
    url: 'https://mof.gov.ua/uk/statistichna-informacija',
  },
  {
    id: 'institutional-worldbank',
    title: 'World Development Indicators',
    authors: [],
    year: new Date().getFullYear(),
    venue: 'World Bank Open Data',
    pages: '',
    lang: 'en',
    source: 'institutional',
    abstract: 'Міжнародні макроекономічні показники для порівняльного аналізу — оберіть конкретний набір даних відповідно до теми.',
    url: 'https://data.worldbank.org/',
  },
];

// Це завжди посилання на головну сторінку розділу статистики, а не на конкретний
// звіт/таблицю — автоматично знайти саме потрібний розділ для довільної теми
// неможливо без окремого пошукового механізму по кожній установі, тому позначаємо
// явно: виконавець має уточнити конкретне джерело перед фінальним оформленням.
export function getEconInstitutionalSources() {
  return ECON_INSTITUTIONAL_SOURCES.map(s => ({
    ...s,
    _missingFields: ['конкретний звіт/розділ (зараз — головна сторінка установи)'],
  }));
}

// ── Головна функція пошуку ──
// 9 запитів паралельно: різні фрази, режими (full-text / title.search), дві сторінки OpenAlex
// r1,r3-r7,r9 — OpenAlex (сирий формат) → mapOpenAlex
// r2, r8      — CrossRef (вже відформатовано fetchCrossRefUkrainian) → без маппінгу
export async function searchSourcesForSection(ukKeywords, enKeywords, needed = 4, sectionTitle = '', topic = '', page = 1, semKeywords = [], anchors = [], geminiPhrases = []) {
  const target = 25;
  const fetchLimit = 20;
  const allUkKeywords = [...new Set([...ukKeywords, ...semKeywords])];
  const yr = `publication_year:>${YEAR_LOOSE - 1}`;

  // ── Фрази для запитів ──
  // Якщо Gemini надав фрази — використовуємо їх; інакше — стара логіка ротації
  let p0, p1, p2, coreTerm, oaPage;
  const usingGemini = geminiPhrases.length >= 2;

  if (usingGemini) {
    p0 = geminiPhrases[0];
    p1 = geminiPhrases[1] || p0;
    p2 = geminiPhrases[2] || p0;
    coreTerm = geminiPhrases[3] || buildCoreTerm(sectionTitle, topic);
    oaPage = page; // пряме відображення: refresh = наступна сторінка OpenAlex
  } else {
    coreTerm = buildCoreTerm(sectionTitle, topic);
    const specificity = (phrase) =>
      phrase.toLowerCase().split(/\s+/).filter(w => w.length > 4 && !STOP_WORDS.has(w)).length;
    const sortedPhrases = [...allUkKeywords].sort((a, b) => specificity(b) - specificity(a));
    const total = Math.max(sortedPhrases.length, 1);
    const i0 = ((page - 1) * 3) % total;
    p0 = sortedPhrases[i0] || coreTerm;
    p1 = sortedPhrases[(i0 + 1) % total] || p0;
    p2 = sortedPhrases[(i0 + 2) % total] || p0;
    oaPage = Math.floor(((page - 1) * 3) / total) + 1;
  }

  const enQ = enKeywords[0] || '';
  const plQ = enQ || p0;

  const [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12] = await Promise.allSettled([
    openAlexSearch(p0, `language:uk,${yr}`, fetchLimit, oaPage),            // r1: full-text uk, p0
    fetchCrossRefUkrainian(p0, fetchLimit),                                  // r2: CrossRef uk, p0
    openAlexTitleSearch(p1, ['language:uk', yr], fetchLimit, oaPage),        // r3: title uk, p1
    openAlexSearch(p2, `language:uk,${yr}`, fetchLimit, oaPage),             // r4: full-text uk, p2
    openAlexTitleSearch(coreTerm, ['language:uk', yr], fetchLimit, oaPage),  // r5: title uk, coreTerm/p3
    openAlexSearch(p1, `language:uk,${yr}`, fetchLimit, oaPage),             // r6: full-text uk, p1
    openAlexTitleSearch(p2, ['language:uk', yr], fetchLimit, oaPage),        // r7: title uk, p2
    openAlexSearch(plQ, `language:pl,${yr}`, fetchLimit, oaPage),            // r8: польські full-text
    openAlexTitleSearch(plQ, ['language:pl', yr], fetchLimit, oaPage),       // r9: польські title
    fetchOpenAlexBooks(p0, fetchLimit),                                       // r10: книги OpenAlex
    fetchCrossRefBooks(p0, fetchLimit),                                       // r11: монографії CrossRef
    fetchBooksGoogle(p0, 8),                                                  // r12: Google Books (books.googleapis.com)
  ]);

  const mapOA = (r, lang) => r.status === 'fulfilled'
    ? r.value.filter(p => p.title && !isBlocked(p)).map(p => mapOpenAlex(p, lang))
    : [];

  const fromR1 = mapOA(r1, 'uk');
  const fromCR = r2.status === 'fulfilled' ? r2.value.filter(p => hasCyrillic(p.title || '')) : [];
  const fromR3 = mapOA(r3, 'uk');
  const fromR4 = mapOA(r4, 'uk');
  const fromR5 = mapOA(r5, 'uk');
  const fromR6 = mapOA(r6, 'uk');
  const fromR7 = mapOA(r7, 'uk');

  // Дедуп + attribution (яка фраза першою знайшла статтю)
  const seen = new Set();
  const allUk = [];
  const phraseAttrib = new Map(); // titleKey → phrase

  const addGroup = (papers, phraseLabel) => {
    for (const p of papers) {
      const key = (p.title || '').toLowerCase().slice(0, 60);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      allUk.push(p);
      if (usingGemini) phraseAttrib.set(key, phraseLabel);
    }
  };

  if (usingGemini) {
    addGroup([...fromR1, ...fromCR], p0);
    addGroup(fromR3, p1);
    addGroup(fromR4, p2);
    addGroup(fromR5, coreTerm);
    addGroup(fromR6, p1);
    addGroup(fromR7, p2);
  } else {
    for (const p of [...fromR1, ...fromCR, ...fromR3, ...fromR4, ...fromR5, ...fromR6, ...fromR7]) {
      const key = (p.title || '').toLowerCase().slice(0, 60);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      allUk.push(p);
    }
  }

  // Скоринг + domainBoost + фільтр за роками
  const withScore = allUk.map(p => ({
    ...p,
    _score: scoreRelevance(p.title.toLowerCase(), allUkKeywords),
  })).sort((a, b) => b._score - a._score);
  const boosted = domainBoost(applyYearFilter(withScore, allUkKeywords), sectionTitle, topic);

  // Іноземні: польські + англійські
  const maxForeign = Math.max(1, Math.ceil(needed * 0.3));
  const enQuery = enKeywords.slice(0, 3).join(' ').trim();
  const enRaw = enQuery
    ? await fetchEnglishViaBackend(enKeywords, maxForeign).catch(() => [])
    : [];
  const fromPL = [...mapOA(r8, 'pl'), ...mapOA(r9, 'pl')];

  const foreignSeen = new Set();
  const allForeign = [];
  for (const p of [...fromPL, ...enRaw]) {
    const key = (p.title || '').toLowerCase().slice(0, 60);
    if (!key || foreignSeen.has(key)) continue;
    foreignSeen.add(key);
    allForeign.push(p);
  }
  const foreignScored = applyYearFilter(
    allForeign.map(p => ({
      ...p,
      _score: scoreRelevance((p.title || '').toLowerCase(), enKeywords),
    })).sort((a, b) => b._score - a._score),
    enKeywords,
    0,
    ['en'], // enKeywords звіряються з англомовними назвами — на відміну від pl, тут скор має сенс
  );

  const ukSeen = new Set(boosted.slice(0, target).map(p => (p.title || '').toLowerCase().slice(0, 60)));
  const foreignFiltered = foreignScored.filter(p => !ukSeen.has((p.title || '').toLowerCase().slice(0, 60)));

  // ── Книги: OpenAlex + CrossRef + Serper ──
  const fromOABooks    = r10.status === 'fulfilled' ? r10.value : [];
  const fromCRBooks    = r11.status === 'fulfilled' ? r11.value : [];
  const fromSerperBooks = r12.status === 'fulfilled' ? r12.value : [];

  const allArticlesSeen = new Set([
    ...boosted.slice(0, target).map(p => (p.title || '').toLowerCase().slice(0, 60)),
    ...foreignFiltered.slice(0, maxForeign).map(p => (p.title || '').toLowerCase().slice(0, 60)),
  ]);
  const booksSeen = new Set(allArticlesSeen);
  const booksPool = [];
  for (const p of [...fromOABooks, ...fromCRBooks, ...fromSerperBooks]) {
    const key = (p.title || '').toLowerCase().slice(0, 60);
    if (!key || booksSeen.has(key)) continue;
    booksSeen.add(key);
    booksPool.push(p);
  }
  const maxBooks = Math.max(2, Math.ceil(needed * 0.4));
  const booksScored = applyYearFilter(
    booksPool
      .map(p => ({ ...p, _score: scoreRelevance((p.title || '').toLowerCase(), allUkKeywords) }))
      .sort((a, b) => b._score - a._score),
    allUkKeywords,
  ).slice(0, maxBooks);

  const flat = [
    ...boosted.slice(0, target),
    ...foreignFiltered.slice(0, maxForeign),
    ...booksScored,
  ];

  // Групи по Gemini-фразах (порожні якщо фрази не надано)
  let groups = [];
  if (usingGemini) {
    const groupMap = {};
    for (const p of boosted.slice(0, target)) {
      const key = (p.title || '').toLowerCase().slice(0, 60);
      const phrase = phraseAttrib.get(key) || p0;
      if (!groupMap[phrase]) groupMap[phrase] = [];
      groupMap[phrase].push(p);
    }
    // Зберігаємо порядок фраз як у Gemini
    const phraseOrder = [p0, p1, p2, coreTerm].filter((v, i, a) => a.indexOf(v) === i);
    groups = phraseOrder
      .filter(ph => groupMap[ph]?.length)
      .map(ph => ({ phrase: ph, papers: groupMap[ph] }));
  }

  return { flat, groups };
}

// ── Прохід Б («адвокат диявола»): незалежна друга перевірка вже відібраних Проходом А
// кандидатів. Не бачить оцінки/вердикту Проходу А (щоб не якорилась на чужому рішенні) —
// отримує лише назву+анотацію і тезу, і її завдання не підтвердити вибір, а спробувати
// його спростувати. Ловить саме те, що один прохід пропускає: загальнотеоретичний збіг
// лексики в тезі задовольняється джерелом з іншого предмета (інший вид мистецтва/
// діяльності, інша вікова група, країна, період чи галузь) ──
async function devilsAdvocateCheck(shortlist, sectionTitle, topic, thesisContext, onCost) {
  if (!shortlist.length) return shortlist;
  const items = shortlist.map((p, i) => {
    const abstractLine = p.abstract ? `\n   Анотація: ${p.abstract.slice(0, 220)}` : '\n   (анотації немає)';
    return `${i}. ${p.title}${abstractLine}`;
  }).join('\n');
  const thesisLine = thesisContext ? `Конкретна теза: "${thesisContext}"\n` : '';
  const prompt = `Тема наукової роботи: "${topic}"
Підрозділ: "${sectionTitle}"
${thesisLine}
Кандидати, які попередньо визнані релевантними:
${items}

Твоє завдання — не підтвердити цей вибір, а спробувати його СПРОСТУВАТИ. Для кожного кандидата шукай конкретну підставу для відхилення:
- підміна виду мистецтва/діяльності/дисципліни (інший жанр чи галузь, ніж у темі, навіть якщо термінологія схожа);
- підміна вікової групи чи цільової аудиторії;
- підміна країни;
- підміна історичного періоду чи епохи;
- підміна конкретного об'єкта дослідження (інший твір/подія/організація, навіть у тій самій галузі).

Загальний збіг теоретичної лексики без збігу власного предмета статті ("про що вона насправді") — підстава відхилити.
Якщо після ретельного пошуку не знайшов жодної з цих підмін — reject:false.
Якщо знайшов хоч одну — reject:true, коротко вкажи яку.

Поверни JSON: {"results":[{"index":0,"reject":false,"reason":"..."}]}`;
  try {
    const res = await fetch(`${getApiBase()}/api/gemini`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        _model: 'gemini-2.5-flash-lite',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 1200,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    index: { type: 'integer' },
                    reject: { type: 'boolean' },
                    reason: { type: 'string' },
                  },
                  required: ['index', 'reject', 'reason'],
                },
              },
            },
            required: ['results'],
          },
        },
      }),
    });
    // Збій запиту — не підтверджено незалежною перевіркою, відхиляємо все (fail-closed)
    if (!res.ok) return [];
    const data = await res.json();
    if (data.usageMetadata) {
      const cost = (data.usageMetadata.promptTokenCount * 0.10 + data.usageMetadata.candidatesTokenCount * 0.40) / 1_000_000;
      reportCost({ cost, model: 'gemini-2.5-flash-lite', inTok: data.usageMetadata.promptTokenCount, outTok: data.usageMetadata.candidatesTokenCount }, onCost);
    }
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = JSON.parse(raw);
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    const verdictByIdx = new Map(results.filter(r => typeof r.index === 'number').map(r => [r.index, r]));
    return shortlist.filter((_, i) => {
      const v = verdictByIdx.get(i);
      return !!v && v.reject === false; // немає вердикту чи reject:true — відхиляємо
    });
  } catch {
    return [];
  }
}

// ── Gemini-фільтрація: два незалежні проходи. Прохід А відбирає за трьома обов'язковими
// осями (об'єкт/аспект/контекст), Прохід Б («адвокат диявола») незалежно намагається
// спростувати кожного кандидата з проходу А. Джерело йде далі лише якщо погодились обидва —
// немає "тихого" дефолту: збій запиту чи непарситься відповідь трактуються як "нічого не
// підтверджено", а не як "усе підходить".
export async function filterSourcesWithGemini(candidates, sectionTitle, topic, maxResults = 15, thesisContext = '', onCost) {
  if (!candidates.length) return candidates;
  const items = candidates.map((p, i) => {
    const abstractLine = p.abstract
      ? `\n   Анотація: ${p.abstract.slice(0, 220)}`
      : '\n   (анотації немає — суди обережно лише за назвою)';
    return `${i}. ${p.title}${abstractLine}`;
  }).join('\n');
  const thesisLine = thesisContext ? `Конкретна теза, під яку шукаємо джерела: "${thesisContext}"\n` : '';
  const prompt = `Тема наукової роботи: "${topic}"
Підрозділ: "${sectionTitle}"
${thesisLine}
Список знайдених статей (з анотацією, де є):
${items}

Для кожного кандидата перевір ТРИ обов'язкові умови — включай статтю в results лише якщо ВСІ три виконані:
1. ОБ'ЄКТ — власний предмет самої статті (те, про що вона за назвою й анотацією, а не окремий термін, який у ній згадується) — той самий конкретний твір/вид мистецтва чи діяльності/явище/група, що й у темі й тезі, а не просто суміжна галузь чи спільна теоретична лексика. Стаття про ІНШИЙ вид мистецтва чи діяльності (напр. драма чи література, коли тема — балет; фольклорний танець, коли тема — класичний балет; підготовка/педагогіка фахівців, коли тема — аналіз конкретних творів), ІНШИЙ напрям чи епоху (напр. авангард/дадаїзм, коли тема — романтизм) — НЕ проходить об'єкт, навіть якщо в анотації трапляються ті самі абстрактні терміни ("метафізична рефлексія", "тіло і звук як код", "методологічний підхід"). Перевіряй, що стаття написана САМЕ про предмет теми, а не просто використовує суміжну термінологію з іншого приводу.
2. АСПЕКТ — стаття розглядає саме той кут проблеми, який потрібен для цієї тези/підрозділу, а не тему загалом з іншого боку.
3. КОНТЕКСТ — країна, період, вікова група, галузь чи метод дослідження не суперечать обмеженням роботи.

Якщо анотації немає — суди дуже обережно: включай лише коли сама назва однозначно підтверджує всі три умови.
Якщо хоч одна з трьох умов не виконується — НЕ включай статтю, навіть якщо назва виглядає схожою чи термінологія збігається. Загальне теоретичне речення в тезі ("тіло і звук діють як єдиний код", "потребує методологічного підходу") НЕ виправдовує джерело з іншого предмета — воно однаково має бути про той самий об'єкт теми.
Якщо жодна стаття не підходить — поверни порожній масив results. Не підганяй кількість під ліміт — краще менше, ніж хибне.

Для кожної відібраної статті постав objectMatch/aspectMatch/contextMatch (усі true), оцінку score 0-100 (100 = точний збіг за трьома умовами, нижче 70 не включай) і одне речення-причину (до 12 слів).

Поверни JSON: {"results":[{"index":0,"objectMatch":true,"aspectMatch":true,"contextMatch":true,"score":85,"reason":"Розглядає..."}]}`;
  try {
    const res = await fetch(`${getApiBase()}/api/gemini`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        _model: 'gemini-2.5-flash-lite',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 1600,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    index: { type: 'integer' },
                    objectMatch: { type: 'boolean' },
                    aspectMatch: { type: 'boolean' },
                    contextMatch: { type: 'boolean' },
                    score: { type: 'integer' },
                    reason: { type: 'string' },
                  },
                  required: ['index', 'objectMatch', 'aspectMatch', 'contextMatch', 'score', 'reason'],
                },
              },
            },
            required: ['results'],
          },
        },
      }),
    });
    // Збій запиту — трактуємо як "нічого не підтверджено", а не як "усе підходить"
    if (!res.ok) return [];
    const data = await res.json();
    if (data.usageMetadata) {
      const cost = (data.usageMetadata.promptTokenCount * 0.10 + data.usageMetadata.candidatesTokenCount * 0.40) / 1_000_000;
      reportCost({ cost, model: 'gemini-2.5-flash-lite', inTok: data.usageMetadata.promptTokenCount, outTok: data.usageMetadata.candidatesTokenCount }, onCost);
    }
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = JSON.parse(raw);
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    const passA = results
      .filter(r =>
        typeof r.index === 'number' && candidates[r.index]
        && r.objectMatch === true && r.aspectMatch === true && r.contextMatch === true
        && typeof r.score === 'number' && r.score >= 70,
      )
      .map(r => ({
        ...candidates[r.index],
        geminiReason: r.reason || '',
        geminiScore: r.score,
      }));
    if (!passA.length) return passA;
    // Прохід Б: незалежна друга перевірка — не бачить оцінки/причини Проходу А
    return devilsAdvocateCheck(passA, sectionTitle, topic, thesisContext, onCost);
  } catch {
    // Мережевий збій або непарситься JSON — так само "нічого не підтверджено"
    return [];
  }
}

// ── Другий раунд добору при нестачі: альтернативні (синоніми/суміжні терміни) пошукові фрази ──
export async function generateAlternatePhrases(topic, sectionTitle, triedPhrases = [], onCost) {
  const prompt = `Тема наукової роботи: "${topic}"
Підрозділ: "${sectionTitle}"
Вже пробували ці пошукові фрази (результатів бракує): ${triedPhrases.join('; ')}

Попередні фрази явно занадто вузькі — бракує результатів під них у наукових базах. Запропонуй 3 НОВІ, СУТТЄВО ШИРШІ пошукові фрази українською: прибери вузькі власні назви (конкретні імена, назви творів) і вузькоспеціальні терміни, залиш лише загальний предмет і суть теми підрозділу — так, як шукав би цю тему науковець, що формулює запит на рівень ширше за вже спробуване, а не просто підбирає синонім до того самого вузького словосполучення.
Поверни JSON: {"phrases":["фраза1","фраза2","фраза3"]}`;
  try {
    const res = await fetch(`${getApiBase()}/api/gemini`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        _model: 'gemini-2.5-flash-lite',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 400, responseMimeType: 'application/json' },
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (data.usageMetadata) {
      const cost = (data.usageMetadata.promptTokenCount * 0.10 + data.usageMetadata.candidatesTokenCount * 0.40) / 1_000_000;
      reportCost({ cost, model: 'gemini-2.5-flash-lite', inTok: data.usageMetadata.promptTokenCount, outTok: data.usageMetadata.candidatesTokenCount }, onCost);
    }
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = JSON.parse(raw);
    return (parsed.phrases || []).map(String).filter(Boolean);
  } catch {
    return [];
  }
}

// ── Gemini генерує 4 точних академічних пошукових фрази для підрозділу ──
/**
 * Для паперів без url і без doi — шукає DOI в CrossRef за бібліографічними даними.
 * Повертає той самий об'єкт з доданим doi (якщо знайдено з достатньою впевненістю).
 */
export async function lookupDOIByBiblio(paper) {
  if (paper.doi || paper.url) return paper;
  const title = (paper.title || '').slice(0, 120);
  const firstAuthorFamily = (Array.isArray(paper.authors) ? (paper.authors[0] || '') : '')
    .split(/[\s,]+/)[0] || '';
  const year = String(paper.year || '');
  if (!title || title.length < 8) return paper;
  try {
    const q = [title, firstAuthorFamily, year].filter(Boolean).join(' ');
    const r = await fetch(
      `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&rows=1&select=DOI,published,title&mailto=support@academ-assist.vercel.app`,
    );
    if (!r.ok) return paper;
    const d = await r.json();
    const item = d.message?.items?.[0];
    if (!item?.DOI) return paper;
    // Перевіряємо рік — відхилення ≤ 1 рік
    const itemYear = item.published?.['date-parts']?.[0]?.[0];
    if (year && itemYear && Math.abs(parseInt(year, 10) - parseInt(itemYear, 10)) > 1) return paper;
    // Перевіряємо автора — прізвище першого автора має бути в CrossRef-назві або авторах
    const crTitle = (item.title?.[0] || '').toLowerCase();
    const ourTitleLower = title.toLowerCase();
    // Хоча б 3 спільних слова > 4 літер між назвами → достатня схожість
    const ourWords = ourTitleLower.split(/\s+/).filter(w => w.length > 4);
    const overlap = ourWords.filter(w => crTitle.includes(w)).length;
    if (ourWords.length > 2 && overlap < 2) return paper; // занадто різні назви — не беремо
    return { ...paper, doi: item.DOI };
  } catch { return paper; }
}

/**
 * Шукає загальний обсяг книги (кількість сторінок) через Google Books API.
 * Використовується коли CrossRef/OpenAlex/DOI не дають діапазону сторінок
 * (типово для книг — вони мають лише "загальний обсяг", не "сторінки статті").
 */
export async function fetchGoogleBooksPageCount(title, authorSurname = '') {
  const cleanTitle = (title || '').slice(0, 120).trim();
  if (!cleanTitle || cleanTitle.length < 8) return null;
  try {
    const qParts = [`intitle:${cleanTitle}`];
    if (authorSurname) qParts.push(`inauthor:${authorSurname}`);
    const q = qParts.join('+');
    const r = await fetch(
      `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=1`,
      { cache: 'no-store' },
    );
    if (!r.ok) return null;
    const d = await r.json();
    const item = d.items?.[0];
    const pageCount = item?.volumeInfo?.pageCount;
    if (!pageCount || pageCount < 4) return null;
    // Перевірка збігу назви — щоб не причепити обсяг чужої книги
    const foundTitle = (item.volumeInfo?.title || '').toLowerCase();
    const ourWords = cleanTitle.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const overlap = ourWords.filter(w => foundTitle.includes(w)).length;
    if (ourWords.length > 2 && overlap < 2) return null;
    return pageCount;
  } catch { return null; }
}

/**
 * Шукає видавця, рік і обсяг книги через Google Books API (ширший набір полів,
 * ніж fetchGoogleBooksPageCount — для повного збагачення джерела, не лише сторінок).
 */
async function fetchGoogleBooksInfo(title, authorSurname = '') {
  const cleanTitle = (title || '').slice(0, 120).trim();
  if (!cleanTitle || cleanTitle.length < 8) return null;
  try {
    const qParts = [`intitle:${cleanTitle}`];
    if (authorSurname) qParts.push(`inauthor:${authorSurname}`);
    const q = qParts.join('+');
    const r = await fetch(
      `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=1`,
      { cache: 'no-store' },
    );
    if (!r.ok) return null;
    const d = await r.json();
    const item = d.items?.[0];
    const info = item?.volumeInfo;
    if (!info) return null;
    const foundTitle = (info.title || '').toLowerCase();
    const ourWords = cleanTitle.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const overlap = ourWords.filter(w => foundTitle.includes(w)).length;
    if (ourWords.length > 2 && overlap < 2) return null; // не та книга
    return {
      pageCount: info.pageCount && info.pageCount >= 4 ? info.pageCount : null,
      publisher: info.publisher || '',
      year: info.publishedDate ? info.publishedDate.slice(0, 4) : '',
    };
  } catch { return null; }
}

function normTitle(str) {
  if (!str) return str;
  const letters = str.match(/[а-яґєіїА-ЯҐЄІЇa-zA-Z]/g) || [];
  const upper = letters.filter(c => c !== c.toLowerCase()).length;
  if (letters.length > 5 && upper / letters.length > 0.6)
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  return str;
}

/**
 * Збагачує один рядок ручного введення — підтягує сторінки.
 *
 * Стратегія (від надійного до ненадійного):
 *  1. DOI в тексті → CrossRef/OpenAlex напряму (не залежить від сайту)
 *  2. CrossRef бібліографічний пошук по тексту рядка (назва + автор + рік)
 *  3. HTML мета-теги через проксі (fallback, може дати 429 або timeout)
 */
export async function enrichManualLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return line;
  // Вже є позначка сторінок: "С. 86" / "P. 45" (велика літера = сторінки, не ініціал)
  if (/[СP]\.\s*\d/.test(trimmed)) return line;

  const isUk = /[а-яА-ЯҐЄІЇґєії]/.test(trimmed);

  // Вставляємо сторінки перед URL або в кінець рядка
  const insertPages = (pages) => {
    const p = pages.replace(/-/g, '–');
    const pagesStr = isUk ? `С. ${p}` : `P. ${p}`;
    const urlM = trimmed.match(/https?:\/\/\S+/);
    if (urlM) {
      const url = urlM[0].replace(/[.,;)#]+$/, '');
      return line.replace(urlM[0], `${pagesStr}. ${urlM[0]}`);
    }
    return line.trimEnd().replace(/[.\s]+$/, '') + `. ${pagesStr}.`;
  };

  // ── Крок 1: DOI в тексті (doi.org/10.xxx або bare 10.xxx) ──
  const doiRaw = trimmed.match(/doi\.org\/(10\.\d{4,}\/[^\s"'<>]+)/i)
    || trimmed.match(/(?:^|\s)(10\.\d{4,}\/[^\s"'<>]+)/);
  if (doiRaw) {
    const doi = doiRaw[1].replace(/[.,;)]+$/, '');
    const meta = await lookupDoiMetadata(doi);
    if (meta?.pages) return insertPages(meta.pages);
  }

  // ── Крок 2: CrossRef бібліографічний пошук по тексту ──
  const textOnly = trimmed.replace(/https?:\/\/\S+/g, '').replace(/\s{2,}/g, ' ').trim();
  const yearM = textOnly.match(/\b(20\d{2}|19\d{2})\b/);
  const lineYear = yearM ? parseInt(yearM[1], 10) : null;

  if (textOnly.length > 20) {
    try {
      const q = encodeURIComponent(textOnly.slice(0, 220));
      const r = await fetch(
        `https://api.crossref.org/works?query.bibliographic=${q}&rows=1&select=DOI,page,published&mailto=support@academ-assist.vercel.app`,
      );
      if (r.ok) {
        const d = await r.json();
        const item = d.message?.items?.[0];
        if (item?.page) {
          // Перевірка року — відхилення не більше 1 року
          const crYear = item.published?.['date-parts']?.[0]?.[0];
          if (!lineYear || !crYear || Math.abs(lineYear - crYear) <= 1) {
            return insertPages(item.page);
          }
        }
      }
    } catch { /* CrossRef недоступний */ }
  }

  // ── Крок 3: HTML мета-теги через проксі (fallback) ──
  const urlMatch = trimmed.match(/https?:\/\/\S+/);
  if (urlMatch) {
    const url = urlMatch[0].replace(/[.,;)#]+$/, '');
    const pages = await fetchPagesFromUrl(url);
    if (pages) return insertPages(pages);
  }

  // ── Крок 4: без URL і без DOI — це, ймовірно, книга. Пробуємо загальний
  // обсяг через Google Books (окрема сторінка для конкретної цитати з книги
  // об'єктивно невідома — але хоча б діапазон 1–N дає з чого обрати) ──
  const looksLikeArticle = /№|Вип\.|Vol\.|No\.|pp?\.\s*\d/i.test(textOnly);
  if (!urlMatch && !looksLikeArticle && textOnly.length > 8) {
    const pageCount = await fetchGoogleBooksPageCount(textOnly);
    if (pageCount) {
      const suffix = isUk ? `${pageCount} с.` : `${pageCount} p.`;
      return line.trimEnd().replace(/[.\s]+$/, '') + `. ${suffix}`;
    }
  }

  return line;
}

/**
 * Збагачує один рядок джерела (типово — з клієнтської готової частини роботи,
 * де джерела часто оформлені без частини даних) повнішою бібліографічною
 * інформацією: рік, том/випуск, видавництво, журнал, сторінки.
 * На відміну від enrichManualLine (лише сторінки), тут додаються всі поля,
 * яких у рядку явно бракує; сам стиль оформлення виправляє подальший LLM-крок
 * конвеєра (formatSourcesWithRetry), тому дані просто дописуються в кінець.
 *
 * Стратегія пошуку та сама, що й у enrichManualLine:
 *  1. DOI в тексті → CrossRef/OpenAlex напряму
 *  2. CrossRef бібліографічний пошук за назвою+автором+роком → DOI → повні метадані
 *  3. Немає URL і не схоже на статтю → ймовірно книга → Google Books
 */
export async function enrichFullSourceInfo(line) {
  const trimmed = line.trim();
  if (!trimmed) return line;

  const isUk = /[а-яА-ЯҐЄІЇґєії]/.test(trimmed);
  const hasYear = /\b(19|20)\d{2}\b/.test(trimmed);
  const hasPages = /[СP]\.\s*\d/.test(trimmed);
  const hasVolIssue = /(Vol\.|Т\.\s*\d|№\s*\d|No\.\s*\d)/i.test(trimmed);
  const textOnly = trimmed.replace(/https?:\/\/\S+/g, '').replace(/\s{2,}/g, ' ').trim();
  const looksSparse = textOnly.split(/\s+/).filter(Boolean).length < 12;

  let meta = null;

  // ── Крок 1: DOI в тексті ──
  const doiRaw = trimmed.match(/doi\.org\/(10\.\d{4,}\/[^\s"'<>]+)/i)
    || trimmed.match(/(?:^|\s)(10\.\d{4,}\/[^\s"'<>]+)/);
  if (doiRaw) {
    const doi = doiRaw[1].replace(/[.,;)]+$/, '');
    meta = await lookupDoiMetadata(doi);
  }

  // ── Крок 2: без DOI — шукаємо його за бібліографічними даними, тоді тягнемо повні метадані ──
  if (!meta && textOnly.length > 20) {
    const yearM = textOnly.match(/\b(20\d{2}|19\d{2})\b/);
    const withDoi = await lookupDOIByBiblio({ title: textOnly, authors: [], year: yearM?.[1] || '' });
    if (withDoi.doi) meta = await lookupDoiMetadata(withDoi.doi);
  }

  const extras = [];
  if (meta) {
    if (meta.year && !hasYear) extras.push(String(meta.year));
    if (!hasVolIssue) {
      const vi = [];
      if (meta.volume) vi.push(isUk ? `Т. ${meta.volume}` : `Vol. ${meta.volume}`);
      if (meta.issue) vi.push(isUk ? `№ ${meta.issue}` : `No. ${meta.issue}`);
      if (vi.length) extras.push(vi.join(', '));
    }
    if (meta.journal && looksSparse) extras.push(meta.journal);
    if (meta.publisher && looksSparse) extras.push([meta.publisher, meta.publisherLocation].filter(Boolean).join(', '));
    if (meta.pages && !hasPages) extras.push((isUk ? 'С. ' : 'P. ') + meta.pages.replace(/-/g, '–'));
  }

  // ── Крок 3: без DOI-збігу, без URL, не схоже на статтю — ймовірно книга ──
  const urlMatch = trimmed.match(/https?:\/\/\S+/);
  const looksLikeArticle = /№|Вип\.|Vol\.|No\.|pp?\.\s*\d/i.test(textOnly);
  if (!meta && !urlMatch && !looksLikeArticle && textOnly.length > 8) {
    const books = await fetchGoogleBooksInfo(textOnly);
    if (books) {
      if (books.year && !hasYear) extras.push(String(books.year));
      if (books.publisher && looksSparse) extras.push(books.publisher);
      if (books.pageCount && !hasPages) extras.push(isUk ? `${books.pageCount} с.` : `${books.pageCount} p.`);
    }
  }

  if (!extras.length) return line;
  const extraStr = extras.join('. ') + '.';
  if (urlMatch) return line.replace(urlMatch[0], `${extraStr} ${urlMatch[0]}`);
  return line.trimEnd().replace(/[.\s]+$/, '') + `. ${extraStr}`;
}

export function paperToCitation(paper) {
  const isUk = paper.lang !== 'en';
  const authorsList = Array.isArray(paper.authors) ? paper.authors : [];
  // ДСТУ: коли автор невідомий — починаємо з назви (без "Автор невідомий")
  const authorsPart = authorsList.length ? `${authorsList.join(', ')}. ` : '';
  const isDomainLike = paper.venue && /^[\w.-]+\.[a-zA-Z]{2,}$/.test(paper.venue.trim());
  const venue = (paper.venue && !isDomainLike) ? ` *${paper.venue}*.` : '';
  let issuePart = '';
  if (paper.volume) issuePart += isUk ? ` Вип. ${paper.volume}.` : ` Vol. ${paper.volume}.`;
  if (paper.issue) issuePart += isUk ? ` № ${paper.issue}.` : ` No. ${paper.issue}.`;
  const pages = paper.pages
    ? ` ${isUk ? 'С.' : 'P.'} ${paper.pages}.`
    : '';
  const rawUrl = paper.url || (paper.doi ? `https://doi.org/${paper.doi}` : '');
  const urlPart = rawUrl ? ` URL: ${rawUrl}.` : '';
  return `${authorsPart}${normTitle(paper.title)}.${venue} ${paper.year}.${issuePart}${pages}${urlPart}`.replace(/\.\s*\./g, '.').replace(/\s{2,}/g, ' ').trim();
}

export async function generateSearchPhrases(sectionLabel, topic, direction = '', subject = '', onCost) {
  const domainCtx = [direction, subject].filter(Boolean).join(', ');
  const prompt = `Тема наукової роботи: "${topic}"${domainCtx ? `\nГалузь: ${domainCtx}` : ''}
Підрозділ: "${sectionLabel}"

Згенеруй пошукові фрази для пошуку в наукових базах (OpenAlex, CrossRef, Semantic Scholar).
Потрібно:
- 4 фрази УКРАЇНСЬКОЮ (3–5 слів, реальні академічні формулювання)
- 4 фрази АНГЛІЙСЬКОЮ (3–5 слів, academic English equivalents)
- Кожна фраза — різний аспект підрозділу
- Лише ключові слова, без прийменників і сполучників

Поверни JSON: {"phrases":["укр 1","укр 2","укр 3","укр 4","en 1","en 2","en 3","en 4"]}`;
  try {
    const res = await fetch(`${getApiBase()}/api/gemini`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        _model: 'gemini-2.5-flash-lite',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 400, responseMimeType: 'application/json' },
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (data.usageMetadata) {
      const cost = (data.usageMetadata.promptTokenCount * 0.10 + data.usageMetadata.candidatesTokenCount * 0.40) / 1_000_000;
      reportCost({ cost, model: 'gemini-2.5-flash-lite', inTok: data.usageMetadata.promptTokenCount, outTok: data.usageMetadata.candidatesTokenCount }, onCost);
    }
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = JSON.parse(raw);
    return (parsed.phrases || []).filter(p => typeof p === 'string' && p.trim().length > 3).slice(0, 8);
  } catch {
    return [];
  }
}

// ── Автозбагачення метаданих + гейт повноти для вже релевантних (Прохід А+Б) джерел ──
// Викликається одразу після filterSourcesWithGemini, до вставки в suggestedSources — щоб
// автовставка (SourcesStage.jsx buildTop) оцінювала вже збагачені дані, а не сирі з
// пошукового API, де авторів/сторінок часто бракує, хоча вони доступні через DOI.
// Позначає кожне джерело полями _complete/_missingFields: чого не вдалось знайти
// в жодній базі після реальної спроби — того чесно бракує, воно не автовставляється,
// а йде в список ручного вибору з поясненням, що саме відсутнє.
export async function enrichSources(papers) {
  if (!papers.length) return papers;

  // _doiResolved: чи справді підтвердився DOI через живий запит до CrossRef/OpenAlex —
  // null, якщо DOI взагалі немає (перевіряти нема чим цим шляхом).
  const afterDoi = await Promise.all(papers.map(async p => {
    if (!p.doi) return { ...p, _doiResolved: null };
    const meta = await lookupDoiMetadata(p.doi);
    if (!meta) return { ...p, _doiResolved: false };
    return {
      ...p,
      _doiResolved: true,
      ...(meta.authorsStructured?.length ? { authorsStructured: meta.authorsStructured } : {}),
      ...(meta.authors?.length ? { authors: meta.authors } : {}),
      ...(meta.pages && !p.pages ? { pages: meta.pages } : {}),
      ...(meta.volume ? { volume: meta.volume } : {}),
      ...(meta.issue ? { issue: meta.issue } : {}),
      ...(meta.journal && (!p.venue || /^[\w.-]+\.[a-zA-Z]{2,}$/.test(p.venue.trim())) ? { venue: meta.journal } : {}),
      ...(meta.publisher ? { publisher: meta.publisher } : {}),
      ...(meta.publisherLocation ? { publisherLocation: meta.publisherLocation } : {}),
    };
  }));

  // lookupDOIByBiblio сам перевіряє збіг назви+року перед тим, як прикріпити DOI —
  // якщо DOI щойно знайдено цим шляхом, вважаємо його підтвердженим так само.
  const afterDoiBiblio = await Promise.all(afterDoi.map(async p => {
    const result = await lookupDOIByBiblio(p);
    if (result.doi && p._doiResolved === null) return { ...result, _doiResolved: true };
    return result;
  }));

  const afterMeta = await Promise.all(afterDoiBiblio.map(async p => {
    if (p.pages) return p;
    const pageUrl = p.url || (p.doi ? `https://doi.org/${p.doi}` : null);
    if (!pageUrl) return p;
    const pages = await fetchPagesFromUrl(pageUrl);
    return pages ? { ...p, pages } : p;
  }));

  const enriched = await Promise.all(afterMeta.map(async p => {
    if (p.type !== 'book' || p.pages || p.totalPages) return p;
    const firstAuthorSurname = (Array.isArray(p.authors) ? (p.authors[0] || '') : '').split(/[\s,]+/)[0] || '';
    const totalPages = await fetchGoogleBooksPageCount(p.title, firstAuthorSurname);
    return totalPages ? { ...p, totalPages } : p;
  }));

  // Перевірка існування: DOI резолвиться живим запитом, АБО (коли DOI немає) URL
  // справді відкривається. Без жодного з двох — джерело не можна вважати підтвердженим,
  // хай навіть назва виглядає правдоподібно.
  const verified = await Promise.all(enriched.map(async p => {
    if (p._doiResolved === true) return p;
    if (p._doiResolved === false) return { ...p, _unverified: true }; // DOI є, але не резолвиться
    if (p.url) {
      const ok = await verifyUrlOpens(p.url);
      return ok ? p : { ...p, _unverified: true };
    }
    return { ...p, _unverified: true }; // ні DOI, ні URL — нічим підтвердити
  }));

  // Гейт повноти: рік, видання/видавництво мають бути присутні, а існування — підтверджене.
  // Для книг вимагаємо саме видавця (не будь-яке "видання") і обсяг сторінок —
  // ISBN/каталог послідовно недоступні з наявних API, тому видавець+обсяг — реалістичний
  // мінімум. Авторів навмисно не вимагаємо жорстко — ДСТУ 8302 дозволяє легітимні записи
  // без автора (інституційні звіти тощо), paperToCitation це коректно обробляє.
  // Анотація — не блокує _complete: для вузьких/спеціальних тем вона часто недоступна
  // через API навіть у справді релевантних і підтверджених (DOI/URL) джерел. Лишається
  // видимою в _missingFields як інформаційний бейдж, щоб користувач бачив прогалину.
  return verified.map(p => {
    const missing = [];
    const missingSoft = [];
    if (!p.year) missing.push('рік');
    if (p.type === 'book') {
      if (!p.publisher) missing.push('видавець');
      if (!p.pages && !p.totalPages) missing.push('обсяг сторінок');
    } else if (!p.venue && !p.publisher) {
      missing.push('видання/видавництво');
    }
    if (!p.abstract) missingSoft.push('анотація');
    if (p._unverified) missing.push('не підтверджено існування джерела (DOI/посилання)');
    return { ...p, _complete: missing.length === 0, _missingFields: [...missing, ...missingSoft] };
  });
}
