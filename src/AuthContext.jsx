import { createContext, useContext, useEffect, useState } from "react";
import { auth, db } from "./firebase";
import {
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged,
} from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";

const AuthContext = createContext();

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [profile, setProfile] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const unsub = onAuthStateChanged(auth, async (u) => {
            setUser(u);
            if (u) {
                const ref = doc(db, "users", u.uid);
                const snap = await getDoc(ref);
                if (snap.exists()) {
                    setProfile(snap.data());
                } else {
                    // Документа немає — створюємо автоматично з роллю manager
                    const newProfile = {
                        email: u.email,
                        name: u.email.split("@")[0],
                        role: "manager",
                        approved: true,
                        blocked: false,
                        createdAt: new Date().toISOString(),
                    };
                    try {
                        await setDoc(ref, newProfile);
                        setProfile(newProfile);
                    } catch (e) {
                        console.error("Auto-create profile error:", e);
                        setProfile(null);
                    }
                }
            } else {
                setProfile(null);
            }
            setLoading(false);
        });
        return unsub;
    }, []);

    const login = (email, password) =>
        signInWithEmailAndPassword(auth, email, password);

    const logout = () => signOut(auth);

    return (
        <AuthContext.Provider value={{ user, profile, login, logout, loading }}>
            {!loading && children}
        </AuthContext.Provider>
    );
}

export const useAuth = () => useContext(AuthContext);
