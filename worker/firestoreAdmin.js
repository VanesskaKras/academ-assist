// Підключення до Firestore з Node через firebase-admin (сервісний акаунт) —
// на відміну від браузерного src/firebase.js (клієнтський SDK, публічний
// конфіг, права через security rules прив'язані до автентифікованого
// користувача), тут повні права на читання/запис без прив'язки до браузера.
// Налаштування (GOOGLE_APPLICATION_CREDENTIALS тощо) — див. firebaseApp.js.
import { getFirestore } from "firebase-admin/firestore";
import { ensureApp } from "./firebaseApp.js";

function ordersCollection() {
  ensureApp();
  return getFirestore().collection("orders");
}

export async function loadOrder(orderId) {
  const snap = await ordersCollection().doc(orderId).get();
  if (!snap.exists) throw new Error(`Замовлення "${orderId}" не знайдено в Firestore (колекція orders)`);
  return { id: snap.id, ...snap.data() };
}

// merge:true, як і саме saveToFirestore в academic-assistant.jsx; Firestore
// (як admin, так і клієнтський SDK) не приймає значення undefined в полях —
// відфільтровуємо їх, щоб патчі з orderStages.js (де частина полів
// умовно undefined) не падали з помилкою запису.
export async function saveOrderPatch(orderId, patch) {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  await ordersCollection().doc(orderId).set({ ...clean, updatedAt: new Date().toISOString() }, { merge: true });
}
