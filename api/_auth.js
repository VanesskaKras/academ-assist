// Спільна логіка CORS і автентифікації для API-проксі
// Верифікація Firebase ID-токена через публічний REST-ендпоінт.
// Не потребує firebase-admin і service account.

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";

export function setCors(res) {
    const origin = ALLOWED_ORIGIN || "https://academ-assist.vercel.app";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// Повертає об'єкт користувача Firebase або null якщо токен недійсний
export async function verifyToken(req) {
    const authHeader = req.headers["authorization"] || "";
    if (!authHeader.startsWith("Bearer ")) return null;
    const idToken = authHeader.slice(7);

    const apiKey = process.env.FIREBASE_WEB_API_KEY;
    if (!apiKey) {
        console.error("FIREBASE_WEB_API_KEY is not set");
        return null;
    }

    try {
        const res = await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ idToken }),
            }
        );
        if (!res.ok) return null;
        const data = await res.json();
        return data.users?.[0] || null;
    } catch (e) {
        console.error("Token verification error:", e.message);
        return null;
    }
}
