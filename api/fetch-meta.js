// Серверний проксі для витягування сторінок зі сторінки журналу
// Більшість академічних видань публікують Google Scholar мета-теги:
//   <meta name="citation_firstpage" content="123">
//   <meta name="citation_lastpage" content="145">
// Якщо мета-теги відсутні — витягуємо citation_doi і звертаємось до CrossRef.
export const config = { maxDuration: 15 };

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

/**
 * Витягує DOI зі сторінки журналу (мета-тег citation_doi або DC.Identifier).
 * OJS та більшість видавничих платформ завжди містять цей тег.
 */
function extractMetaDoi(html) {
  // <meta name="citation_doi" content="10.xxxxx/xxxxx">
  const m1 = html.match(/<meta[^>]+name=["']citation_doi["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']citation_doi["']/i);
  if (m1) return m1[1].replace(/^https?:\/\/doi\.org\//i, '').trim();

  // <meta name="DC.Identifier" content="doi:10.xxxxx/xxxxx">
  const m2 = html.match(/<meta[^>]+name=["']DC\.Identifier["'][^>]+content=["']doi:([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']doi:([^"']+)["'][^>]+name=["']DC\.Identifier["']/i);
  if (m2) return m2[1].trim();

  // Пошук посилання <a href="https://doi.org/10.xxxxx/..."> в першому вікні HTML
  const m3 = html.match(/https?:\/\/doi\.org\/(10\.\d{4,}\/[^\s"'<>]+)/i);
  if (m3) return m3[1].trim();

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
      }),
      4000,
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
    if (pages) return res.status(200).json({ pages });

    // Мета-теги сторінок відсутні — пробуємо CrossRef по DOI зі сторінки
    const doi = extractMetaDoi(html);
    if (doi) {
      try {
        const cr = await withTimeout(
          fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
            headers: { 'User-Agent': 'AcademAssist/1.0 (mailto:support@academ-assist.vercel.app)' },
          }),
          4000,
        );
        if (cr.ok) {
          const crData = await cr.json();
          const p = crData?.message;
          if (p?.page) {
            return res.status(200).json({ pages: p.page.replace(/-/g, '–') });
          }
        }
      } catch { /* CrossRef недоступний — повертаємо null */ }
    }

    return res.status(200).json({ pages: null });
  } catch {
    return res.status(200).json({ pages: null });
  }
}
