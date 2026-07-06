// Gemini 2.5 Flash — дешева альтернатива Sonnet для генерації тексту
export const config = {
    maxDuration: 60,
    api: {
        bodyParser: {
            sizeLimit: "32mb",
        },
    },
};

function getApiKeys() {
    const keys = [
        process.env.GEMINI_API_KEY_1,
        process.env.GEMINI_API_KEY_2,
        process.env.GEMINI_API_KEY_3,
        process.env.GEMINI_API_KEY,
    ].filter(Boolean);
    return keys.length > 0 ? keys : [];
}

export default async function handler(req, res) {
    if (req.method === "GET") {
        const keys = getApiKeys();
        const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${keys[0]}`;
        const r = await fetch(listUrl);
        const d = await r.json();
        return res.status(200).json(d);
    }
    if (req.method !== "POST") return res.status(405).end();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    const keys = getApiKeys();
    if (keys.length === 0) {
        return res.status(500).json({ error: "No Gemini API keys configured" });
    }

    const { _model, ...body } = req.body;
    const requestedModel = _model || "gemini-2.5-flash";

    // Fallback chain: якщо модель перевантажена — спробуємо наступну
    const MODEL_FALLBACKS = {
        "gemini-2.5-flash-lite": ["gemini-2.5-flash"],
        "gemini-2.5-flash":      ["gemini-2.5-flash-lite"],
        "gemini-2.5-pro":        ["gemini-2.5-flash",      "gemini-2.5-flash-lite"],
    };
    const modelsToTry = [requestedModel, ...(MODEL_FALLBACKS[requestedModel] || [])];

    let lastError = null;
    for (const model of modelsToTry) {
        let allOverloaded = true;
        for (let i = 0; i < keys.length; i++) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${keys[i]}`;
                const response = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                });

                const data = await response.json();

                if (response.status === 429 || response.status === 503) {
                    console.warn(`Gemini model=${model} key ${i + 1} returned ${response.status}`);
                    lastError = { status: response.status, data };
                    continue;
                }

                allOverloaded = false;

                if (!response.ok) {
                    console.error("Gemini API error:", response.status, JSON.stringify(data));
                    return res.status(response.status).json(data);
                }

                return res.status(200).json(data);
            } catch (e) {
                console.error(`Gemini model=${model} key ${i + 1} error:`, e.message);
                lastError = { status: 500, data: { error: e.message } };
                allOverloaded = false;
            }
        }
        if (allOverloaded) {
            console.warn(`All keys overloaded for model=${model}, trying fallback`);
        } else {
            break;
        }
    }

    console.error("All Gemini models/keys exhausted");
    res.status(lastError.status).json(lastError.data);
}
