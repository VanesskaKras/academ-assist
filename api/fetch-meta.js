// Серверний проксі для витягування сторінок зі сторінки журналу
// Більшість академічних видань публікують Google Scholar мета-теги:
//   <meta name="citation_firstpage" content="123">
//   <meta name="citation_lastpage" content="145">
export const config = { maxDuration: 10 };

function withTimeout(promise, ms = 6000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

function extractMetaPages(html) {
  // Шукаємо citation_firstpage / citation_lastpage
  const first = html.match(/<meta[^>]+name=["']citation_firstpage["'][^>]+content=["'](\d+)["']/i)
    || html.match(/<meta[^>]+content=["'](\d+)["'][^>]+name=["']citation_firstpage["']/i);
  const last = html.match(/<meta[^>]+name=["']citation_lastpage["'][^>]+content=["'](\d+)["']/i)
    || html.match(/<meta[^>]+content=["'](\d+)["'][^>]+name=["']citation_lastpage["']/i);

  if (first) {
    const f = first[1];
    const l = last ? last[1] : null;
    return l && l !== f ? `${f}–${l}` : f;
  }

  // Fallback: citation_pages (деякі видавці використовують один тег)
  const pages = html.match(/<meta[^>]+name=["']citation_pages["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']citation_pages["']/i);
  if (pages) return pages[1].replace('-', '–');

  return null;
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

  const { url } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(200).json({ pages: null });

  try {
    const r = await withTimeout(
      fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AcademAssist/1.0; +https://academ-assist.vercel.app)',
          'Accept': 'text/html',
        },
      })
    );
    if (!r.ok) return res.status(200).json({ pages: null });

    // Читаємо тільки перші 30 КБ — мета-теги завжди в <head>
    const reader = r.body.getReader();
    let html = '';
    while (html.length < 30000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
      if (html.includes('</head>')) break;
    }
    reader.cancel();

    const pages = extractMetaPages(html);
    return res.status(200).json({ pages });
  } catch {
    return res.status(200).json({ pages: null });
  }
}
