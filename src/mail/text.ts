const URL_RE = /https?:\/\/[^\s<>"'()]+/gi;
const MAX_URLS = 50;
const MAX_URL_LENGTH = 2000;

export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, digits: string) => codepoint(Number(digits)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Cut on a UTF-8 boundary so a multibyte character is not split. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text);
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

export function extractUrls(sources: readonly string[], max = MAX_URLS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of sources) {
    for (const match of source.matchAll(URL_RE)) {
      const url = (match[0] ?? "").replace(/[.,;:]+$/, "").slice(0, MAX_URL_LENGTH);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
      if (out.length >= max) return out;
    }
  }
  return out;
}

function codepoint(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return "";
  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}
