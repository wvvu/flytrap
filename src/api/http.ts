export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message = "bad_request") {
    super(message);
    this.statusCode = statusCode;
    this.name = "HttpError";
  }
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function encodeCursor(receivedAt: number, id: string): string {
  return Buffer.from(`${receivedAt}:${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { receivedAt: number; id: string } | null {
  let text: string;
  try {
    text = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const splitAt = text.indexOf(":");
  if (splitAt <= 0) return null;
  const receivedAt = Number(text.slice(0, splitAt));
  const id = text.slice(splitAt + 1);
  if (!Number.isInteger(receivedAt) || receivedAt < 0 || id.length === 0 || id.length > 80) return null;
  if (!/^[\w-]+$/.test(id)) return null;
  return { receivedAt, id };
}

export function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Drop values that look like filesystem paths before they reach a client. */
export function publicError(value: string | null): string | null {
  if (!value) return null;
  if (value.length > 120 || /[\\/]/.test(value)) return null;
  return value;
}

export function safeMime(mime: string | null): string {
  if (!mime || /[\r\n;]/.test(mime)) return "application/octet-stream";
  return mime;
}

const DISPOSITION_NAME = /^[0-9a-f]{64}(?:\.eml)?$/;

/** Quoted filename is hex-only, so CR, LF, and quotes cannot break the header. */
export function contentDisposition(filename: string): string {
  if (!DISPOSITION_NAME.test(filename)) throw new HttpError(404, "not_found");
  return `attachment; filename="${filename}"; filename*=UTF-8''${filename}`;
}

export function actorName(value: string): string {
  const clean = value.replace(/[^\w.@+-]/g, "").slice(0, 64);
  return clean || "unknown";
}

const ERROR_NAMES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  415: "bad_request",
  429: "rate_limited",
};

export function errorName(status: number): string {
  return ERROR_NAMES[status] ?? "bad_request";
}
