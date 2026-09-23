import { authenticate, type AuthenticateResult, type DNSResolver } from "mailauth";
import { z } from "zod";

export const DNS_ATTEMPTS = 3;
export const AUTH_TIMEOUT_MS = 10_000;

export const authResultSchema = z
  .object({
    schema: z.literal(1),
    spf: z.string().min(1),
    dkim: z.string().min(1),
    dmarc: z.string().min(1),
    arc: z.string().min(1),
    rdns: z
      .object({
        ptr: z.string().nullable(),
        match: z.boolean(),
      })
      .strict(),
    headers: z.string(),
    error: z.string().optional(),
  })
  .strict();

export type AuthResult = z.infer<typeof authResultSchema>;

export class DnsTimeoutError extends Error {
  readonly kind = "dns_timeout";

  constructor() {
    super("dns_timeout");
    this.name = "DnsTimeoutError";
  }
}

export function isDnsFailure(err: unknown): boolean {
  if (err instanceof DnsTimeoutError) return true;
  if (!(err instanceof Error)) return false;
  const code = "code" in err ? String(err.code) : "";
  if (code === "ETIMEOUT" || code === "EDNSTIMEOUT" || code === "ESERVFAIL" || code === "EAI_AGAIN") return true;
  return err.name === "DnsTimeoutError";
}

export interface AuthInput {
  raw: Buffer;
  ip: string;
  helo: string;
  sender: string;
  mta: string;
  ptr: string | null;
}

export interface Authenticator {
  (input: AuthInput): Promise<AuthResult>;
}

export function createMailauthAuthenticator(timeoutMs = AUTH_TIMEOUT_MS): Authenticator {
  return (input) => authenticateMessage(input, timeoutMs);
}

export async function authenticateMessage(input: AuthInput, timeoutMs = AUTH_TIMEOUT_MS, resolver?: DNSResolver): Promise<AuthResult> {
  const result = await withTimeout(
    authenticate(input.raw, {
      ip: input.ip && input.ip !== "unknown" ? input.ip : undefined,
      helo: input.helo || undefined,
      sender: input.sender || undefined,
      mta: input.mta,
      resolver,
      disableBimi: true,
    }),
    timeoutMs,
  );
  return projectAuth(result, { ptr: input.ptr, helo: input.helo });
}

export function projectAuth(raw: AuthenticateResult, rdns: { ptr: string | null; helo: string }): AuthResult {
  return authResultSchema.parse({
    schema: 1,
    spf: statusOf(raw.spf && raw.spf.status),
    dkim: dkimOf(raw),
    dmarc: statusOf(raw.dmarc && raw.dmarc.status),
    arc: statusOf(raw.arc && raw.arc.status),
    rdns: {
      ptr: rdns.ptr,
      match: rdnsMatch(rdns.ptr, rdns.helo),
    },
    headers: typeof raw.headers === "string" ? raw.headers : "",
  });
}

export function dnsTempAuth(rdns: { ptr: string | null; helo: string }): AuthResult {
  return authResultSchema.parse({
    schema: 1,
    spf: "temperror",
    dkim: "none",
    dmarc: "temperror",
    arc: "none",
    rdns: { ptr: rdns.ptr, match: rdnsMatch(rdns.ptr, rdns.helo) },
    headers: "",
    error: "dns_timeout",
  });
}

export function rdnsMatch(ptr: string | null, helo: string): boolean {
  if (!ptr || !helo) return false;
  return ptr.trim().replace(/\.$/, "").toLowerCase() === helo.trim().replace(/\.$/, "").toLowerCase();
}

function dkimOf(raw: AuthenticateResult): string {
  const results = raw.dkim?.results ?? [];
  if (results.length === 0) return "none";
  const pass = results.find((item) => item.status?.result === "pass");
  return statusOf(pass?.status ?? results[0]?.status);
}

function statusOf(status: { result?: string } | false | null | undefined): string {
  if (!status || !status.result) return "none";
  return status.result === "temperr" ? "temperror" : status.result;
}

export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DnsTimeoutError()), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
