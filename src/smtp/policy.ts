export interface Accept {
  accept: true;
}

export interface Reject {
  accept: false;
  responseCode: 421 | 550 | 552;
  message: string;
}

export type Decision = Accept | Reject;

export interface AddressParts {
  localpart: string;
  domain: string;
}

/** Relay control. Empty MAIL FROM is a bounce and is always accepted. */
export function evaluateMailFrom(_address: string | null | undefined): Accept {
  return { accept: true };
}

export function evaluateRcpt(address: string, acceptDomains: ReadonlySet<string>): Decision & Partial<AddressParts> {
  const parts = splitAddress(address);
  if (!parts) {
    return { accept: false, responseCode: 550, message: "5.1.1 bad recipient" };
  }
  if (!acceptDomains.has(parts.domain)) {
    return { accept: false, responseCode: 550, message: "5.7.1 relay denied" };
  }
  return { accept: true, localpart: parts.localpart, domain: parts.domain };
}

export function evaluateConnect(input: {
  activeConnections: number;
  connectsInWindow: number;
  maxActive: number;
  maxPerMinute: number;
}): Decision {
  if (input.activeConnections >= input.maxActive) {
    return { accept: false, responseCode: 421, message: "4.7.0 too many connections" };
  }
  if (input.connectsInWindow >= input.maxPerMinute) {
    return { accept: false, responseCode: 421, message: "4.7.0 connection rate exceeded" };
  }
  return { accept: true };
}

export function evaluateDataRate(dataInWindow: number, maxPerHour: number): Decision {
  if (dataInWindow >= maxPerHour) {
    return { accept: false, responseCode: 421, message: "4.7.0 message rate exceeded" };
  }
  return { accept: true };
}

export function evaluateSize(size: number, max: number): Decision {
  if (size > max) {
    return { accept: false, responseCode: 552, message: "5.3.4 message size exceeds limit" };
  }
  return { accept: true };
}

export function countInWindow(timestamps: readonly number[], now: number, windowMs: number): number {
  const cutoff = now - windowMs;
  let count = 0;
  for (const ts of timestamps) {
    if (ts >= cutoff) count += 1;
  }
  return count;
}

export function splitAddress(address: string): AddressParts | null {
  const trimmed = address.trim().replace(/^<|>$/g, "");
  if (!trimmed) return null;
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const localpart = trimmed.slice(0, at).trim();
  const domain = trimmed.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  if (!localpart || !domain || domain.includes("@") || /\s/.test(localpart) || /\s/.test(domain)) {
    return null;
  }
  return { localpart, domain };
}

/** Collapse IPv4-mapped IPv6 so per-IP limits see one key. */
export function normalizeIp(ip: string | undefined): string {
  if (!ip) return "unknown";
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) return lower.slice(7);
  return lower;
}
