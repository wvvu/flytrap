import { finalizeAiResult, parseModelJson, parseModelOutput } from "./types.js";
import type { Classifier, ClassifyInput } from "./classifier.js";

export interface KeyState {
  key: string;
  cooldownUntil: number;
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  lastUsedAt: number;
  lastError?: string;
}

export interface GeminiClassifierOptions {
  apiKeys: string[];
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cooldownMs?: number;
}

export interface KeyPoolSummary {
  model: string;
  keys: Array<{
    prefix: string;
    isCoolingDown: boolean;
    cooldownRemainingSec: number;
    successCalls: number;
    failedCalls: number;
    lastError?: string;
  }>;
}

export interface GeminiClassifier extends Classifier {
  getKeyPoolStatus(): KeyPoolSummary;
}

export function createGeminiClassifier(options: GeminiClassifierOptions): GeminiClassifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const cooldownMs = options.cooldownMs ?? 60_000;
  const model = options.model || "gemini-2.5-flash";
  const baseUrl = (options.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, "");

  const keys: KeyState[] = (options.apiKeys.length > 0 ? options.apiKeys : [""])
    .map((k) => k.trim())
    .filter(Boolean)
    .map((key) => ({
      key,
      cooldownUntil: 0,
      totalCalls: 0,
      successCalls: 0,
      failedCalls: 0,
      lastUsedAt: 0,
    }));

  let roundRobinIdx = 0;

  function pickAvailableKey(): KeyState {
    const currentNow = now();
    const available = keys.filter((k) => k.cooldownUntil <= currentNow);
    if (available.length === 0) {
      const minWait = Math.min(...keys.map((k) => Math.max(0, k.cooldownUntil - currentNow)));
      throw new Error(`gemini key pool exhausted: all ${keys.length} keys in cooldown (retry in ${Math.ceil(minWait / 1000)}s)`);
    }
    const picked = available[roundRobinIdx % available.length];
    if (!picked) {
      throw new Error("gemini key pool unexpected empty pick");
    }
    roundRobinIdx = (roundRobinIdx + 1) % available.length;
    return picked;
  }

  return {
    id: "gemini",
    model,
    async classify(input: ClassifyInput) {
      const currentNow = now();
      let lastErr: Error | null = null;
      // Try available keys up to keys.length times
      const maxAttempts = Math.max(1, keys.length);

      for (let i = 0; i < maxAttempts; i++) {
        let keyState: KeyState;
        try {
          keyState = pickAvailableKey();
        } catch (err) {
          throw err instanceof Error ? err : new Error(String(err));
        }

        keyState.totalCalls += 1;
        keyState.lastUsedAt = now();

        try {
          const content = await callGemini(fetchImpl, baseUrl, model, keyState.key, input, timeoutMs);
          const output = parseModelOutput(parseModelJson(content));
          keyState.successCalls += 1;
          return finalizeAiResult({
            schema: 1,
            prompt_id: input.promptId,
            model,
            provider: "gemini",
            at: new Date(now()).toISOString(),
            label: output.label,
            confidence: output.confidence,
            summary: output.summary,
            tags: output.tags,
            signals: output.signals,
            raw: output,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          keyState.failedCalls += 1;
          keyState.lastError = errMsg;

          // If rate limited or service unavailable, cool down this key and fail over to next
          if (errMsg.includes("429") || errMsg.includes("503") || errMsg.includes("ResourceExhausted") || errMsg.includes("Unavailable")) {
            keyState.cooldownUntil = now() + cooldownMs;
            lastErr = err instanceof Error ? err : new Error(errMsg);
            continue;
          }
          throw err;
        }
      }

      throw lastErr || new Error("gemini all attempts failed");
    },
    getKeyPoolStatus() {
      const currentNow = now();
      return {
        model,
        keys: keys.map((k) => ({
          prefix: k.key.length > 8 ? `${k.key.slice(0, 4)}...${k.key.slice(-4)}` : "***",
          isCoolingDown: k.cooldownUntil > currentNow,
          cooldownRemainingSec: Math.max(0, Math.ceil((k.cooldownUntil - currentNow) / 1000)),
          successCalls: k.successCalls,
          failedCalls: k.failedCalls,
          lastError: k.lastError,
        })),
      };
    },
  };
}

async function callGemini(
  fetchImpl: typeof fetch,
  baseUrl: string,
  model: string,
  apiKey: string,
  input: ClassifyInput,
  timeoutMs: number,
): Promise<string> {
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    system_instruction: {
      parts: [{ text: input.systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: input.userMessage }],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  };

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`gemini ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };

  const partText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!partText || partText.trim().length === 0) {
    throw new Error("gemini empty completion");
  }
  return partText;
}
