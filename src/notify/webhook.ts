import { notifyPayload, type Notifier, type NotifyInput } from "./types.js";

export function createWebhookNotifier(options: {
  url: string;
  bearer?: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Notifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    id: "webhook",
    async notify(input: NotifyInput) {
      try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
        const response = await fetchImpl(options.url, {
          method: "POST",
          headers,
          body: JSON.stringify(notifyPayload(input)),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`webhook ${response.status}`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("webhook ")) throw err;
        throw new Error("webhook request failed");
      }
    },
  };
}
