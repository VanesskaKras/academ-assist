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

function isBlocked(obj) {
  const t = JSON.stringify(obj).toLowerCase();
  return BLOCKED.some(p => t.includes(p));
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
    const authors = (p.author || []).slice(0, 3)
      .map(a => [a.family, a.given?.[0]].filter(Boolean).join(' ')).filter(Boolean);
    const pages = p.page
      ? p.page.replace('-', '–')
      : extractPagesFromDoi(doi);
    return { authors, pages };
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

// ── Головна функція пошуку ──
// 9 запитів паралельно: різні фрази, режими (full-text / title.search), дві сторінки OpenAlex
// r1,r3-r7,r9 — OpenAlex (сирий формат) → mapOpenAlex
// r2, r8      — CrossRef (вже відформатовано fetchCrossRefUkrainian) → без маппінгу
export async function searchSourcesForSection(ukKeywords, enKeywords, needed = 4, sectionTitle = '', topic = '', page = 1, semKeywords = [], anchors = []) {
  const target = 25;

  const fetchLimit = 15;
  const allUkKeywords = [...new Set([...ukKeywords, ...semKeywords])];
  const coreTerm = buildCoreTerm(sectionTitle, topic);
  const yr = 'publication_year:>2019';
  const page2 = page + 1;

  const specificity = (phrase) =>
    phrase.toLowerCase().split(/\s+/).filter(w => w.length > 4 && !STOP_WORDS.has(w)).length;
  const sortedPhrases = [...allUkKeywords].sort((a, b) => specificity(b) - specificity(a));

  // Кожне оновлення (page++) зсуває набір фраз на 3 позиції → реально різні запити
  const total = Math.max(sortedPhrases.length, 1);
  const i0 = ((page - 1) * 3) % total;
  const p0 = sortedPhrases[i0] || coreTerm;
  const p1 = sortedPhrases[(i0 + 1) % total] || p0;
  const p2 = sortedPhrases[(i0 + 2) % total] || p0;
  // OpenAlex page міняється повільніше: новий цикл після того як пройшли всі фрази
  const oaPage = Math.floor(((page - 1) * 3) / total) + 1;
  const enQ = enKeywords[0] || '';

  const plQ = enQ || p0;

  const [r1, r2, r3, r4, r5, r6, r7, r8, r9] = await Promise.allSettled([
    openAlexSearch(p0, `language:uk,${yr}`, fetchLimit, oaPage),            // r1: full-text uk, p0
    fetchCrossRefUkrainian(p0, fetchLimit),                                  // r2: CrossRef uk, p0 (вже готово)
    openAlexTitleSearch(p1, ['language:uk', yr], fetchLimit, oaPage),        // r3: title uk, p1
    openAlexSearch(p2, `language:uk,${yr}`, fetchLimit, oaPage),             // r4: full-text uk, p2
    openAlexTitleSearch(coreTerm, ['language:uk', yr], fetchLimit, oaPage),  // r5: title uk, coreTerm
    openAlexSearch(p1, `language:uk,${yr}`, fetchLimit, oaPage),             // r6: full-text uk, p1
    openAlexTitleSearch(p2, ['language:uk', yr], fetchLimit, oaPage),        // r7: title uk, p2
    openAlexSearch(plQ, `language:pl,${yr}`, fetchLimit, oaPage),            // r8: польські джерела full-text
    openAlexTitleSearch(plQ, ['language:pl', yr], fetchLimit, oaPage),       // r9: польські джерела title
  ]);

  // OpenAlex → mapOpenAlex; CrossRef (r2) вже у потрібному форматі
  const mapOA = (r, lang) => r.status === 'fulfilled'
    ? r.value.filter(p => p.title && !isBlocked(p)).map(p => mapOpenAlex(p, lang))
    : [];

  // Українські джерела
  const fromR1 = mapOA(r1, 'uk');
  const fromCR = r2.status === 'fulfilled' ? r2.value.filter(p => hasCyrillic(p.title || '')) : [];
  const fromR3 = mapOA(r3, 'uk');
  const fromR4 = mapOA(r4, 'uk');
  const fromR5 = mapOA(r5, 'uk');
  const fromR6 = mapOA(r6, 'uk');
  const fromR7 = mapOA(r7, 'uk');

  // Дедуп українських
  const seen = new Set();
  const allUk = [];
  for (const p of [...fromR1, ...fromCR, ...fromR3, ...fromR4, ...fromR5, ...fromR6, ...fromR7]) {
    const key = (p.title || '').toLowerCase().slice(0, 60);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    allUk.push(p);
  }

  // Скоринг + domainBoost
  const withScore = allUk.map(p => ({
    ...p,
    _score: scoreRelevance(p.title.toLowerCase(), allUkKeywords),
  })).sort((a, b) => b._score - a._score);
  const boosted = domainBoost(withScore, sectionTitle, topic);

  // Іноземні: польські (r8, r9) + англійські (Semantic Scholar)
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

  return [
    ...boosted.slice(0, target),
    ...foreignFiltered.slice(0, maxForeign),
  ];
}

// ── Gemini-фільтрація: двохрівнева з поясненням ──
// Повертає [{...paper, geminiTier: 'exact'|'analogy', geminiReason: '...'}]
export async function filterSourcesWithGemini(candidates, sectionTitle, topic) {
  if (candidates.length < 4) return candidates;
  const items = candidates.map((p, i) => `${i}. ${p.title}`).join('\n');
  const prompt = `Тема наукової роботи: "${topic}"
Підрозділ: "${sectionTitle}"

Список знайдених статей:
${items}

Відбери статті за двома категоріями:
- "exact": стаття ТОЧНО стосується цього підрозділу (предмет, мова/галузь, рівень — усе збігається)
- "analogy": може підійти як теоретична аналогія (схожий підхід, але інша мова або суміжний контекст)
Статті що взагалі не стосуються — не включай.
Для кожної відібраної напиши одне речення до 15 слів — чому підходить.

Поверни JSON: {"results":[{"index":0,"tier":"exact","reason":"Розглядає..."},{"index":3,"tier":"analogy","reason":"Аналогічний підхід у..."}]}`;
  try {
    const res = await fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        _model: 'gemini-2.5-flash-lite',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 800, responseMimeType: 'application/json' },
      }),
    });
    if (!res.ok) return candidates;
    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = JSON.parse(raw);
    const results = parsed.results || [];
    if (results.length < 2) return candidates;
    return results
      .filter(r => typeof r.index === 'number' && candidates[r.index])
      .map(r => ({
        ...candidates[r.index],
        geminiTier: r.tier === 'analogy' ? 'analogy' : 'exact',
        geminiReason: r.reason || '',
      }));
  } catch {
    return candidates;
  }
}
