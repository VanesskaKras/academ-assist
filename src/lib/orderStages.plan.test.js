// Смоук-тести runPlanStage без реального API. Перевіряють структурну коректність
// порту (чи не падає кожна гілка дерева рішень), не якість самого плану.
// Запуск: node src/lib/orderStages.plan.test.js
import assert from "node:assert/strict";
import { runPlanStage } from "./orderStages.js";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const baseOrder = {
  info: { type: "Курсова робота", topic: "Тестова тема", subject: "Психологія", course: "3", pages: "30", language: "Українська" },
  methodInfo: null,
  commentAnalysis: null,
  comment: "",
  clientPlan: "",
  clientMaterialsSummary: null,
  clientMaterialsText: "",
  readyWorkText: "",
  content: {},
  citInputs: {},
  illustrations: [],
  illustrationsPdf: null,
};

function failIfCalled(name) {
  return async () => { throw new Error(`${name} не мала викликатись у цій гілці`); };
}

await test("без методички/плану клієнта → дефолтний план через naming-виклик (fallback гарантовано спрацьовує)", async () => {
  const ctx = {
    callClaude: async () => JSON.stringify({ titles: { "1.1": "Назва 1.1", "2.1": "Назва 2.1" } }),
    callGemini: failIfCalled("callGemini"),
    onProgress: () => {},
  };
  const patch = await runPlanStage(baseOrder, ctx);
  assert.ok(Array.isArray(patch.sections) && patch.sections.length > 3, "має повернути непорожній масив sections");
  assert.equal(patch.stage, "plan");
  assert.equal(patch.status, "plan_ready");
  assert.ok(patch.sections.some(s => s.type === "intro"));
  assert.ok(patch.sections.some(s => s.type === "conclusions"));
  assert.ok(patch.sections.some(s => s.type === "sources"));
});

await test("clientPlan заданий → бере структуру з нього, жодного AI-виклику не потрібно", async () => {
  const ctx = {
    callClaude: failIfCalled("callClaude"),
    callGemini: failIfCalled("callGemini"),
    onProgress: () => {},
  };
  const order = {
    ...baseOrder,
    clientPlan: [
      "Розділ 1. Теорія",
      "1.1 Перший підрозділ",
      "1.2 Другий підрозділ",
      "Розділ 2. Аналіз",
      "2.1 Третій підрозділ",
      "2.2 Четвертий підрозділ",
      "Вступ",
      "Висновки",
      "Список використаних джерел",
    ].join("\n"),
  };
  const patch = await runPlanStage(order, ctx);
  assert.ok(Array.isArray(patch.sections) && patch.sections.length > 3);
  assert.equal(patch.status, "plan_ready");
});

await test("methodInfo заданий → генерує план під методичку (методичка-гілка не падає)", async () => {
  const ctx = {
    callClaude: async () => { throw new Error("не мало дійти до naming — methodInfo-гілка мала повернутись раніше"); },
    callGemini: async () => JSON.stringify({
      sections: [
        { id: "1.1", label: "1.1 A", sectionTitle: "РОЗДІЛ 1", pages: 8, type: "theory" },
        { id: "1.2", label: "1.2 B", sectionTitle: "РОЗДІЛ 1", pages: 8, type: "theory" },
        { id: "2.1", label: "2.1 C", sectionTitle: "РОЗДІЛ 2", pages: 8, type: "analysis" },
        { id: "2.2", label: "2.2 D", sectionTitle: "РОЗДІЛ 2", pages: 6, type: "analysis" },
        { id: "intro", label: "Вступ", pages: 2, type: "intro" },
        { id: "conclusions", label: "Висновки", pages: 3, type: "conclusions" },
        { id: "sources", label: "Список використаних джерел", pages: 1, type: "sources" },
      ],
    }),
    onProgress: () => {},
  };
  const order = { ...baseOrder, methodInfo: { chaptersCount: 2, subsectionsPerChapter: 2 } };
  const patch = await runPlanStage(order, ctx);
  assert.ok(Array.isArray(patch.sections) && patch.sections.length > 3);
  assert.equal(patch.status, "plan_ready");
});

console.log(`\n${passed} тестів пройшло`);
if (process.exitCode) console.error("Є ПОМИЛКИ");
