import { readFileSync } from "node:fs";
import { SMTPServer, type SMTPServerDataStream, type SMTPServerOptions, type SMTPServerSession } from "smtp-server";
import type { Config } from "../config.js";
import type { Codec } from "../compress.js";
import type { Db } from "../db/index.js";
import { acceptMessage, type AcceptInput } from "../ingest/accept.js";
import { IpLimiter } from "./limits.js";
import { evaluateMailFrom, evaluateRcpt, normalizeIp } from "./policy.js";
import { buildSmtpMeta } from "./session-meta.js";

export interface SmtpLog {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  fatal(obj: object, msg?: string): void;
  trace(obj: object, msg?: string): void;
}

export interface StartSmtpOptions {
  config: Config;
  db: Db;
  codec: Codec;
  log: SmtpLog;
  /** Overrides SMTP_PORT. Tests pass 0. */
  port?: number;
  now?: () => number;
  accept?: (input: AcceptInput) => Promise<{ id: string; sha256: string; duplicate: boolean; sizeBytes: number }>;
}

export interface RunningSmtp {
  port: number;
  close: () => Promise<void>;
}

export async function startSmtp(options: StartSmtpOptions): Promise<RunningSmtp> {
  const { config, db, codec, log } = options;
  const now = options.now ?? Date.now;
  const accept = options.accept ?? ((input: AcceptInput) =>
    acceptMessage({ db, dataDir: config.mailDataDir, codec }, input));
  const limiter = new IpLimiter();
  const openSessions = new Set<string>();
  const inflight = new Set<Promise<void>>();
  let draining = false;

  const tls = loadTls(config);
  const server = new SMTPServer({
    banner: config.smtpBanner,
    size: config.smtpMaxBytes,
    disabledCommands: ["AUTH"],
    authOptional: true,
    hideSTARTTLS: !tls,
    disableReverseLookup: false,
    logger: log as SMTPServerOptions["logger"],
    key: tls?.key,
    cert: tls?.cert,
    onConnect(session, callback) {
      if (draining) {
        callback(smtpError(421, "4.3.2 shutting down"));
        return;
      }
      const ip = normalizeIp(session.remoteAddress);
      const decision = limiter.admitConnect(ip, now(), {
        maxActive: config.smtpMaxConnPerIp,
        maxPerMinute: config.smtpMaxConnPerMin,
      });
      if (!decision.accept) {
        callback(smtpError(decision.responseCode, decision.message));
        return;
      }
      openSessions.add(session.id);
      callback();
    },
    onMailFrom(address, _session, callback) {
      evaluateMailFrom(address.address);
      callback();
    },
    onRcptTo(address, _session, callback) {
      const decision = evaluateRcpt(address.address, config.acceptDomainSet);
      if (!decision.accept) {
        callback(smtpError(decision.responseCode, decision.message));
        return;
      }
      callback();
    },
    onData(stream, session, callback) {
      const task = handleData({
        stream,
        session,
        callback,
        config,
        limiter,
        now,
        accept,
        log,
      });
      inflight.add(task);
      void task.finally(() => inflight.delete(task));
    },
    onClose(session) {
      if (openSessions.delete(session.id)) limiter.release(normalizeIp(session.remoteAddress));
    },
  });

  server.on("error", (err) => {
    log.error({ err: err.message }, "smtp socket error");
  });

  const port = await listen(server, options.port ?? config.smtpPort, config.smtpHost);
  log.info({ host: config.smtpHost, port, banner: config.smtpBanner }, "smtp listening");

  return {
    port,
    async close() {
      draining = true;
      const deadline = Date.now() + 30_000;
      while (inflight.size > 0 && Date.now() < deadline) {
        await sleep(20);
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      const grace = Date.now() + 1_000;
      while (inflight.size > 0 && Date.now() < grace) {
        await sleep(20);
      }
    },
  };
}

function handleData(input: {
  stream: SMTPServerDataStream;
  session: SMTPServerSession;
  callback: (err?: Error | null) => void;
  config: Config;
  limiter: IpLimiter;
  now: () => number;
  accept: NonNullable<StartSmtpOptions["accept"]>;
  log: SmtpLog;
}): Promise<void> {
  const { stream, session, config, limiter, log } = input;
  const ip = normalizeIp(session.remoteAddress);
  const rate = limiter.admitData(ip, input.now(), config.smtpMaxDataPerHour);
  if (!rate.accept) {
    return finishAfterDrain(stream, () => input.callback(smtpError(rate.responseCode, rate.message)));
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;
  let tooBig = false;

  const finish = (err?: Error) => {
    if (settled) return;
    settled = true;
    chunks.length = 0;
    input.callback(err);
  };

  return new Promise((resolve) => {
    const done = (err?: Error) => {
      finish(err);
      resolve();
    };

    stream.on("data", (chunk: Buffer) => {
      if (settled || tooBig) return;
      size += chunk.length;
      if (size > config.smtpMaxBytes || stream.sizeExceeded) {
        tooBig = true;
        chunks.length = 0;
        stream.destroy();
        done(smtpError(552, "5.3.4 message size exceeds limit"));
        return;
      }
      chunks.push(chunk);
    });

    stream.on("error", () => {
      if (settled) return;
      chunks.length = 0;
      if (tooBig || stream.sizeExceeded || size > config.smtpMaxBytes) {
        done(smtpError(552, "5.3.4 message size exceeds limit"));
        return;
      }
      done(smtpError(451, "4.3.0 temporary failure"));
    });

    stream.on("end", () => {
      if (settled) return;
      if (tooBig || stream.sizeExceeded || size > config.smtpMaxBytes) {
        chunks.length = 0;
        done(smtpError(552, "5.3.4 message size exceeds limit"));
        return;
      }
      const bytes = Buffer.concat(chunks, size);
      chunks.length = 0;
      const receivedAtMs = input.now();
      const mailFrom = session.envelope.mailFrom;
      const meta = buildSmtpMeta({
        remoteIp: session.remoteAddress,
        reverseDns: session.clientHostname,
        helo: session.hostNameAppearsAs,
        mailFrom: mailFrom && mailFrom.address ? mailFrom.address : "",
        rcptTo: session.envelope.rcptTo.map((item) => item.address),
        secure: session.secure,
        receivedAtMs,
        localIp: session.localAddress,
        localPort: session.localPort,
      });
      void input.accept({ bytes, meta, receivedAtMs })
        .then((result) => {
          log.info(
            {
              id: result.id,
              sha256: result.sha256,
              remoteIp: meta.remoteIp,
              sizeBytes: result.sizeBytes,
              duplicate: result.duplicate,
              rcpt: meta.rcptTo.length,
            },
            "accepted",
          );
          done();
        })
        .catch((err: unknown) => {
          log.error(
            { err: err instanceof Error ? err.message : "ingest failed", remoteIp: meta.remoteIp },
            "ingest failed",
          );
          done(smtpError(451, "4.3.0 temporary failure"));
        });
    });
  });
}

/**
 * smtp-server sends our callback's reply only once the DATA stream ends,
 * when the stream is still readable. Over the size limit we destroy instead,
 * so the 552 is not stuck behind a client that keeps sending.
 */
function finishAfterDrain(stream: SMTPServerDataStream, callback: () => void): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      callback();
      resolve();
    };
    stream.on("data", () => undefined);
    stream.on("end", done);
    stream.on("error", done);
  });
}

function loadTls(config: Config): { key: Buffer; cert: Buffer } | undefined {
  if (!config.smtpTlsKeyFile || !config.smtpTlsCertFile) return undefined;
  return {
    key: readFileSync(config.smtpTlsKeyFile),
    cert: readFileSync(config.smtpTlsCertFile),
  };
}

function listen(server: SMTPServer, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      reject(err);
    };
    server.on("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const address = server.server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

function smtpError(responseCode: number, message: string): Error & { responseCode: number } {
  const err = new Error(message) as Error & { responseCode: number };
  err.responseCode = responseCode;
  return err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
