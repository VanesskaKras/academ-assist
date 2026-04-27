import { useState, useEffect, useMemo } from "react";
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

const STATUS_META = [
    { key: "new",          label: "Нове",              color: "#888",   bg: "#f5f5f5",  dot: "#ccc"    },
    { key: "plan_ready",   label: "План готовий",       color: "#5a7a2a", bg: "#eef5e4", dot: "#8ac040" },
    { key: "plan_approved",label: "План затверджено",   color: "#1a5a8a", bg: "#e4f0ff", dot: "#4a9ade" },
    { key: "writing",      label: "В роботі",           color: "#2a7a6a", bg: "#e4f5f2", dot: "#3abfa0" },
    { key: "sources",      label: "Джерела",            color: "#8a5a1a", bg: "#fff3e0", dot: "#e8a050" },
    { key: "done",         label: "Готово",             color: "#1a6a1a", bg: "#e4ffe4", dot: "#4aba4a" },
];

const DATE_RANGES = [
    { key: "1",   label: "1 день",  days: 1   },
    { key: "2",   label: "2 дні",   days: 2   },
    { key: "7",   label: "7 днів",  days: 7   },
    { key: "30",  label: "Місяць",  days: 30  },
    { key: "90",  label: "3 місяці",days: 90  },
    { key: "all", label: "Весь час",days: null },
];

function getOrderStatus(o) {
    const s = o.status || "new";
    if (o.stage === "sources" || (s === "done" && (!o.refList || o.refList.length === 0))) return "sources";
    return s;
}

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

// ─── Вкладка статистики ───────────────────────────────────────────────────────

function StatsTab({ users }) {
    const [allOrders, setAllOrders] = useState([]);
    const [loading, setLoading] = useState(true);
    const [customFrom, setCustomFrom] = useState("");
    const [customTo, setCustomTo] = useState("");

    useEffect(() => {
        const load = async () => {
            setLoading(true);
            const snap = await getDocs(collection(db, "orders"));
            setAllOrders(snap.docs.map(d => ({ id: d.id, ...d.data() })));
            setLoading(false);
        };
        load();
    }, []);

    const orders = useMemo(() => {
        if (!customFrom && !customTo) return allOrders;
        const from = customFrom ? new Date(customFrom + "T00:00:00") : null;
        const to = customTo ? new Date(customTo + "T23:59:59") : null;
        return allOrders.filter(o => {
            if (!o.createdAt) return false;
            const d = new Date(o.createdAt);
            if (from && d < from) return false;
            if (to && d > to) return false;
            return true;
        });
    }, [allOrders, customFrom, customTo]);

    const overall = useMemo(() => {
        const counts = { total: orders.length };
        STATUS_META.forEach(s => { counts[s.key] = 0; });
        orders.forEach(o => {
            const s = getOrderStatus(o);
            if (counts[s] !== undefined) counts[s]++;
        });
        return counts;
    }, [orders]);

    const byManager = useMemo(() => {
        const userMap = {};
        users.forEach(u => { userMap[u.id] = u; });

        const map = {};
        orders.forEach(o => {
            if (!o.uid) return;
            if (!map[o.uid]) {
                map[o.uid] = { uid: o.uid, total: 0, lastOrder: null };
                STATUS_META.forEach(s => { map[o.uid][s.key] = 0; });
            }
            const s = getOrderStatus(o);
            if (map[o.uid][s] !== undefined) map[o.uid][s]++;
            map[o.uid].total++;
            if (!map[o.uid].lastOrder || o.createdAt > map[o.uid].lastOrder) {
                map[o.uid].lastOrder = o.createdAt;
            }
        });

        return Object.values(map)
            .map(row => ({ ...row, user: userMap[row.uid] }))
            .sort((a, b) => b.total - a.total);
    }, [orders, users]);

    const formatDate = (iso) => {
        if (!iso) return "—";
        const d = new Date(iso);
        return d.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" });
    };

    if (loading) return <div style={{ padding: 32, color: "#888" }}>Завантаження статистики...</div>;

    return (
        <div>
            {/* Фільтр по даті */}
            <div style={{ background: "#fff", borderRadius: 10, padding: "16px 20px", marginBottom: 20, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                <div style={{ fontSize: 11, color: "#888", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>Період</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 12, color: "#888" }}>Від</span>
                        <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                            style={{ padding: "6px 10px", border: `1.5px solid ${customFrom ? "#1a1a14" : "#e0ddd4"}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", outline: "none", cursor: "pointer" }} />
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 12, color: "#888" }}>До</span>
                        <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                            style={{ padding: "6px 10px", border: `1.5px solid ${customTo ? "#1a1a14" : "#e0ddd4"}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", outline: "none", cursor: "pointer" }} />
                    </div>
                    {(customFrom || customTo) && (
                        <button onClick={() => { setCustomFrom(""); setCustomTo(""); }}
                            style={{ padding: "6px 12px", borderRadius: 7, border: "1.5px solid #e0ddd4", background: "transparent", color: "#888", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                            Скинути ✕
                        </button>
                    )}
                    {!customFrom && !customTo && <span style={{ fontSize: 11, color: "#bbb" }}>— весь час</span>}
                </div>
            </div>

            {/* Загальна статистика */}
            <div style={{ background: "#fff", borderRadius: 10, padding: 20, marginBottom: 20, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#1a1a14", marginBottom: 16 }}>Загальна статистика</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12 }}>
                    {/* Всього */}
                    <div style={{ padding: "14px 16px", borderRadius: 10, background: "#1a1a14", border: "none" }}>
                        <div style={{ fontSize: 28, fontWeight: 700, color: "#e8ff47", lineHeight: 1 }}>{overall.total}</div>
                        <div style={{ fontSize: 12, color: "#aaa", marginTop: 4 }}>Всього</div>
                    </div>
                    {/* По статусах */}
                    {STATUS_META.map(s => (
                        <div key={s.key} style={{ padding: "14px 16px", borderRadius: 10, background: s.bg, border: `1.5px solid ${s.dot}30` }}>
                            <div style={{ fontSize: 28, fontWeight: 700, color: s.color, lineHeight: 1 }}>{overall[s.key]}</div>
                            <div style={{ fontSize: 11, color: s.color, opacity: 0.8, marginTop: 4 }}>{s.label}</div>
                        </div>
                    ))}
                </div>
            </div>

            {/* По менеджерам */}
            <div style={{ background: "#fff", borderRadius: 10, padding: 20, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#1a1a14", marginBottom: 16 }}>По менеджерам</div>
                {byManager.length === 0 ? (
                    <div style={{ color: "#aaa", fontSize: 14 }}>Немає даних за вибраний період</div>
                ) : (
                    <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                            <thead>
                                <tr style={{ borderBottom: "2px solid #f0ece2" }}>
                                    <th style={{ textAlign: "left", padding: "8px 10px", color: "#888", fontWeight: 600, fontSize: 11, letterSpacing: 1, textTransform: "uppercase" }}>Менеджер</th>
                                    <th style={{ textAlign: "center", padding: "8px 10px", color: "#888", fontWeight: 600, fontSize: 11, letterSpacing: 1, textTransform: "uppercase" }}>Всього</th>
                                    {STATUS_META.map(s => (
                                        <th key={s.key} style={{ textAlign: "center", padding: "8px 6px", color: s.color, fontWeight: 600, fontSize: 10, letterSpacing: 0.5, whiteSpace: "nowrap" }}>{s.label}</th>
                                    ))}
                                    <th style={{ textAlign: "center", padding: "8px 10px", color: "#888", fontWeight: 600, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", whiteSpace: "nowrap" }}>Останнє</th>
                                </tr>
                            </thead>
                            <tbody>
                                {byManager.map((row, i) => (
                                    <tr key={row.uid} style={{ borderBottom: "1px solid #f0ece2", background: i % 2 === 0 ? "transparent" : "#faf8f3" }}>
                                        <td style={{ padding: "10px 10px" }}>
                                            <div style={{ fontWeight: 600, color: "#1a1a14" }}>{row.user?.name || "—"}</div>
                                            <div style={{ fontSize: 11, color: "#aaa" }}>{row.user?.email || row.uid}</div>
                                        </td>
                                        <td style={{ textAlign: "center", padding: "10px", fontWeight: 700, fontSize: 15, color: "#1a1a14" }}>{row.total}</td>
                                        {STATUS_META.map(s => (
                                            <td key={s.key} style={{ textAlign: "center", padding: "10px 6px" }}>
                                                {row[s.key] > 0 ? (
                                                    <span style={{ display: "inline-block", minWidth: 24, padding: "2px 8px", borderRadius: 12, background: s.bg, color: s.color, fontWeight: 600, fontSize: 12 }}>
                                                        {row[s.key]}
                                                    </span>
                                                ) : (
                                                    <span style={{ color: "#ddd" }}>—</span>
                                                )}
                                            </td>
                                        ))}
                                        <td style={{ textAlign: "center", padding: "10px", color: "#888", fontSize: 12, whiteSpace: "nowrap" }}>{formatDate(row.lastOrder)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Головна сторінка ─────────────────────────────────────────────────────────

export default function AdminPage({ onBack }) {
    const [tab, setTab] = useState("users");
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
            const secondaryApp = initializeApp(
                JSON.parse(document.getElementById("fb-config").textContent),
                "secondary-" + Date.now()
            );
            const secondaryAuth = getAuth(secondaryApp);
            const cred = await createUserWithEmailAndPassword(secondaryAuth, newEmail, newPassword);

            await setDoc(doc(db, "users", cred.user.uid), {
                email: newEmail,
                name: newName,
                role: newRole,
                approved: true,
                blocked: false,
                createdAt: new Date().toISOString(),
            });

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

            <div style={{ maxWidth: 960, margin: "32px auto", padding: "0 20px" }}>

                {/* Вкладки */}
                <div style={{ display: "flex", gap: 4, marginBottom: 24, borderBottom: "2px solid #e0ddd4" }}>
                    {[
                        { key: "users", label: "Користувачі" },
                        { key: "stats", label: "Статистика" },
                    ].map(t => (
                        <button key={t.key} onClick={() => setTab(t.key)}
                            style={{
                                padding: "10px 22px", fontSize: 14, fontWeight: tab === t.key ? 700 : 400,
                                background: "transparent", border: "none", cursor: "pointer",
                                fontFamily: "inherit", color: tab === t.key ? "#1a1a14" : "#888",
                                borderBottom: tab === t.key ? "2px solid #1a1a14" : "2px solid transparent",
                                marginBottom: -2, transition: "all .15s",
                            }}>
                            {t.label}
                        </button>
                    ))}
                </div>

                {/* Вкладка: Користувачі */}
                {tab === "users" && (
                    <>
                        {/* Створити користувача */}
                        <div style={{ background: "#fff", borderRadius: 10, padding: 24, marginBottom: 24, boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, color: "#1a1a14" }}>Створити нового користувача</div>
                            <form onSubmit={createUser}>
                                <AdminField label="Ім'я" value={newName} onChange={setNewName} placeholder="Іван Петренко" />
                                <AdminField label="Email" value={newEmail} onChange={setNewEmail} type="email" placeholder="user@example.com" />
                                <AdminField label="Пароль" value={newPassword} onChange={setNewPassword} type="password" placeholder="мінімум 6 символів" />

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
                                        <div style={{ width: 38, height: 38, borderRadius: "50%", background: u.blocked ? "#ffeeee" : "#eef5e4", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>
                                            {u.blocked ? "🚫" : u.role === "admin" ? "👑" : "👤"}
                                        </div>

                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontSize: 14, fontWeight: 600, color: "#1a1a14" }}>{u.name || "—"}</div>
                                            <div style={{ fontSize: 12, color: "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.email}</div>
                                        </div>

                                        <div style={{ padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: roleInfo.bg, color: roleInfo.color, flexShrink: 0 }}>
                                            {roleInfo.label}
                                        </div>

                                        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
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

                                            <button onClick={() => toggleBlock(u.id, u.blocked)}
                                                style={{ background: u.blocked ? "#eef5e4" : "#fff0f0", border: `1px solid ${u.blocked ? "#c8dfa0" : "#ffcccc"}`, color: u.blocked ? "#3a6010" : "#c00", borderRadius: 6, padding: "5px 10px", fontSize: 11, cursor: "pointer" }}>
                                                {u.blocked ? "Розблок." : "Блок."}
                                            </button>

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
                    </>
                )}

                {/* Вкладка: Статистика */}
                {tab === "stats" && <StatsTab users={users} />}
            </div>
        </div>
    );
}
