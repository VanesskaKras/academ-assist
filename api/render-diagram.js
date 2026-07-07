// Серверний проксі для рендеру PlantUML-діаграм у PNG через Kroki (https://kroki.io)
export const config = { maxDuration: 20 };

function withTimeout(promise, ms = 12000) {
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

  const { source } = req.body || {};
  if (!source || typeof source !== 'string') {
    return res.status(400).json({ error: 'Missing diagram source' });
  }

  try {
    const r = await withTimeout(
      fetch('https://kroki.io/plantuml/png', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diagram_source: source }),
      }),
    );

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.error('Kroki error:', r.status, errText.slice(0, 300));
      return res.status(200).json({ error: 'render_failed' });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    return res.status(200).json({ image: buf.toString('base64') });
  } catch (e) {
    console.error('render-diagram error:', e.message);
    return res.status(200).json({ error: 'render_failed' });
  }
}
