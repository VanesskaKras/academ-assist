// Підключення до Firestore з Node через firebase-admin (сервісний акаунт) —
// на відміну від браузерного src/firebase.js (клієнтський SDK, публічний
// конфіг, права через security rules прив'язані до автентифікованого
// користувача), тут повні права на читання/запис без прив'язки до браузера.
//
// Потрібно перед запуском:
//   1. Firebase Console → Project Settings → Service Accounts → Generate new
//      private key → зберегти JSON-файл десь ЛОКАЛЬНО (не комітити в git!).
//   2. Встановити змінні середовища:
//        GOOGLE_APPLICATION_CREDENTIALS=шлях/до/service-account.json
//        FIREBASE_PROJECT_ID=той самий projectId, що й у src/firebase.js
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function ensureApp() {
  if (getApps().length) return;
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS не задано — потрібен шлях до JSON-ключа сервісного акаунта Firebase " +
      "(Firebase Console → Project Settings → Service Accounts → Generate new private key)."
    );
  }
  initializeApp({
    credential: applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
}

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
