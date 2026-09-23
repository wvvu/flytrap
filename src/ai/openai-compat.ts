import { finalizeAiResult, parseModelJson, parseModelOutput } from "./types.js";
import type { Classifier, ClassifyInput } from "./classifier.js";

export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export function createOpenAiClassifier(options: OpenAiCompatOptions): Classifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 60_000;
  return {
    id: "openai-compat",
    model: options.model,
    async classify(input) {
      const content = await complete(fetchImpl, options, input, timeoutMs);
      const output = parseModelOutput(parseModelJson(content));
      return finalizeAiResult({
        schema: 1,
        prompt_id: input.promptId,
        model: options.model,
        provider: "openai-compat",
        at: new Date(now()).toISOString(),
        label: output.label,
        confidence: output.confidence,
        summary: output.summary,
        tags: output.tags,
        signals: output.signals,
        raw: output,
      });
    },
  };
}

async function complete(
  fetchImpl: typeof fetch,
  options: OpenAiCompatOptions,
  input: ClassifyInput,
  timeoutMs: number,
): Promise<string> {
  const endpoint = `${options.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const messages = [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: input.userMessage },
  ];
  let response = await post(fetchImpl, endpoint, options.apiKey, { model: options.model, temperature: 0, response_format: { type: "json_object" }, messages }, timeoutMs);
  if (response.status === 400) {
    response = await post(fetchImpl, endpoint, options.apiKey, { model: options.model, temperature: 0, messages }, timeoutMs);
  }
  if (!response.ok) throw new Error(`openai ${response.status}`);
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) throw new Error("openai empty completion");
  return content;
}

function post(fetchImpl: typeof fetch, endpoint: string, apiKey: string, body: unknown, timeoutMs: number): Promise<Response> {
  return fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}
