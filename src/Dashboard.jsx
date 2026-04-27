import { useState, useEffect, useMemo } from "react";
import { db } from "./firebase";
import { collection, query, where, orderBy, getDocs, deleteDoc, doc } from "firebase/firestore";
import { useAuth } from "./AuthContext";

const STAT_META = [
    { key: "new",           label: "Нове",             color: "#888",    bg: "#f5f5f5"  },
    { key: "plan_ready",    label: "План готовий",      color: "#5a7a2a", bg: "#eef5e4"  },
    { key: "plan_approved", label: "План затверджено",  color: "#1a5a8a", bg: "#e4f0ff"  },
    { key: "writing",       label: "В роботі",          color: "#2a7a6a", bg: "#e4f5f2"  },
    { key: "sources",       label: "Джерела",           color: "#8a5a1a", bg: "#fff3e0"  },
    { key: "done",          label: "Готово",            color: "#1a6a1a", bg: "#e4ffe4"  },
];

const DATE_RANGES = [
    { key: "1",   label: "1 день",   days: 1   },
    { key: "2",   label: "2 дні",    days: 2   },
    { key: "7",   label: "7 днів",   days: 7   },
    { key: "30",  label: "Місяць",   days: 30  },
    { key: "90",  label: "3 місяці", days: 90  },
    { key: "all", label: "Весь час", days: null },
];

function getStatStatus(o) {
    const s = o.status || "new";
    if (o.stage === "sources" || (s === "done" && (!o.refList || o.refList.length === 0))) return "sources";
    return s;
}

function AdminStatsModal({ onClose }) {
    const [allOrders, setAllOrders] = useState([]);
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [range, setRange] = useState("7");
    const [customFrom, setCustomFrom] = useState("");
    const [customTo, setCustomTo] = useState("");

    useEffect(() => {
        const load = async () => {
            const [ordersSnap, usersSnap] = await Promise.all([
                getDocs(collection(db, "orders")),
                getDocs(collection(db, "users")),
            ]);
            setAllOrders(ordersSnap.docs.map(d => ({ id: d.id, ...d.data() })));
            setUsers(usersSnap.docs.map(d => ({ id: d.id, ...d.data() })));
            setLoading(false);
        };
        load();
    }, []);

    const orders = useMemo(() => {
        if (customFrom || customTo) {
            const from = customFrom ? new Date(customFrom + "T00:00:00") : null;
            const to = customTo ? new Date(customTo + "T23:59:59") : null;
            return allOrders.filter(o => {
                if (!o.createdAt) return false;
                const d = new Date(o.createdAt);
                if (from && d < from) return false;
                if (to && d > to) return false;
                return true;
            });
        }
        const r = DATE_RANGES.find(d => d.key === range);
        if (!r || !r.days) return allOrders;
        const from = new Date();
        from.setDate(from.getDate() - r.days);
        from.setHours(0, 0, 0, 0);
        return allOrders.filter(o => o.createdAt && new Date(o.createdAt) >= from);
    }, [allOrders, range, customFrom, customTo]);

    const overall = useMemo(() => {
        const c = { total: orders.length };
        STAT_META.forEach(s => { c[s.key] = 0; });
        orders.forEach(o => { const s = getStatStatus(o); if (c[s] !== undefined) c[s]++; });
        return c;
    }, [orders]);

    const byManager = useMemo(() => {
        const userMap = {};
        users.forEach(u => { userMap[u.id] = u; });
        const map = {};
        orders.forEach(o => {
            if (!o.uid) return;
            if (!map[o.uid]) {
                map[o.uid] = { uid: o.uid, total: 0, lastOrder: null };
                STAT_META.forEach(s => { map[o.uid][s.key] = 0; });
            }
            const s = getStatStatus(o);
            if (map[o.uid][s] !== undefined) map[o.uid][s]++;
            map[o.uid].total++;
            if (!map[o.uid].lastOrder || o.createdAt > map[o.uid].lastOrder) map[o.uid].lastOrder = o.createdAt;
        });
        return Object.values(map).map(r => ({ ...r, user: userMap[r.uid] })).sort((a, b) => b.total - a.total);
    }, [orders, users]);

    const fmt = iso => iso ? new Date(iso).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

    return (
        <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "32px 16px", overflowY: "auto" }}>
            <div onClick={e => e.stopPropagation()} style={{ background: "#f5f2eb", borderRadius: 14, width: "100%", maxWidth: 900, fontFamily: "'Spectral',Georgia,serif", boxShadow: "0 12px 60px rgba(0,0,0,0.3)" }}>

                {/* Заголовок */}
                <div style={{ background: "#1a1a14", borderRadius: "14px 14px 0 0", padding: "16px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ color: "#e8ff47", fontFamily: "'Spectral SC',serif", fontSize: 15, letterSpacing: 3 }}>СТАТИСТИКА</div>
                    <button onClick={onClose} style={{ background: "none", border: "none", color: "#888", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>✕</button>
                </div>

                <div style={{ padding: 20 }}>
                    {loading ? (
                        <div style={{ padding: 40, textAlign: "center", color: "#888" }}>Завантаження...</div>
                    ) : (<>
                        {/* Фільтр */}
                        <div style={{ background: "#fff", borderRadius: 10, padding: "14px 18px", marginBottom: 16, boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
                            <div style={{ fontSize: 10, color: "#aaa", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 10 }}>Період</div>
                            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 10 }}>
                                {DATE_RANGES.map(r => {
                                    const active = !customFrom && !customTo && range === r.key;
                                    return (
                                        <button key={r.key} onClick={() => { setRange(r.key); setCustomFrom(""); setCustomTo(""); }}
                                            style={{ padding: "6px 14px", borderRadius: 20, fontSize: 12, cursor: "pointer", fontFamily: "inherit", border: active ? "2px solid #1a1a14" : "1.5px solid #e0ddd4", background: active ? "#1a1a14" : "#faf8f3", color: active ? "#e8ff47" : "#555", fontWeight: active ? 700 : 400, transition: "all .15s" }}>
                                            {r.label}
                                        </button>
                                    );
                                })}
                            </div>
                            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                <span style={{ fontSize: 11, color: "#aaa" }}>або діапазон:</span>
                                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                    <span style={{ fontSize: 11, color: "#888" }}>Від</span>
                                    <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} style={{ padding: "5px 8px", border: `1.5px solid ${customFrom ? "#1a1a14" : "#e0ddd4"}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", outline: "none" }} />
                                </div>
                                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                    <span style={{ fontSize: 11, color: "#888" }}>До</span>
                                    <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} style={{ padding: "5px 8px", border: `1.5px solid ${customTo ? "#1a1a14" : "#e0ddd4"}`, borderRadius: 6, fontSize: 12, fontFamily: "inherit", outline: "none" }} />
                                </div>
                                {(customFrom || customTo) && (
                                    <button onClick={() => { setCustomFrom(""); setCustomTo(""); }} style={{ padding: "5px 10px", borderRadius: 6, border: "1.5px solid #e0ddd4", background: "transparent", color: "#888", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>Скинути ✕</button>
                                )}
                            </div>
                        </div>

                        {/* Загальна статистика */}
                        <div style={{ background: "#fff", borderRadius: 10, padding: "14px 18px", marginBottom: 16, boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
                            <div style={{ fontSize: 14, fontWeight: 700, color: "#1a1a14", marginBottom: 14 }}>Загальна статистика</div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 10 }}>
                                <div style={{ padding: "12px 14px", borderRadius: 10, background: "#1a1a14" }}>
                                    <div style={{ fontSize: 26, fontWeight: 700, color: "#e8ff47", lineHeight: 1 }}>{overall.total}</div>
                                    <div style={{ fontSize: 11, color: "#aaa", marginTop: 4 }}>Всього</div>
                                </div>
                                {STAT_META.map(s => (
                                    <div key={s.key} style={{ padding: "12px 14px", borderRadius: 10, background: s.bg, border: `1.5px solid ${s.color}22` }}>
                                        <div style={{ fontSize: 26, fontWeight: 700, color: s.color, lineHeight: 1 }}>{overall[s.key]}</div>
                                        <div style={{ fontSize: 10, color: s.color, opacity: 0.8, marginTop: 4 }}>{s.label}</div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* По менеджерам */}
                        <div style={{ background: "#fff", borderRadius: 10, padding: "14px 18px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
                            <div style={{ fontSize: 14, fontWeight: 700, color: "#1a1a14", marginBottom: 14 }}>По менеджерам</div>
                            {byManager.length === 0 ? (
                                <div style={{ color: "#aaa", fontSize: 13 }}>Немає даних за вибраний період</div>
                            ) : (
                                <div style={{ overflowX: "auto" }}>
                                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                                        <thead>
                                            <tr style={{ borderBottom: "2px solid #f0ece2" }}>
                                                <th style={{ textAlign: "left", padding: "7px 10px", color: "#888", fontWeight: 600, fontSize: 10, letterSpacing: 1, textTransform: "uppercase" }}>Менеджер</th>
                                                <th style={{ textAlign: "center", padding: "7px 8px", color: "#888", fontWeight: 600, fontSize: 10, letterSpacing: 1, textTransform: "uppercase" }}>Всього</th>
                                                {STAT_META.map(s => (
                                                    <th key={s.key} style={{ textAlign: "center", padding: "7px 5px", color: s.color, fontWeight: 600, fontSize: 9, whiteSpace: "nowrap" }}>{s.label}</th>
                                                ))}
                                                <th style={{ textAlign: "center", padding: "7px 8px", color: "#888", fontWeight: 600, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", whiteSpace: "nowrap" }}>Останнє</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {byManager.map((row, i) => (
                                                <tr key={row.uid} style={{ borderBottom: "1px solid #f0ece2", background: i % 2 === 0 ? "transparent" : "#faf8f3" }}>
                                                    <td style={{ padding: "9px 10px" }}>
                                                        <div style={{ fontWeight: 600, color: "#1a1a14", fontSize: 13 }}>{row.user?.name || "—"}</div>
                                                        <div style={{ fontSize: 10, color: "#aaa" }}>{row.user?.email || row.uid}</div>
                                                    </td>
                                                    <td style={{ textAlign: "center", fontWeight: 700, fontSize: 14, color: "#1a1a14" }}>{row.total}</td>
                                                    {STAT_META.map(s => (
                                                        <td key={s.key} style={{ textAlign: "center", padding: "9px 5px" }}>
                                                            {row[s.key] > 0 ? (
                                                                <span style={{ display: "inline-block", minWidth: 22, padding: "2px 7px", borderRadius: 10, background: s.bg, color: s.color, fontWeight: 600, fontSize: 11 }}>{row[s.key]}</span>
                                                            ) : <span style={{ color: "#ddd" }}>—</span>}
                                                        </td>
                                                    ))}
                                                    <td style={{ textAlign: "center", color: "#888", fontSize: 11, whiteSpace: "nowrap" }}>{fmt(row.lastOrder)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    </>)}
                </div>
            </div>
        </div>
    );
}

const STATUS_LABELS = {
    new: { label: "Нове", color: "#888", bg: "#f5f5f5", dot: "#ccc" },
    plan_ready: { label: "План готовий", color: "#5a7a2a", bg: "#eef5e4", dot: "#8ac040" },
    plan_approved: { label: "План затверджено", color: "#1a5a8a", bg: "#e4f0ff", dot: "#4a9ade" },
    writing: { label: "В роботі", color: "#2a7a6a", bg: "#e4f5f2", dot: "#3abfa0" },
    sources: { label: "Джерела", color: "#8a5a1a", bg: "#fff3e0", dot: "#e8a050" },
    done: { label: "Готово", color: "#1a6a1a", bg: "#e4ffe4", dot: "#4aba4a" },
};

export default function Dashboard({ onOpen, onNew, onAdmin }) {
    const { user, profile, logout } = useAuth();
    const [orders, setOrders] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [filterStatus, setFilterStatus] = useState(null); // null = всі
    const [infoOrder, setInfoOrder] = useState(null); // модалка деталей
    const [showHelp, setShowHelp] = useState(false);
    const [showStats, setShowStats] = useState(false);

    useEffect(() => {
        const load = async () => {
            setLoading(true);
            try {
                const q = query(
                    collection(db, "orders"),
                    where("uid", "==", user.uid),
                    orderBy("createdAt", "desc")
                );
                const snap = await getDocs(q);
                setOrders(snap.docs.map(d => ({ id: d.id, ...d.data() })));
            } catch (e) {
                console.error(e);
            }
            setLoading(false);
        };
        load();
    }, [user.uid]);

    const deleteOrder = async (id, e) => {
        e.stopPropagation();
        if (!window.confirm("Видалити замовлення?")) return;
        await deleteDoc(doc(db, "orders", id));
        setOrders(p => p.filter(o => o.id !== id));
    };

    const needsSources = (o) => o.stage === "sources" || (o.status === "done" && (!o.refList || o.refList.length === 0));

    const filtered = useMemo(() => {
        let result = orders;
        // Фільтр по статусу
        if (filterStatus) {
            result = result.filter(o => {
                const s = o.status || "new";
                if (filterStatus === "sources") return needsSources(o);
                if (filterStatus === "writing") return s === "writing" && o.stage !== "sources";
                if (filterStatus === "plan_ready") return s === "plan_ready" || s === "plan_approved";
                if (filterStatus === "done") return s === "done" && !needsSources(o);
                if (filterStatus === "new") return s === "new";
                return true;
            });
        }
        // Пошук по тексту
        if (search.trim()) {
            const q = search.toLowerCase().trim();
            result = result.filter(o =>
                o.topic?.toLowerCase().includes(q) ||
                o.id?.toLowerCase().includes(q) ||
                o.type?.toLowerCase().includes(q) ||
                o.deadline?.toLowerCase().includes(q) ||
                o.info?.orderNumber?.toLowerCase().includes(q)
            );
        }
        return result;
    }, [orders, search, filterStatus]);

    const counts = useMemo(() => {
        const c = { all: orders.length, done: 0, writing: 0, sources: 0, plan_ready: 0, new: 0 };
        orders.forEach(o => {
            const s = o.status || "new";
            if (needsSources(o)) c.sources++;
            else if (s === "done") c.done++;
            else if (s === "writing") c.writing++;
            else if (s === "plan_ready" || s === "plan_approved") c.plan_ready++;
            else c.new++;
        });
        return c;
    }, [orders]);

    return (
        <div style={{ minHeight: "100vh", background: "#f5f2eb", fontFamily: "'Spectral', Georgia, serif" }}>
            <style>{`@import url('https://fonts.googleapis.com/css2?family=Spectral:wght@400;600&family=Spectral+SC:wght@600&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>

            {/* Header */}
            <div style={{ background: "#1a1a14", color: "#f5f2eb", padding: "16px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 20, letterSpacing: 4, color: "#e8ff47" }}>ACADEM</div>
                    <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 20, letterSpacing: 4 }}>ASSIST</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <button onClick={() => setShowHelp(true)} title="Інструкція" style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontFamily: "inherit", fontSize: 14, lineHeight: 1 }}>ℹ</button>
                    {profile?.role === "admin" && (
                        <button onClick={() => setShowStats(true)} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Статистика</button>
                    )}
                    {onAdmin && (
                        <button onClick={onAdmin} style={{ background: "#e8ff47", color: "#1a1a14", border: "none", borderRadius: 6, padding: "6px 16px", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700 }}>
                            ⚙ Адмін
                        </button>
                    )}
                    <div style={{ fontSize: 13, color: "#888" }}>{profile?.name || user.email}</div>
                    <button onClick={logout} style={{ background: "transparent", border: "1px solid #555", color: "#aaa", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Вийти</button>
                </div>
            </div>

            <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px clamp(16px, 3vw, 48px)" }}>

                {/* Top bar */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
                    <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 18, letterSpacing: 2, color: "#1a1a14" }}>МОЇ ЗАМОВЛЕННЯ</div>
                    <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => onNew("small")} style={{ background: "transparent", color: "#1a1a14", border: "1.5px solid #1a1a14", borderRadius: 7, padding: "9px 18px", fontSize: 12, fontWeight: 600, cursor: "pointer", letterSpacing: 1, fontFamily: "inherit" }}>
                            + Мала робота
                        </button>
                        <button onClick={() => onNew("large")} style={{ background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, padding: "10px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer", letterSpacing: 1, fontFamily: "inherit" }}>
                            + Нове замовлення
                        </button>
                    </div>
                </div>

                {/* Stats */}
                {!loading && orders.length > 0 && (
                    <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
                        {[
                            { label: "Всього", val: counts.all, color: "#1a1a14", bg: "#e8e4d8", key: null },
                            { label: "План", val: counts.plan_ready, color: "#1a5a8a", bg: "#e4f0ff", key: "plan_ready" },
                            { label: "В роботі", val: counts.writing, color: "#2a7a6a", bg: "#e4f5f2", key: "writing" },
                            { label: "Джерела", val: counts.sources, color: "#8a5a1a", bg: "#fff3e0", key: "sources" },
                            { label: "Готово", val: counts.done, color: "#1a6a1a", bg: "#e4ffe4", key: "done" },
                        ].map(s => {
                            const isActive = filterStatus === s.key;
                            return (
                                <div key={s.label}
                                    onClick={() => setFilterStatus(isActive ? null : s.key)}
                                    style={{
                                        padding: "8px 18px", borderRadius: 20, background: isActive ? s.color : s.bg,
                                        color: isActive ? "#fff" : s.color, fontSize: 12, fontWeight: 600,
                                        cursor: "pointer", transition: "all .15s",
                                        border: isActive ? `2px solid ${s.color}` : "2px solid transparent",
                                        userSelect: "none"
                                    }}>
                                    {s.val} {s.label}
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Search */}
                {orders.length > 0 && (
                    <div style={{ marginBottom: 18, position: "relative" }}>
                        <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontSize: 16, color: "#aaa" }}>🔍</span>
                        <input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Пошук за темою, типом, дедлайном, номером замовлення..."
                            style={{ width: "100%", padding: "11px 14px 11px 40px", border: "1.5px solid #d4cfc4", borderRadius: 8, fontSize: 14, fontFamily: "'Spectral',serif", background: "#fff", color: "#1a1a14", outline: "none" }}
                        />
                        {search && (
                            <button onClick={() => setSearch("")} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "#aaa", lineHeight: 1 }}>✕</button>
                        )}
                    </div>
                )}

                {/* List */}
                {loading ? (
                    <div style={{ textAlign: "center", padding: 60, color: "#888" }}>
                        <div style={{ fontSize: 14 }}>Завантаження...</div>
                    </div>
                ) : orders.length === 0 ? (
                    <div style={{ background: "#fff", borderRadius: 12, padding: 56, textAlign: "center", boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
                        <div style={{ fontSize: 40, marginBottom: 16 }}>📄</div>
                        <div style={{ fontSize: 16, color: "#888", marginBottom: 20 }}>Замовлень ще немає</div>
                        <button onClick={onNew} style={{ background: "#1a1a14", color: "#e8ff47", border: "none", borderRadius: 7, padding: "10px 24px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                            Створити перше замовлення →
                        </button>
                    </div>
                ) : filtered.length === 0 ? (
                    <div style={{ textAlign: "center", padding: 40, color: "#888", fontSize: 14 }}>
                        Нічого не знайдено за запитом «{search}»
                    </div>
                ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        {filtered.map(order => {
                            const st = (needsSources(order) ? STATUS_LABELS.sources : null) || STATUS_LABELS[order.status] || STATUS_LABELS.new;
                            const isSmall = order.mode === "small";
                            return (
                                <div key={order.id} onClick={() => onOpen(order.id, order.mode || "large")}
                                    style={{ background: "#fff", borderRadius: 10, padding: "16px 20px", cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,0.05)", display: "flex", alignItems: "center", gap: 14, transition: "box-shadow .2s" }}
                                    onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 18px rgba(0,0,0,0.10)"}
                                    onMouseLeave={e => e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.05)"}>

                                    {/* Status dot */}
                                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: st.dot, flexShrink: 0 }} />

                                    {/* Info */}
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontSize: 15, fontWeight: 600, color: "#1a1a14", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                            {order.topic || "Без теми"}
                                        </div>
                                        <div style={{ fontSize: 12, color: "#888", display: "flex", gap: 12, flexWrap: "wrap" }}>
                                            {isSmall && <span style={{ background: "#f0e4ff", color: "#5a1a8a", padding: "1px 8px", borderRadius: 8, fontSize: 11 }}>📝 Мала</span>}
                                            {order.type && <span>{order.type}</span>}
                                            {order.pages && <span>{order.pages} стор.</span>}
                                            {order.deadline && <span>⏰ {order.deadline}</span>}
                                            <span style={{ color: "#bbb" }}>{order.createdAt?.slice(0, 10) || ""}</span>
                                            {order.info?.orderNumber && <span style={{ background: "#f0e8ff", color: "#5a1a8a", padding: "1px 8px", borderRadius: 8, fontSize: 11, fontFamily: "monospace" }}>№ {order.info.orderNumber}</span>}
                                            <span style={{ color: "#ccc", fontFamily: "monospace", fontSize: 10 }}>#{order.id.slice(0, 8)}</span>
                                        </div>
                                    </div>

                                    {/* Status badge */}
                                    <div style={{ padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: st.bg, color: st.color, whiteSpace: "nowrap", flexShrink: 0 }}>
                                        {st.label}
                                    </div>

                                    {/* Delete */}
                                    <button onClick={e => deleteOrder(order.id, e)}
                                        style={{ background: "transparent", border: "1px solid #eee", color: "#ccc", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", flexShrink: 0 }}
                                        onMouseEnter={e => { e.currentTarget.style.borderColor = "#f99"; e.currentTarget.style.color = "#c55"; }}
                                        onMouseLeave={e => { e.currentTarget.style.borderColor = "#eee"; e.currentTarget.style.color = "#ccc"; }}>
                                        ✕
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Модалка інструкції */}
            {showHelp && (
                <div onClick={() => setShowHelp(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
                    <div onClick={e => e.stopPropagation()} style={{ background: "#1a1a14", borderRadius: 14, padding: "32px 36px", maxWidth: 680, width: "100%", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 12px 60px rgba(0,0,0,0.5)", fontFamily: "'Spectral',Georgia,serif", color: "#f5f2eb" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
                            <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 16, letterSpacing: 3, color: "#e8ff47" }}>ІНСТРУКЦІЯ</div>
                            <button onClick={() => setShowHelp(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#888", lineHeight: 1 }}>✕</button>
                        </div>
                        {[
                            { title: "Що це за програма?", body: "ACADEM ASSIST — AI-асистент для написання академічних робіт. Він автоматично генерує текст курсових, дипломних та інших робіт на основі твоїх даних." },
                            { title: "Типи робіт", body: "Нове замовлення — для курсових, дипломних, бакалаврських робіт.\nМала робота — для рефератів, тез, статей, есе, презентацій." },
                            { title: "Крок 1 — Введення даних", body: "Вставте текст шаблону замовлення (бланк від викладача). За потреби додайте коментар та завантажте методичку (PDF). Якщо є готовий план — вставте або сфотографуйте його. Натисніть «Аналізувати»." },
                            { title: "Крок 2 — Перевірка даних", body: "Перевірте витягнуті дані: тему, напрям, кількість сторінок, мову, дедлайн. Відредагуйте за потреби. Натисніть «Генерувати план»." },
                            { title: "Крок 3 — План роботи", body: "Переглянте та відредагуйте назви розділів і підрозділів. Натисніть «Затвердити план» щоб розпочати написання." },
                            { title: "Крок 4 — Написання тексту", body: "Система генерує текст по кожному підрозділу поступово. Прогрес відображається у верхній панелі. Можна зупинити і продовжити пізніше. Кожен підрозділ можна перегенерувати з додатковими вимогами." },
                            { title: "Крок 5 — Джерела", body: "Введіть реальні джерела для кожного підрозділу. Скористайтесь кнопкою «Ключові слова» щоб знайти релевантні запити для пошуку. Натисніть «Сформувати список літератури»." },
                            { title: "Крок 6 — Готово", body: "Завантажити .docx — готова робота з титульною сторінкою.\nДоповідь — текст для захисту у .docx.\nПрезентація — автоматичний .pptx.\nДодатки — генерує додатки до роботи.\nКопіювати текст — весь текст у буфер обміну." },
                            { title: "Малі роботи", body: "Натисніть «Мала робота», оберіть тип (Реферат / Тези / Стаття / Есе / Презентація), заповніть форму і натисніть «Генерувати». Завантажте результат у .docx або .pptx." },
                            { title: "Корисні поради", body: "Методичка значно покращує якість роботи — завантажуй її якщо є.\nЯкщо генерація переривається — поверніться до замовлення і продовжіть.\nЗвук лунає коли генерація завершена, навіть якщо вкладка прихована.\nВсі дані зберігаються автоматично в хмарі." },
                        ].map(({ title, body }) => (
                            <div key={title} style={{ marginBottom: 22 }}>
                                <div style={{ fontSize: 13, fontWeight: 700, color: "#e8ff47", letterSpacing: 1, marginBottom: 6, fontFamily: "'Spectral SC',serif" }}>{title}</div>
                                <div style={{ fontSize: 13, color: "#c8c4bb", lineHeight: 1.7, whiteSpace: "pre-line" }}>{body}</div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Статистика */}
            {showStats && <AdminStatsModal onClose={() => setShowStats(false)} />}

            {/* Модалка деталей замовлення */}
            {infoOrder && (
                <div onClick={() => setInfoOrder(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
                    <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: 28, maxWidth: 520, width: "100%", boxShadow: "0 8px 40px rgba(0,0,0,0.18)", fontFamily: "'Spectral',Georgia,serif" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                            <div style={{ fontFamily: "'Spectral SC',serif", fontSize: 14, letterSpacing: 2, color: "#1a1a14" }}>ДЕТАЛІ ЗАМОВЛЕННЯ</div>
                            <button onClick={() => setInfoOrder(null)} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#aaa" }}>✕</button>
                        </div>
                        <div style={{ fontSize: 11, color: "#aaa", fontFamily: "monospace", marginBottom: 16 }}>#{infoOrder.id}</div>
                        {[
                            { label: "Тема", val: infoOrder.topic },
                            { label: "Тип роботи", val: infoOrder.type },
                            { label: "Галузь / спеціальність", val: infoOrder.subject },
                            { label: "К-сть сторінок", val: infoOrder.pages },
                            { label: "Мова", val: infoOrder.language },
                            { label: "Унікальність", val: infoOrder.uniqueness },
                            { label: "Дедлайн", val: infoOrder.deadline },
                            { label: "К-сть джерел", val: infoOrder.sourceCount },
                            { label: "Додатково", val: infoOrder.extras },
                            { label: "Вимоги методички", val: infoOrder.methodNotes },
                            { label: "Дата створення", val: infoOrder.createdAt?.slice(0, 10) },
                        ].filter(r => r.val).map(r => (
                            <div key={r.label} style={{ display: "flex", gap: 12, marginBottom: 10, fontSize: 13 }}>
                                <div style={{ color: "#888", minWidth: 160, flexShrink: 0 }}>{r.label}</div>
                                <div style={{ color: "#1a1a14", fontWeight: 500 }}>{r.val}</div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
