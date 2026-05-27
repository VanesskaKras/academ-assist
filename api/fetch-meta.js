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
  // ── citation_firstpage / citation_lastpage (OJS, більшість журналів) ──
  const first = html.match(/<meta[^>]+name=["']citation_firstpage["'][^>]+content=["'](\d+)["']/i)
    || html.match(/<meta[^>]+content=["'](\d+)["'][^>]+name=["']citation_firstpage["']/i);
  const last = html.match(/<meta[^>]+name=["']citation_lastpage["'][^>]+content=["'](\d+)["']/i)
    || html.match(/<meta[^>]+content=["'](\d+)["'][^>]+name=["']citation_lastpage["']/i);

  if (first) {
    const f = first[1];
    const l = last ? last[1] : null;
    return l && l !== f ? `${f}–${l}` : f;
  }

  // ── citation_pages (деякі видавці використовують один тег) ──
  const citPages = html.match(/<meta[^>]+name=["']citation_pages["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']citation_pages["']/i);
  if (citPages) return citPages[1].replace('-', '–');

  // ── DC.description — DSpace/EPrints кладуть повну цитату сюди ──
  // Приклад: content="... - С.82-87." або "pp. 45-67"
  const dcDesc = html.match(/<meta[^>]+name=["']DC\.description["'][^>]+content=["']([^"']{10,})["']/i)
    || html.match(/<meta[^>]+content=["']([^"']{10,})["'][^>]+name=["']DC\.description["']/i);
  if (dcDesc) {
    // Кирилична С. або латинська P./pp. + діапазон сторінок
    const pm = dcDesc[1].match(/[СC]\.\s*(\d{1,4})\s*[-–]\s*(\d{1,4})/u)
      || dcDesc[1].match(/[Pp]{1,2}\.\s*(\d{1,4})\s*[-–]\s*(\d{1,4})/);
    if (pm && parseInt(pm[2], 10) >= parseInt(pm[1], 10)) {
      return `${pm[1]}–${pm[2]}`;
    }
  }

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

/**
 * Перетворює пряме посилання на PDF у репозиторії на HTML-сторінку статті,
 * де є citation_firstpage / citation_lastpage мета-теги.
 *
 * lib.iitta.gov.ua:  /id/eprint/NNN/seq/file.pdf  → /id/eprint/NNN
 * DSpace:            /bitstream/NNN/MMM/seq/file   → /handle/NNN/MMM
 */
function resolveHtmlUrl(rawUrl) {
  // Відрізаємо якір (#page=NNN тощо) — він не потрібен для фетчу
  const url = rawUrl.split('#')[0];

  // IITTA EPrints: https://lib.iitta.gov.ua/id/eprint/NNN/digit/...
  const iittaM = url.match(/^(https?:\/\/lib\.iitta\.gov\.ua\/id\/eprint\/\d+)\/\d+\//i);
  if (iittaM) return iittaM[1];

  // DSpace: https://dspace.*/bitstream/NNN/MMM/digit/...
  const dspaceM = url.match(/^(https?:\/\/[^/]+)\/bitstream\/(\d+\/\d+)\/\d+\//i);
  if (dspaceM) return `${dspaceM[1]}/handle/${dspaceM[2]}`;

  return url;
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

  const { url: rawUrl } = req.body || {};
  if (!rawUrl || typeof rawUrl !== 'string') return res.status(200).json({ pages: null });

  const url = resolveHtmlUrl(rawUrl);

  try {
    const r = await withTimeout(
      fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AcademAssist/1.0; +https://academ-assist.vercel.app)',
          'Accept': 'text/html',
        },
      }),
      7000,
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
          5000,
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
