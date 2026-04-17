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
async function openAlexTitleSearch(query, filterStr, limit, page = 1) {
  const url = `${OA_BASE}?filter=title.search:${encodeURIComponent(query)},${filterStr}&per_page=${limit}&page=${page}&select=${OA_FIELDS}`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.results || []).filter(p => p.title && !isBlocked(p));
}

function mapOpenAlex(p, forceLang) {
  const lang = forceLang || (p.language === 'uk' || hasCyrillic(p.title) ? 'uk' : 'en');
  const fp = p.biblio?.first_page;
  const lp = p.biblio?.last_page;
  const pages = fp ? (lp && lp !== fp ? `${fp}–${lp}` : fp) : '';
  const abstract = snippetAbstract(decodeAbstract(p.abstract_inverted_index));
  return {
    id: p.id || p.doi || String(Math.random()),
    title: p.title || '',
    authors: (p.authorships || []).slice(0, 3)
      .map(a => a.author?.display_name || '').filter(Boolean),
    year: p.publication_year || '',
    venue: p.primary_location?.source?.display_name || '',
    doi: p.doi ? p.doi.replace('https://doi.org/', '') : '',
    pages,
    lang,
    source: 'openalex',
    abstract,
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
      pages: p.page ? p.page.replace('-', '–') : '',
      lang: 'uk',
      source: 'crossref',
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

/**
 * Головна функція: шукає джерела для підрозділу.
 *
 * Стратегія:
 * 1. findTopTerms: два найспецифічніших терміни з ключових фраз + назви підрозділу (B+C)
 * 2. title.search за обома термінами → тільки статті де є ці слова в заголовку
 * 3. Доповнюємо повнотекстовим пошуком за першою ключовою фразою
 * 4. Жорсткий фільтр: вимагаємо coreTerm в заголовку (з fallback)
 * 5. Скоринг + domainBoost за словами теми/підрозділу (E)
 *
 * @param {string[]} ukKeywords   — українські ключові фрази (від Gemini)
 * @param {string[]} enKeywords   — англійські ключові фрази (від Gemini)
 * @param {number}   needed       — скільки джерел потрібно
 * @param {string}   sectionTitle — назва підрозділу
 * @param {string}   topic        — тема + напрям роботи
 */
export async function searchSourcesForSection(ukKeywords, enKeywords, needed = 4, sectionTitle = '', topic = '', page = 1, semKeywords = [], anchors = []) {
  const target = 15;
  const maxForeign = 3;
  const fetchLimit = target + 8;
  const allUkKeywords = [...new Set([...ukKeywords, ...semKeywords])];
  const coreTerm = buildCoreTerm(sectionTitle, topic);

  const specificity = (phrase) =>
    phrase.toLowerCase().split(/\s+/).filter(w => w.length > 4 && !STOP_WORDS.has(w)).length;
  const sortedPhrases = [...allUkKeywords].sort((a, b) => specificity(b) - specificity(a));

  const enQuery = enKeywords.slice(0, 3).join(' ').trim();
  const yr = 'publication_year:>2019';

  // ── Парні сторінки = anchor mode (full-text), непарні = thesis mode (title.search) ──
  const useAnchorMode = page % 2 === 0;

  let queries;
  if (!useAnchorMode) {
    // Thesis mode: фрази "якір теми + теза підрозділу" → title.search по 4 фразах
    const pq = sortedPhrases.slice(0, 4).filter(Boolean);
    queries = [
      pq[0] ? openAlexTitleSearch(pq[0], `language:uk,${yr}`, fetchLimit, 1) : Promise.resolve([]),
      pq[1] ? openAlexTitleSearch(pq[1], `language:uk,${yr}`, fetchLimit, 1) : Promise.resolve([]),
      pq[2] ? openAlexTitleSearch(pq[2], `language:uk,${yr}`, fetchLimit, 1) : Promise.resolve([]),
      coreTerm ? fetchCrossRefUkrainian(coreTerm, fetchLimit) : Promise.resolve([]),
      pq[3] ? openAlexTitleSearch(pq[3], `language:uk,${yr}`, fetchLimit, 1) : Promise.resolve([]),
      pq[0] ? openAlexSearch(pq[0], `language:uk,${yr}`, fetchLimit, 1) : Promise.resolve([]),
    ];
  } else {
    // Anchor mode: Gemini-якорі у називному відмінку → full-text search
    const aq = anchors.filter(Boolean);
    const a1 = aq[0] || coreTerm;
    const a2 = aq[1] || sortedPhrases[0] || '';
    const a3 = aq[2] || sortedPhrases[1] || '';
    queries = [
      a1 ? openAlexSearch(a1, `language:uk,${yr}`, fetchLimit, 1) : Promise.resolve([]),
      a2 ? openAlexSearch(a2, `language:uk,${yr}`, fetchLimit, 1) : Promise.resolve([]),
      a1 ? openAlexSearch(a1, yr, fetchLimit, 1) : Promise.resolve([]),
      a1 ? fetchCrossRefUkrainian(a1, fetchLimit) : Promise.resolve([]),
      a3 ? openAlexSearch(a3, `language:uk,${yr}`, fetchLimit, 1) : Promise.resolve([]),
      a2 ? openAlexSearch(a2, yr, fetchLimit, 1) : Promise.resolve([]),
    ];
  }

  const [r1, r2, r3, r4, r5, r6] = await Promise.allSettled(queries);

  const mapUk = (r) => r.status === 'fulfilled'
    ? r.value.filter(p => hasCyrillic(p.title || '')).map(p => mapOpenAlex(p, 'uk'))
    : [];
  const fromR1 = r1.status === 'fulfilled' ? r1.value.map(p => mapOpenAlex(p, 'uk')) : [];
  const fromCR = r4.status === 'fulfilled' ? r4.value : [];

  // ── Дедуп ──
  const mergeOrder = [...fromR1, ...mapUk(r2), ...mapUk(r3), ...fromCR, ...mapUk(r5), ...mapUk(r6)];
  const seen = new Set();
  const allUk = [];
  for (const p of mergeOrder) {
    const key = (p.title || '').toLowerCase().slice(0, 60);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    allUk.push(p);
  }

  // ── Крок 5: скоринг + domainBoost (E) ──
  const withScore = allUk.map(p => ({
    ...p,
    _score: scoreRelevance(p.title.toLowerCase(), allUkKeywords),
  })).sort((a, b) => b._score - a._score);
  const boosted = domainBoost(withScore, sectionTitle, topic);

  // Англійські джерела
  const enRaw = enQuery
    ? await fetchEnglishViaBackend(enKeywords, maxForeign + 2).catch(() => [])
    : [];
  const enScored = enRaw.map(p => ({
    ...p,
    _score: scoreRelevance((p.title || '').toLowerCase(), enKeywords),
  })).sort((a, b) => b._score - a._score);

  // Фінальна дедуп між укр і англ
  const finalSeen = new Set(boosted.slice(0, target).map(p => (p.title || '').toLowerCase().slice(0, 60)));
  const enFiltered = enScored.filter(p => {
    const key = (p.title || '').toLowerCase().slice(0, 60);
    return !finalSeen.has(key);
  });

  return [
    ...boosted.slice(0, target),
    ...enFiltered.slice(0, maxForeign),
  ];
}
