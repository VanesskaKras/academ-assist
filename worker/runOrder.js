#!/usr/bin/env node
// CLI-скрипт: доводить одне замовлення через генерацію без відкритої вкладки
// браузера, використовуючи ту саму спільну логіку (src/lib/orderStages.js),
// що й academic-assistant.jsx. Продовжує з того місця, де замовлення зараз
// зупинилось (за полем stage у Firestore) — можна перезапускати після збою.
//
// Використання:
//   GOOGLE_APPLICATION_CREDENTIALS=... FIREBASE_PROJECT_ID=... \
//     node worker/runOrder.js <orderId> [--api-base=https://...]
//
// Межі цієї фази (навмисно не автоматизовано):
//   - стадія "sources" (пошук і довставка джерел) — виконується вручну через
//     сайт; скрипт зупиняється й просить довести замовлення до стадії
//     "writing" через звичайний UI;
//   - Додаток А для емпіричних робіт (doGenAppendices) — якщо секція
//     потребує вже готового додатку, а його нема, секція просто генерується
//     без цього контексту (у браузері генерація в такому разі чекає на
//     Додаток А — тут ні). Не критично для тестових замовлень без Додатку А.
import { loadOrder, saveOrderPatch } from "./firestoreAdmin.js";
import { runAnalyzeStage, runPlanStage, runWritingSection, runRemapStage } from "../src/lib/orderStages.js";
import { callClaude, callGemini, setApiBase, createCostTracker, resetGenerationCost } from "../src/lib/api.js";
import { createTokenAccumulator } from "./tokenAccumulator.js";

const orderId = process.argv[2];
const apiBaseArg = process.argv.find(a => a.startsWith("--api-base="));
if (!orderId || orderId.startsWith("--")) {
  console.error("Використання: node worker/runOrder.js <orderId> [--api-base=https://...]");
  process.exit(1);
}
if (apiBaseArg) setApiBase(apiBaseArg.slice("--api-base=".length));
else if (process.env.API_BASE) setApiBase(process.env.API_BASE);

const costTracker = createCostTracker();
const wrappedCallClaude = (messages, signal, systemPrompt, maxTokens, onWait, model, opts) =>
  callClaude(messages, signal, systemPrompt, maxTokens, onWait, model, { ...opts, costTracker });
const wrappedCallGemini = (messages, signal, systemPrompt, maxTokens, onWait, model, jsonMode, opts) =>
  callGemini(messages, signal, systemPrompt, maxTokens, onWait, model, jsonMode, { ...opts, costTracker });
const onProgress = (msg) => console.log(`  ${msg}`);

async function main() {
  let order = await loadOrder(orderId);
  console.log(`Замовлення ${orderId}: stage="${order.stage}", status="${order.status}"`);
  resetGenerationCost();
  const tokenAcc = createTokenAccumulator(order);
  // save() — обгортка над saveOrderPatch, що завжди домішує актуальний
  // знімок вартості/токенів, як і кожен saveToFirestore у браузері.
  const save = async (patch) => {
    order = { ...order, ...patch };
    await saveOrderPatch(orderId, { ...patch, ...tokenAcc.snapshot() });
  };

  if (order.stage === "input" || order.stage === "parsed" || !order.stage) {
    console.log("→ Аналіз вхідних даних...");
    const patch = await runAnalyzeStage(
      { ...order, analyzeProgress: order.analyzeProgress || {} },
      {
        callClaude: wrappedCallClaude, callGemini: wrappedCallGemini, onProgress, onCost: tokenAcc.onCost,
        save: async (p) => { order = { ...order, ...p }; await saveOrderPatch(orderId, { ...p, ...tokenAcc.snapshot() }); },
      }
    );
    await save({ ...patch, stage: "parsed", status: order.status || "new" });
  }

  if (order.stage === "parsed") {
    console.log("→ Генерація плану...");
    const patch = await runPlanStage(order, { callClaude: wrappedCallClaude, callGemini: wrappedCallGemini, onProgress, onCost: tokenAcc.onCost });
    await save(patch);
    console.log(`  План: ${order.sections?.length || 0} пунктів`);
  }

  if (order.stage === "plan" || order.stage === "sources") {
    console.log(`\n⏸ Замовлення на стадії "${order.stage}" — підбір і довставка джерел у цій фазі виконується вручну через сайт.`);
    console.log(`  Довстав джерела через звичайний UI, доведи замовлення до стадії "writing" (кнопка "До написання"), і запусти скрипт знову.`);
    return;
  }

  if (order.stage === "writing") {
    // generationStartedAt — той самий підхід, що й startGen() у браузері: якщо
    // вже виставлено (замовлення почав браузер) — не чіпаємо, лише довіряємось
    // йому для фінального підрахунку generationDurationSec.
    if (!order.generationStartedAt) {
      await save({ generationStartedAt: new Date().toISOString() });
    }
    const sections = order.sections || [];
    let genIdx = order.genIdx || 0;
    console.log(`→ Написання: ${genIdx}/${sections.length} підрозділів уже готово`);
    while (genIdx < sections.length) {
      const sec = sections[genIdx];
      if (order.content?.[sec.id] !== undefined) { genIdx++; continue; }
      if (sec.type === "sources") {
        genIdx++;
        await save({ content: { ...order.content, [sec.id]: "[Додайте джерела на кроці «Джерела»]" }, genIdx });
        continue;
      }
      console.log(`  [${genIdx + 1}/${sections.length}] ${sec.label}`);
      const patch = await runWritingSection(order, sec, { callClaude: wrappedCallClaude, onProgress, onCost: tokenAcc.onCost });
      genIdx++;
      await save({ content: patch.content, citInputs: patch.citInputs, abstractsMap: patch.abstractsMap, sourceThesisMap: patch.sourceThesisMap, glossary: patch.glossary, stage: "writing", status: "writing", genIdx });
      await new Promise(r => setTimeout(r, 2000)); // пауза проти rate limit, як і в браузері
    }

    console.log("→ Усі підрозділи готові. Перерозподіл цитат, список джерел, фінальне оформлення...");
    const remapPatch = await runRemapStage(order, { callClaude: wrappedCallClaude, onCost: tokenAcc.onCost });
    const completedAt = new Date().toISOString();
    const generationDurationSec = order.generationStartedAt
      ? Math.round((Date.now() - new Date(order.generationStartedAt).getTime()) / 1000)
      : undefined;
    await save({ ...remapPatch, ...(remapPatch.stage === "done" ? { completedAt, generationDurationSec } : {}) });
    console.log(`\n✓ Замовлення ${orderId} готове (stage="${order.stage}"). Вартість цієї генерації (лише цей запуск): $${costTracker.value.toFixed(2)}`);
    console.log(`  Сумарна вартість замовлення (усі запуски): $${tokenAcc.snapshot().totalCostUsd.toFixed(2)}${generationDurationSec !== undefined ? `, час: ${generationDurationSec}с` : ""}`);
    return;
  }

  if (order.stage === "done") {
    console.log("Замовлення вже готове (stage=\"done\") — нічого робити не треба.");
    return;
  }

  console.log(`Невідома стадія "${order.stage}" — нічого не зроблено.`);
}

main().catch(e => {
  console.error("\n✗ Помилка:", e.message);
  console.error(e.stack);
  process.exit(1);
});
