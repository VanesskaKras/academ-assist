import { buildSYS } from "./prompts.js";

export const MODEL = "claude-sonnet-4-6";
export const MODEL_FAST = "claude-haiku-4-5-20251001";

export async function callClaude(messages, signal, systemPrompt, maxTokens, onWait, model) {
  const MAX_RETRIES = 5;
  let delay = 12000;
  const useStream = (maxTokens || 8000) >= 2000; // stream for large responses only

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch("/api/claude", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model || MODEL,
        max_tokens: maxTokens || 8000,
        system: systemPrompt || buildSYS(),
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
      let inputTokens = 0, outputTokens = 0;

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
              } else if (evt.type === "message_delta" && evt.usage) {
                outputTokens = evt.usage.output_tokens || 0;
              }
            } catch { /* ignore malformed chunks */ }
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (inputTokens || outputTokens) {
        const PRICES = { [MODEL]: { in: 3, out: 15 }, [MODEL_FAST]: { in: 0.80, out: 4 } };
        const p = PRICES[model || MODEL] || PRICES[MODEL];
        const cost = (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
        window.dispatchEvent(new CustomEvent("apicost", { detail: { cost, model: model || MODEL, inTok: inputTokens, outTok: outputTokens } }));
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
      const cost = (data.usage.input_tokens * p.in + data.usage.output_tokens * p.out) / 1_000_000;
      window.dispatchEvent(new CustomEvent("apicost", { detail: { cost, model: model || MODEL, inTok: data.usage.input_tokens, outTok: data.usage.output_tokens } }));
    }
    return data.content.map(b => b.text || "").join("") || "";
  }
}

export async function callGemini(messages, signal, systemPrompt, maxTokens, onWait, model, jsonMode) {
  const MAX_RETRIES = 5;
  const FALLBACK_MODEL = "gemini-1.5-flash";
  const FALLBACK_AFTER_503 = 2;
  let delay = 12000;
  let currentModel = model || "gemini-2.5-flash-lite";
  let failCount503 = 0;

  const toGeminiPart = (c) => {
    if ((c.type === "document" || c.type === "image") && c.source?.type === "base64")
      return { inlineData: { mimeType: c.source.media_type || "application/pdf", data: c.source.data } };
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
      const cost = (data.usageMetadata.promptTokenCount * 0.075 + data.usageMetadata.candidatesTokenCount * 0.30) / 1_000_000;
      window.dispatchEvent(new CustomEvent("apicost", { detail: { cost, model: currentModel, inTok: data.usageMetadata.promptTokenCount, outTok: data.usageMetadata.candidatesTokenCount } }));
    }
    return text;
  }
}
