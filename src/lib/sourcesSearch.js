// ── Пошук джерел ──
// OpenAlex  — CORS підтримується, викликаємо з браузера напряму
// CrossRef  — CORS підтримується, викликаємо з браузера напряму (добре індексує укр. журнали)
// Semantic Scholar — НЕ підтримує CORS, проксимо через /api/search-sources (Vercel)

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
  try {
    const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers: { 'User-Agent': 'AcademAssist/1.0 (mailto:support@academ-assist.vercel.app)' },
    });
    if (!r.ok) return null;
    const d = await r.json();
    const p = d.message;
    if (!p) return null;
    const authorsStructured = (p.author || []).slice(0, 3)
      .map(a => ({ family: a.family || '', given: a.given || '' }))
      .filter(a => a.family);
    const authors = authorsStructured
      .map(a => [a.family, a.given?.[0]].filter(Boolean).join(' '))
      .filter(Boolean);
    const pages = p.page
      ? p.page.replace('-', '–')
      : extractPagesFromDoi(doi);
    return {
      authorsStructured,
      authors,
      pages,
      volume: p.volume || '',
      issue: p.issue || '',
      journal: p['container-title']?.[0] || '',
      publisher: p.publisher || '',
      publisherLocation: p['publisher-location'] || '',
    };
  } catch {
    return null;
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

// ── OpenAlex ──
const OA_BASE = 'https://api.openalex.org/works';
const OA_FIELDS = 'title,authorships,publication_year,primary_location,doi,language,id,biblio,abstract_inverted_index';

async function openAlexSearch(query, filterStr, limit, page = 1) {
  const url = `${OA_BASE}?search=${encodeURIComponent(query)}&filter=${filterStr}&per_page=${limit}&page=${page}&select=${OA_FIELDS}`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.results || []).filter(p => p.title && !isBlocked(p));
}

// Пошук тільки по заголовках — набагато точніший
async function openAlexTitleSearch(query, filters, limit, page = 1) {
  const filterParams = filters.map(f => `filter=${f}`).join('&');
  const url = `${OA_BASE}?filter=title.search:${encodeURIComponent(query)}&${filterParams}&per_page=${limit}&page=${page}&select=${OA_FIELDS}`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) return [];
  const d = await r.json();
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
  return {
    id: p.id || p.doi || String(Math.random()),
    title: p.title || '',
    authors: (p.authorships || []).slice(0, 3)
      .map(a => a.author?.display_name || '').filter(Boolean),
    year: p.publication_year || '',
    venue: p.primary_location?.source?.display_name || '',
    doi,
    pages,
    lang,
    source: 'openalex',
    abstract,
    url,
  };
}

// ── BASE (Bielefeld Academic Search Engine) — індексує укр. репозиторії ──
async function fetchBASE(query, limit) {
  try {
    const q = `${query} dclanguage:uk`;
    const url = `https://api.base-search.net/cgi-bin/BaseHttpSearchInterface.fcgi?func=PerformSearch&query=${encodeURIComponent(q)}&format=json&hits=${limit}`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.response?.docs || []).filter(p => {
      const title = Array.isArray(p.dctitle) ? p.dctitle[0] : p.dctitle;
      return title && !isBlocked(p);
    });
  } catch { return []; }
}

function mapBASE(doc) {
  const title = Array.isArray(doc.dctitle) ? doc.dctitle[0] : (doc.dctitle || '');
  const rawDoi = Array.isArray(doc.dcdoi) ? doc.dcdoi[0] : (doc.dcdoi || '');
  const doi = rawDoi.replace('https://doi.org/', '');
  const rawLink = Array.isArray(doc.dclink) ? doc.dclink[0] : (doc.dclink || '');
  const url = rawLink || (doi ? `https://doi.org/${doi}` : '');
  const rawId = Array.isArray(doc.dcidentifier) ? doc.dcidentifier[0] : (doc.dcidentifier || '');
  const abstract = Array.isArray(doc.dcdescription) ? doc.dcdescription[0] : (doc.dcdescription || '');
  return {
    id: rawId || url || String(Math.random()),
    title,
    authors: (doc.dcauthor || []).slice(0, 3).map(String),
    year: doc.dcyear || '',
    venue: Array.isArray(doc.dcpublisher) ? doc.dcpublisher[0] : (doc.dcpublisher || ''),
    doi,
    pages: '',
    lang: hasCyrillic(title) ? 'uk' : 'pl',
    source: 'base',
    abstract: snippetAbstract(abstract),
    url,
  };
}

// ── Google Scholar через Serper.dev (проксі /api/search-scholar) ──
async function fetchScholar(query, limit) {
  try {
    const res = await fetch('/api/search-scholar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.sources || []).filter(p => p.title && !isBlocked(p));
  } catch { return []; }
}

// ── CORE.ac.uk — агрегатор відкритого доступу, індексує репозиторії ──
const CORE_KEY = typeof import.meta !== 'undefined' ? (import.meta.env?.VITE_CORE_API_KEY || '') : '';

async function fetchCORE(query, limit) {
  if (!CORE_KEY) return [];
  try {
    const url = `https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent(query)}&limit=${limit}&apiKey=${CORE_KEY}`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.results || []).filter(p => p.title && !isBlocked(p));
  } catch { return []; }
}

function mapCORE(result) {
  const title = result.title || '';
  const doi = result.doi || '';
  const urls = result.sourceFulltextUrls || [];
  const url = result.downloadUrl || urls[0] || (doi ? `https://doi.org/${doi}` : '');
  return {
    id: result.id ? `core-${result.id}` : String(Math.random()),
    title,
    authors: (result.authors || []).slice(0, 3).map(a => (typeof a === 'string' ? a : a.name || '')).filter(Boolean),
    year: result.yearPublished || '',
    venue: (result.journals || [])[0]?.title || result.publisher || '',
    doi,
    pages: '',
    lang: hasCyrillic(title) ? 'uk' : 'en',
    source: 'core',
    abstract: snippetAbstract(result.abstract || ''),
    url,
  };
}

// ── OpenAlex книги (тип book/monograph, україномовні) ──
async function fetchOpenAlexBooks(query, limit) {
  try {
    const yr = 'publication_year:>2014';
    const url = `${OA_BASE}?search=${encodeURIComponent(query)}&filter=type:book,language:uk,${yr}&per_page=${limit}&select=${OA_FIELDS}`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.results || [])
      .filter(p => p.title && !isBlocked(p))
      .map(p => ({ ...mapOpenAlex(p, 'uk'), type: 'book' }));
  } catch { return []; }
}

// ── CrossRef монографії ──
async function fetchCrossRefBooks(query, limit) {
  try {
    const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&filter=type:monograph&rows=${Math.min(limit, 10)}`;
    const r = await fetch(url, {
      cache: 'no-store',
      headers: { 'User-Agent': 'AcademAssist/1.0 (mailto:support@academ-assist.vercel.app)' },
    });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.message?.items || [])
      .filter(p => p.title?.[0] && hasCyrillic(p.title[0]) && !isBlocked(p))
      .map(p => ({
        id: p.DOI || String(Math.random()),
        title: p.title[0],
        authors: (p.author || []).slice(0, 3)
          .map(a => [a.family, a.given?.[0]].filter(Boolean).join(' ')).filter(Boolean),
        year: p.published?.['date-parts']?.[0]?.[0]
          || p['published-print']?.['date-parts']?.[0]?.[0] || '',
        venue: p['container-title']?.[0] || p.publisher || '',
        doi: p.DOI || '',
        pages: '',
        lang: 'uk',
        source: 'crossref',
        type: 'book',
        url: p.DOI ? `https://doi.org/${p.DOI}` : '',
      }));
  } catch { return []; }
}

// ── Google Books через Serper.dev (проксі /api/search-books) ──
async function fetchBooksSerper(query, limit) {
  try {
    const res = await fetch('/api/search-books', {
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
async function fetchCrossRefUkrainian(query, limit) {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&filter=from-pub-date:2020&rows=${Math.min(limit * 2, 20)}`;
  const r = await fetch(url, {
    cache: 'no-store',
    headers: { 'User-Agent': 'AcademAssist/1.0 (mailto:support@academ-assist.vercel.app)' },
  });
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
      authors: (p.author || []).slice(0, 3)
        .map(a => [a.family, a.given?.[0]].filter(Boolean).join(' ')).filter(Boolean),
      year: (p.published?.['date-parts']?.[0]?.[0]
        || p['published-print']?.['date-parts']?.[0]?.[0]
        || ''),
      venue: p['container-title']?.[0] || '',
      doi: p.DOI || '',
      pages: p.page ? p.page.replace('-', '–') : extractPagesFromDoi(p.DOI || ''),
      lang: 'uk',
      source: 'crossref',
      url: p.DOI ? `https://doi.org/${p.DOI}` : '',
    }));
}

// ── Semantic Scholar через бекенд (немає CORS у браузері) ──
async function fetchEnglishViaBackend(enKeywords, limit) {
  try {
    const res = await fetch('/api/search-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enKeywords, ukKeywords: [], needed: limit }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.sources || []).filter(p => p.lang === 'en');
  } catch {
    return [];
  }
}

// ── Пошук за однією фразою: BASE, Scholar (опційно), CORE, OpenAlex uk, CrossRef, OpenAlex pl ──
export async function searchByPhrase(phrase, limit = 10, page = 1, useScholar = false) {
  const yr = 'publication_year:>2019';
  const [r1, r2, r3, r4, r5, r6] = await Promise.allSettled([
    fetchBASE(phrase, limit),
    useScholar ? fetchScholar(phrase, limit) : Promise.resolve([]),
    fetchCORE(phrase, limit),
    openAlexSearch(phrase, `language:uk,${yr}`, limit, page),
    fetchCrossRefUkrainian(phrase, limit),
    openAlexSearch(phrase, `language:pl,${yr}`, limit, page),
  ]);

  const baseRaw    = r1.status === 'fulfilled' ? r1.value.map(mapBASE) : [];
  const scholarRaw = r2.status === 'fulfilled' ? r2.value : [];
  const coreRaw    = r3.status === 'fulfilled' ? r3.value.map(mapCORE) : [];
  const ukRaw      = r4.status === 'fulfilled' ? r4.value.map(p => mapOpenAlex(p, 'uk')) : [];
  const crRaw      = r5.status === 'fulfilled' ? r5.value.filter(p => hasCyrillic(p.title || '')) : [];
  const plRaw      = r6.status === 'fulfilled' ? r6.value.map(p => mapOpenAlex(p, 'pl')) : [];

  const seen = new Set();
  const results = [];
  for (const p of [...baseRaw, ...scholarRaw, ...coreRaw, ...ukRaw, ...crRaw, ...plRaw]) {
    const key = (p.title || '').toLowerCase().slice(0, 60);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    results.push(p);
  }
  return results;
}

// ── Головна функція пошуку ──
// 9 запитів паралельно: різні фрази, режими (full-text / title.search), дві сторінки OpenAlex
// r1,r3-r7,r9 — OpenAlex (сирий формат) → mapOpenAlex
// r2, r8      — CrossRef (вже відформатовано fetchCrossRefUkrainian) → без маппінгу
export async function searchSourcesForSection(ukKeywords, enKeywords, needed = 4, sectionTitle = '', topic = '', page = 1, semKeywords = [], anchors = [], geminiPhrases = []) {
  const target = 25;
  const fetchLimit = 15;
  const allUkKeywords = [...new Set([...ukKeywords, ...semKeywords])];
  const yr = 'publication_year:>2019';

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
    fetchBooksSerper(p0, 8),                                                  // r12: Google Books Serper
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

  // Скоринг + domainBoost
  const withScore = allUk.map(p => ({
    ...p,
    _score: scoreRelevance(p.title.toLowerCase(), allUkKeywords),
  })).sort((a, b) => b._score - a._score);
  const boosted = domainBoost(withScore, sectionTitle, topic);

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
  const foreignScored = allForeign.map(p => ({
    ...p,
    _score: scoreRelevance((p.title || '').toLowerCase(), enKeywords),
  })).sort((a, b) => b._score - a._score);

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
  const booksScored = booksPool
    .map(p => ({ ...p, _score: scoreRelevance((p.title || '').toLowerCase(), allUkKeywords) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, maxBooks);

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

// ── Gemini-фільтрація: двохрівнева з поясненням ──
// Повертає [{...paper, geminiTier: 'exact'|'analogy', geminiReason: '...'}]
export async function filterSourcesWithGemini(candidates, sectionTitle, topic, maxResults = 15, thesisContext = '') {
  if (!candidates.length) return candidates;
  const items = candidates.map((p, i) => `${i}. ${p.title}`).join('\n');
  const thesisLine = thesisContext ? `Конкретний аспект для цих джерел: "${thesisContext}"\n` : '';
  const prompt = `Тема наукової роботи: "${topic}"
Підрозділ: "${sectionTitle}"
${thesisLine}
Список знайдених статей:
${items}

Відбери ЛИШЕ статті що безпосередньо стосуються теми і підрозділу: той самий об'єкт дослідження, та сама галузь, той самий контекст.
НЕ включай: статті де спільне лише одне загальне слово без прив'язки до теми, статті з інших галузей, загальні огляди не пов'язані з предметом.
Якщо жодна стаття не підходить — поверни порожній масив results.
Для кожної відібраної — одне речення до 12 слів чому підходить.

Поверни JSON: {"results":[{"index":0,"reason":"Розглядає..."}]}`;
  try {
    const res = await fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        _model: 'gemini-2.5-flash-lite',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 1200, responseMimeType: 'application/json' },
      }),
    });
    if (!res.ok) return candidates;
    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = JSON.parse(raw);
    const results = parsed.results || [];
    if (!results.length) return [];
    return results
      .filter(r => typeof r.index === 'number' && candidates[r.index])
      .map(r => ({
        ...candidates[r.index],
        geminiReason: r.reason || '',
      }));
  } catch {
    return candidates;
  }
}

// ── Gemini генерує 4 точних академічних пошукових фрази для підрозділу ──
export function paperToCitation(paper) {
  const authorsList = Array.isArray(paper.authors) ? paper.authors : [];
  const authors = authorsList.length ? authorsList.join(', ') : 'Автор невідомий';
  const isDomainLike = paper.venue && /^[\w.-]+\.[a-zA-Z]{2,}$/.test(paper.venue.trim());
  const venue = (paper.venue && !isDomainLike) ? ` ${paper.venue}.` : '';
  const pages = paper.pages
    ? ` ${paper.lang === 'en' ? 'P.' : 'С.'} ${paper.pages}.`
    : '';
  const urlPart = paper.url
    ? ` ${paper.url}`
    : paper.doi ? ` https://doi.org/${paper.doi}` : '';
  return `${authors}. ${paper.title}.${venue} ${paper.year}.${pages}${urlPart}`.replace(/\.\s*\./g, '.').replace(/\s{2,}/g, ' ').trim();
}

export async function generateSearchPhrases(sectionLabel, topic, direction = '', subject = '') {
  const domainCtx = [direction, subject].filter(Boolean).join(', ');
  const prompt = `Тема наукової роботи: "${topic}"${domainCtx ? `\nГалузь: ${domainCtx}` : ''}
Підрозділ: "${sectionLabel}"

Згенеруй рівно 4 пошукові фрази для пошуку в наукових базах (OpenAlex, CrossRef).
Вимоги:
- 3–5 слів, називний відмінок
- Реальні наукові формулювання (як пишуть у заголовках статей)
- Українська мова
- Кожна фраза — інший аспект підрозділу

Поверни JSON: {"phrases":["фраза 1","фраза 2","фраза 3","фраза 4"]}`;
  try {
    const res = await fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        _model: 'gemini-2.5-flash-lite',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 200, responseMimeType: 'application/json' },
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = JSON.parse(raw);
    return (parsed.phrases || []).filter(p => typeof p === 'string' && p.trim().length > 3).slice(0, 4);
  } catch {
    return [];
  }
}
