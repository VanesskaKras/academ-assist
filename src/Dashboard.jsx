import { useState, useEffect, useMemo } from "react";
import { db } from "./firebase";
import { collection, query, where, orderBy, getDocs, deleteDoc, doc } from "firebase/firestore";
import { useAuth } from "./AuthContext";

const STATUS_LABELS = {
    new: { label: "Нове", color: "#888", bg: "#f5f5f5", dot: "#ccc" },
    plan_ready: { label: "План готовий", color: "#5a7a2a", bg: "#eef5e4", dot: "#8ac040" },
    plan_approved: { label: "План затверджено", color: "#1a5a8a", bg: "#e4f0ff", dot: "#4a9ade" },
    writing: { label: "В роботі", color: "#8a5a1a", bg: "#fff5e4", dot: "#d4902a" },
    done: { label: "Готово", color: "#1a6a1a", bg: "#e4ffe4", dot: "#4aba4a" },
};

export default function Dashboard({ onOpen, onNew, onAdmin }) {
    const { user, profile, logout } = useAuth();
    const [orders, setOrders] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [filterStatus, setFilterStatus] = useState(null); // null = всі
    const [infoOrder, setInfoOrder] = useState(null); // модалка деталей

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

    const filtered = useMemo(() => {
        let result = orders;
        // Фільтр по статусу
        if (filterStatus) {
            result = result.filter(o => {
                const s = o.status || "new";
                if (filterStatus === "writing") return s === "writing";
                if (filterStatus === "plan_ready") return s === "plan_ready" || s === "plan_approved";
                if (filterStatus === "done") return s === "done";
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
                o.deadline?.toLowerCase().includes(q)
            );
        }
        return result;
    }, [orders, search, filterStatus]);

    const counts = useMemo(() => {
        const c = { all: orders.length, done: 0, writing: 0, plan_ready: 0, new: 0 };
        orders.forEach(o => {
            const s = o.status || "new";
            if (s === "done") c.done++;
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
                            { label: "В роботі", val: counts.writing, color: "#8a5a1a", bg: "#fff5e4", key: "writing" },
                            { label: "План", val: counts.plan_ready, color: "#1a5a8a", bg: "#e4f0ff", key: "plan_ready" },
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
                            const st = STATUS_LABELS[order.status] || STATUS_LABELS.new;
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
