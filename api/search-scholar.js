// Проксі для Google Scholar через Serper.dev (немає CORS у браузері)
export const config = { maxDuration: 15 };

const BLOCKED = [
  'russia', 'russian federation', 'москв', 'санкт-петербург', 'новосибирск',
  'екатеринбург', 'казань', 'самар', 'нижн', 'российск', 'росс', 'rsci',
  'elibrary.ru', 'cyberleninka', 'белорус', 'беларус', 'minsk', 'минск',
];

function isRussianUrl(url = '') {
  return /\.ru(\/|$)/i.test(url.toLowerCase());
}

function isBlocked(obj) {
  const t = JSON.stringify(obj).toLowerCase();
  if (BLOCKED.some(p => t.includes(p))) return true;
  return isRussianUrl(obj?.link || obj?.url || '');
}

function withTimeout(promise, ms = 10000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

async function searchScholar(query, limit, apiKey) {
  const res = await fetch('https://google.serper.dev/scholar', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num: limit }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.organic || []).filter(p => p.title && !isBlocked(p));
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

  const apiKey = process.env.SERPER_API_KEY || '';
  if (!apiKey) return res.status(200).json({ sources: [] });

  try {
    const { query = '', limit = 10 } = req.body || {};
    if (!query.trim()) return res.status(200).json({ sources: [] });

    const raw = await withTimeout(searchScholar(query, limit, apiKey));

    const sources = raw.map(item => {
      const pubInfo = item.publicationInfo || '';
      const dashIdx = pubInfo.lastIndexOf(' - ');
      const authorsStr = dashIdx > 0 ? pubInfo.slice(0, dashIdx) : '';
      const authors = authorsStr
        ? authorsStr.split(',').map(a => a.trim()).filter(Boolean).slice(0, 3)
        : [];
      const yearMatch = pubInfo.match(/\b(20\d{2})\b/);
      const year = item.year || (yearMatch ? parseInt(yearMatch[1]) : '');
      const venueRaw = dashIdx > 0 ? pubInfo.slice(dashIdx + 3) : '';
      const venue = venueRaw.replace(/,?\s*\d{4}.*$/, '').trim();
      const hasCyr = /[А-ЯҐЄІЇа-яґєіїёЁ]/.test(item.title || '');

      return {
        id: item.link || String(Math.random()),
        title: item.title || '',
        authors,
        year,
        venue,
        doi: '',
        pages: '',
        lang: hasCyr ? 'uk' : 'en',
        source: 'scholar',
        abstract: item.snippet || '',
        url: item.link || '',
      };
    });

    return res.status(200).json({ sources });
  } catch (e) {
    console.error('search-scholar error:', e.message);
    return res.status(200).json({ sources: [] });
  }
}
