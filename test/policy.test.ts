import assert from "node:assert/strict";
import test from "node:test";
import {
  countInWindow,
  evaluateConnect,
  evaluateDataRate,
  evaluateMailFrom,
  evaluateRcpt,
  evaluateSize,
  normalizeIp,
} from "../src/smtp/policy.js";

const domains = new Set(["example.com", "example.net"]);

test("this domain is accepted, including any local-part", () => {
  const decision = evaluateRcpt("Admin@Example.com", domains);
  assert.equal(decision.accept, true);
  if (decision.accept) {
    assert.equal(decision.domain, "example.com");
    assert.equal(decision.localpart, "Admin");
  }
});

test("other domains are a relay deny, and a broken address is 550", () => {
  const relay = evaluateRcpt("a@evil.test", domains);
  assert.equal(relay.accept, false);
  if (!relay.accept) {
    assert.equal(relay.responseCode, 550);
    assert.match(relay.message, /relay denied/);
  }
  const broken = evaluateRcpt("not-an-address", domains);
  assert.equal(broken.accept, false);
  if (!broken.accept) assert.equal(broken.responseCode, 550);
});

test("empty MAIL FROM is accepted", () => {
  assert.equal(evaluateMailFrom("").accept, true);
  assert.equal(evaluateMailFrom("<>").accept, true);
  assert.equal(evaluateMailFrom(null).accept, true);
});

test("connection and DATA ceilings return 421", () => {
  const flooded = evaluateConnect({
    activeConnections: 10,
    connectsInWindow: 0,
    maxActive: 10,
    maxPerMinute: 60,
  });
  assert.equal(flooded.accept, false);
  if (!flooded.accept) assert.equal(flooded.responseCode, 421);

  const fast = evaluateConnect({
    activeConnections: 1,
    connectsInWindow: 60,
    maxActive: 10,
    maxPerMinute: 60,
  });
  assert.equal(fast.accept, false);

  const data = evaluateDataRate(120, 120);
  assert.equal(data.accept, false);
  if (!data.accept) assert.equal(data.responseCode, 421);
});

test("size above the ceiling is 552", () => {
  const decision = evaluateSize(21, 20);
  assert.equal(decision.accept, false);
  if (!decision.accept) assert.equal(decision.responseCode, 552);
  assert.equal(evaluateSize(20, 20).accept, true);
});

test("rate window and mapped ipv4", () => {
  assert.equal(countInWindow([1000, 2000, 3000], 3000, 1000), 2);
  assert.equal(normalizeIp("::ffff:203.0.113.10"), "203.0.113.10");
});
