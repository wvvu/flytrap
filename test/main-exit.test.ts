import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appRoot } from "../src/paths.js";

test("main exits 0 on a valid env and 1 when the api secret is missing", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-boot-"));
  try {
    const ok = run({
      NODE_ENV: "test",
      ROLES: "smtp",
      MAIL_DATA_DIR: dataDir,
      ACCEPT_DOMAINS: "example.com",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "2525",
      CLASSIFIER: "fake",
      LOG_LEVEL: "error",
    });
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);

    const bad = run({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dataDir,
      ACCEPT_DOMAINS: "example.com",
      CLASSIFIER: "fake",
      LOG_LEVEL: "fatal",
    });
    assert.equal(bad.status, 1, bad.stderr + bad.stdout);
    assert.match(bad.stdout + bad.stderr, /API_PASSWORD/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function run(overrides: Record<string, string>) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    PATHEXT: process.env.PATHEXT,
    COMSPEC: process.env.COMSPEC,
  };
  Object.assign(env, overrides);
  return spawnSync(process.execPath, ["--import", "tsx", "src/main.ts", "--check"], {
    cwd: appRoot(),
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
}
