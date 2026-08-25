import { buildSYS } from "./prompts.js";

export const MODEL = "claude-sonnet-4-6";
export const MODEL_FAST = "claude-haiku-4-5-20251001";

// ── Запобіжник від "втечі" вартості однієї генерації (напр. баг у циклі, що
// зумовлює десятки дорогих викликів поспіль). generationCost рахує суму cost
// з усіх викликів callClaude І callGemini, поки хтось явно не скине її через
// resetGenerationCost() — кожна "одна генерація" (написання роботи, розстановка
// джерел, пакетне застосування правок тощо) скидає її на старті.
//
// Вартість РЕЗЕРВУЄТЬСЯ синхронно (до першого await), одразу після перевірки
// ліміту — це закриває "check-then-act" гонку: коли кілька викликів стартують
// паралельно (напр. Promise.all при розбитті джерел навпіл), кожен наступний
// вже бачить резерв попередніх, а не стартовий generationCost. Після відповіді
// різниця між реальною вартістю й резервом коригується (settle) — при помилці/
// обриві резерв просто звільняється.
export const GENERATION_COST_LIMIT = 3; // USD
let generationCost = 0;
export function resetGenerationCost() { generationCost = 0; }
export function getGenerationCost() { return generationCost; }

function checkCostLimit() {
  if (generationCost > GENERATION_COST_LIMIT) {
    const err = new Error(`⛔ Зупинено: вартість цієї генерації вже перевищила ліміт $${GENERATION_COST_LIMIT} (витрачено $${generationCost.toFixed(2)}). Уже згенероване/виправлене лишилось як є — перевірте документ вручну.`);
    err.isCostLimit = true;
    throw err;
  }
}

// Повертає {settle} — виклич settle(actualCost) щойно реальна вартість відома;
// якщо виклик впав/обірвався до цього — обов'язково settle(0) в finally.
function reserveCost(estimatedCost) {
  generationCost += estimatedCost;
  let settled = false;
  return {
    settle(actualCost) {
      if (settled) return;
      settled = true;
      generationCost += actualCost - estimatedCost;
    },
    get settled() { return settled; },
  };
}

export async function callClaude(messages, signal, systemPrompt, maxTokens, onWait, model, opts) {
  checkCostLimit();
  const CLAUDE_PRICES = { [MODEL]: { in: 3, out: 15 }, [MODEL_FAST]: { in: 0.80, out: 4 } };
  const claudeP = CLAUDE_PRICES[model || MODEL] || CLAUDE_PRICES[MODEL];
  const reservation = reserveCost(((maxTokens || 8000) * claudeP.out) / 1_000_000);
  try {
    return await callClaudeInner(messages, signal, systemPrompt, maxTokens, onWait, model, opts, reservation);
  } finally {
    if (!reservation.settled) reservation.settle(0);
  }
}

async function callClaudeInner(messages, signal, systemPrompt, maxTokens, onWait, model, opts, reservation) {
  const MAX_RETRIES = 5;
  let delay = 12000;
  const useStream = (maxTokens || 8000) >= 2000; // stream for large responses only
  // Кешування системного промпту (opts.cache) — вигідно коли той самий system
  // повторюється в кількох послідовних викликах (напр. цикл правок по розділах):
  // перший виклик пише кеш, наступні читають його в рази дешевше.
  // opts.extraCached — додаткові статичні блоки (напр. матеріали клієнта), що
  // повторюються в кожному виклику циклу генерації підрозділів так само незмінно,
  // як system — виносимо їх окремим кешованим блоком замість user-повідомлення,
  // щоб не пересилати їх по повній ціні на кожен підрозділ.
  const baseSystemText = systemPrompt || buildSYS();
  const systemField = (opts?.cache || opts?.extraCached?.length)
    ? [
        { type: "text", text: baseSystemText, ...(opts?.cache ? { cache_control: { type: "ephemeral" } } : {}) },
        ...(opts?.extraCached || []).map(t => ({ type: "text", text: t, cache_control: { type: "ephemeral" } })),
      ]
    : baseSystemText;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch("/api/claude", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model || MODEL,
        max_tokens: maxTokens || 8000,
        system: systemField,
        messages,
        ...(useStream ? { stream: true } : {}),
      }),
    });

    if (res.status === 429) {
      if (attempt === MAX_RETRIES) throw new Error("Rate limit: спробуйте через хвилину");
      const waitSec = Math.ceil(delay / 1000);
      for (let s = waitSec; s > 0; s--) {
        if (onWait) onWait(s);
        await new Promise(r => setTimeout(r, 1000));
        if (signal?.aborted) throw new Error("AbortError");
      }
      delay = Math.min(delay * 1.5, 60000);
      continue;
    }
    if (res.status === 400) {
      let errData = {};
      try { errData = await res.json(); } catch { }
      const msg = errData?.error?.message || "";
      if (msg.includes("usage limits") || msg.includes("regain access")) {
        throw new Error("💳 Вичерпано місячний ліміт API. Поповніть баланс або підніміть ліміт на console.anthropic.com");
      }
      throw new Error("API 400: " + (msg || "Bad Request"));
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error("API " + res.status + " " + errText.slice(0, 200));
    }

    // --- Streaming path ---
    if (useStream) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      let buffer = "";
      let inputTokens = 0, outputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (signal?.aborted) throw new Error("AbortError");
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (!raw || raw === "[DONE]") continue;
            try {
              const evt = JSON.parse(raw);
              if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
                fullText += evt.delta.text;
              } else if (evt.type === "message_start" && evt.message?.usage) {
                inputTokens = evt.message.usage.input_tokens || 0;
                cacheCreationTokens = evt.message.usage.cache_creation_input_tokens || 0;
                cacheReadTokens = evt.message.usage.cache_read_input_tokens || 0;
              } else if (evt.type === "message_delta" && evt.usage) {
                outputTokens = evt.usage.output_tokens || 0;
              }
            } catch { /* ignore malformed chunks */ }
          }
        }
      } finally {
        reader.releaseLock();
        // Звітуємо про витрачені токени навіть при перериванні (abort) — Anthropic вже їх обробив
        if (inputTokens || outputTokens || cacheCreationTokens || cacheReadTokens) {
          const PRICES = { [MODEL]: { in: 3, out: 15 }, [MODEL_FAST]: { in: 0.80, out: 4 } };
          const p = PRICES[model || MODEL] || PRICES[MODEL];
          // Запис у кеш коштує 1.25х ціни input, читання з кешу — 0.1х (тарифи Anthropic prompt caching)
          const cost = (inputTokens * p.in + outputTokens * p.out + cacheCreationTokens * p.in * 1.25 + cacheReadTokens * p.in * 0.1) / 1_000_000;
          reservation.settle(cost);
          window.dispatchEvent(new CustomEvent("apicost", { detail: { cost, model: model || MODEL, inTok: inputTokens + cacheCreationTokens + cacheReadTokens, outTok: outputTokens } }));
        }
      }
      return fullText;
    }

    // --- Non-streaming path (short JSON tasks) ---
    const data = await res.json();
    if (!data.content) {
      console.error("Claude API unexpected response:", JSON.stringify(data).slice(0, 300));
      throw new Error("No content in response: " + JSON.stringify(data).slice(0, 200));
    }
    if (data.usage) {
      const PRICES = { [MODEL]: { in: 3, out: 15 }, [MODEL_FAST]: { in: 0.80, out: 4 } };
      const p = PRICES[model || MODEL] || PRICES[MODEL];
      const cacheCreationTokens = data.usage.cache_creation_input_tokens || 0;
      const cacheReadTokens = data.usage.cache_read_input_tokens || 0;
      // Запис у кеш коштує 1.25х ціни input, читання з кешу — 0.1х (тарифи Anthropic prompt caching)
      const cost = (data.usage.input_tokens * p.in + data.usage.output_tokens * p.out + cacheCreationTokens * p.in * 1.25 + cacheReadTokens * p.in * 0.1) / 1_000_000;
      reservation.settle(cost);
      window.dispatchEvent(new CustomEvent("apicost", { detail: { cost, model: model || MODEL, inTok: data.usage.input_tokens + cacheCreationTokens + cacheReadTokens, outTok: data.usage.output_tokens } }));
    }
    return data.content.map(b => b.text || "").join("") || "";
  }
}

const FILE_INLINE_LIMIT = 3 * 1024 * 1024; // 3MB raw → ~4MB base64

async function uploadLargeFile(base64Data, mimeType) {
  const rawSize = Math.floor(base64Data.length * 0.75);
  if (rawSize <= FILE_INLINE_LIMIT) return null;

  // Decode first to get exact byte count (base64 padding makes estimates off by 1-2 bytes)
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const initRes = await fetch("/api/gemini-files-init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mimeType, fileSize: bytes.byteLength }),
  });
  if (!initRes.ok) throw new Error("Не вдалось ініціалізувати завантаження файлу");
  const { uploadUrl } = await initRes.json();

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes,
  });
  if (!uploadRes.ok) {
    const errText = await uploadRes.text().catch(() => "");
    throw new Error(`Не вдалось завантажити файл до Gemini (${uploadRes.status}): ${errText.slice(0, 150)}`);
  }
  const data = await uploadRes.json();
  return data.file?.uri;
}

const GEMINI_PRICES = { "gemini-2.5-flash-lite": { in: 0.10, out: 0.40 }, "gemini-2.5-flash": { in: 0.15, out: 0.60 } };

export async function callGemini(messages, signal, systemPrompt, maxTokens, onWait, model, jsonMode) {
  checkCostLimit();
  const geminiP = GEMINI_PRICES[model || "gemini-2.5-flash-lite"] || GEMINI_PRICES["gemini-2.5-flash-lite"];
  const reservation = reserveCost(((maxTokens || 8000) * geminiP.out) / 1_000_000);
  try {
    return await callGeminiInner(messages, signal, systemPrompt, maxTokens, onWait, model, jsonMode, reservation);
  } finally {
    if (!reservation.settled) reservation.settle(0);
  }
}

async function callGeminiInner(messages, signal, systemPrompt, maxTokens, onWait, model, jsonMode, reservation) {
  const MAX_RETRIES = 5;
  const FALLBACK_MODEL = "gemini-2.5-flash";
  const FALLBACK_AFTER_503 = 2;
  let delay = 12000;
  let currentModel = model || "gemini-2.5-flash-lite";
  let failCount503 = 0;

  // Upload large documents to Gemini Files API to bypass Vercel 4.5MB limit
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if ((part.type === "document" || part.type === "image") && part.source?.type === "base64") {
        const uri = await uploadLargeFile(part.source.data, part.source.media_type || "application/pdf");
        if (uri) part.source = { type: "file_uri", media_type: part.source.media_type, uri };
      }
    }
  }

  const toGeminiPart = (c) => {
    if ((c.type === "document" || c.type === "image") && c.source?.type === "base64")
      return { inlineData: { mimeType: c.source.media_type || "application/pdf", data: c.source.data } };
    if ((c.type === "document" || c.type === "image") && c.source?.type === "file_uri")
      return { fileData: { mimeType: c.source.media_type || "application/pdf", fileUri: c.source.uri } };
    return { text: c.text || c.content || "" };
  };

  const contents = messages.map((msg, i) => {
    if (Array.isArray(msg.content)) {
      const parts = msg.content.map(toGeminiPart);
      if (i === 0 && systemPrompt) {
        const firstTextIdx = parts.findIndex(p => p.text !== undefined);
        if (firstTextIdx >= 0) parts[firstTextIdx] = { text: systemPrompt + "\n\n" + parts[firstTextIdx].text };
        else parts.unshift({ text: systemPrompt });
      }
      return { role: msg.role === "assistant" ? "model" : "user", parts };
    }
    return {
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: (i === 0 && systemPrompt ? systemPrompt + "\n\n" : "") + (msg.content || "") }],
    };
  });

  const body = {
    _model: currentModel,
    contents,
    generationConfig: { maxOutputTokens: maxTokens || 8000, thinkingConfig: { thinkingBudget: 0 }, ...(jsonMode ? { responseMimeType: "application/json" } : {}) },
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    body._model = currentModel;
    const res = await fetch("/api/gemini", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status === 503) {
      if (attempt === MAX_RETRIES) throw new Error(res.status === 503 ? "Gemini перевантажений, спробуйте ще раз" : "Rate limit: спробуйте через хвилину");
      if (res.status === 503) {
        failCount503++;
        if (failCount503 >= FALLBACK_AFTER_503 && currentModel !== FALLBACK_MODEL) {
          currentModel = FALLBACK_MODEL;
          failCount503 = 0;
          delay = 3000;
        }
      }
      const waitSec = Math.ceil(delay / 1000);
      for (let s = waitSec; s > 0; s--) {
        if (onWait) onWait(s);
        await new Promise(r => setTimeout(r, 1000));
        if (signal?.aborted) { const e = new Error("AbortError"); e.name = "AbortError"; throw e; }
      }
      delay = Math.min(delay * 1.5, 60000);
      continue;
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error("Gemini API " + res.status + ": " + errText.slice(0, 200));
    }
    const data = await res.json();
    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason;
    if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
      throw new Error(`Gemini зупинився: ${finishReason}. ${candidate?.content ? "" : "Відповідь порожня."}`);
    }
    const text = candidate?.content?.parts?.filter(p => !p.thought)?.map(p => p.text || "").join("") || "";
    if (!text) {
      console.error("Gemini порожня відповідь. Raw:", JSON.stringify(data).slice(0, 500));
      throw new Error("Gemini: порожня відповідь" + (finishReason ? ` (${finishReason})` : ""));
    }
    if (data.usageMetadata) {
      const gp = GEMINI_PRICES[currentModel] || GEMINI_PRICES["gemini-2.5-flash-lite"];
      const cost = (data.usageMetadata.promptTokenCount * gp.in + data.usageMetadata.candidatesTokenCount * gp.out) / 1_000_000;
      reservation.settle(cost);
      window.dispatchEvent(new CustomEvent("apicost", { detail: { cost, model: currentModel, inTok: data.usageMetadata.promptTokenCount, outTok: data.usageMetadata.candidatesTokenCount } }));
    }
    return text;
  }
}
