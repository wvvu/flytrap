import type { ClassifyFacts } from "./prompt.js";
import { finalizeAiResult, type AiResult } from "./types.js";

export interface ClassifyInput {
  promptId: string;
  systemPrompt: string;
  userMessage: string;
  facts: ClassifyFacts;
}

export interface Classifier {
  id: string;
  model: string;
  classify(input: ClassifyInput): Promise<AiResult>;
}

/** Dry-run classifier. It does not call a network and it does not read the body into the summary. */
export function fakeClassifier(now: () => number = Date.now): Classifier {
  return {
    id: "fake",
    model: "fake",
    async classify(input) {
      return finalizeAiResult({
        schema: 1,
        prompt_id: input.promptId,
        model: "fake",
        provider: "fake",
        at: new Date(now()).toISOString(),
        label: "gray",
        confidence: 0.2,
        summary: "假分类器，未调用模型",
        tags: ["fake"],
        signals: [],
      });
    },
  };
}
