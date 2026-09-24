import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApi } from "../src/api/app.js";
import { gzipCodec } from "../src/compress.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { migrationsDir } from "../src/paths.js";

function cookieHeader(setCookie: string | string[] | undefined, current = ""): string {
  const jar = new Map<string, string>();
  for (const part of current.split(";").filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const lines = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const line of lines) {
    const pair = (line.split(";")[0] ?? "").trim();
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
}

test("the panel is static and the mail API stays behind the session", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flytrap-ui-"));
  const db = openDatabase(path.join(dir, "db", "mail.db"));
  migrate(db, migrationsDir());
  const app = await buildApi({
    config: loadConfig({
      NODE_ENV: "test",
      ROLES: "api",
      MAIL_DATA_DIR: dir,
      ACCEPT_DOMAINS: "example.com",
      API_PASSWORD: "test-password-value",
      SESSION_SECRET: "0123456789abcdef0123456789abcdef",
      CLASSIFIER: "fake",
    }),
    db,
    codec: gzipCodec(),
    log: false,
  });
  try {
    const page = await app.inject({ method: "GET", url: "/" });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-type"] ?? "", /text\/html/);
    assert.match(page.body, /\/app\.js/);
    assert.match(page.body, /\/app\.css/);
    assert.equal(page.body.includes("allow-same-origin"), false);
    assert.match(page.body, /sandbox=""/);
    assert.match(String(page.headers["content-security-policy"] ?? ""), /script-src 'self'/);

    const script = await app.inject({ method: "GET", url: "/app.js" });
    assert.equal(script.statusCode, 200);
    assert.match(script.headers["content-type"] ?? "", /javascript/);
    assert.match(script.body, /\/v1\/messages/);
    assert.match(script.body, /\/v1\/messages\/" \+ encodeURIComponent\(id\) \+ "\/reclassify/);
    assert.match(script.body, /x-csrf-token/);
    assert.match(script.body, /重分类/);
    assert.equal(script.body.includes("innerHTML"), false);

    const style = await app.inject({ method: "GET", url: "/app.css" });
    assert.equal(style.statusCode, 200);
    assert.match(style.headers["content-type"] ?? "", /text\/css/);

    const closed = await app.inject({ method: "GET", url: "/v1/messages" });
    assert.equal(closed.statusCode, 401);
    assert.deepEqual(closed.json(), { error: "unauthorized" });

    const anonymous = await app.inject({ method: "GET", url: "/%2e%2e/%2e%2e/package.json" });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(anonymous.body.includes("better-sqlite3"), false);

    const csrf = await app.inject({ method: "GET", url: "/v1/csrf" });
    let cookie = cookieHeader(csrf.headers["set-cookie"]);
    const token = csrf.json().token as string;
    const login = await app.inject({
      method: "POST",
      url: "/v1/login",
      headers: { cookie, "x-csrf-token": token, "content-type": "application/json" },
      payload: { username: "admin", password: "test-password-value" },
    });
    assert.equal(login.statusCode, 200);
    cookie = cookieHeader(login.headers["set-cookie"], cookie);
    const escaped = await app.inject({ method: "GET", url: "/%2e%2e/%2e%2e/package.json", headers: { cookie } });
    assert.equal(escaped.statusCode, 404);
    assert.equal(escaped.body.includes("better-sqlite3"), false);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
