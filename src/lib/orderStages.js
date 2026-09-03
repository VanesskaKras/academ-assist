// Спільна, не прив'язана до React орхестраційна логіка генерації однієї роботи —
// використовується і браузером (academic-assistant.jsx викликає ці самі функції
// замість дублювання логіки), і серверним воркером (worker/runOrder.js), щоб
// генерація могла йти без відкритої вкладки. Кожна функція — "чиста": приймає
// плоский об'єкт стану замовлення (та ж форма, що й документ у Firestore) і
// повертає патч полів для збереження; жодних setState/window/alert усередині.

import {
  buildSYS, SYS_JSON, SYS_JSON_SHORT, SYS_JSON_ARRAY, buildContinuationPlanPrompt, buildIllustrationsPrompt, buildIllustrationsPdfPrompt,
  buildTemplateAnalysisPrompt, STRUCTURE_READING_PROMPT, buildMethodologyReadingPrompt, buildExampleWorkReadingPrompt, buildCommentAnalysisPrompt, buildDrawingsDescriptionPrompt,
  buildAnnotationPrompt,
} from "./prompts.js";
import { MODEL, MODEL_FAST } from "./api.js";
import { enforceWordCount, enforceTotalVolume, stripEmDash } from "./wordCount.js";
import { insertMissingCitations, capCitationRepeats, buildFinalReferenceList, buildCiteFormats, createReferenceDeduper, applyCitationRemap } from "./citationFormatting.js";
import { fixDanglingFigures } from "./figureFixup.js";
import { deriveDegreeLevelFromType } from "./titlePageTokens.js";
import { fixMixedScript, typographQuotes, getIntroTasksProfile, INTRO_TASKS_MERGE_SPLIT_RULE, CODE_GROUNDING_RULE } from "./textCleanup.js";
import {
  getEmpiricalSections, getEconSections, getTechnicalSections, parsePagesAvg, hasRealFigure, extractOpeningSentences, getLangLabels,
  buildWorkConfig, calcSourceDist, buildPlanText, parseClientPlan, parseTemplate, detectRequestedChapterCount, isPsychoPed,
  deriveStructureFromExampleTOC, mergeExampleWorkIntoMethodInfo, mergeIntroComponents,
} from "./planUtils.js";
import { getAcademicDefaults, normalizeWorkType } from "./academicDefaults.js";
import { searchByPhrase, filterSourcesWithGemini, paperToCitation, enrichSources } from "./sourcesSearch.js";
import { extractReadyWorkStructure, quickParsePlanIds } from "./readyWorkExtract.js";

// ── Підбір ілюстрацій клієнта для розділу (перенесено з academic-assistant.jsx
// без змін логіки — раніше читала component state напряму, тепер приймає його як аргументи) ──
function getIllustrationsForSection(sec, illustrationDescs, illustrations) {
  if (!illustrationDescs?.length) return [];
  if (illustrations?.length > 0) {
    return illustrations.map((ill, i) => {
      const desc = illustrationDescs.find(d => d.figureNum === i + 1) || illustrationDescs[i];
      if (!desc) return null;
      const target = ill.targetSection?.trim();
      if (target) {
        const t = target.toLowerCase().replace(/^розділ\s+/i, "").trim();
        if (sec.id?.toLowerCase() === t || sec.id?.toLowerCase().startsWith(t + ".") || sec.label?.toLowerCase().includes(t)) {
          return { ...desc, caption: ill.caption, index: i };
        }
        return null;
      }
      const suggested = desc.suggestedSection?.trim();
      if (suggested && (sec.id === suggested || sec.id?.startsWith(suggested + ".") || suggested?.startsWith(sec.id))) {
        return { ...desc, caption: ill.caption, index: i };
      }
      return null;
    }).filter(Boolean);
  }
  // PDF-режим: ілюстрації визначені тільки через illustrationDescs
  return illustrationDescs.filter(desc => {
    const suggested = desc.suggestedSection?.trim();
    return suggested && (sec.id === suggested || sec.id?.startsWith(suggested + ".") || suggested?.startsWith(sec.id));
  });
}

// ── Пошук заміни джерела, яке після довставки цитати не підтвердило жодного
// речення (unresolved) — та сама логіка, що й retryUnmatchedSource у
// academic-assistant.jsx, лише без прив'язки до component state ──
async function retryUnmatchedSource({ order, secId, sectionText, marker, thesis, lang, signal, ctx }) {
  if (!thesis) return null;
  try {
    const info = order.info;
    const topicCtx = [info?.topic, info?.direction, info?.subject].filter(Boolean).join(' ');
    const filterLabel = (order.sections.find(s => s.id === secId)?.label || '')
      .replace(/^РОЗДІЛ\s+[IVXivxІVХ\d]+[.\s:]+/i, '').trim();
    const existingTitles = new Set(
      Object.values(order.citStructured || {}).flat().map(p => (p.title || '').toLowerCase().slice(0, 60))
    );
    const candidates = await searchByPhrase(thesis, 15, 1, true, 0, '');
    const fresh = candidates.filter(p => {
      const key = (p.title || '').toLowerCase().slice(0, 60);
      return key && !existingTitles.has(key);
    });
    if (!fresh.length || signal?.aborted) return null;
    const filteredRaw = await filterSourcesWithGemini(fresh.slice(0, 25), filterLabel, topicCtx, 3, thesis, ctx.onCost);
    const filtered = await enrichSources(filteredRaw);
    const best = [...filtered]
      .filter(p => p._complete !== false)
      .sort((a, b) => (b.geminiScore ?? 0) - (a.geminiScore ?? 0))[0];
    if (!best || (best.geminiScore ?? 0) < 70 || signal?.aborted) return null;

    const newLine = paperToCitation(best);
    if (!newLine) return null;
    const { text, unresolved } = await insertMissingCitations({
      sectionText, insertions: [{ number: 1, marker, sourceText: newLine, abstract: best.abstract, thesis }],
      lang, callClaude: ctx.callClaude, signal,
    });
    if (unresolved.length) return null; // заміна теж не підтвердила жодного речення
    return { text, newLine, paper: best };
  } catch (e) {
    console.error('retryUnmatchedSource error:', e.message);
    return null;
  }
}

/**
 * Генерує ОДИН підрозділ (`sec`) роботи. Не знає про genIdx/цикл/паузи між
 * підрозділами й не зберігає нічого сама — виклик, збереження результату і
 * просування genIdx лишаються за викликачем (браузерний useEffect-цикл або
 * воркер), так само як і зараз.
 *
 * @param {object} order - плоский стан замовлення (та ж форма, що документ Firestore):
 *   info, sections, content, citInputs, citStructured, abstractsMap, sourceThesisMap,
 *   commentAnalysis, methodInfo, appendicesText, clientMaterialsSummary,
 *   clientMaterialsText, econProfile, glossary, illustrationDescs, illustrations
 * @param {object} sec - підрозділ зі order.sections, який генеруємо
 * @param {object} ctx - { callClaude, signal?, onProgress?(msg), onCost? }
 *   callClaude тут — ВЖЕ прив'язана до costTracker/onCost версія (див. api.js
 *   createCostTracker) — orderStages.js сам не керує лічильником вартості.
 * @returns {Promise<{content, citInputs, abstractsMap, sourceThesisMap, glossary}>}
 *   патч полів, які викликач має злити в order і зберегти (у Firestore чи де завгодно).
 */
export async function runWritingSection(order, sec, ctx) {
  const { callClaude: doCallClaude, signal, onProgress } = ctx;
  const d = order.info;
  const lang = d?.language || "Українська";
  const sections = order.sections;
  const content = order.content || {};
  const citInputs = order.citInputs || {};
  const abstractsMap = order.abstractsMap || {};
  const sourceThesisMap = order.sourceThesisMap || {};
  const commentAnalysis = order.commentAnalysis;
  const methodInfo = order.methodInfo;
  const appendicesText = order.appendicesText;
  const clientMaterialsSummary = order.clientMaterialsSummary;
  const clientMaterialsText = order.clientMaterialsText;
  const econProfile = order.econProfile;
  const glossary = order.glossary || {};

  onProgress?.("Генерую: " + sec.label + "...");

  // Будуємо повний multi-turn контекст як у Claude.ai
  const buildMessages = (instruction) => {
    const prevEntries = Object.entries(content).filter(([k]) => k !== sec.id);
    if (!prevEntries.length) return [{ role: "user", content: instruction }];
    const isLargeWork = totalPages > 50;
    const currentChapter = sec.id.split(".")[0];
    const empSecsForConclusions = sec.type === "conclusions"
      ? getEmpiricalSections(sections, d, commentAnalysis, methodInfo)
      : null;
    const empSecsForIntro = sec.type === "intro"
      ? getEmpiricalSections(sections, d, commentAnalysis, methodInfo)
      : null;
    const contextText = prevEntries.map(([k, v]) => {
      const s = sections.find(x => x.id === k);
      const label = s?.label || k;
      if (!isLargeWork) return `=== ${label} ===\n${v}`;
      const sameChapter = k.split(".")[0] === currentChapter;
      const isIntroForConclusions = sec.type === "conclusions" && s?.type === "intro";
      const isEmpiricalForConclusions = sec.type === "conclusions" && empSecsForConclusions &&
        (empSecsForConclusions.chapterSectionIds.includes(k) || k === empSecsForConclusions.anchorId);
      const isEmpiricalForIntro = sec.type === "intro" && empSecsForIntro &&
        (empSecsForIntro.chapterSectionIds.includes(k) || k === empSecsForIntro.anchorId);
      if (sameChapter || isIntroForConclusions || isEmpiricalForConclusions || isEmpiricalForIntro) return `=== ${label} ===\n${v}`;
      const firstPara = v.split("\n").find(p => p.trim().length > 60) || v.slice(0, 400);
      return `=== ${label} [перший абзац] ===\n${firstPara}`;
    }).join("\n\n---\n\n");
    const glossaryBlock = sec.type === "conclusions"
      ? Object.entries(glossary)
        .map(([k, terms]) => {
          if (!terms) return null;
          const s = sections.find(x => x.id === k);
          return `${s?.label || k}: ${terms}`;
        })
        .filter(Boolean)
        .join("\n")
      : "";
    const fullContextText = glossaryBlock
      ? `${contextText}\n\n---\n\n=== Глосарій ключових авторських термінів і назв методик за розділами ===\n${glossaryBlock}`
      : contextText;
    return [
      { role: "user", content: "Ось вже написані частини цієї роботи:" },
      { role: "assistant", content: fullContextText },
      { role: "user", content: instruction },
    ];
  };
  const planSummary = sections
    .filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type))
    .map(s => s.label)
    .join("\n");
  const typeHints = {
    theory: "теоретичний — визначення понять, аналіз літератури, огляд наукових підходів",
    analysis: "аналітично-практичний — аналіз даних, виявлення закономірностей, порівняння",
    recommendations: "рекомендаційний — практичні пропозиції, шляхи вирішення, прогнози",
  };
  let instruction = "";
  const totalPages = parsePagesAvg(d?.pages);
  const isLarge = totalPages > 40;

  if (sec.type === "intro") {
    const mainSecs = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const tasksProfile = getIntroTasksProfile(d.type, d.course, mainSecs.length, isLarge);
    const tasksCount = tasksProfile.count;

    const lc = getLangLabels(lang);
    const il = lc.introLabels || {};
    const defaultComponents = lc.defaultIntroComponents || ["актуальність теми", "мета дослідження", "завдання дослідження", "об'єкт дослідження", "предмет дослідження", "методи дослідження", "практичне значення дослідження", "структура роботи"];
    const allComponents = mergeIntroComponents(defaultComponents, methodInfo?.introComponents);
    const structureRe = /структура|structure|struktura|štruktúra|aufbau/i;
    const structureIdx = allComponents.findIndex(c => structureRe.test(c));
    if (structureIdx !== -1 && structureIdx !== allComponents.length - 1) {
      allComponents.push(allComponents.splice(structureIdx, 1)[0]);
    }

    const componentLines = allComponents.map((comp) => {
      const label = comp.charAt(0).toUpperCase() + comp.slice(1);
      if (/актуальн|actuality|aktual|relevance|relevanz|pertine/i.test(comp)) {
        const phrase = il.actuality || "Актуальність теми.";
        return `${label}: one paragraph starting with "${phrase}" — immediately introduce why the topic is relevant today. Do not split into multiple paragraphs.`;
      }
      if (/теоретико|теоретичн.*основ|методологічн.*основ|podstawy.*teoret|theoretical.*basis/i.test(comp)) {
        const phrase = il.theoryBasis || "Теоретико-методологічну основу дослідження становлять";
        return `${label}: one paragraph starting with "${phrase}" — list scholarly works, authors, regulatory sources relevant to the topic.`;
      }
      if ((/мета|goal|cel|ziel|objetivo|purpose|účel|cieľ/i.test(comp)) && !/завдання|tasks|zadania|aufgaben|úkoly|úlohy/i.test(comp)) {
        const phrase = il.goal || "Мета дослідження –";
        return `${label}: write in format "${phrase} [clearly formulated goal for topic "${d.topic}"]".`;
      }
      if (/завдання|tasks|zadania|aufgaben|tareas|úkoly|úlohy/i.test(comp)) {
        const phrase = il.tasks || "Завдання дослідження:";
        const natureLine = tasksProfile.nature ? ` Завдання мають бути ${tasksProfile.nature}.` : "";
        return `${label}: write in format "${phrase}" — then exactly ${tasksCount} numbered tasks.${natureLine} ${INTRO_TASKS_MERGE_SPLIT_RULE}\nСтруктура плану роботи (змістова основа для завдань):\n${mainSecs.map((s, j) => `   ${j + 1}) "${s.label}"`).join("\n")}`;
      }
      if (/об.єкт|przedmiot|gegenstand|objeto/i.test(comp) && !/предмет|subject|obiekt/i.test(comp)) {
        const phrase = il.object || "Об'єкт дослідження –";
        return `${label}: write in format "${phrase} [phenomenon or process being studied]".`;
      }
      if (/предмет|subject|obiekt/i.test(comp)) {
        const phrase = il.subject || "Предмет дослідження –";
        return `${label}: write in format "${phrase} [specific aspect of the object being analyzed]".`;
      }
      if (/метод|method/i.test(comp) && !/теоретико|методологічн.*основ|podstawy/i.test(comp)) {
        const phrase = il.methods || "Методи дослідження:";
        return `${label}: write in format "${phrase} [list of methods, comma-separated]".`;
      }
      if (/новизн|novelty|nowość|neuheit|novedad/i.test(comp)) {
        const phrase = il.novelty || "Наукова новизна дослідження –";
        return `${label}: write in format "${phrase} [new positions or solutions proposed by the author]".`;
      }
      if (/практичн|practical|praktyczn|praktisch|přínos|prínos/i.test(comp)) {
        const phrase = il.practical || "Практична значущість:";
        return `${label}: write in format "${phrase} [how results can be applied in practice]".`;
      }
      if (/апробац|approbation|aprobata/i.test(comp)) {
        const phrase = il.approbation || "Апробація результатів дослідження –";
        return `${label}: write in format "${phrase} [conferences, publications, seminars where results were presented]".`;
      }
      if (structureRe.test(comp)) {
        const phrase = il.structure || "Структура роботи:";
        const chapCount = new Set(mainSecs.map(s => s.id.split(".")[0])).size || mainSecs.length;
        return `${label}: write EXACTLY one sentence following this template (translate it into the language of the work, keep the same structure), with NOTHING else added — no chapter-by-chapter description: "${phrase} the work consists of an introduction, ${chapCount} chapters, conclusions, and a list of sources. The total volume of the work is __TOTAL_PAGES__ pages." Keep the literal token __TOTAL_PAGES__ unchanged exactly as written (no digits) — it will be replaced automatically with the real page count once the whole work is generated.`;
      }
      return `${label}: write in format "${label} – [content relevant to topic "${d.topic}"]".`;
    });

    instruction = `Напиши ВСТУП для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.

INTRO STRUCTURE (follow strictly, each element as a new paragraph):

${componentLines.map((l, i) => `${i + 1}. ${l}`).join("\n\n")}
${methodInfo?.otherRequirements ? `\nМЕТОДИЧКА ВИМОГИ: ${methodInfo.otherRequirements}` : ""}${commentAnalysis?.textStructureHints ? `\nКЛІЄНТ ВИМОГИ (ОБОВ'ЯЗКОВО): ${commentAnalysis.textStructureHints}` : ""}

IMPORTANT: use already written sections (in context) for exact formulation of methods, sample, object — everything must match the text. Follow each element's format strictly. No citations. No bold or italic. Write in continuous paragraphs. EXCEPTION: research tasks — write as numbered list (1. 2. 3. ...), each task on a new line.

КРИТИЧНО ВАЖЛИВО (об'єкт, предмет, мета, завдання): якщо в тексті вище (розділ з анкетуванням/емпіричним дослідженням) вже вказано РЕАЛЬНИХ respondents дослідження (напр. вчителі, батьки, фахівці) — об'єкт, предмет, мета і завдання ОБОВ'ЯЗКОВО мають описувати ефект/результат САМЕ щодо цієї реальної вибірки, а не абстрактної групи з теми (напр. учнів), яку дослідження фактично не вимірювало. Якщо тема стосується учнів, а опитані — вчителі, сформулюй мету про вплив на педагогічну практику/готовність вчителів (за потреби — з поясненням, що це опосередкований шлях впливу на учнів), а НЕ про безпосередній ефект на учнях. Розрив між заявленою метою та реально дослідженою вибіркою — груба методологічна помилка, яку одразу помітить рецензент.`;

  } else if (sec.type === "conclusions") {
    const conclReq = methodInfo?.conclusionsRequirements || "";
    const mainSecsForConcl = sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
    const conclTasksProfile = getIntroTasksProfile(d.type, d.course, mainSecsForConcl.length, isLarge);

    instruction = `Напиши ВИСНОВКИ для ${d.type} на тему "${d.topic}".
${conclReq ? `ВИМОГИ МЕТОДИЧКИ: ${conclReq}\n` : ""}${commentAnalysis?.textStructureHints ? `ВИМОГИ КЛІЄНТА ДО СТРУКТУРИ (ОБОВ'ЯЗКОВО): ${commentAnalysis.textStructureHints}\n` : ""}
ПРАВИЛА:
- Обсяг: приблизно ${(sec.pages || 2) * 230} слів (~${sec.pages} стор.).
- Перший абзац — загальний підсумок мети і що вдалось досягти
- Далі — рівно ${conclTasksProfile.count} абзаців, по одному на кожне завдання дослідження, сформульоване у вступі (текст вступу є в контексті) — у тому самому порядку. Якщо завдання у вступі поєднувало кілька підрозділів плану — зведи їхні конкретні результати в одному абзаці; якщо завдання було розбите з одного підрозділу — розподіли результати на відповідну кількість абзаців
- Кожен такий абзац = конкретний результат, що відповідає своєму завданню
- Останній абзац — перспективи подальших досліджень
- НЕ повторювати те що сказано у вступі, НЕ вводити нову інформацію
- Абзаци-результати мають мати різний ритм і різні відкривачі речень: не починай кожен з підсумкової конструкції на кшталт "Аналіз... засвідчив, що...", чергуй з прямим твердженням, конкретним фактом чи розгортанням попередньої думки. Висновки загалом мають звучати іншим голосом, ніж вступ, а не повторювати його ритм у зворотному порядку.
- Без посилань. Без жирного. Без нумерації. Пиши суцільними абзацами, не використовуй жодних списків.

Спирайся на весь написаний текст роботи, включно з формулюваннями завдань у вступі (є в контексті) — формулюй конкретні висновки на основі реального змісту підрозділів.`;

  } else if (sec.type === "chapter_conclusion") {
    const chapNum = sec.chapterNum || sec.id.split(".")[0];
    instruction = `Напиши "Висновки до розділу ${chapNum}" для ${d.type} на тему "${d.topic}".
${methodInfo?.chapterConclusionRequirements ? `ВИМОГИ МЕТОДИЧКИ: ${methodInfo.chapterConclusionRequirements}` : ""}
Обсяг: 120–150 слів (не більше).
Без нової інформації. Без посилань. Без жирного. Без нумерації. Пиши суцільними абзацами.
Спирайся на повний текст підрозділів розділу ${chapNum} (є в контексті).`;
  } else {
    const methodReqMap = {
      theory: methodInfo?.theoryRequirements,
      analysis: methodInfo?.analysisRequirements,
      recommendations: methodInfo?.analysisRequirements,
    };
    const methodReq = methodReqMap[sec.type] || methodInfo?.otherRequirements || "";

    const empSecs = getEmpiricalSections(sections, d, commentAnalysis, methodInfo);
    const isEmpChapter = empSecs.chapterSectionIds.includes(sec.id);
    const isEmpAnchor = empSecs.anchorId === sec.id;
    let empiricalBlock = "";

    const econSecIds = getEconSections(sections, d);
    const isEconSec = econSecIds.includes(sec.id);
    let econBlock = "";
    if (isEconSec) {
      const secFormulas = (methodInfo?.requiredFormulas || []).filter(f => !f.section || f.section === sec.type);
      const secTables = (methodInfo?.requiredTables || []).filter(t => !t.section || t.section === sec.type);
      const formulasBlock = secFormulas.length
        ? `\nОБОВ'ЯЗКОВІ ФОРМУЛИ З МЕТОДИЧКИ (підстав реалістичні числові значення та підрахуй результат):\n${secFormulas.map(f =>
          `- ${f.name}: ${f.formula}\n  Змінні: ${f.variables}${f.interpretation ? `\n  Інтерпретація: ${f.interpretation}` : ""}`
        ).join("\n")}`
        : "";
      const tablesBlock = secTables.length
        ? `\nОБОВ'ЯЗКОВІ ТАБЛИЦІ З МЕТОДИЧКИ (відтвори структуру, заповни реалістичними даними під тему "${d.topic}"):\n${secTables.map(t =>
          `- ${t.name}\n  Структура: ${t.structure}\n  Що заповнювати: ${t.instructions}`
        ).join("\n")}`
        : "";
      const genericEcon = !secFormulas.length && !secTables.length
        ? `\nОБОВ'ЯЗКОВО для цього підрозділу (економічна/управлінська робота):
- Додай мінімум одну таблицю markdown (|---|---| формат) з конкретними числовими даними (показники за 2-3 роки або порівняння з нормою/конкурентами)
- Після таблиці — аналіз динаміки або відхилень, конкретні висновки з цифрами
- Якщо підрозділ рекомендаційний: додай таблицю прогнозних або планових показників після впровадження рекомендацій`
        : "";
      const profileBlock = econProfile
        ? `\nФІКСОВАНІ БАЗОВІ ДАНІ ПІДПРИЄМСТВА (використовуй САМЕ ЦІ дані в усіх розрахунках і таблицях цього підрозділу, не вигадуй іншу назву/рік/цифри):\n${econProfile}\n`
        : "";
      econBlock = `${profileBlock}${formulasBlock}${tablesBlock}${genericEcon}`;
    }

    const technicalSecIds = getTechnicalSections(sections, d);
    const isTechnicalSec = technicalSecIds.includes(sec.id);
    let technicalBlock = "";
    if (isTechnicalSec) {
      const secFormulasT = (methodInfo?.requiredFormulas || []).filter(f => !f.section || f.section === sec.type);
      const secTablesT = (methodInfo?.requiredTables || []).filter(t => !t.section || t.section === sec.type);
      const formulasBlockT = secFormulasT.length
        ? `\nОБОВ'ЯЗКОВІ ФОРМУЛИ З МЕТОДИЧКИ (підстав реалістичні числові значення та підрахуй результат):\n${secFormulasT.map(f =>
          `- ${f.name}: ${f.formula}\n  Змінні: ${f.variables}${f.interpretation ? `\n  Інтерпретація: ${f.interpretation}` : ""}`
        ).join("\n")}`
        : "";
      const tablesBlockT = secTablesT.length
        ? `\nОБОВ'ЯЗКОВІ ТАБЛИЦІ З МЕТОДИЧКИ (відтвори структуру, заповни реалістичними даними під тему "${d.topic}"):\n${secTablesT.map(t =>
          `- ${t.name}\n  Структура: ${t.structure}\n  Що заповнювати: ${t.instructions}`
        ).join("\n")}`
        : "";
      const genericTechnical = !secFormulasT.length && !secTablesT.length
        ? `\nОБОВ'ЯЗКОВО для цього підрозділу (технічна/інженерна робота):
- Наведи конкретний інженерний/технічний розрахунок з формулою і підстановкою реалістичних числових значень
- Результати розрахунків зведи в таблицю markdown (|---|---| формат)`
        : "";
      const hasClientMaterials = !!(clientMaterialsSummary?.rawText || clientMaterialsText?.trim());
      const codeSnippetBlock = hasClientMaterials
        ? `\nЯКЩО серед МАТЕРІАЛІВ КЛІЄНТА є реальний вихідний код — цей підрозділ ОБОВ'ЯЗКОВО пиши на основі цього коду: опиши реальну структуру програми (модулі/класи/функції), послідовність роботи алгоритму та ключову логіку, посилаючись на фактичні назви функцій/класів/змінних із наданого коду. ${CODE_GROUNDING_RULE} Додатково наведи в тексті ОДИН короткий фрагмент (5-15 рядків) цього коду як ілюстрацію, оформлений у потрійних зворотних лапках (\`\`\`), точно як у наданому коді (не вигадуй новий код, не спотворюй). Якщо коду серед матеріалів немає — пропусти цю вимогу.`
        : "";
      technicalBlock = `${formulasBlockT}${tablesBlockT}${genericTechnical}${codeSnippetBlock}`;
    }

    const appendixBlock = appendicesText
      ? `\nДОДАТОК А (вже згенерований — спирайся на нього точно):\n${appendicesText}\nПРАВИЛО ПОГОДЖЕННЯ ПОКАЗНИКІВ: якщо в тексті підрозділу наводиш відсоток чи цифру, пов'язану з даними з таблиці додатку, — або (а) вживай те саме число й те саме формулювання показника, що вже є в таблиці додатку, або (б) якщо це справді інший, ширший/агрегований показник (напр. частка тих, хто відповів "так" на будь-яке з кількох питань, — на відміну від частки конкретної відповіді на одне питання анкети) — прямо поясни в тексті, з яких показників таблиці він виводиться і чому число відрізняється. Не залишай поруч два близькі за формулюванням, але різні за суттю числа без явного пояснення зв'язку між ними.\n`
      : "";

    const rd = commentAnalysis?.researchDesign ?? (commentAnalysis?.empiricalHints ? { instrumentType: "questionnaire", groups: [], comparisonRequired: false, biographicalFields: [], statisticalMinN: null } : null);
    const methodInfoHasEmpirical = !!(methodInfo && /анкет|опитуванн|емпіричн|респондент|вибірк|тест|експеримент|методик/i.test(
      [methodInfo.analysisRequirements, methodInfo.otherRequirements, methodInfo.theoryRequirements].filter(Boolean).join(" ")
    ));
    const hasEmpirical = !!(rd || methodInfoHasEmpirical);
    const practicalApproachEarly = commentAnalysis?.practicalApproach;
    const suppressEmpiricalBlock = !!(practicalApproachEarly && practicalApproachEarly !== "questionnaire");

    const secAcadDefaults = (!rd && !methodInfoHasEmpirical && !practicalApproachEarly && ["analysis", "recommendations"].includes(sec.type))
      ? getAcademicDefaults(d.subject, d.type, d.course, d.topic)
      : null;
    const secMethodsHint = secAcadDefaults?.methods?.length
      ? `\nМЕТОДИ ДОСЛІДЖЕННЯ (за типом роботи): ${secAcadDefaults.researchType}. Використовувані методи: ${secAcadDefaults.methods.join(", ")}.${secAcadDefaults.notes ? ` Примітка: ${secAcadDefaults.notes}.` : ""}`
      : "";

    const buildEmpHint = (rd, legacyHint) => {
      if (!rd) return legacyHint || "";
      const parts = [];
      if (rd.groups?.length) parts.push(`Групи: ${rd.groups.map(g => `${g.name}${g.minN ? ` (n≥${g.minN})` : ""}${g.criteria ? `, ${g.criteria}` : ""}`).join("; ")}.`);
      if (rd.biographicalFields?.length) parts.push(`Біографічний блок: ${rd.biographicalFields.join(", ")}.`);
      if (rd.statisticalMinN) parts.push(`Мін. вибірка: ${rd.statisticalMinN} осіб.`);
      if (rd.comparisonRequired) parts.push("Порівняння між групами обов'язкове.");
      return parts.join(" ") || legacyHint || "";
    };
    const empHint = buildEmpHint(rd, commentAnalysis?.empiricalHints || (methodInfo?.otherRequirements && /учасник|респондент|вибірк|осіб/i.test(methodInfo.otherRequirements) ? methodInfo.otherRequirements : "20-30 респондентів"));

    const hasMultipleGroups = (rd?.groups?.length || 0) > 1;
    const comparisonRequired = rd?.comparisonRequired || hasMultipleGroups;
    const bioDesc = rd?.biographicalFields?.length ? rd.biographicalFields.join(", ") : "ПІБ, вік, стаж, кваліфікація";
    const tableDataSource = appendicesText ? "по запитаннях з Додатку А" : "з репрезентативними відсотковими показниками за темою дослідження";
    const appendixRef = appendicesText ? '\nДодай речення: "Анкета наведена у Додатку А."' : "";
    const compTableInstruction = comparisonRequired ? `\nПорівняльна таблиця: ОБОВ'ЯЗКОВО окрема таблиця markdown що порівнює ключові показники між групами.` : "";

    if (isEmpChapter && !suppressEmpiricalBlock) {
      empiricalBlock = `

КОНТЕКСТ (емпіричне дослідження):
${appendixBlock}${empHint ? `ВИМОГА: ${empHint}\n` : ""}Цей підрозділ є частиною емпіричного дослідження. Визнач за назвою підрозділу що саме писати:
- якщо підрозділ про організацію або методику дослідження: опиши вибірку (групи, кількість, критерії відбору), біографічний блок анкети (${bioDesc}), метод та принцип проведення.${appendixRef}
- якщо підрозділ про аналіз або результати: таблиця markdown ${tableDataSource}, аналіз даних.${compTableInstruction}
- якщо підрозділ про рекомендації: спирайся на результати з попередніх підрозділів, не повторюй опис вибірки.`;
    } else if (isEmpAnchor && !suppressEmpiricalBlock) {
      empiricalBlock = `

ОБОВ'ЯЗКОВО для цього підрозділу (емпіричне дослідження):
${appendixBlock}${empHint ? `ВИМОГА: ${empHint}\n` : ""}1. Вибірка: ${rd?.groups?.length ? rd.groups.map(g => `${g.name}${g.minN ? ` — мін. ${g.minN} осіб` : ""}${g.criteria ? ` (${g.criteria})` : ""}`).join("; ") : "25-30 осіб (вік, категорія, умови відбору)"}.
2. Біографічний блок анкети: ${bioDesc}.
3. Метод: ${rd?.instrumentType === "fitness_test" ? "фізичне тестування" : rd?.instrumentType === "psycho_scale" ? "психологічна методика/шкала" : rd?.instrumentType === "pedagogical_experiment" ? "педагогічний експеримент" : "анкетування"}. Мета, кількість запитань${appendicesText ? " — точно як в Додатку А" : " — відповідно до теми"}.
4. Принцип проведення: умови та порядок.
5. Результати: таблиця markdown (|---|---| формат) ${tableDataSource}.${compTableInstruction}
6. Аналіз: інтерпретація результатів.${appendixRef}`;
    } else if (hasEmpirical && ["analysis", "recommendations"].includes(sec.type) && !suppressEmpiricalBlock) {
      const practicalSecs = sections.filter(s => ["analysis", "recommendations"].includes(s.type));
      const secIdx = practicalSecs.findIndex(s => s.id === sec.id);
      if (secIdx === 0) {
        empiricalBlock = `

ОБОВ'ЯЗКОВО для цього підрозділу (емпіричне дослідження):
${appendixBlock}${empHint ? `ВИМОГА: ${empHint}\n` : ""}1. Організація дослідження: ${rd?.groups?.length ? `вибірка по групах: ${rd.groups.map(g => `${g.name}${g.minN ? ` (n≥${g.minN})` : ""}${g.criteria ? `, ${g.criteria}` : ""}`).join("; ")}` : "вибірка — кількість, категорії, критерії відбору"}.
2. Біографічний блок анкети: ${bioDesc}.
3. Метод: ${rd?.instrumentType === "fitness_test" ? "фізичне тестування" : rd?.instrumentType === "psycho_scale" ? "психологічна методика/шкала" : rd?.instrumentType === "pedagogical_experiment" ? "педагогічний експеримент" : "анкетування"}. ${appendicesText ? "Мета та кількість запитань — точно як в Додатку А." : "Опиши мету та орієнтовну кількість питань."}
4. Принцип проведення: умови та порядок, якщо кілька груп — опиши кожну окремо.
5. Результати: таблиця markdown (|---|---| формат) ${tableDataSource}.${compTableInstruction}
6. Аналіз: інтерпретація результатів.${appendixRef}`;
      } else if (secIdx < practicalSecs.length - 1) {
        empiricalBlock = `

КОНТЕКСТ (емпіричне дослідження):
${appendixBlock}${empHint ? `ВИМОГА: ${empHint}\n` : ""}Цей підрозділ продовжує аналіз результатів. Таблиця markdown (|---|---| формат) ${tableDataSource}.${compTableInstruction} Аналіз і висновки. Не повторюй опис вибірки та методики.`;
      } else {
        empiricalBlock = `

КОНТЕКСТ (емпіричне дослідження):
${appendixBlock}${empHint ? `ВИМОГА: ${empHint}\n` : ""}Рекомендації на основі результатів дослідження з попередніх підрозділів. Не повторюй опис вибірки та методики.`;
      }
    }

    let practicalBlock = "";
    const practicalApproachRun = commentAnalysis?.practicalApproach;
    if (practicalApproachRun && practicalApproachRun !== "questionnaire" && ["analysis", "recommendations"].includes(sec.type)) {
      const appRef = appendicesText ? "\nДодай речення з посиланням на Додаток А." : "";
      const appCtx = appendicesText ? `\nДОДАТОК А (вже згенерований — спирайся на нього точно):\n${appendicesText}\n` : "";
      if (practicalApproachRun === "textbook_analysis") {
        practicalBlock = `

ОБОВ'ЯЗКОВО для цього підрозділу (аналіз підручників):${appCtx}Визнач за назвою підрозділу що саме писати:
- підрозділ про критерії або методику аналізу: опиши принципи відбору підручників, параметри порівняння (структура, зміст, типи вправ, ілюстрації, методичний апарат, відповідність програмі).
- підрозділ про аналіз або результати: таблиця markdown з порівнянням підручників за критеріями (спирайся на Додаток А). Після таблиці детальний аналіз кожного підручника.${appRef}
- підрозділ про висновки або рекомендації: порівняльні висновки, який підручник краще відповідає меті навчання і чому.`;
      } else if (practicalApproachRun === "lesson_observation") {
        practicalBlock = `

ОБОВ'ЯЗКОВО для цього підрозділу (аналіз уроків):${appCtx}Визнач за назвою підрозділу що саме писати:
- підрозділ про методику спостереження: опиши протокол спостереження (Додаток А), кількість спостережуваних уроків, вчителів, клас.${appRef}
- підрозділ про результати: таблиця markdown з результатами спостережень за аспектами (мотивація, пояснення, практика, організація тощо). Аналіз виявлених закономірностей.
- підрозділ про рекомендації: методичні рекомендації вчителям на основі результатів спостережень.`;
      } else if (practicalApproachRun === "materials_development") {
        practicalBlock = `

ОБОВ'ЯЗКОВО для цього підрозділу (розробка матеріалів):${appCtx}Визнач за назвою підрозділу що саме писати:
- підрозділ про теоретичне обґрунтування: принципи розробки матеріалів, психолого-педагогічне підґрунтя вибору підходу.
- підрозділ про опис матеріалів: детальний опис розроблених матеріалів (Додаток А) — структура, призначення, як використовувати на практиці.${appRef}
- підрозділ про апробацію або ефективність: результати практичного застосування або обґрунтування очікуваної ефективності матеріалів.`;
      }
    }

    const secSourceLines = (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
    const sourcesBlock = secSourceLines.length > 0
      ? `\nДЖЕРЕЛА ДЛЯ ЦЬОГО ПІДРОЗДІЛУ (${secSourceLines.length} шт.) — спирайся на них при написанні, вставляй посилання [N] після відповідних тверджень:\n${secSourceLines.map((s, i) => {
        const snippet = abstractsMap[s];
        return snippet ? `[${i + 1}] ${s}\n    Зміст: ${snippet}` : `[${i + 1}] ${s}`;
      }).join("\n")}\n`
      : "";
    const citNote = secSourceLines.length > 0
      ? "Вставляй [N] у текст одразу після тверджень що спираються на джерело (де N — номер зі списку вище). ЗАБОРОНЕНО вигадувати імена авторів перед цитатою — не пиши 'Іванов А. стверджує...'. Використовуй безособові конструкції: 'у дослідженні зазначається [N]', 'науковці вказують [N]', 'встановлено [N]' тощо. Цитата в тексті — ЛИШЕ [N] (технічна позначка), НІКОЛИ не пиши саму цитату (прізвище, рік, сторінку) в жодному вигляді, ні круглими, ні квадратними дужками — фінальний стиль оформлення підставить система пізніше. Посилайся ЛИШЕ на джерела зі списку вище під їхніми номерами — не згадуй і не посилайся на будь-яке дослідження чи автора, якого немає в цьому списку. Розподіляй посилання рівномірно між усіма наданими джерелами — спочатку використай кожне хоч раз, і лише потім за потреби повторюй. Одне й те саме джерело [N] НЕ цитувати більше 2 разів у межах цього підрозділу."
      : "Без посилань [1],[2].";

    const priorMainSecIds = sections.slice(0, sections.findIndex(s => s.id === sec.id))
      .filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type) && content[s.id]);
    const priorOpeningsBlock = priorMainSecIds.length
      ? `\n\nУЖЕ НАПИСАНІ ПОЧАТКИ ПОПЕРЕДНІХ ПІДРОЗДІЛІВ ЦІЄЇ Ж РОБОТИ (не повторюй ні структуру речень, ні перше слово, ні порядок "теза-приклад-висновок" — обери інший стиль відкриття й інший ритм):\n${priorMainSecIds.map((s, i) => `${i + 1}. ${extractOpeningSentences(content[s.id])}`).join("\n")}`
      : "";

    instruction = `Напиши підрозділ "${sec.label}" для ${d.type} на тему "${d.topic}". Галузь: ${d.subject}.
Тип підрозділу: ${typeHints[sec.type] || "основний"}.
${methodReq ? `ВИМОГИ МЕТОДИЧКИ ДО ЦЬОГО РОЗДІЛУ: ${methodReq}` : ""}${empiricalBlock}${practicalBlock}${econBlock}${technicalBlock}${secMethodsHint}${sourcesBlock}${priorOpeningsBlock}
ПЛАН РОБОТИ (для розуміння структури та уникнення повторів):
${planSummary}

Обсяг: приблизно ${Math.round((sec.pages || 1) * 230)} слів (~${sec.pages} стор.).
Не обривай текст. Завершуй підсумковим абзацом. ${citNote} Без жирного.
ЗАБОРОНЕНО вставляти будь-які внутрішні підназви, заголовки абзаців або окремі рядки-мітки ("Загальна картина", "Результати аналізу" тощо). Кожен рядок тексту — повне речення, рядок таблиці або підпис до таблиці/рисунка.
Абзаци мають різнитись за довжиною: чергуй короткі (2-3 речення) з довшими (5-7 речень).`;

    if (methodInfo?.hasFigures) {
      const chapterMainTypes = ["theory", "analysis", "recommendations"];
      const currentChapNum = sec.id.split(".")[0];
      const chapterSecs = sections.filter(s => chapterMainTypes.includes(s.type) && s.id.split(".")[0] === currentChapNum);
      const isLastInChapter = chapterSecs[chapterSecs.length - 1]?.id === sec.id;
      const hasFigureAlready = chapterSecs.some(s => s.id !== sec.id && hasRealFigure(content[s.id] || ""));
      if (isLastInChapter && !hasFigureAlready) {
        instruction += `\n\nОБОВ'ЯЗКОВО: жоден інший підрозділ цього розділу ще не містить рисунка — цей підрозділ МАЄ містити хоча б один рисунок (графік із таблиці даних або PlantUML-схема за правилами FIGURES вище), інакше вимога методички "щонайменше один рисунок на розділ" буде порушена.`;
      }
    }
  }
  const clientWritingReqs = [
    commentAnalysis?.writingHints,
    commentAnalysis?.textStructureHints,
  ].filter(Boolean).join("\n");
  if (clientWritingReqs) instruction += `\n\nВИМОГИ КЛІЄНТА (ОБОВ'ЯЗКОВО виконати при написанні):\n${clientWritingReqs}`;
  const secIllustrations = getIllustrationsForSection(sec, order.illustrationDescs, order.illustrations);
  if (secIllustrations.length) {
    const hasIndex = secIllustrations.every(ill => ill.index != null);
    const illLines = secIllustrations.map(ill =>
      `Рис. ${ill.figureNum}${ill.caption ? ` – ${ill.caption}` : ""}: ${ill.description}${hasIndex ? ` — маркер вставки: [КЛІЄНТ-ІЛЮСТРАЦІЯ:${ill.index}]` : ""}`
    ).join("\n");
    instruction += `\n\nІЛЮСТРАЦІЇ КЛІЄНТА ДО ЦЬОГО ПІДРОЗДІЛУ (вже надані, треба вставити в текст):\n${illLines}\nОБОВ'ЯЗКОВО для кожної ілюстрації: 1) додай посилання на неї в тексті (напр. "як показано на Рис. X.Y..."), використовуючи нумерацію X.Y відповідно до номера підрозділу;${hasIndex ? " 2) безпосередньо ПЕРЕД стандартним підписом рисунка (Рис. X.Y – Назва) додай окремим рядком точно вказаний вище маркер вставки у форматі [КЛІЄНТ-ІЛЮСТРАЦІЯ:N] — без жодних змін, більше нічого на цьому рядку." : ""}`;
  }
  const isTechnicalSecFinal = getTechnicalSections(sections, d).includes(sec.id);
  const materialsRaw = clientMaterialsSummary?.rawText || clientMaterialsText?.trim() || "";
  const materialsBlock = materialsRaw
    ? `МАТЕРІАЛИ КЛІЄНТА (використовуй ці дані - не вигадуй, не замінюй):\n${materialsRaw.slice(0, 80000)}${isTechnicalSecFinal ? `\n\n${CODE_GROUNDING_RULE}` : ""}`
    : "";
  if (materialsBlock) instruction += `\n\nДив. МАТЕРІАЛИ КЛІЄНТА нижче в системному промпті - використовуй ці дані, не вигадуй і не замінюй їх.`;
  const genOpts = { cache: true, ...(materialsBlock ? { extraCached: [materialsBlock] } : {}), onCost: ctx.onCost };
  const sectionMaxTokens = Math.min(60000, Math.max(8000, Math.round((sec.pages || 1) * 3000)));
  const cleanResult = (raw) => typographQuotes(fixMixedScript(raw, lang)
    .replace(/ — /g, ", ").replace(/— /g, " ").replace(/ —/g, " ")
    .replace(/[ᄀ-ᇿ⺀-鿿ꀀ-꓿가-퟿豈-﫿]/g, "")
  )
    .replace(/(\[[^\]]*)\]\s*\[([^\]]*\])/g, "$1; $2")
    .replace(/(\[[^\]]*)\]\s*\[([^\]]*\])/g, "$1; $2");
  const targetWords = sec.type === "chapter_conclusion" ? 115 : Math.round((sec.pages || 1) * 230);

  const raw = await doCallClaude(buildMessages(instruction), signal, buildSYS(lang, methodInfo, normalizeWorkType(d.type, d.course)), sectionMaxTokens, (s) => onProgress?.(`Генерую: ${sec.label}... зачекайте ${s}с`), undefined, genOpts);
  const cleaned = cleanResult(raw);
  const result = sec.type === "sources" ? cleaned : await enforceWordCount({
    text: cleaned, targetWords, label: sec.label, callClaude: doCallClaude,
    sys: buildSYS(lang, methodInfo, normalizeWorkType(d.type, d.course)), signal, onProgress, clean: cleanResult,
    cacheOpts: genOpts,
  });

  let finalResult = result;
  let nextCitInputs = citInputs;
  let nextAbstractsMap = abstractsMap;
  let nextSourceThesisMap = sourceThesisMap;
  const localSourceLines = (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
  if (localSourceLines.length && !signal?.aborted) {
    const citedLocalNums = new Set();
    [...finalResult.matchAll(/\[\s*(\d+(?:\s*[,;]\s*\d+)*)/g)].forEach(m => {
      m[1].split(/[,;]/).forEach(s => citedLocalNums.add(Number(s.trim())));
    });
    const missingLocal = localSourceLines
      .map((line, i) => ({
        number: i + 1, marker: `[${i + 1}]`, sourceText: line,
        abstract: abstractsMap[line], thesis: sourceThesisMap[line],
      }))
      .filter(s => !citedLocalNums.has(s.number));
    if (missingLocal.length) {
      onProgress?.(`Довставляю пропущені джерела: ${sec.label}...`);
      try {
        const { text, unresolved } = await insertMissingCitations({
          sectionText: finalResult, insertions: missingLocal, lang, callClaude: doCallClaude, signal,
        });
        finalResult = cleanResult(text);

        const updatedLines = [...localSourceLines];
        let linesChanged = false;
        if (unresolved.length && !signal?.aborted) {
          for (const num of unresolved) {
            const idx = num - 1;
            const oldLine = localSourceLines[idx];
            const thesis = sourceThesisMap[oldLine];
            if (!thesis) continue;
            onProgress?.(`Шукаю заміну джерела: ${sec.label}...`);
            const replacement = await retryUnmatchedSource({
              order, secId: sec.id, sectionText: finalResult, marker: `[${num}]`, thesis, lang, signal, ctx,
            });
            if (replacement) {
              finalResult = cleanResult(replacement.text);
              updatedLines[idx] = replacement.newLine;
              linesChanged = true;
              if (replacement.paper.abstract) {
                nextAbstractsMap = { ...nextAbstractsMap, [replacement.newLine]: replacement.paper.abstract };
              }
              nextSourceThesisMap = { ...nextSourceThesisMap, [replacement.newLine]: thesis };
            }
          }
        }
        if (linesChanged) {
          nextCitInputs = { ...nextCitInputs, [sec.id]: updatedLines.join("\n") };
        }
      } catch (e) { console.error("Довставлення пропущених джерел одразу після генерації:", e); }
    }
  }

  finalResult = capCitationRepeats(finalResult);

  if (!signal?.aborted) {
    try {
      finalResult = await fixDanglingFigures({ text: finalResult, lang, callClaude: doCallClaude, signal });
    } catch (e) { console.error("fixDanglingFigures:", e.message); }
  }

  const newContent = { ...content, [sec.id]: finalResult };

  let nextGlossary = glossary;
  if (["theory", "analysis", "recommendations"].includes(sec.type) && !signal?.aborted) {
    try {
      onProgress?.(`Виділяю терміни: ${sec.label}...`);
      const glossPrompt = `Текст підрозділу "${sec.label}" ${d.type} на тему "${d.topic}":\n\n${finalResult.slice(0, 16000)}\n\nВиділи 3-6 ключових авторських термінів, назв методик/моделей/технологій чи багаторівневих структур (напр. "Етап 1 – Етап 2 – Етап 3"), ВВЕДЕНИХ саме в цьому тексті. Якщо таких немає — поверни порожній масив.\nВідповідь — ТІЛЬКИ JSON масив рядків, напр. ["термін 1", "термін 2"].`;
      const glossRaw = await doCallClaude([{ role: "user", content: glossPrompt }], null, SYS_JSON_ARRAY, 300, null, MODEL_FAST, { onCost: ctx.onCost });
      const terms = JSON.parse(glossRaw.match(/\[[\s\S]*\]/)?.[0] || "[]");
      if (terms.length) nextGlossary = { ...nextGlossary, [sec.id]: terms.join("; ") };
    } catch (e) { console.error("Глосарій термінів підрозділу:", e.message); }
  }

  return {
    content: newContent,
    citInputs: nextCitInputs,
    abstractsMap: nextAbstractsMap,
    sourceThesisMap: nextSourceThesisMap,
    glossary: nextGlossary,
  };
}

// ── Дефолтний план (без методички, без плану клієнта) — перенесено з
// academic-assistant.jsx без змін логіки ──
function buildDefaultPlan(totalPages, lang = "Українська", chapCountOverride = null) {
  const lc = getLangLabels(lang);
  const needThirdChapter = totalPages >= 40;
  const mainPages = Math.round(totalPages * 0.80);
  const chapCount = chapCountOverride || (needThirdChapter ? 3 : 2);
  const pagesPerCh = Math.max(1, Math.round(mainPages / chapCount));
  const pagesPerSub = Math.max(1, Math.round(pagesPerCh / 3));
  const introPages = 2;
  const concPages = totalPages > 40 ? 3 : 2;
  const chapterNames = lc.chapterTemplate.slice(0, chapCount);
  const chTypes = ["theory", "analysis", "recommendations"];
  const sections = [];
  chapterNames.forEach((chName, ci) => {
    const chapNum = ci + 1;
    for (let i = 1; i <= 3; i++) sections.push({ id: `${chapNum}.${i}`, label: `${chapNum}.${i} [${lc.subsWord} ${chapNum}.${i}]`, sectionTitle: chName, pages: pagesPerSub, type: chTypes[ci] });
  });
  sections.push({ id: "intro", label: lc.intro, pages: introPages, type: "intro" });
  sections.push({ id: "conclusions", label: lc.conclusions, pages: concPages, type: "conclusions" });
  sections.push({ id: "sources", label: lc.sources, pages: 1, type: "sources" });
  return sections;
}

/**
 * Генерує план роботи. Дерево гілок із гарантованим запасним варіантом
 * (buildDefaultPlan) у кінці — на відміну від runWritingSection, тут НЕ
 * потрібне покрокове відновлення: кожна гілка або вдається одразу, або
 * (перехоплено try/catch) провалюється до наступної, аж до дефолту. Повторний
 * виклик після збою просто безпечно повторює весь підбір — жодна гілка не
 * лишає замовлення в напівготовому стані.
 *
 * @param {object} order - те саме, що й для runWritingSection, плюс:
 *   comment, clientPlan, readyWorkText, illustrationsPdf
 * @param {object} ctx - { callClaude, callGemini, onProgress?, onCost?,
 *   extractIllustrationsFromPdf?(pdfFile, descs) } — останнє потрібне лише
 *   коли order.illustrationsPdf заданий і треба витягти реальні зображення
 *   сторінок (браузер має pdfjs для цього; воркер поки може це пропустити —
 *   illustrationDescs все одно повернуться, просто без картинок-джерел).
 * @returns {Promise<object>} патч полів (sections, planDisplay, info, stage,
 *   status, і залежно від гілки — content/citInputs/readyWorkImportedIds/
 *   illustrations/illustrationDescs/readyWorkNeedsManualAI)
 */
export async function runPlanStage(order, ctx) {
  const { callClaude, callGemini, onProgress } = ctx;
  const d = order.info;
  const totalPages = parsePagesAvg(d.pages);
  const wc = buildWorkConfig({ info: d, methodInfo: order.methodInfo, commentAnalysis: order.commentAnalysis });
  const introP = wc.introPages;
  const conclP = wc.conclusionsPages;
  const L = getLangLabels(d?.language);
  const isEnglish = /англ|english/i.test(d?.language || "");
  const requestedChapCountRaw = detectRequestedChapterCount(
    [order.comment, order.clientMaterialsSummary?.rawText, order.clientMaterialsText].filter(Boolean).join("\n")
  );
  const requestedChapCount = requestedChapCountRaw ? Math.min(Math.max(requestedChapCountRaw, 1), 3) : null;

  let readyWorkNeedsManualAI = false;

  const finalizeSections = async (secsIn) => {
    const secs = secsIn.filter(s => {
      if (s.type === "intro" && d?.includeIntro === false) return false;
      if (s.type === "conclusions" && d?.includeConclusions === false) return false;
      if (s.type === "sources" && d?.includeSources === false) return false;
      return true;
    });
    const mapped = secs.map(s => {
      let label = s.label;
      if (s.id && /^\d+\.\d+$/.test(s.id) && !label.startsWith(s.id)) {
        label = `${s.id} ${label}`;
      }
      return { ...s, label, prompts: s.type === "sources" ? 0 : Math.max(1, Math.ceil((s.pages || 1) / 3)) };
    });

    const withPrompts = (() => {
      const currentTotal = mapped.reduce((sum, s) => sum + (s.pages || 0), 0);
      if (currentTotal === totalPages) return mapped;
      const mainIdxs = mapped.reduce((acc, s, i) => {
        if (!["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type)) acc.push(i);
        return acc;
      }, []);
      const fixedTotal = mapped.reduce((sum, s, i) => mainIdxs.includes(i) ? sum : sum + (s.pages || 0), 0);
      const pagesForMain = Math.max(mainIdxs.length, totalPages - fixedTotal);
      const currentMainTotal = mainIdxs.reduce((sum, i) => sum + (mapped[i].pages || 1), 0);
      const result = [...mapped];
      let assigned = 0;
      mainIdxs.forEach((idx, j) => {
        const isLast = j === mainIdxs.length - 1;
        const p = isLast
          ? Math.max(1, pagesForMain - assigned)
          : Math.max(1, Math.round((mapped[idx].pages / currentMainTotal) * pagesForMain));
        result[idx] = { ...result[idx], pages: p, prompts: Math.max(1, Math.ceil(p / 3)) };
        if (!isLast) assigned += p;
      });
      return result;
    })();

    const { dist, total } = calcSourceDist(withPrompts, parsePagesAvg(d?.pages));
    const patch = {
      sections: withPrompts, planDisplay: buildPlanText(withPrompts),
      info: { ...d, sourceCount: String(total) },
      stage: "plan", status: "plan_ready",
      readyWorkNeedsManualAI,
      sourceDist: dist, sourceTotal: total,
    };
    if (order.illustrations?.length > 0 || order.illustrationsPdf) {
      try {
        let illContent;
        if (order.illustrationsPdf) {
          illContent = [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: order.illustrationsPdf.b64 } },
            { type: "text", text: buildIllustrationsPdfPrompt({ topic: d?.topic, planSections: withPrompts, lang: d?.language }) },
          ];
        } else {
          illContent = order.illustrations.map(ill => ({
            type: "image", source: { type: "base64", media_type: ill.type, data: ill.b64 }
          }));
          illContent.push({ type: "text", text: buildIllustrationsPrompt({ topic: d?.topic, illustrations: order.illustrations, planSections: withPrompts, lang: d?.language }) });
        }
        const illRaw = await callClaude([{ role: "user", content: illContent }], null, SYS_JSON_ARRAY, 1500, null, MODEL_FAST, { onCost: ctx.onCost });
        const illMatch = illRaw.match(/\[[\s\S]*\]/);
        const illParsed = JSON.parse(illMatch?.[0] || illRaw);
        patch.illustrationDescs = illParsed;
        if (order.illustrationsPdf && ctx.extractIllustrationsFromPdf) {
          const built = await ctx.extractIllustrationsFromPdf(order.illustrationsPdf, illParsed);
          if (built?.length) patch.illustrations = built;
        }
      } catch (e) {
        console.warn("illustrationDescs re-analysis in plan:", e.message);
      }
    }
    // Готову частину роботи клієнта більше НЕ підганяємо автоматично через ШІ тут — код-розпізнавання
    // вже спробувало це вище; якщо не вийшло, клієнтка сама натискає кнопку "Аналізувати через ШІ".
    return patch;
  };

  // Якщо клієнт надав готову частину роботи — беремо структуру З НЕЇ (реальні заголовки й реальний обсяг),
  // а не вигадуємо нову структуру і не підганяємо готовий текст під неї. Спочатку пробуємо чистим кодом
  // (безкоштовно, миттєво); лише якщо код не зміг розпізнати заголовки — падаємо на ШІ-резерв.
  if (order.readyWorkText?.trim()) {
    try {
      onProgress?.("Аналізую структуру готової частини роботи клієнта...");
      const planSections = order.clientPlan?.trim() ? quickParsePlanIds(order.clientPlan) : null;
      const extracted = extractReadyWorkStructure({ documentText: order.readyWorkText, lang: d?.language, planSections });

      if (extracted) {
        let finalSecs = extracted.sections;
        let finalContent = extracted.content;

        if (!order.clientPlan?.trim()) {
          const chapNums = finalSecs.map(s => parseInt(String(s.id).split(".")[0], 10)).filter(n => !isNaN(n));
          const lastChapNum = chapNums.length ? Math.max(...chapNums) : 0;
          const existingPages = finalSecs.reduce((sum, s) => sum + (s.pages || 0), 0);
          const continuationBudget = totalPages;
          const desiredChapCount = Math.max(lastChapNum, order.methodInfo?.chaptersCount || ((existingPages + continuationBudget) >= 40 ? 3 : 2));
          const hasIntro = finalSecs.some(s => s.type === "intro");
          const hasConclusions = finalSecs.some(s => s.type === "conclusions");
          const hasSources = finalSecs.some(s => s.type === "sources");
          const needsChapterConcl = order.methodInfo?.hasChapterConclusions === true;
          const missingChapNums = [];
          for (let n = lastChapNum + 1; n <= desiredChapCount; n++) missingChapNums.push(n);

          if (missingChapNums.length || !hasIntro || !hasConclusions || !hasSources) {
            onProgress?.("Догенеровую відсутні розділи (продовження)...");
            const contLC = getLangLabels(d?.language);
            let newChapterData = [];
            if (missingChapNums.length) {
              try {
                const subsOverrides = order.methodInfo?.subsectionsPerChapterOverrides || {};
                const defaultSubsPerChapter = order.methodInfo?.subsectionsPerChapter || 3;
                const existingChapterTitles = [...new Set(finalSecs.filter(s => s.sectionTitle).map(s => s.sectionTitle))];
                const prompt = buildContinuationPlanPrompt({
                  topic: d.topic, subject: d.subject, type: d.type, lang: d?.language,
                  existingChapterTitles,
                  newChapters: missingChapNums.map(num => ({
                    num,
                    subsCount: subsOverrides[String(num)] ?? defaultSubsPerChapter,
                    forcedType: order.methodInfo?.chapterTypes?.[num - 1],
                  })),
                  otherRequirements: order.methodInfo?.otherRequirements,
                });
                const raw = await callClaude([{ role: "user", content: prompt }], null, SYS_JSON, 2000, null, MODEL_FAST, { onCost: ctx.onCost });
                const jsonMatch = raw.match(/\{[\s\S]*\}/);
                const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
                newChapterData = parsed.chapters || [];
              } catch (e) { console.error("Продовження плану:", e); }
            }

            const newSubCount = newChapterData.reduce((sum, c) => sum + (c.subsections?.length || 0), 0);
            const introPages = hasIntro ? 0 : 2;
            const conclPages = hasConclusions ? 0 : 3;
            const srcPages = hasSources ? 0 : 1;
            const chapConclCount = needsChapterConcl ? newChapterData.length : 0;
            const pagesForSubs = Math.max(newSubCount, continuationBudget - introPages - conclPages - srcPages - chapConclCount);
            const pagesPerSub = newSubCount ? Math.max(1, Math.round(pagesForSubs / newSubCount)) : 0;

            const newChapterSecs = [];
            newChapterData.forEach(c => {
              const forcedType = order.methodInfo?.chapterTypes?.[c.num - 1];
              (c.subsections || []).forEach((subLabel, i) => {
                const idMatch = subLabel.match(/^(\d+\.\d+)/);
                const id = idMatch ? idMatch[1] : `${c.num}.${i + 1}`;
                newChapterSecs.push({ id, label: subLabel, sectionTitle: c.title, pages: pagesPerSub, type: forcedType || c.type || "theory" });
              });
              if (needsChapterConcl) {
                newChapterSecs.push({ id: `${c.num}.conclusions`, label: contLC.chapConclLabel(c.num), sectionTitle: c.title, pages: 1, type: "chapter_conclusion" });
              }
            });

            const mainExisting = finalSecs.filter(s => !["intro", "conclusions", "sources"].includes(s.type));
            const introSec = finalSecs.find(s => s.type === "intro") || (hasIntro ? null : { id: "intro", label: contLC.intro, pages: introPages, type: "intro" });
            const conclSec = finalSecs.find(s => s.type === "conclusions") || (hasConclusions ? null : { id: "conclusions", label: contLC.conclusions, pages: conclPages, type: "conclusions" });
            const srcSec = finalSecs.find(s => s.type === "sources") || (hasSources ? null : { id: "sources", label: contLC.sources, pages: srcPages, type: "sources" });

            finalSecs = [introSec, ...mainExisting, ...newChapterSecs, conclSec, srcSec].filter(Boolean);
          }
        } else {
          const foundIdsSet = new Set(finalSecs.map(s => s.id));
          const missingPlanIds = (planSections || []).filter(p => !foundIdsSet.has(p.id));
          if (missingPlanIds.length) {
            const existingPages = finalSecs.reduce((sum, s) => sum + (s.pages || 0), 0);
            const pagesLeft = Math.max(missingPlanIds.length, totalPages - existingPages);
            const pagesPerMissing = Math.max(1, Math.round(pagesLeft / missingPlanIds.length));
            missingPlanIds.forEach(p => {
              finalSecs = [...finalSecs, { id: p.id, label: p.label, pages: pagesPerMissing, type: p.chapNum === 1 ? "theory" : p.chapNum === 2 ? "analysis" : "recommendations" }];
            });
            finalSecs.sort((a, b) => {
              const na = String(a.id).split(".").map(Number), nb = String(b.id).split(".").map(Number);
              if (a.id === "intro") return -1; if (b.id === "intro") return 1;
              if (a.id === "conclusions" || a.id === "sources") return 1; if (b.id === "conclusions" || b.id === "sources") return -1;
              return (na[0] - nb[0]) || ((na[1] || 0) - (nb[1] || 0));
            });
          }
          const tailLC = getLangLabels(d?.language);
          if (!finalSecs.some(s => s.type === "intro")) finalSecs = [{ id: "intro", label: tailLC.intro, pages: 2, type: "intro" }, ...finalSecs];
          if (!finalSecs.some(s => s.type === "conclusions")) finalSecs = [...finalSecs, { id: "conclusions", label: tailLC.conclusions, pages: 3, type: "conclusions" }];
          if (!finalSecs.some(s => s.type === "sources")) finalSecs = [...finalSecs, { id: "sources", label: tailLC.sources, pages: 1, type: "sources" }];
        }

        const mergedContent = { ...order.content, ...finalContent };
        const mergedCitInputs = { ...order.citInputs, ...extracted.citInputs };
        return {
          sections: finalSecs, planDisplay: buildPlanText(finalSecs),
          content: mergedContent, citInputs: mergedCitInputs,
          readyWorkImportedIds: extracted.foundIds, stage: "plan", status: "plan_ready",
          readyWorkNeedsManualAI: false,
        };
      }

      // Код не зміг розпізнати заголовки (нестандартне оформлення) — НЕ викликаємо ШІ автоматично.
      // Звичайний план згенерується як завжди нижче; аналіз через ШІ клієнтка запускає вручну кнопкою на етапі плану.
      console.warn("Структура з готової роботи: розпізнано замало розділів, повертаюсь до звичайної генерації плану");
      readyWorkNeedsManualAI = true;
    } catch (e) { console.error("Витяг структури з готової роботи:", e); }
  }

  if (order.clientPlan?.trim()) {
    const parsed = parseClientPlan(order.clientPlan.trim(), totalPages, d?.language);
    if (parsed) return await finalizeSections(parsed);
  }

  // Якщо на фото є готовий план — використати його структуру як шаблон (тільки якщо план клієнта не надано)
  if (!order.clientPlan?.trim() && order.commentAnalysis?.photoTOC && typeof order.commentAnalysis.photoTOC === "string" && order.commentAnalysis.photoTOC.length > 20) {
    try {
      const toc = order.commentAnalysis.photoTOC;
      const subsMatches = toc.match(/^\s*\d+\.\d+/gm) || [];
      const totalSubsPhoto = subsMatches.length || 4;
      const chapConclCount = (toc.match(/висновк[^\s]*\s+до\s+|conclusions?\s+to\s+chapter/gi) || []).length;
      const pagesPerSub = Math.max(3, Math.round((totalPages - introP - conclP - chapConclCount) / totalSubsPhoto));
      const photoTplPrompt = `A client provided a READY PLAN from a photo. Use its EXACT structure (number of chapters, subsections per chapter, chapter conclusions if present) but create NEW titles matching the topic below. Do NOT copy titles from the plan.

TOPIC: "${d.topic}". Type: ${d.type}. Field: ${d.subject}. Pages: ${totalPages}.
Language of work: ${d.language || "Ukrainian"} — all labels (INTRODUCTION, CONCLUSIONS, chapter/section titles) must be in the work language.

PLAN FROM PHOTO (structure only, do not copy titles):
${toc}

PAGE DISTRIBUTION (total must equal ${totalPages}):
- ${L.intro}: ${introP} p.
- ${L.conclusions}: ${conclP} p.
- Chapter conclusions: 1 p. each (if present in photo plan)
- Each subsection: ~${pagesPerSub} p. (total subsections: ${totalSubsPhoto})

Return ONLY JSON without markdown:
{"sections":[{"id":"1.1","label":"1.1 Title","sectionTitle":"${L.chapterWord} 1. TITLE","pages":8,"type":"theory"},{"id":"intro","label":"${L.intro}","pages":${introP},"type":"intro"},{"id":"conclusions","label":"${L.conclusions}","pages":${conclP},"type":"conclusions"},{"id":"sources","label":"${L.sources}","pages":2,"type":"sources"}]}`;
      const raw = await callGemini([{ role: "user", content: photoTplPrompt }], null, SYS_JSON_SHORT, 3000, null, undefined, undefined, { onCost: ctx.onCost });
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
      const secs = parsed.sections || parsed;
      if (Array.isArray(secs) && secs.length > 3) return await finalizeSections(secs);
    } catch (e) { console.warn("photoTOC plan failed:", e.message); }
  }

  // Якщо коментар містить приклад структури плану — використати як шаблон, адаптувати назви під тему (тільки якщо план клієнта не надано)
  if (!order.clientPlan?.trim() && order.comment?.trim() && /розділ\s*\d+/i.test(order.comment)) {
    try {
      const chapNums = [...new Set((order.comment.match(/розділ\s*(\d+)/gi) || []).map(m => m.match(/\d+/)[0]))];
      const chapCount = chapNums.length || 2;
      const chapSubsMap = {};
      for (const line of order.comment.split('\n')) {
        const m = line.trim().match(/^(\d+)\.(\d+)/);
        if (m) chapSubsMap[m[1]] = (chapSubsMap[m[1]] || 0) + 1;
      }
      const subsCount = Object.values(chapSubsMap).reduce((a, b) => a + b, 0) || 4;
      const chapStructure = chapNums.length
        ? chapNums.map(n => `Chapter ${n}: EXACTLY ${chapSubsMap[n] || 2} subsection(s)`).join('\n')
        : `Each chapter: EXACTLY 2 subsections`;
      const chapConclCount = (order.comment.match(/висновк[^\s]*\s+до\s+/gi) || []).length;
      const pagesForSubs = totalPages - introP - conclP - chapConclCount;
      const pagesPerSub = Math.max(3, Math.round(pagesForSubs / subsCount));
      const templatePrompt = `A client provided a STRUCTURE EXAMPLE. Use EXACTLY the structure below.

Do NOT copy titles from the example. Create NEW titles for the topic below.
MANDATORY STRUCTURE — you MUST follow this exactly:
- EXACTLY ${chapCount} chapter(s)
${chapStructure}
${chapConclCount > 0 ? `- Chapter conclusions after each chapter` : `- NO chapter conclusions`}

TOPIC: "${d.topic}". Type: ${d.type}. Field: ${d.subject}. Pages: ${totalPages}.
Language of work: ${d.language || "Ukrainian"} — all labels must be in this language.

EXAMPLE (structure only, do not copy titles):
${order.comment}

PAGE DISTRIBUTION (total must equal ${totalPages}):
- ${L.intro}: ${introP} p.
- ${L.conclusions}: ${conclP} p.
- Chapter conclusions: 1 p. each (if present)
- Each subsection: ${pagesPerSub} p. (total: ${subsCount})

Allowed type values: "theory" | "analysis" | "recommendations" | "chapter_conclusion" | "intro" | "conclusions" | "sources"
Chapter conclusion id format: "1.conclusions", "2.conclusions", "3.conclusions"

Return ONLY JSON without markdown:
{"sections":[
  {"id":"1.1","label":"1.1 Section title","sectionTitle":"${L.chapterWord} 1. CHAPTER TITLE","pages":8,"type":"theory"},
  ${chapConclCount > 0 ? `{"id":"1.conclusions","label":"${L.chapConclLabel(1)}","sectionTitle":"${L.chapterWord} 1. CHAPTER TITLE","pages":1,"type":"chapter_conclusion"},` : ""}
  {"id":"2.1","label":"2.1 Section title","sectionTitle":"${L.chapterWord} 2. CHAPTER TITLE","pages":8,"type":"analysis"},
  ${chapConclCount > 0 ? `{"id":"2.conclusions","label":"${L.chapConclLabel(2)}","sectionTitle":"${L.chapterWord} 2. CHAPTER TITLE","pages":1,"type":"chapter_conclusion"},` : ""}
  {"id":"intro","label":"${L.intro}","pages":${introP},"type":"intro"},
  {"id":"conclusions","label":"${L.conclusions}","pages":${conclP},"type":"conclusions"},
  {"id":"sources","label":"${L.sources}","pages":2,"type":"sources"}
]}`;
      await new Promise(r => setTimeout(r, 1000));
      const raw = await callGemini([{ role: "user", content: templatePrompt }], null, SYS_JSON_SHORT, 3000, null, undefined, undefined, { onCost: ctx.onCost });
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
      const secs = parsed.sections || parsed;
      if (Array.isArray(secs) && secs.length > 3) return await finalizeSections(secs);
    } catch (e) { console.warn("comment template plan failed:", e.message); }
  }

  const commentHasConcl = order.commentAnalysis?.planHints ? /висновк[^\s]*\s+до\s+/i.test(order.commentAnalysis.planHints) : false;

  const acadDefaults = (!order.commentAnalysis?.practicalApproach && !order.commentAnalysis?.researchDesign)
    ? getAcademicDefaults(d.subject, d.type, d.course, d.topic)
    : null;
  const acadDefaultsBlock = acadDefaults
    ? `\nRESEARCH TYPE FOR PRACTICAL CHAPTER (use as context for subsection naming): ${acadDefaults.researchType}. Methods: ${acadDefaults.methods.join(", ")}.${acadDefaults.notes ? ` Note: ${acadDefaults.notes}.` : ""}`
    : "";

  if (order.methodInfo) {
    const chapCount = requestedChapCount || order.methodInfo.chaptersCount || (totalPages >= 40 ? 3 : 2);
    const hasConcl = order.methodInfo.hasChapterConclusions === true || commentHasConcl || false;
    const chTypes = order.methodInfo.chapterTypes?.length ? order.methodInfo.chapterTypes : ["theory", "analysis", "recommendations"].slice(0, chapCount);
    const chapConclP = hasConcl ? chapCount : 0;

    const subsPerChapter = order.methodInfo.subsectionsPerChapter || 3;
    const subsOverrides = order.methodInfo.subsectionsPerChapterOverrides || {};
    const chapSubsCounts = Array.from({ length: chapCount }, (_, i) => subsOverrides[String(i + 1)] ?? subsPerChapter);
    const totalSubsCount = chapSubsCounts.reduce((a, b) => a + b, 0);
    const pagesPerSub = Math.max(3, Math.round((totalPages - introP - conclP - chapConclP) / totalSubsCount));
    const subsCountLine = chapSubsCounts.every(c => c === subsPerChapter)
      ? `- Subsections per chapter: ${subsPerChapter}`
      : chapSubsCounts.map((c, i) => `- Chapter ${i + 1} subsections: ${c}`).join('\n');

    const planPrompt = `Create a plan for ${d.type} on topic: "${d.topic}". Field: ${d.subject}. Pages: ${totalPages}.
Language of work: ${d.language || "Ukrainian"} — all labels and titles must be in this language.
${order.clientPlan?.trim() ? `\nCLIENT'S REQUIRED CHAPTER TITLES — use these EXACTLY as sectionTitle values, in this exact order, do NOT rename or reorder them:\n${order.clientPlan}\n` : (order.commentAnalysis?.planHints ? `\nCLIENT HINTS:\n${order.commentAnalysis.planHints}\n` : "")}${acadDefaultsBlock}
GUIDE REQUIREMENTS:
- Chapters: ${chapCount}
${subsCountLine}
- Chapter conclusions: ${hasConcl ? "YES — add after last subsection of each chapter" : "NO — do not add"}
- Chapter types: ${chTypes.join(", ")}
${order.methodInfo.otherRequirements ? `- Other requirements: ${order.methodInfo.otherRequirements}` : ""}
${order.methodInfo.exampleTOC ? `\nFORMATTING EXAMPLE FROM GUIDE (headings style only — do NOT copy titles or use as structure):
${order.methodInfo.exampleTOC}` : ""}

PAGE DISTRIBUTION (must sum to exactly ${totalPages}):
- ${L.intro}: ${introP} p.
- ${L.conclusions}: ${conclP} p.
- Each subsection: ~${pagesPerSub} p. (total: ${totalSubsCount})
${hasConcl ? `- Chapter conclusions: 1 p. each (${chapCount} total)` : ""}

Allowed type values: "theory" | "analysis" | "recommendations" | "chapter_conclusion" | "intro" | "conclusions" | "sources"
Chapter conclusion id format: "1.conclusions", "2.conclusions" etc.
IMPORTANT: every subsection label MUST start with its numeric id (e.g. "1.1 ", "1.2 ", "2.3 "). Never omit the number prefix.

Return ONLY JSON without markdown:
{"sections":[
  {"id":"1.1","label":"1.1 Section title","sectionTitle":"${L.chapterWord} 1. CHAPTER TITLE","pages":8,"type":"theory"},
  {"id":"1.2","label":"1.2 Section title","sectionTitle":"${L.chapterWord} 1. CHAPTER TITLE","pages":7,"type":"theory"},${hasConcl ? `
  {"id":"1.conclusions","label":"${L.chapConclLabel(1)}","sectionTitle":"${L.chapterWord} 1. CHAPTER TITLE","pages":1,"type":"chapter_conclusion"},` : ""}
  {"id":"2.1","label":"2.1 Section title","sectionTitle":"${L.chapterWord} 2. CHAPTER TITLE","pages":8,"type":"analysis"},
  {"id":"2.2","label":"2.2 Section title","sectionTitle":"${L.chapterWord} 2. CHAPTER TITLE","pages":7,"type":"analysis"},${hasConcl ? `
  {"id":"2.conclusions","label":"${L.chapConclLabel(2)}","sectionTitle":"${L.chapterWord} 2. CHAPTER TITLE","pages":1,"type":"chapter_conclusion"},` : ""}
  {"id":"intro","label":"${L.intro}","pages":${introP},"type":"intro"},
  {"id":"conclusions","label":"${L.conclusions}","pages":${conclP},"type":"conclusions"},
  {"id":"sources","label":"${L.sources}","pages":2,"type":"sources"}
]}
Order: subsections grouped by chapter, then intro, conclusions, sources.`;

    try {
      await new Promise(r => setTimeout(r, 3000)); // пауза після аналізу методички
      const raw = await callGemini([{ role: "user", content: planPrompt }], null, SYS_JSON, 3000, null, undefined, undefined, { onCost: ctx.onCost });
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
      const secs = parsed.sections || parsed;
      if (Array.isArray(secs) && secs.length > 3) return await finalizeSections(secs);
      console.warn("methodInfo plan: unexpected shape", parsed);
    } catch (e) { console.error("methodInfo plan error:", e); }
  }

  const defaultSecs = buildDefaultPlan(totalPages, d?.language, requestedChapCount);
  const hasThreeChapters = requestedChapCount ? requestedChapCount >= 3 : totalPages >= 40;
  const empiricalChapNum = hasThreeChapters ? 3 : 2;
  const planSecs = isPsychoPed(d)
    ? defaultSecs.map(s => {
      const chapNum = parseInt(s.id.split(".")[0]);
      if (!hasThreeChapters && s.type === "analysis" && chapNum === 2) {
        const title = isEnglish ? "CHAPTER 2. EMPIRICAL RESEARCH" : "РОЗДІЛ 2. ЕМПІРИЧНЕ ДОСЛІДЖЕННЯ";
        return { ...s, sectionTitle: title };
      }
      if (hasThreeChapters && s.type === "recommendations" && chapNum === 3) {
        const title = isEnglish ? "CHAPTER 3. EMPIRICAL RESEARCH" : "РОЗДІЛ 3. ЕМПІРИЧНЕ ДОСЛІДЖЕННЯ";
        return { ...s, sectionTitle: title };
      }
      return s;
    })
    : defaultSecs;
  const psychoPedNamingHint = isPsychoPed(d)
    ? `\nIMPORTANT for Chapter ${empiricalChapNum} (empirical research): subsections should cover: research methodology and sample description, questionnaire/survey instrument, results analysis and interpretation.`
    : "";
  const namingPrompt = `For ${d.type} on topic "${d.topic}" (field: ${d.subject}) create subsection titles.${order.commentAnalysis?.planHints ? `\nHINTS:\n${order.commentAnalysis.planHints}` : ""}${psychoPedNamingHint}${acadDefaultsBlock}\nFixed structure:\n${planSecs.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type)).map(s => `${s.id} [${s.sectionTitle}]`).join("\n")}\n\nReturn ONLY JSON without markdown:\n{"titles":{"1.1":"Title","1.2":"Title","2.1":"Title","2.2":"Title"}}`;
  try {
    await new Promise(r => setTimeout(r, 2000)); // пауза перед запитом
    const raw = await callClaude([{ role: "user", content: namingPrompt }], null, SYS_JSON, 1000, null, MODEL_FAST, { onCost: ctx.onCost });
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
    const namedSecs = planSecs.map(s => { const name = parsed.titles?.[s.id]; return name ? { ...s, label: `${s.id} ${name}` } : s; });
    return await finalizeSections(namedSecs);
  } catch (e) {
    console.error("Naming error:", e);
    return await finalizeSections(planSecs);
  }
}

// ── Розв'язання файлового входу (методичка/приклад роботи/ілюстрації-PDF/фото)
// в готові байти. Браузер завжди передає { b64, mediaType } — файл уже лежить
// у пам'яті вкладки, тож просто повертаємо його як є. CRM-шлях/воркер натомість
// може передати { url, mediaType } — файл довантажується звідти щоразу, коли
// потрібен (і при першому запуску, і при відновленні після збою), тож нічого не
// треба заливати в Firestore (там є жорсткий ліміт 1 МБ на документ, а методички
// в PDF легко можуть бути більшими) — джерело істини лишається зовнішнім.
async function resolveFileBytes(fileRef) {
  if (!fileRef) return null;
  if (fileRef.b64) return { b64: fileRef.b64, mediaType: fileRef.mediaType || fileRef.type || "application/pdf" };
  if (fileRef.url) {
    const res = await fetch(fileRef.url);
    if (!res.ok) throw new Error(`Не вдалось завантажити файл за посиланням (${res.status}): ${fileRef.url}`);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    // Buffer існує в Node (воркер), відсутній у браузері; typeof-перевірка безпечна в обох середовищах
    /* eslint-disable no-undef */
    const b64 = typeof Buffer !== "undefined"
      ? Buffer.from(bytes).toString("base64")
      : btoa(bytes.reduce((s, b) => s + String.fromCharCode(b), ""));
    /* eslint-enable no-undef */
    return { b64, mediaType: fileRef.mediaType || "application/pdf" };
  }
  return null;
}

/**
 * Аналізує вхідні дані замовлення: шаблон, методичку, приклад роботи, коментар
 * (+фото), ілюстрації, креслення, матеріали клієнта. На відміну від
 * runPlanStage, тут є справжнє покрокове відновлення — кроки з дорогими
 * викликами ШІ (читання PDF методички/прикладу роботи, опис ілюстрацій)
 * позначаються завершеними через order.analyzeProgress і на повторному
 * виклику НЕ повторюються, якщо вже зроблені. Аналіз шаблону (КРОК 1) — єдиний
 * виняток: він ніколи не був окремою точкою збереження навіть в оригінальному
 * коді (перший saveToFirestore відбувався вже після методички), тож і тут
 * завжди виконується заново — це дешевий виклик, це не проблема.
 *
 * ВАЖЛИВО: order.analyzeProgress призначений саме для АВТОМАТИЧНОГО
 * повторного запуску після збою (той самий order, той самий виклик). Якщо
 * викликач хоче зробити СВІЖИЙ аналіз (користувач завантажив нову методичку,
 * відредагував коментар тощо) — має явно передати analyzeProgress: {}
 * (або зовсім не передавати це поле), інакше вже пройдені кроки помилково
 * пропустяться зі старими даними. Браузерна обгортка (doAnalyze) саме так і
 * робить: кожен клік на "Аналізувати" — це свідомо нова спроба.
 *
 * @param {object} order - tplText, comment, clientPlan, methodInfo (попередній
 *   результат, якщо PDF не надано повторно), methodichkaFile, exampleWorkFile,
 *   illustrationsPdfFile, illustrations[], photos[], clientDrawings[],
 *   clientMaterials[], clientMaterialsText, appendicesText, fileLabel,
 *   exampleWorkFileName, analyzeProgress?
 * @param {object} ctx - { callClaude, callGemini, onProgress?, onCost?,
 *   save(patch) - ОБОВ'ЯЗКОВИЙ async колбек, викликається після кожного
 *   завершеного дорогого кроку для реального збереження прогресу (не лише
 *   в кінці — інакше сенс відновлення втрачається), extractIllustrationsFromPdf? }
 * @returns {Promise<object>} фінальний консолідований патч (те саме, що
 *   в сумі вже пішло через ctx.save по кроках)
 */
export async function runAnalyzeStage(order, ctx) {
  const { callClaude, callGemini, onProgress, save } = ctx;
  const progress = { ...(order.analyzeProgress || {}) };
  const patch = { analyzeProgress: progress };

  // КРОК 1: Аналіз шаблону замовлення (тільки текст, без PDF) — завжди заново
  const msgs = [{ type: "text", text: buildTemplateAnalysisPrompt(order.tplText, order.comment) }];
  let newInfo;
  try {
    const raw = await callClaude([{ role: "user", content: msgs }], null, SYS_JSON, 1000, null, MODEL_FAST, { onCost: ctx.onCost });
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
    newInfo = { ...parseTemplate(order.tplText), ...Object.fromEntries(Object.entries(parsed).filter(([, v]) => v != null && v !== "")) };
  } catch (e) {
    console.warn("doAnalyze fallback:", e.message);
    newInfo = parseTemplate(order.tplText);
  }
  if (!newInfo.course && /магістерськ/i.test(newInfo.type || "")) newInfo.course = "6";
  if (!newInfo.workCategory) {
    const dir = ((newInfo.direction || "") + " " + (newInfo.subject || "")).toLowerCase();
    if (/економ|фінанс|менедж|облік|маркет|бізнес|бухгалт|аудит|логіст|підприємн|публічн.*управл|держ.*управл/.test(dir)) newInfo.workCategory = "Економічне";
    else if (/біолог|медицин|хімі|фізіол|екол|природн|ветеринар/.test(dir)) newInfo.workCategory = "Біологічне";
    else if (/техн|інформ|програм|комп|it\b|кібер|електр|машин|буд|архіт/.test(dir)) newInfo.workCategory = "Технічне";
    else newInfo.workCategory = "Гуманітарне";
  }
  patch.info = newInfo;
  // Миттєве оновлення (не запис у Firestore — той піде пізніше, разом із
  // методичкою, як і в оригіналі) — щоб інтерфейс показав тему/тип одразу,
  // не чекаючи повільного читання методички/прикладу роботи в фоні.
  ctx.onInfo?.(newInfo);
  onProgress?.("Аналізую шаблон...");

  // КРОК 2: методичка (пропускається, якщо вже пройдена і не надано нового файлу)
  let methodParsed = order.methodInfo || null;
  if (order.methodichkaFile && !progress.methodologyRead) {
    onProgress?.("Читаю методичку...");
    await new Promise(r => setTimeout(r, 2000));
    try {
      const resolved = await resolveFileBytes(order.methodichkaFile);
      const docPart = { type: "document", source: { type: "base64", media_type: resolved.mediaType, data: resolved.b64 } };
      onProgress?.("Читаю методичку... крок 1/2");
      const structMsgs = [docPart, { type: "text", text: STRUCTURE_READING_PROMPT }];
      const structRaw = await callGemini([{ role: "user", content: structMsgs }], null, SYS_JSON_SHORT, 2000, null, "gemini-2.5-flash", true, { onCost: ctx.onCost });
      const structMatch = structRaw.match(/\{[\s\S]*\}/);
      let structureInfo = null;
      try { structureInfo = structMatch ? JSON.parse(structMatch[0]) : null; } catch (e) { console.warn("[methodology] structure step parse error:", e.message); }

      await new Promise(r => setTimeout(r, 1500));
      const methodMsgs = [docPart, { type: "text", text: buildMethodologyReadingPrompt(structureInfo) }];
      const raw = await callGemini([{ role: "user", content: methodMsgs }], null, SYS_JSON_SHORT, 8000, (s) => onProgress?.(`Читаю методичку... крок 2/2, зачекайте ${s}с`), "gemini-2.5-flash", true, { onCost: ctx.onCost });
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch?.[0] || raw.replace(/```json|```/g, "").trim());
      if (structureInfo) {
        if (structureInfo.chaptersCount != null) parsed.chaptersCount = structureInfo.chaptersCount;
        if (structureInfo.subsectionsPerChapter != null) parsed.subsectionsPerChapter = structureInfo.subsectionsPerChapter;
        parsed.subsectionsPerChapterOverrides = structureInfo.subsectionsPerChapterOverrides ?? null;
        parsed.hasChapterConclusions = structureInfo.hasChapterConclusions;
        if (structureInfo.chapterTypes?.length) parsed.chapterTypes = structureInfo.chapterTypes;
        if (structureInfo.totalPages != null) parsed.totalPages = structureInfo.totalPages;
        if (structureInfo.introPages != null) parsed.introPages = structureInfo.introPages;
        if (structureInfo.conclusionsPages != null) parsed.conclusionsPages = structureInfo.conclusionsPages;
      }
      if (Array.isArray(parsed.recommendedSources)) parsed.recommendedSources = parsed.recommendedSources.join('; ');
      if (Array.isArray(parsed.sourcesStyle)) parsed.sourcesStyle = parsed.sourcesStyle.join(', ');
      if (Array.isArray(parsed.citationStyle)) parsed.citationStyle = parsed.citationStyle.join('; ');
      if (typeof parsed.sourcesMinCount === 'string') parsed.sourcesMinCount = parseInt(parsed.sourcesMinCount) || null;
      methodParsed = parsed;
      progress.methodologyRead = true;
      await save({ methodInfo: methodParsed, analyzeProgress: progress });
    } catch (e) {
      console.warn("methodInfo extract failed:", e.message);
      patch.apiError = e.message;
    }
  }

  // КРОК 2b: приклад роботи (той самий принцип пропуску)
  let exampleParsed = null, exampleStructure = null;
  if (order.exampleWorkFile && !progress.exampleWorkRead) {
    onProgress?.("Читаю приклад роботи...");
    await new Promise(r => setTimeout(r, 1500));
    try {
      const resolved = await resolveFileBytes(order.exampleWorkFile);
      const exampleDocPart = { type: "document", source: { type: "base64", media_type: resolved.mediaType, data: resolved.b64 } };
      const exampleMsgs = [exampleDocPart, { type: "text", text: buildExampleWorkReadingPrompt() }];
      const exampleRaw = await callGemini([{ role: "user", content: exampleMsgs }], null, SYS_JSON_SHORT, 6000, (s) => onProgress?.(`Читаю приклад роботи... зачекайте ${s}с`), "gemini-2.5-flash", true, { onCost: ctx.onCost });
      const exampleMatch = exampleRaw.match(/\{[\s\S]*\}/);
      exampleParsed = JSON.parse(exampleMatch?.[0] || exampleRaw.replace(/```json|```/g, "").trim());
      if (Array.isArray(exampleParsed.sourcesStyle)) exampleParsed.sourcesStyle = exampleParsed.sourcesStyle.join(', ');
      if (Array.isArray(exampleParsed.citationStyle)) exampleParsed.citationStyle = exampleParsed.citationStyle.join('; ');
      exampleStructure = deriveStructureFromExampleTOC(exampleParsed.exampleTOC, newInfo?.language);
      progress.exampleWorkRead = true;
    } catch (e) {
      console.warn("exampleWork extract failed:", e.message);
      patch.apiError = patch.apiError || e.message;
    }
  }

  // Об'єднуємо: явні поля методички мають пріоритет, приклад роботи заповнює те, чого в методичці нема
  const finalMethodInfo = (exampleParsed || exampleStructure)
    ? mergeExampleWorkIntoMethodInfo(methodParsed, exampleParsed, exampleStructure)
    : methodParsed;

  let filledTitleText = null, filledTitleLines = null;
  if (finalMethodInfo?.titlePageTemplate) {
    const currentYear = new Date().getFullYear().toString();
    const topic = newInfo?.topic || "";
    // Ці токени клієнт майже завжди вказує (ПІБ, група, факультет, кафедра, керівник) — без
    // підстановки тут вони лишаються буквальним "[ПІБ]" аж до фінального docx-експорту (де їх
    // ще підхоплює exportDocx.js), і саме тому попередній перегляд титулки на кроці "Готово"
    // показує сирі токени замість реальних даних. degreeLevel/specialty окремих полів у
    // клієнта немає — ступінь виводимо з типу роботи, спеціальність — з direction як фолбек.
    const personalFieldMap = {
      "[ПІБ]": newInfo?.studentName,
      "[ГРУПА]": newInfo?.studentGroup,
      "[КУРС]": newInfo?.course,
      "[ФАКУЛЬТЕТ]": newInfo?.faculty,
      "[КАФЕДРА]": newInfo?.department,
      "[КЕРІВНИК]": newInfo?.supervisorUniversity,
      "[ОКР]": deriveDegreeLevelFromType(newInfo?.type),
      "[СПЕЦІАЛЬНІСТЬ]": newInfo?.direction,
    };
    const fillText = (t) => {
      let s = t;
      if (topic) {
        s = s.replace(/\[ТЕМА\]/g, topic);
        s = s.replace(/\(найменування\s+теми\)/gi, topic);
        s = s.replace(/\(назва\s+теми\)/gi, topic);
      }
      s = s.replace(/\[РІК\]/g, currentYear).replace(/\[ДАТА\]/g, currentYear);
      s = s.replace(/\b20\d\d\b/g, currentYear);
      s = s.replace(/\b20\d?\s*[_]+/g, currentYear);
      for (const [token, value] of Object.entries(personalFieldMap)) {
        if (value && s.includes(token)) s = s.split(token).join(value);
      }
      return s;
    };
    if (Array.isArray(finalMethodInfo.titlePageTemplate)) {
      let filledLines = finalMethodInfo.titlePageTemplate.map(item => ({ ...item, text: fillText(item.text) }));
      filledLines = filledLines.reduce((acc, item) => {
        const prev = acc[acc.length - 1];
        if (prev && /–\s*\d{1,3}$/.test(prev.text) && /^\d{1,2}$/.test(item.text.trim())) {
          acc[acc.length - 1] = { ...prev, text: prev.text + item.text.trim() };
        } else {
          acc.push(item);
        }
        return acc;
      }, []);
      filledTitleLines = filledLines;
      filledTitleText = filledLines.map(item => item.text).join("\n");
    } else {
      filledTitleText = fillText(finalMethodInfo.titlePageTemplate);
    }
  }

  patch.methodInfo = finalMethodInfo || null;
  if (filledTitleText) { patch.titlePage = filledTitleText; patch.titlePageLines = filledTitleLines; }
  await save({
    tplText: order.tplText, comment: order.comment, clientPlan: order.clientPlan, info: newInfo,
    ...(finalMethodInfo ? { methodInfo: finalMethodInfo } : {}),
    fileLabel: order.fileLabel, exampleWorkFileName: order.exampleWorkFileName,
    ...(filledTitleText ? { titlePage: filledTitleText, titlePageLines: filledTitleLines } : {}),
    ...(order.appendicesText?.trim() ? { appendicesText: order.appendicesText } : {}),
    stage: "parsed", status: "new", analyzeProgress: progress,
  });

  // КРОК 3: коментар клієнта (+фото)
  if (progress.commentAnalysis) {
    patch.commentAnalysis = order.commentAnalysis ?? null;
  } else if (order.comment?.trim() || order.photos?.length > 0) {
    onProgress?.("Аналізую коментар...");
    await new Promise(r => setTimeout(r, 1000));
    try {
      const caContent = [];
      for (const ph of (order.photos || [])) {
        const resolved = await resolveFileBytes(ph);
        caContent.push({ type: "image", source: { type: "base64", media_type: resolved.mediaType, data: resolved.b64 } });
      }
      caContent.push({ type: "text", text: buildCommentAnalysisPrompt({ topic: newInfo?.topic, comment: order.comment, photoCount: order.photos?.length || 0 }) });
      const caRaw = await callClaude([{ role: "user", content: caContent }], null, SYS_JSON_SHORT, 600, null, MODEL_FAST, { onCost: ctx.onCost });
      const caMatch = caRaw.match(/\{[\s\S]*\}/);
      const caParsed = JSON.parse(caMatch?.[0] || caRaw);
      if (Array.isArray(caParsed.sourcesHints)) caParsed.sourcesHints = caParsed.sourcesHints.join('; ');
      if (Array.isArray(caParsed.planHints)) caParsed.planHints = caParsed.planHints.join('; ');
      if (Array.isArray(caParsed.textStructureHints)) caParsed.textStructureHints = caParsed.textStructureHints.join('; ');
      if (Array.isArray(caParsed.writingHints)) caParsed.writingHints = caParsed.writingHints.join('; ');
      patch.commentAnalysis = caParsed;
      progress.commentAnalysis = true;
      await save({
        tplText: order.tplText, comment: order.comment, clientPlan: order.clientPlan, info: newInfo,
        commentAnalysis: caParsed, ...(order.appendicesText?.trim() ? { appendicesText: order.appendicesText } : {}),
        stage: "parsed", status: "new", analyzeProgress: progress,
      });
    } catch (e) {
      console.warn("commentAnalysis failed:", e.message);
      patch.commentAnalysis = null;
    }
  } else {
    patch.commentAnalysis = null;
  }

  // КРОК 3.5: опис ілюстрацій клієнта
  if (progress.illustrationsDesc) {
    patch.illustrationDescs = order.illustrationDescs ?? [];
  } else if (order.illustrations?.length > 0 || order.illustrationsPdfFile) {
    onProgress?.("Описую ілюстрації...");
    await new Promise(r => setTimeout(r, 500));
    try {
      let illContent;
      if (order.illustrationsPdfFile) {
        const resolved = await resolveFileBytes(order.illustrationsPdfFile);
        illContent = [
          { type: "document", source: { type: "base64", media_type: resolved.mediaType, data: resolved.b64 } },
          { type: "text", text: buildIllustrationsPdfPrompt({ topic: newInfo?.topic, planSections: order.sections || [], lang: newInfo?.language }) },
        ];
      } else {
        illContent = [];
        for (const ill of order.illustrations) {
          const resolved = await resolveFileBytes(ill);
          illContent.push({ type: "image", source: { type: "base64", media_type: resolved.mediaType, data: resolved.b64 } });
        }
        illContent.push({ type: "text", text: buildIllustrationsPrompt({ topic: newInfo?.topic, illustrations: order.illustrations, planSections: order.sections || [], lang: newInfo?.language }) });
      }
      const illRaw = await callClaude([{ role: "user", content: illContent }], null, SYS_JSON_ARRAY, 1500, null, MODEL_FAST, { onCost: ctx.onCost });
      const illMatch = illRaw.match(/\[[\s\S]*\]/);
      const illParsed = JSON.parse(illMatch?.[0] || illRaw);
      patch.illustrationDescs = illParsed;
      progress.illustrationsDesc = true;
      if (order.illustrationsPdfFile && ctx.extractIllustrationsFromPdf) {
        const built = await ctx.extractIllustrationsFromPdf(order.illustrationsPdfFile, illParsed);
        if (built?.length) patch.illustrations = built;
      }
      await save({
        ...(order.illustrationsPdfFile ? {} : { illustrations: order.illustrations }),
        illustrationDescs: illParsed, analyzeProgress: progress,
      });
    } catch (e) {
      console.warn("illustrationDescs failed:", e.message);
      patch.illustrationDescs = [];
    }
  } else {
    patch.illustrationDescs = [];
  }

  // КРОК 3.6 + 4 (об'єднано в один checkpoint — проміжний drawingDescsResult
  // ніде окремо не зберігається, тож немає сенсу відновлювати їх нарізно):
  // опис креслень клієнта і збірка підсумкового тексту матеріалів
  if (progress.materialsText) {
    patch.clientMaterialsSummary = order.clientMaterialsSummary ?? null;
    patch.clientDrawings = order.clientDrawings;
  } else {
    let drawingDescsResult = [];
    if (order.clientDrawings?.length > 0) {
      onProgress?.("Описую креслення...");
      await new Promise(r => setTimeout(r, 500));
      try {
        const drContent = [];
        for (const d of order.clientDrawings) {
          const resolved = await resolveFileBytes(d);
          drContent.push({ type: "image", source: { type: "base64", media_type: resolved.mediaType, data: resolved.b64 } });
        }
        drContent.push({ type: "text", text: buildDrawingsDescriptionPrompt({ topic: newInfo?.topic, drawings: order.clientDrawings, lang: newInfo?.language }) });
        const drRaw = await callClaude([{ role: "user", content: drContent }], null, SYS_JSON_ARRAY, 1200, null, MODEL_FAST, { onCost: ctx.onCost });
        const drMatch = drRaw.match(/\[[\s\S]*\]/);
        drawingDescsResult = JSON.parse(drMatch?.[0] || drRaw);
        patch.clientDrawings = order.clientDrawings;
        await save({ clientDrawings: order.clientDrawings });
      } catch (e) {
        console.warn("clientDrawingDescs failed:", e.message);
      }
    }

    const combinedMaterialsText = [
      ...(order.clientMaterials || []).map(m => `=== ${m.name} ===\n${m.text}`),
      ...drawingDescsResult.map(d => `=== Технічний опис креслення: ${d.name} ===\n${d.description}`),
      order.clientMaterialsText?.trim() || "",
    ].filter(Boolean).join("\n\n");

    if (combinedMaterialsText.trim()) {
      const rawSummary = { rawText: combinedMaterialsText };
      patch.clientMaterialsSummary = rawSummary;
      progress.materialsText = true;
      await save({
        clientMaterialsSummary: rawSummary, clientMaterialsText: order.clientMaterialsText?.trim() || null,
        analyzeProgress: progress,
      });
    } else {
      patch.clientMaterialsSummary = null;
      progress.materialsText = true;
      await save({ analyzeProgress: progress });
    }
  }

  return patch;
}

// ── Анотація (укр/англ) для бакалаврських/магістерських робіт — перенесено з
// doGenAnnotation без зміни логіки, викликається лише зсередини runRemapStage ──
async function genAnnotation(order, contentForGen, refListForGen, ctx) {
  const mainSections = order.sections.filter(s => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type));
  const intro = order.sections.find(s => s.type === "intro");
  const concs = order.sections.find(s => s.type === "conclusions");
  const introText = intro ? (contentForGen[intro.id] || "") : "";
  const concsText = concs ? (contentForGen[concs.id] || "") : "";

  const wt = normalizeWorkType(order.info?.type, order.info?.course);
  const degreeLabel = wt === "master" ? "магістра (Master's)" : "бакалавра (Bachelor's)";
  const chaptersCount = new Set(mainSections.map(s => s.id.split(".")[0])).size;
  const sourcesCount = (refListForGen || order.refList || []).length;
  const appendicesCount = (order.appendicesText?.match(/^ДОДАТОК\s+[А-ЯA-Z]/gim) || []).length;
  const pagesLabel = order.info?.pages || order.methodInfo?.totalPages || "";

  const statsText = [
    `Освітній ступінь: ${degreeLabel}`,
    `Спеціальність/напрям: ${order.info?.subject || order.info?.direction || ""}`,
    `Кількість розділів: ${chaptersCount}`,
    `Кількість використаних джерел: ${sourcesCount}`,
    appendicesCount ? `Кількість додатків: ${appendicesCount}` : "Додатків немає",
    pagesLabel ? `Орієнтовний обсяг роботи: ${pagesLabel} сторінок` : "",
  ].filter(Boolean).join("\n");

  const prompt = buildAnnotationPrompt(order.info, order.methodInfo, statsText, introText, concsText);
  const raw = await ctx.callClaude([{ role: "user", content: prompt }], ctx.signal, SYS_JSON, 3000, null, MODEL, { onCost: ctx.onCost });
  const match = raw.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(match?.[0] || raw.replace(/```json|```/g, "").trim());
  return { annotationUk: parsed.uk || "", annotationEn: parsed.en || "" };
}

/**
 * Фінальний крок після написання всіх підрозділів: перерозподіляє локальні
 * номери цитат [N] по підрозділах у глобальний список джерел, форматує список
 * за потрібним стилем (ДСТУ/APA/MLA), довставляє пропущені цитати
 * "осиротілих" джерел, прибирає ті, що так і не підтвердились, перевіряє
 * сумарний обсяг усієї роботи і генерує анотацію (для бакалаврських/
 * магістерських). Це те, що робить різницю між "весь текст дописаний" і
 * "робота дійсно готова" (стадія done з коректним списком літератури).
 *
 * @param {object} order - sections, citInputs, citStructured, methodInfo,
 *   commentAnalysis, citStyleOverride, sourcesOrderOverride, citFootnotes,
 *   content, info, appendicesText, refList
 * @param {object} ctx - { callClaude, signal?, onCost? }
 * @returns {Promise<object>} патч: content, citInputs, citStructured, refList,
 *   stage:"done", status:"done", і annotationUk/annotationEn для бак./маг.
 */
export async function runRemapStage(order, ctx) {
  const doCallClaude = (messages, signal, systemPrompt, maxTokens, onWait, model, opts) =>
    ctx.callClaude(messages, ctx.signal, systemPrompt, maxTokens, onWait, model, opts);

  const sections = order.sections;
  const citInputs = order.citInputs || {};
  const methodInfo = order.methodInfo;
  const commentAnalysis = order.commentAnalysis;
  const info = order.info;
  const mainSecs = sections.filter(s => s.type !== "sources");
  const _extraText2 = (methodInfo?.otherRequirements || "") + " " + (methodInfo?.citationStyle || "") + " " + (commentAnalysis?.sourcesHints || "");
  const sourcesStyle = order.citStyleOverride
    || methodInfo?.sourcesStyle
    || (/APA/i.test(_extraText2) ? "APA" : /MLA/i.test(_extraText2) ? "MLA" : "ДСТУ 8302:2015");
  const isAPA = /APA/i.test(sourcesStyle);
  const isMLA = /MLA/i.test(sourcesStyle);
  const isDstu = /ДСТУ/i.test(sourcesStyle);
  const isFootnoteMode = order.citFootnotes && isDstu;
  const _effectiveOrderRemap = order.sourcesOrderOverride || methodInfo?.sourcesOrder;
  const isAlphabeticalOrder = !_effectiveOrderRemap || _effectiveOrderRemap === "alphabetical";

  const secLocalSources = {};
  mainSecs.forEach(sec => {
    const lines = (citInputs[sec.id] || "").split("\n").map(l => l.trim()).filter(Boolean);
    secLocalSources[sec.id] = {};
    lines.forEach((line, i) => { secLocalSources[sec.id][i + 1] = line; });
  });

  const deduper = createReferenceDeduper();
  mainSecs.forEach(sec => {
    Object.values(secLocalSources[sec.id]).forEach(text => { deduper.add(text); });
  });
  const rawRefs = deduper.canonicalRefs;

  const _remapWorkLang = info?.language || "Українська";
  const _remapLatinFirst = /англ|english|польськ|polish|нім|german|франц|french|іспан|spanish|італ|italian/i.test(_remapWorkLang);
  const _remapPageAbbrev = /англ|english/i.test(_remapWorkLang) ? "p." : "с.";

  const structuredByTitle2 = {};
  Object.values(order.citStructured || {}).forEach(papers => {
    (papers || []).forEach(p => {
      if (p.title) structuredByTitle2[p.title.toLowerCase().slice(0, 60)] = p;
    });
  });
  const findStructured2 = (refText) => {
    const lower = refText.toLowerCase();
    for (const [key, paper] of Object.entries(structuredByTitle2)) {
      if (lower.includes(key)) return paper;
    }
    return null;
  };

  let { finalTexts: allRefs, indexMap } = await buildFinalReferenceList({
    rawRefs, findStructured: findStructured2, sourcesStyle, isLatinWork: _remapLatinFirst,
    sourcesFormatRules: methodInfo?.sourcesFormatRules, sourcesGrouping: methodInfo?.sourcesGrouping, callClaude: doCallClaude,
    skipSort: !isAlphabeticalOrder && !isDstu,
  });
  if (ctx.signal?.aborted) return {};
  let fmtLines = allRefs;
  let fmtResult = allRefs.map((r, i) => `${i + 1}. ${r}`).join("\n");

  const secLocalToGlobal = {};
  mainSecs.forEach(sec => {
    secLocalToGlobal[sec.id] = {};
    Object.entries(secLocalSources[sec.id]).forEach(([localN, text]) => {
      const rawIdx = deduper.add(text);
      secLocalToGlobal[sec.id][Number(localN)] = indexMap[rawIdx];
    });
  });

  const { refCiteText, pageRanges: pageRanges2 } = buildCiteFormats({
    finalTexts: allRefs, rawRefs, indexMap, findStructured: findStructured2,
    isAPA, isMLA, isFootnoteMode,
  });

  const newContent = { ...order.content };
  mainSecs.forEach(sec => {
    if (!newContent[sec.id]) return;
    const mapping = secLocalToGlobal[sec.id];
    if (!mapping || !Object.keys(mapping).length) return;
    newContent[sec.id] = applyCitationRemap(newContent[sec.id], mapping, refCiteText, { pageRanges: pageRanges2, pageAbbrev: _remapPageAbbrev });
  });

  const citedGlobalNums = new Set();
  mainSecs.forEach(sec => {
    const text = newContent[sec.id];
    if (!text) return;
    if (isFootnoteMode) {
      [...text.matchAll(/%%FN(\d+)%%/g)].forEach(m => citedGlobalNums.add(Number(m[1])));
    } else if (isAPA || isMLA) {
      Object.entries(refCiteText).forEach(([n, cite]) => { if (text.includes(cite)) citedGlobalNums.add(Number(n)); });
    } else {
      [...text.matchAll(/\[\s*(\d+(?:\s*[,;]\s*\d+)*)/g)].forEach(m => {
        m[1].split(/[,;]/).forEach(s => citedGlobalNums.add(Number(s.trim())));
      });
    }
  });

  const orphans = [];
  const seenOrphanGlobalNums = new Set();
  mainSecs.forEach(sec => {
    Object.entries(secLocalToGlobal[sec.id] || {}).forEach(([, globalN]) => {
      if (!globalN || citedGlobalNums.has(globalN) || seenOrphanGlobalNums.has(globalN)) return;
      seenOrphanGlobalNums.add(globalN);
      orphans.push({ sec, globalN });
    });
  });

  const unresolvedOrphans = [];
  const orphansBySec = new Map();
  orphans.forEach(o => {
    if (!newContent[o.sec.id]) return;
    if (!orphansBySec.has(o.sec.id)) orphansBySec.set(o.sec.id, []);
    orphansBySec.get(o.sec.id).push(o);
  });
  await Promise.all([...orphansBySec.entries()].map(async ([secId, secOrphans]) => {
    if (ctx.signal?.aborted) return;
    const insertions = secOrphans.map(({ globalN }) => ({
      number: globalN,
      marker: refCiteText[globalN] || `[${globalN}]`,
      sourceText: allRefs[globalN - 1],
    }));
    try {
      const { text, unresolved } = await insertMissingCitations({
        sectionText: newContent[secId], insertions, lang: _remapWorkLang,
        callClaude: doCallClaude, signal: ctx.signal,
      });
      newContent[secId] = text;
      unresolvedOrphans.push(...unresolved);
    } catch (e) {
      console.error("Помилка вставки цитат непроцитованих джерел", secId, e);
      unresolvedOrphans.push(...secOrphans.map(o => o.globalN));
    }
  }));
  if (ctx.signal?.aborted) return {};

  if (unresolvedOrphans.length) {
    const removed = new Set(unresolvedOrphans);
    const oldToNewGlobal = {};
    let nextN = 1;
    allRefs.forEach((_, i) => {
      const oldN = i + 1;
      if (!removed.has(oldN)) oldToNewGlobal[oldN] = nextN++;
    });
    if (!isAPA && !isMLA) {
      const newRefCiteText = {};
      const newPageRanges = {};
      Object.entries(oldToNewGlobal).forEach(([oldNStr, newN]) => {
        const oldN = Number(oldNStr);
        newRefCiteText[newN] = isFootnoteMode ? `%%FN${newN}%%` : `[${newN}]`;
        if (pageRanges2[oldN]) newPageRanges[newN] = pageRanges2[oldN];
      });
      mainSecs.forEach(sec => {
        if (!newContent[sec.id]) return;
        newContent[sec.id] = applyCitationRemap(newContent[sec.id], oldToNewGlobal, newRefCiteText, { pageRanges: newPageRanges, pageAbbrev: _remapPageAbbrev });
      });
    }
    allRefs = allRefs.filter((_, i) => !removed.has(i + 1));
    fmtLines = allRefs;
    fmtResult = allRefs.map((r, i) => `${i + 1}. ${r}`).join("\n");
  }

  if (!isAPA && !isMLA) {
    mainSecs.forEach(sec => {
      if (!newContent[sec.id]) return;
      newContent[sec.id] = newContent[sec.id].replace(/\[\s*(\d+(?:\s*[,;]\s*\d+)*)\s*(?:,\s*[сc]\.?\s*\d*[^\]]*)?\s*\]/g, (match, nums) => {
        const valid = nums.split(/[,;]/).every(n => {
          const num = Number(n.trim());
          return num >= 1 && num <= fmtLines.length;
        });
        return valid ? match : "";
      });
    });
  }

  if (!isAPA && !isMLA && !isAlphabeticalOrder) {
    const firstSeen = [], seen = new Set();
    mainSecs.forEach(sec => {
      const text = newContent[sec.id] || "";
      [...text.matchAll(/\[\s*(\d+(?:\s*[,;]\s*\d+)*)/g)].forEach(m => {
        m[1].split(/[,;]/).forEach(s => {
          const n = Number(s.trim());
          if (!seen.has(n)) { seen.add(n); firstSeen.push(n); }
        });
      });
    });
    const oldToNew = {};
    firstSeen.forEach((oldN, idx) => { oldToNew[oldN] = idx + 1; });
    let nextNew = firstSeen.length + 1;
    fmtLines.forEach((_, i) => { const n = i + 1; if (!oldToNew[n]) oldToNew[n] = nextNew++; });

    if (Object.entries(oldToNew).some(([old, nw]) => Number(old) !== nw)) {
      mainSecs.forEach(sec => {
        if (!newContent[sec.id]) return;
        let text = newContent[sec.id].replace(/\[\s*(\d+(?:\s*[,;]\s*\d+)*)\s*(?:,\s*[сc]\.?\s*(\d+)?[^\]]*)?\s*\]/g, (match, nums, page) => {
          const newNums = nums.split(/[,;]/).map(s => oldToNew[Number(s.trim())]).filter(Boolean);
          if (!newNums.length) return match;
          if (newNums.length === 1) return `[${newNums[0]}${page ? `, с. ${page}` : ""}]`;
          return `[${[...new Set(newNums)].join(", ")}]`;
        });
        newContent[sec.id] = text;
      });

      const newFmtLines = new Array(fmtLines.length);
      fmtLines.forEach((line, i) => {
        const newIdx = oldToNew[i + 1] - 1;
        if (newIdx >= 0 && newIdx < newFmtLines.length) newFmtLines[newIdx] = line;
      });
      fmtResult = newFmtLines
        .map((line, i) => line ? `${i + 1}. ${line.replace(/^\d+\.\s*/, "")}` : null)
        .filter(Boolean).join("\n");
    }
  }

  const srcSec = sections.find(s => s.type === "sources");
  if (srcSec) newContent[srcSec.id] = fmtResult || allRefs.map((r, i) => `${i + 1}. ${r}`).join("\n");
  const newRefList = (fmtResult || allRefs.map((r, i) => `${i + 1}. ${r}`).join("\n"))
    .split("\n").filter(Boolean);

  if (!ctx.signal?.aborted) {
    const totalTargetWords = sections.reduce((sum, s) => sum + Number(s.pages || 0) * 230, 0);
    const adjustedVolume = await enforceTotalVolume({
      sections, content: newContent, targetWords: totalTargetWords,
      isEligible: (s) => !["intro", "conclusions", "sources", "chapter_conclusion"].includes(s.type),
      callClaude: doCallClaude, signal: ctx.signal,
      sys: buildSYS(_remapWorkLang, methodInfo, normalizeWorkType(info?.type, info?.course)),
      clean: stripEmDash,
    });
    Object.assign(newContent, adjustedVolume);
  }

  if (!ctx.signal?.aborted) {
    const introSec = sections.find(s => s.type === "intro");
    if (introSec && newContent[introSec.id]?.includes("__TOTAL_PAGES__")) {
      const totalWords = sections
        .reduce((sum, s) => sum + (newContent[s.id] || "").trim().split(/\s+/).filter(Boolean).length, 0);
      const actualPages = Math.max(1, Math.round(totalWords / 230));
      newContent[introSec.id] = newContent[introSec.id].replaceAll("__TOTAL_PAGES__", String(actualPages));
    }
  }

  const patch = {
    content: newContent, citInputs, citStructured: order.citStructured,
    refList: newRefList, stage: "done", status: "done",
  };

  const wt = normalizeWorkType(info?.type, info?.course);
  if (wt === "master" || wt === "bachelor") {
    try {
      Object.assign(patch, await genAnnotation({ ...order, refList: newRefList }, newContent, newRefList, ctx));
    } catch (e) {
      console.error("doGenAnnotation error:", e);
    }
  }

  return patch;
}
