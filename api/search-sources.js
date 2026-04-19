// Серверна функція для Semantic Scholar (немає CORS у браузері — проксимо тут)
export const config = { maxDuration: 25 };

const BLOCKED = [
  'russia', 'russian federation', 'москв', 'санкт-петербург', 'новосибирск',
  'екатеринбург', 'казань', 'самар', 'нижн', 'российск', 'росс', 'rsci',
  'elibrary.ru', 'cyberleninka', 'белорус', 'беларус', 'minsk', 'минск',
];

function isBlocked(obj) {
  const t = JSON.stringify(obj).toLowerCase();
  return BLOCKED.some(p => t.includes(p));
}

function withTimeout(promise, ms = 10000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

async function searchSemanticScholar(query, limit) {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&fields=title,authors,year,venue,externalIds&limit=${limit}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'AcademAssist/1.0' } });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.data || [])
    .filter(p => {
      if (!p.title || !p.year || p.year < 2020) return false;
      if (isBlocked(p)) return false;
      // Тільки латиниця (англомовні)
      const cyr = (p.title.match(/[А-ЯҐЄІЇа-яґєіїёЁ]/g) || []).length;
      return cyr === 0;
    })
    .map(p => ({
      id: p.paperId,
      title: p.title,
      authors: (p.authors || []).slice(0, 3).map(a => a.name || '').filter(Boolean),
      year: p.year,
      venue: p.venue || '',
      doi: p.externalIds?.DOI || '',
      lang: 'en',
      source: 'ss',
      url: p.externalIds?.DOI
        ? `https://doi.org/${p.externalIds.DOI}`
        : `https://www.semanticscholar.org/paper/${p.paperId}`,
    }));
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).end();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const { enKeywords = [], needed = 3 } = req.body || {};
    const query = enKeywords.slice(0, 3).join(' ').trim();

    if (!query) return res.status(200).json({ sources: [] });

    const sources = await withTimeout(searchSemanticScholar(query, needed + 3));

    // Дедуп
    const seen = new Set();
    const deduped = sources.filter(p => {
      const key = p.title.toLowerCase().slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return res.status(200).json({ sources: deduped.slice(0, needed) });
  } catch (e) {
    console.error('search-sources error:', e.message);
    return res.status(200).json({ sources: [] }); // не падаємо — повертаємо порожній масив
  }
}
