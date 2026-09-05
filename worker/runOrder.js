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
//   - "ширший період"/"оновити джерела" для окремого підрозділу — ручні кнопки
//     дороблення в браузері, не частина автоматичного потоку;
//   - профіль підприємства для економічних робіт (doGenEconProfile) — якщо
//     Додаток А економічної роботи мав би спиратись на щойно згенерований
//     профіль, а econProfile в замовленні ще порожній, Додаток А генерується
//     без цього блоку (не критично для тестових замовлень без цього кроку).
import { loadOrder, saveOrderPatch } from "./firestoreAdmin.js";
import {
  runAnalyzeStage, runPlanStage, runSourcesStage, runWritingSection, runRemapStage,
  runAppendicesStage, runFillAppendixDataStage, sectionNeedsAppendix, planAppendixGeneration,
} from "../src/lib/orderStages.js";
import { getEmpiricalSections } from "../src/lib/planUtils.js";
import { APPENDIX_FILL_MARKER } from "../src/lib/textCleanup.js";
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
    // generationStartedAt — той самий підхід і той самий момент, що й
    // startGen() у браузері: виставляється на самому початку sources-фази,
    // до самого пошуку джерел, а не пізніше на "writing".
    if (!order.generationStartedAt) {
      await save({ generationStartedAt: new Date().toISOString() });
    }
    console.log("→ Підбір джерел...");
    const mainSecs = (order.sections || []).filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    // crossSectionSeen — спільний для всіх підрозділів цього запуску, щоб те
    // саме джерело не потрапило в citInputs двох різних підрозділів одразу
    // (той самий підхід, що doGenKeywords використовує в браузері).
    const crossSectionSeen = new Set();
    for (const sec of mainSecs) {
      if ((order.citInputs?.[sec.id] || "").trim()) continue; // вже є джерела — природний чекпойнт, як і авто-вставка в браузері
      console.log(`  [джерела] ${sec.label}`);
      const patch = await runSourcesStage(order, sec, { callGemini: wrappedCallGemini, onCost: tokenAcc.onCost, crossSectionSeen });
      await save({ ...patch, workflowMode: "sources-first", stage: "sources", status: "writing" });
    }
    await save({ stage: "writing", status: "writing" });
  }

  if (order.stage === "writing") {
    // Додаток А: реальний інструмент (методика/тест/експеримент) чи додатки
    // з реальним обґрунтуванням генеруємо ДО тексту — вони не залежать від
    // того, що напише ШІ. Авторську анкету (немає фіксованого джерела істини)
    // відкладаємо до готового тексту — той самий підхід, що й startGen().
    if (!order.appendicesText) {
      const { needsAppendix, deferred } = planAppendixGeneration(order);
      if (needsAppendix && !deferred) {
        console.log("→ Генерую Додаток А (до написання тексту)...");
        const patch = await runAppendicesStage(order, { callClaude: wrappedCallClaude, onCost: tokenAcc.onCost });
        await save(patch);
      }
    }

    const sections = order.sections || [];
    let genIdx = order.genIdx || 0;
    console.log(`→ Написання: ${genIdx}/${sections.length} підрозділів уже готово`);
    const deferredSecIds = [];
    while (genIdx < sections.length) {
      const sec = sections[genIdx];
      if (order.content?.[sec.id] !== undefined) { genIdx++; continue; }
      if (sec.type === "sources") {
        genIdx++;
        await save({ content: { ...order.content, [sec.id]: "[Додайте джерела на кроці «Джерела»]" }, genIdx });
        continue;
      }
      if (!order.appendicesText && sectionNeedsAppendix(sec, order)) {
        // Додаток А ще не готовий (відкладена генерація) — цей підрозділ
        // пропускаємо, повернемось до нього після написання решти й генерації додатку.
        deferredSecIds.push(sec.id);
        genIdx++;
        continue;
      }
      console.log(`  [${genIdx + 1}/${sections.length}] ${sec.label}`);
      const patch = await runWritingSection(order, sec, { callClaude: wrappedCallClaude, onProgress, onCost: tokenAcc.onCost });
      genIdx++;
      await save({ content: patch.content, citInputs: patch.citInputs, abstractsMap: patch.abstractsMap, sourceThesisMap: patch.sourceThesisMap, glossary: patch.glossary, stage: "writing", status: "writing", genIdx });
      await new Promise(r => setTimeout(r, 2000)); // пауза проти rate limit, як і в браузері
    }

    // Відкладена генерація Додатку А — тепер, коли решта тексту готова,
    // додаток узгоджується з реально написаною вибіркою (той самий підхід,
    // що deferred-ефект у браузері) — і дописуємо підрозділи, які на нього чекали.
    if (deferredSecIds.length && !order.appendicesText) {
      console.log("→ Генерую Додаток А (відкладено, узгоджено з готовим текстом)...");
      const empSecsForApp = getEmpiricalSections(order.sections, order.info, order.commentAnalysis, order.methodInfo);
      const empIds = new Set([...(empSecsForApp.chapterSectionIds || []), empSecsForApp.anchorId].filter(Boolean));
      const empText = order.sections.filter(s => empIds.has(s.id)).map(s => order.content[s.id]).filter(Boolean).join("\n\n");
      const finishedBodyText = empText || order.sections.filter(s => s.type !== "sources").map(s => order.content[s.id]).filter(Boolean).join("\n\n");
      const appPatch = await runAppendicesStage(order, { callClaude: wrappedCallClaude, onCost: tokenAcc.onCost }, { finishedBodyTextOverride: finishedBodyText });
      await save(appPatch);

      for (const secId of deferredSecIds) {
        const sec = order.sections.find(s => s.id === secId);
        if (!sec || order.content?.[sec.id] !== undefined) continue;
        console.log(`  [відкладений] ${sec.label}`);
        const patch = await runWritingSection(order, sec, { callClaude: wrappedCallClaude, onProgress, onCost: tokenAcc.onCost });
        await save({ content: patch.content, citInputs: patch.citInputs, abstractsMap: patch.abstractsMap, sourceThesisMap: patch.sourceThesisMap, glossary: patch.glossary });
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // Автозаповнення полів Додатку А, позначених маркером (напр. "Фактичний
    // результат"/"Статус" для ІТ-протоколу тестування) — тепер, коли основний
    // текст точно готовий, так само як в браузері.
    if (order.appendicesText?.includes(APPENDIX_FILL_MARKER)) {
      console.log("→ Автозаповнення полів Додатку А...");
      const fillPatch = await runFillAppendixDataStage(order, { callClaude: wrappedCallClaude, onCost: tokenAcc.onCost });
      if (fillPatch.appendicesText) await save(fillPatch);
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
