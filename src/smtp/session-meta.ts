import { normalizeIp } from "./policy.js";

export interface SmtpMeta {
  schema: 1;
  remoteIp: string;
  reverseDns: string | null;
  helo: string;
  mailFrom: string;
  rcptTo: string[];
  secure: boolean;
  receivedAt: string;
  localIp: string;
  localPort: number;
}

export function buildSmtpMeta(input: {
  remoteIp: string | undefined;
  reverseDns: string | undefined;
  helo: string | undefined;
  mailFrom: string | null | undefined;
  rcptTo: readonly string[];
  secure: boolean;
  receivedAtMs: number;
  localIp: string | undefined;
  localPort: number | undefined;
}): SmtpMeta {
  const remoteIp = normalizeIp(input.remoteIp);
  return {
    schema: 1,
    remoteIp,
    reverseDns: pointerOrNull(input.reverseDns, remoteIp),
    helo: (input.helo ?? "").trim(),
    mailFrom: (input.mailFrom ?? "").trim(),
    rcptTo: [...input.rcptTo],
    secure: input.secure,
    receivedAt: new Date(input.receivedAtMs).toISOString(),
    localIp: normalizeIp(input.localIp),
    localPort: input.localPort ?? 0,
  };
}

function pointerOrNull(hostname: string | undefined, remoteIp: string): string | null {
  if (!hostname) return null;
  const name = hostname.trim().replace(/\.$/, "");
  if (!name) return null;
  const bare = name.startsWith("[") && name.endsWith("]") ? name.slice(1, -1) : name;
  if (bare.toLowerCase() === remoteIp) return null;
  if (netIsIp(bare)) return null;
  return name;
}

function netIsIp(value: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return true;
  return value.includes(":");
}
