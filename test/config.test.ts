import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ConfigError, loadConfig, parseAcceptDomains } from "../src/config.js";
import { appRoot } from "../src/paths.js";

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    NODE_ENV: "test",
    ROLES: "smtp",
    MAIL_DATA_DIR: path.join(appRoot(), "data-test"),
    ACCEPT_DOMAINS: "Example.COM,example.net",
    SMTP_PORT: "2525",
    SMTP_HOST: "127.0.0.1",
    CLASSIFIER: "fake",
    API_PASSWORD: undefined,
    SESSION_SECRET: undefined,
    OPENAI_API_KEY: undefined,
    OPENAI_BASE_URL: undefined,
    OPENAI_MODEL: undefined,
  };
  return { ...base, ...overrides };
}

test("accept domains are normalized and wildcards are rejected", () => {
  assert.deepEqual(parseAcceptDomains(" Example.COM. , example.net "), ["example.com", "example.net"]);
  assert.throws(() => parseAcceptDomains("*.example.com"), ConfigError);
  assert.throws(() => parseAcceptDomains(""), ConfigError);
  assert.throws(() => parseAcceptDomains("not a domain"), ConfigError);
});

test("smtp-only config loads without an api password", () => {
  const config = loadConfig(env());
  assert.deepEqual(config.roles, ["smtp"]);
  assert.equal(config.acceptDomains[0], "example.com");
  assert.equal(config.smtpPort, 2525);
  assert.equal(config.classifier, "fake");
});

test("api role refuses to start without a password or a long session secret", () => {
  assert.throws(() => loadConfig(env({ ROLES: "api" })), /API_PASSWORD/);
  assert.throws(
    () => loadConfig(env({ ROLES: "api", API_PASSWORD: "hunter2", SESSION_SECRET: "short" })),
    /SESSION_SECRET/,
  );
  const config = loadConfig(
    env({
      ROLES: "api",
      API_PASSWORD: "hunter2",
      SESSION_SECRET: "0123456789abcdef0123456789abcdef",
    }),
  );
  assert.equal(config.apiPassword, "hunter2");
});

test("production refuses the placeholder secret and the password admin", () => {
  assert.throws(
    () =>
      loadConfig(
        env({
          NODE_ENV: "production",
          ROLES: "api",
          API_PASSWORD: "admin",
          SESSION_SECRET: "0123456789abcdef0123456789abcdef",
        }),
      ),
    /API_PASSWORD|SESSION_SECRET/,
  );
  const config = loadConfig(
    env({
      NODE_ENV: "production",
      ROLES: "api",
      API_PASSWORD: "a-real-password-value",
      SESSION_SECRET: "another-secret-that-is-at-least-32-bytes",
    }),
  );
  assert.equal(config.nodeEnv, "production");
});

test("worker with openai-compat requires the model settings", () => {
  assert.throws(() => loadConfig(env({ ROLES: "worker", CLASSIFIER: "openai-compat" })), /OPENAI_BASE_URL/);
  const config = loadConfig(
    env({
      ROLES: "worker",
      CLASSIFIER: "openai-compat",
      OPENAI_BASE_URL: "https://llm.example/v1",
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "gpt-test",
    }),
  );
  assert.equal(config.openaiModel, "gpt-test");
});

test("tls files must be paired and unknown roles fail", () => {
  assert.throws(() => loadConfig(env({ SMTP_TLS_KEY_FILE: "a.key" })), /SMTP_TLS/);
  assert.throws(() => loadConfig(env({ ROLES: "smtp,imap" })), /unknown role/);
});

test(".env.example names the keys the process requires", () => {
  const example = fs.readFileSync(path.join(appRoot(), ".env.example"), "utf8");
  for (const key of [
    "ROLES",
    "MAIL_DATA_DIR",
    "ACCEPT_DOMAINS",
    "API_PASSWORD",
    "SESSION_SECRET",
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "NOTIFY_WEBHOOK_URL",
    "NOTIFY_LABELS",
  ]) {
    assert.match(example, new RegExp(`^${key}=`, "m"), key);
  }
  assert.doesNotMatch(example, /sk-[a-zA-Z0-9]{20,}/);
});
