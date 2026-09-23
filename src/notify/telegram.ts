import { notifyText, type Notifier, type NotifyInput } from "./types.js";

export function createTelegramNotifier(options: {
  token: string;
  chatId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Notifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    id: "telegram",
    async notify(input: NotifyInput) {
      try {
        const response = await fetchImpl(`https://api.telegram.org/bot${options.token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: options.chatId,
            text: notifyText(input),
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`telegram ${response.status}`);
      } catch (err) {
        if (err instanceof Error && (err.message === "telegram request failed" || /^telegram \d+$/.test(err.message))) {
          throw new Error(err.message.includes(options.token) ? "telegram request failed" : err.message);
        }
        throw new Error("telegram request failed");
      }
    },
  };
}
