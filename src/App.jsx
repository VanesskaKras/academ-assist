import { useState } from "react";
import { AuthProvider, useAuth } from "./AuthContext";
import LoginPage from "./LoginPage";
import AdminPage from "./AdminPage";
import Dashboard from "./Dashboard";
import AcademAssist from "./academic-assistant";
import SmallWorks from "./small-works";

function AppRouter() {
  const { user, profile } = useAuth();
  const [view, setView] = useState("dashboard");
  const [currentOrderId, setCurrentOrderId] = useState(null);
  const [currentMode, setCurrentMode] = useState("large"); // "large" | "small"

  if (!user) return <LoginPage />;

  if (profile?.blocked) {
    return (
      <div style={{ minHeight: "100vh", background: "#f5f2eb", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Georgia, serif" }}>
        <div style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>🚫</div>
          <div style={{ fontSize: 18, color: "#c00", marginBottom: 8 }}>Доступ заблоковано</div>
          <div style={{ fontSize: 14, color: "#888" }}>Зверніться до адміністратора</div>
        </div>
      </div>
    );
  }

  if (view === "admin" && profile?.role === "admin") {
    return <AdminPage onBack={() => setView("dashboard")} />;
  }

  if (view === "order") {
    if (currentMode === "small") {
      return (
        <SmallWorks
          orderId={currentOrderId}
          onOrderCreated={(id) => setCurrentOrderId(id)}
          onBack={() => { setCurrentOrderId(null); setView("dashboard"); }}
        />
      );
    }
    return (
      <AcademAssist
        orderId={currentOrderId}
        onOrderCreated={(id) => setCurrentOrderId(id)}
        onBack={() => { setCurrentOrderId(null); setView("dashboard"); }}
      />
    );
  }

  return (
    <Dashboard
      onOpen={(id, mode) => { setCurrentOrderId(id); setCurrentMode(mode || "large"); setView("order"); }}
      onNew={(mode) => { setCurrentOrderId(null); setCurrentMode(mode || "large"); setView("order"); }}
      onAdmin={profile?.role === "admin" ? () => setView("admin") : null}
    />
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRouter />
    </AuthProvider>
  );
}
