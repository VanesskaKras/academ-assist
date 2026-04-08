// Gemini 2.0 Flash — дешева альтернатива Sonnet для генерації тексту
export const config = {
    maxDuration: 60,
    api: {
        bodyParser: {
            sizeLimit: "10mb",
        },
    },
};

export default async function handler(req, res) {
    if (req.method === "GET") {
        const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;
        const r = await fetch(listUrl);
        const d = await r.json();
        return res.status(200).json(d);
    }
    if (req.method !== "POST") return res.status(405).end();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    try {
        const { _model, ...body } = req.body;
        const model = _model || "gemini-2.5-flash";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

        let response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        // Fallback to gemini-2.0-flash if primary model is overloaded
        if ((response.status === 503 || response.status === 429) && model === "gemini-2.5-flash") {
            console.warn(`Gemini ${model} returned ${response.status}, retrying with gemini-2.0-flash`);
            const fallbackUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
            response = await fetch(fallbackUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
        }

        const data = await response.json();

        if (!response.ok) {
            console.error("Gemini API error:", response.status, JSON.stringify(data));
            return res.status(response.status).json(data);
        }

        res.status(200).json(data);
    } catch (e) {
        console.error("Gemini handler error:", e.message);
        res.status(500).json({ error: e.message });
    }
}
