import assert from "node:assert/strict";
import test from "node:test";
import { createGeminiClassifier } from "../src/ai/gemini.js";

test("gemini classifier completes json format and parses result", async () => {
  let calledUrl = "";
  let calledBody: any = null;

  const stubFetch: typeof fetch = async (input, init) => {
    calledUrl = String(input);
    calledBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    label: "phish",
                    confidence: 0.95,
                    summary: "仿冒钓鱼邮件",
                    tags: ["credential_harvesting"],
                    signals: [{ name: "url", value: "fake domain" }],
                  }),
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const classifier = createGeminiClassifier({
    apiKeys: ["test-gemini-key-1234"],
    model: "gemini-2.5-flash",
    fetchImpl: stubFetch,
  });

  const res = await classifier.classify({
    promptId: "classify-v1",
    systemPrompt: "You are a mail security analyst.",
    userMessage: "Analyze this email.",
    facts: {} as any,
  });

  assert.equal(res.label, "phish");
  assert.equal(res.confidence, 0.95);
  assert.equal(res.provider, "gemini");
  assert.equal(res.model, "gemini-2.5-flash");
  assert.ok(calledUrl.includes("models/gemini-2.5-flash:generateContent"));
  assert.ok(calledUrl.includes("key=test-gemini-key-1234"));
  assert.equal(calledBody.generationConfig.responseMimeType, "application/json");
});

test("gemini classifier fails over to next key on 429/503 and cools down", async () => {
  const calls: string[] = [];

  const stubFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("key=key-1")) {
      calls.push("key-1");
      return new Response("ResourceExhausted: Quota exceeded", { status: 429 });
    }
    if (url.includes("key=key-2")) {
      calls.push("key-2");
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      label: "legit",
                      confidence: 0.99,
                      summary: "Normal mail",
                      tags: ["newsletter"],
                      signals: [],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error("unexpected key");
  };

  const classifier = createGeminiClassifier({
    apiKeys: ["key-1", "key-2"],
    fetchImpl: stubFetch,
    cooldownMs: 30_000,
  });

  const res = await classifier.classify({
    promptId: "classify-v1",
    systemPrompt: "sys",
    userMessage: "msg",
    facts: {} as any,
  });

  assert.equal(res.label, "legit");
  assert.deepEqual(calls, ["key-1", "key-2"]);

  const poolStatus = classifier.getKeyPoolStatus();
  assert.equal(poolStatus.keys[0]?.isCoolingDown, true);
  assert.equal(poolStatus.keys[1]?.isCoolingDown, false);
});
