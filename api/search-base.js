// Серверна функція для BASE-search.net (немає CORS у браузері — проксимо тут)
export const config = { maxDuration: 15 };

function withTimeout(promise, ms = 10000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
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
    const { query = '', limit = 10 } = req.body || {};
    if (!query.trim()) return res.status(200).json({ docs: [] });

    const url = `https://api.base-search.net/cgi-bin/BaseHttpSearchInterface.fcgi?func=PerformSearch&query=${encodeURIComponent(query)}&format=json&hits=${limit}`;
    const r = await withTimeout(fetch(url, { cache: 'no-store' }));
    if (!r.ok) return res.status(200).json({ docs: [] });
    const data = await r.json();
    return res.status(200).json({ docs: data.response?.docs || [] });
  } catch (e) {
    console.error('search-base error:', e.message);
    return res.status(200).json({ docs: [] });
  }
}
