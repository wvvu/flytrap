import { z } from "zod";

export const LABELS = ["legit", "spam", "phish", "malware", "gray", "unsolicited-admin"] as const;
export type Label = (typeof LABELS)[number];

const signalSchema = z.object({ name: z.string().min(1).max(64), value: z.string().max(500) }).strict();

/** What the model itself is allowed to return. Extra keys are rejected. */
export const modelOutputSchema = z
  .object({
    label: z.enum(LABELS),
    confidence: z.number().min(0).max(1),
    summary: z.string().min(1).max(2000),
    tags: z.array(z.string().min(1).max(64)).max(20),
    signals: z.array(signalSchema).max(30),
  })
  .strict();

export type ModelOutput = z.infer<typeof modelOutputSchema>;

export const aiResultSchema = z
  .object({
    schema: z.literal(1),
    prompt_id: z.string().min(1),
    model: z.string().min(1),
    provider: z.string().min(1),
    at: z.string().min(1),
    label: z.enum(LABELS),
    confidence: z.number().min(0).max(1),
    summary: z.string().min(1).max(2000),
    tags: z.array(z.string()).max(20),
    signals: z.array(signalSchema).max(30),
    raw: z.record(z.string(), z.unknown()).optional(),
    previous: z.unknown().optional(),
  })
  .strict();

export type AiResult = z.infer<typeof aiResultSchema>;

export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}

export function parseModelJson(content: string): unknown {
  let trimmed = content.trim();
  if (trimmed.startsWith("```")) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new ModelOutputError("model output is not json");
  }
}

export function parseModelOutput(input: unknown): ModelOutput {
  const value = typeof input === "string" ? parseModelJson(input) : input;
  return modelOutputSchema.parse(value);
}

/** The only path that may be written to ai_result. */
export function finalizeAiResult(value: unknown, previous?: unknown): AiResult {
  if (previous === undefined) return aiResultSchema.parse(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return aiResultSchema.parse(value);
  return aiResultSchema.parse({ ...value, previous });
}

export function stripPrevious(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.previous;
  return copy;
}
