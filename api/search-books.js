// Проксі для Google Books через Serper.dev (немає CORS у браузері)
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

function hasCyrillic(text = '') {
  return /[А-ЯҐЄІЇа-яґєіїёЁ]/.test(text);
}

async function searchBooks(query, limit, apiKey) {
  const res = await fetch('https://google.serper.dev/books', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num: limit }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.books || data.organic || []).filter(p => p.title && !isBlocked(p));
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
    const { query = '', limit = 8 } = req.body || {};
    if (!query.trim()) return res.status(200).json({ sources: [] });

    const raw = await withTimeout(searchBooks(query, Math.min(limit, 10), apiKey));

    const sources = raw.map(item => {
      const authorRaw = item.author || item.authors || '';
      const authors = typeof authorRaw === 'string'
        ? authorRaw.split(',').map(a => a.trim()).filter(Boolean).slice(0, 3)
        : (Array.isArray(authorRaw) ? authorRaw.slice(0, 3) : []);

      // Рік: з поля або з snippet/publicationInfo
      const yearMatch = (item.publishedDate || item.year || item.publicationInfo || item.snippet || '').match(/\b(19|20)\d{2}\b/);
      const year = yearMatch ? yearMatch[0] : '';

      const publisher = item.publisher || item.publicationInfo || '';
      const lang = hasCyrillic(item.title) ? 'uk' : 'en';

      return {
        id: item.link || String(Math.random()),
        title: item.title || '',
        authors,
        year,
        venue: publisher,
        doi: '',
        pages: '',
        lang,
        source: 'books-serper',
        type: 'book',
        abstract: item.snippet || '',
        url: item.link || '',
      };
    });

    return res.status(200).json({ sources });
  } catch (e) {
    console.error('search-books error:', e.message);
    return res.status(200).json({ sources: [] });
  }
}
