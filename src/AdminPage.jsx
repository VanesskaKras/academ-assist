import { useState, useEffect } from "react";
import { db, auth } from "./firebase";
import { collection, getDocs, doc, updateDoc, setDoc, deleteDoc } from "firebase/firestore";
import { initializeApp, deleteApp } from "firebase/app";
import { getAuth, createUserWithEmailAndPassword } from "firebase/auth";
import { useAuth } from "./AuthContext";

const ROLE_LABELS = {
    admin: { label: "Адмін", color: "#8a1a8a", bg: "#f5e4ff" },
    manager: { label: "Менеджер", color: "#1a5a8a", bg: "#e4f0ff" },
    user: { label: "Користувач", color: "#555", bg: "#f0f0f0" },
};

function AdminField({ label, value, onChange, type = "text", placeholder }) {
    return (
        <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
            <input
                type={type}
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder={placeholder}
                style={{ width: "100%", padding: "9px 12px", border: "1.5px solid #ddd", borderRadius: 6, fontSize: 13, boxSizing: "border-box", fontFamily: "inherit" }}
            />
        </div>
    );
}

export default function AdminPage({ onBack }) {
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [newEmail, setNewEmail] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [newName, setNewName] = useState("");
    const [newRole, setNewRole] = useState("manager");
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");

    const loadUsers = async () => {
        setLoading(true);
        const snap = await getDocs(collection(db, "users"));
        setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        setLoading(false);
    };

    useEffect(() => { loadUsers(); }, []);

    const createUser = async (e) => {
        e.preventDefault();
        setError(""); setSuccess(""); setCreating(true);
        try {
            // Створюємо ОКРЕМИЙ тимчасовий Firebase app
            // щоб не зачіпати поточну сесію адміна
            const secondaryApp = initializeApp(
                JSON.parse(document.getElementById("fb-config").textContent),
                "secondary-" + Date.now()
            );
            const secondaryAuth = getAuth(secondaryApp);
            const cred = await createUserWithEmailAndPassword(secondaryAuth, newEmail, newPassword);

            // Зберігаємо профіль в Firestore (використовуємо основний db — він не залежить від сесії)
            await setDoc(doc(db, "users", cred.user.uid), {
                email: newEmail,
                name: newName,
                role: newRole,
                approved: true,
                blocked: false,
                createdAt: new Date().toISOString(),
            });

            // Видаляємо тимчасовий app
            await deleteApp(secondaryApp);

            setSuccess(`✓ Користувача ${newEmail} створено з роллю "${ROLE_LABELS[newRole]?.label}"!`);
            setNewEmail(""); setNewPassword(""); setNewName(""); setNewRole("manager");
            loadUsers();
        } catch (e) {
            setError(e.message);
        }
        setCreating(false);
    };

    const toggleBlock = async (uid, blocked) => {
        await updateDoc(doc(db, "users", uid), { blocked: !blocked });
        loadUsers();
    };

    const changeRole = async (uid, currentRole) => {
        const next = currentRole === "manager" ? "admin" : currentRole === "admin" ? "manager" : "manager";
        if (!window.confirm(`Змінити роль на "${ROLE_LABELS[next]?.label}"?`)) return;
        await updateDoc(doc(db, "users", uid), { role: next });
        loadUsers();
    };

    const deleteUser = async (uid) => {
        if (!window.confirm("Видалити користувача?")) return;
        await deleteDoc(doc(db, "users", uid));
        loadUsers();
    };

    return (
        <div style={{ minHeight: "100vh", background: "#f5f2eb", fontFamily: "'Georgia', serif" }}>
            <div style={{ background: "#1a1a14", color: "#e8ff47", padding: "16px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: 3 }}>ACADEM — Адмін-панель</div>
                <button onClick={onBack} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "6px 16px", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>← Назад</button>
            </div>

            <div style={{ maxWidth: 860, margin: "32px auto", padding: "0 20px" }}>

                {/* Створити користувача */}
                <div style={{ background: "#fff", borderRadius: 10, padding: 24, marginBottom: 24, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                    <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, color: "#1a1a14" }}>Створити нового користувача</div>
                    <form onSubmit={createUser}>
                        <AdminField label="Ім'я" value={newName} onChange={setNewName} placeholder="Іван Петренко" />
                        <AdminField label="Email" value={newEmail} onChange={setNewEmail} type="email" placeholder="user@example.com" />
                        <AdminField label="Пароль" value={newPassword} onChange={setNewPassword} type="password" placeholder="мінімум 6 символів" />

                        {/* Вибір ролі */}
                        <div style={{ marginBottom: 16 }}>
                            <div style={{ fontSize: 11, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>Роль</div>
                            <div style={{ display: "flex", gap: 10 }}>
                                {[
                                    { key: "manager", label: "Менеджер", desc: "Створює та редагує замовлення" },
                                    { key: "admin", label: "Адмін", desc: "Повний доступ + адмін-панель" },
                                ].map(r => (
                                    <div key={r.key} onClick={() => setNewRole(r.key)}
                                        style={{
                                            flex: 1, padding: "12px 16px", borderRadius: 8, cursor: "pointer",
                                            border: `2px solid ${newRole === r.key ? "#1a1a14" : "#e0ddd4"}`,
                                            background: newRole === r.key ? "#1a1a14" : "#faf8f3",
                                            transition: "all .15s",
                                        }}>
                                        <div style={{ fontSize: 13, fontWeight: 700, color: newRole === r.key ? "#e8ff47" : "#1a1a14", marginBottom: 3 }}>{r.label}</div>
                                        <div style={{ fontSize: 11, color: newRole === r.key ? "#aaa" : "#888" }}>{r.desc}</div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {error && <div style={{ color: "#c00", fontSize: 13, marginBottom: 12, background: "#fff0f0", padding: "8px 12px", borderRadius: 6 }}>{error}</div>}
                        {success && <div style={{ color: "#060", fontSize: 13, marginBottom: 12, background: "#f0fff0", padding: "8px 12px", borderRadius: 6 }}>{success}</div>}
                        <button type="submit" disabled={creating}
                            style={{ background: creating ? "#aaa" : "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, padding: "10px 28px", fontSize: 13, fontWeight: 700, cursor: creating ? "default" : "pointer" }}>
                            {creating ? "Створюю..." : "Створити →"}
                        </button>
                    </form>
                </div>

                {/* Список користувачів */}
                <div style={{ background: "#fff", borderRadius: 10, padding: 24, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                    <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, color: "#1a1a14" }}>
                        Користувачі ({users.length})
                    </div>
                    {loading ? (
                        <div style={{ color: "#888" }}>Завантаження...</div>
                    ) : users.length === 0 ? (
                        <div style={{ color: "#aaa", fontSize: 14 }}>Поки немає користувачів</div>
                    ) : users.map(u => {
                        const roleInfo = ROLE_LABELS[u.role] || ROLE_LABELS.user;
                        return (
                            <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 0", borderBottom: "1px solid #f0ece2" }}>
                                {/* Аватар */}
                                <div style={{ width: 38, height: 38, borderRadius: "50%", background: u.blocked ? "#ffeeee" : "#eef5e4", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>
                                    {u.blocked ? "🚫" : u.role === "admin" ? "👑" : "👤"}
                                </div>

                                {/* Інфо */}
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: 14, fontWeight: 600, color: "#1a1a14" }}>{u.name || "—"}</div>
                                    <div style={{ fontSize: 12, color: "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.email}</div>
                                </div>

                                {/* Роль badge */}
                                <div style={{ padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: roleInfo.bg, color: roleInfo.color, flexShrink: 0 }}>
                                    {roleInfo.label}
                                </div>

                                {/* Кнопки */}
                                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                                    {/* Змінити роль (тільки для не-адмінів або якщо не єдиний адмін) */}
                                    {u.role !== "admin" && (
                                        <button onClick={() => changeRole(u.id, u.role)}
                                            style={{ background: "#f0f5ff", border: "1px solid #c0d0f0", color: "#1a5a8a", borderRadius: 6, padding: "5px 10px", fontSize: 11, cursor: "pointer" }}>
                                            → Адмін
                                        </button>
                                    )}
                                    {u.role === "admin" && (
                                        <button onClick={() => changeRole(u.id, u.role)}
                                            style={{ background: "#f5e4ff", border: "1px solid #d0a0f0", color: "#8a1a8a", borderRadius: 6, padding: "5px 10px", fontSize: 11, cursor: "pointer" }}>
                                            → Менеджер
                                        </button>
                                    )}

                                    {/* Блокування */}
                                    <button onClick={() => toggleBlock(u.id, u.blocked)}
                                        style={{ background: u.blocked ? "#eef5e4" : "#fff0f0", border: `1px solid ${u.blocked ? "#c8dfa0" : "#ffcccc"}`, color: u.blocked ? "#3a6010" : "#c00", borderRadius: 6, padding: "5px 10px", fontSize: 11, cursor: "pointer" }}>
                                        {u.blocked ? "Розблок." : "Блок."}
                                    </button>

                                    {/* Видалення */}
                                    <button onClick={() => deleteUser(u.id)}
                                        style={{ background: "transparent", border: "1px solid #ddd", color: "#aaa", borderRadius: 6, padding: "5px 10px", fontSize: 11, cursor: "pointer" }}
                                        onMouseEnter={e => { e.currentTarget.style.borderColor = "#f99"; e.currentTarget.style.color = "#c55"; }}
                                        onMouseLeave={e => { e.currentTarget.style.borderColor = "#ddd"; e.currentTarget.style.color = "#aaa"; }}>
                                        ✕
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
