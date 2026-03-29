import { setCors, verifyToken } from "./_auth.js";

// Gemini 2.5 Flash — дешева альтернатива Sonnet для генерації тексту
export const config = {
    maxDuration: 60,
    api: {
        bodyParser: {
            sizeLimit: "10mb",
        },
    },
};

export default async function handler(req, res) {
    setCors(res);

    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).end();

    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    try {
        const { _model, ...body } = req.body;
        const model = _model || "gemini-2.5-flash";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

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
