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
 * Знаходить "ядро теми" — слово що найчастіше повторюється серед ключових фраз
 * і не є стоп-словом. Саме за ним будемо фільтрувати результати.
 *
 * Напр.: ["емпатія сутність", "механізми формування емпатії", "теорія емпатії Тітченера"]
 *   → "емпатія"
 */
function findCoreTerm(keywords) {
  const freq = {};
  for (const kw of keywords) {
    const words = kw.toLowerCase()
      .split(/[\s,.:;()–—\-/]+/)
      .filter(w => w.length > 4 && !STOP_WORDS.has(w));
    for (const w of words) freq[w] = (freq[w] || 0) + 1;
  }
  if (!Object.keys(freq).length) return '';
  return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
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

// ── OpenAlex ──
const OA_BASE = 'https://api.openalex.org/works';
const OA_FIELDS = 'title,authorships,publication_year,primary_location,doi,language,id,biblio';

async function openAlexSearch(query, filterStr, limit) {
  const url = `${OA_BASE}?search=${encodeURIComponent(query)}&filter=${filterStr}&per_page=${limit}&select=${OA_FIELDS}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const d = await r.json();
  return (d.results || []).filter(p => p.title && !isBlocked(p));
}

// Пошук тільки по заголовках — набагато точніший
async function openAlexTitleSearch(query, filterStr, limit) {
  const url = `${OA_BASE}?filter=title.search:${encodeURIComponent(query)},${filterStr}&per_page=${limit}&select=${OA_FIELDS}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const d = await r.json();
  return (d.results || []).filter(p => p.title && !isBlocked(p));
}

function mapOpenAlex(p, forceLang) {
  const lang = forceLang || (p.language === 'uk' || hasCyrillic(p.title) ? 'uk' : 'en');
  const fp = p.biblio?.first_page;
  const lp = p.biblio?.last_page;
  const pages = fp ? (lp && lp !== fp ? `${fp}–${lp}` : fp) : '';
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
  };
}

// ── CrossRef (добре покриває укр. журнали з DOI) ──
async function fetchCrossRefUkrainian(query, limit) {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&filter=from-pub-date:2020&rows=${Math.min(limit * 2, 20)}`;
  const r = await fetch(url, {
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
 * 1. Знаходимо "ядро теми" — найчастіше специфічне слово в ключових фразах
 * 2. title.search за ядром → тільки статті де є це слово в заголовку
 * 3. Доповнюємо повнотекстовим пошуком за першою ключовою фразою
 * 4. Жорсткий фільтр: якщо ядро є — вимагаємо його в заголовку результату
 * 5. Скоринг + сортування за кількістю збігів з ключовими фразами
 *
 * @param {string[]} ukKeywords   — українські ключові фрази (від Claude)
 * @param {string[]} enKeywords   — англійські ключові фрази (від Claude)
 * @param {number}   needed       — скільки джерел потрібно
 * @param {string}   sectionTitle — назва підрозділу
 * @param {string}   topic        — загальна тема роботи
 */
export async function searchSourcesForSection(ukKeywords, enKeywords, needed = 4, _sectionTitle = '', _topic = '') {
  const target = needed + 4;
  const maxForeign = Math.max(1, Math.round(needed * 0.1));
  const fetchLimit = target + 8;

  // ── Крок 1: знаходимо ядро теми з ключових слів ──
  const coreTerm = findCoreTerm(ukKeywords);

  // ── Крок 2: будуємо запити ──
  // Основний: ядро теми (напр. "емпатія")
  // Широкий: перша ключова фраза (напр. "емпатія сутність")
  const titleQuery = coreTerm;
  const broadQuery = ukKeywords.slice(0, 2).join(' ').trim();
  const enQuery = enKeywords.slice(0, 3).join(' ').trim();

  const yr = 'publication_year:>2019';

  // ── Крок 3: паралельні запити ──
  const [r1, r2, r3, r4] = await Promise.allSettled([
    // title.search з ядром + мова:uk — найточніший
    titleQuery ? openAlexTitleSearch(titleQuery, `language:uk,${yr}`, fetchLimit) : Promise.resolve([]),
    // title.search з ядром без фільтру мови (кирилицю відберемо нижче)
    titleQuery ? openAlexTitleSearch(titleQuery, yr, fetchLimit) : Promise.resolve([]),
    // Широкий пошук по всіх полях — як резерв
    broadQuery ? openAlexSearch(broadQuery, `language:uk,${yr}`, fetchLimit) : Promise.resolve([]),
    // CrossRef — добре покриває укр. журнали
    (titleQuery || broadQuery) ? fetchCrossRefUkrainian(titleQuery || broadQuery, fetchLimit) : Promise.resolve([]),
  ]);

  const fromTitleUk  = r1.status === 'fulfilled' ? r1.value.map(p => mapOpenAlex(p, 'uk')) : [];
  const fromTitleAll = r2.status === 'fulfilled'
    ? r2.value.filter(p => hasCyrillic(p.title || '')).map(p => mapOpenAlex(p, 'uk'))
    : [];
  const fromBroad = r3.status === 'fulfilled' ? r3.value.map(p => mapOpenAlex(p, 'uk')) : [];
  const fromCR    = r4.status === 'fulfilled' ? r4.value : [];

  // ── Крок 4: дедуп (title.search результати мають пріоритет) ──
  const seen = new Set();
  const allUk = [];
  for (const p of [...fromTitleUk, ...fromTitleAll, ...fromBroad, ...fromCR]) {
    const key = (p.title || '').toLowerCase().slice(0, 60);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    allUk.push(p);
  }

  // ── Крок 5: жорсткий фільтр за ядром теми ──
  // Якщо є ядро — вимагаємо його присутності в заголовку результату
  // Якщо після фільтру залишилось мало — повертаємо все (краще щось)
  const hardFiltered = coreTerm
    ? allUk.filter(p => p.title.toLowerCase().includes(coreTerm))
    : allUk;
  const ukPool = hardFiltered.length >= needed ? hardFiltered : allUk;

  // ── Крок 6: скоринг + сортування ──
  const withScore = ukPool.map(p => ({
    ...p,
    _score: scoreRelevance(p.title.toLowerCase(), ukKeywords),
  })).sort((a, b) => b._score - a._score);

  // Англійські джерела
  const enRaw = enQuery
    ? await fetchEnglishViaBackend(enKeywords, maxForeign + 2).catch(() => [])
    : [];
  const enScored = enRaw.map(p => ({
    ...p,
    _score: scoreRelevance((p.title || '').toLowerCase(), enKeywords),
  })).sort((a, b) => b._score - a._score);

  // Фінальна дедуп між укр і англ
  const finalSeen = new Set(withScore.slice(0, target).map(p => (p.title || '').toLowerCase().slice(0, 60)));
  const enFiltered = enScored.filter(p => {
    const key = (p.title || '').toLowerCase().slice(0, 60);
    return !finalSeen.has(key);
  });

  return [
    ...withScore.slice(0, target),
    ...enFiltered.slice(0, maxForeign),
  ];
}
