import { setCors, verifyToken } from "./_auth.js";

// Збільшуємо ліміт body до 10MB для передачі PDF методичок
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
        const body = req.body;

        // Захист від перевищення ліміту output токенів моделі
        if (body.max_tokens && body.max_tokens > 64000) {
            body.max_tokens = 64000;
        }

        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": process.env.ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(body),
        });

        const data = await response.json();

        // Якщо Anthropic повернув помилку — логуємо і передаємо клієнту
        if (!response.ok) {
            console.error("Anthropic API error:", response.status, JSON.stringify(data));
            return res.status(response.status).json(data);
        }

        res.status(200).json(data);
    } catch (e) {
        console.error("Handler error:", e.message);
        res.status(500).json({ error: e.message });
    }
}
