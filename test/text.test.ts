import assert from "node:assert/strict";
import test from "node:test";
import { extractUrls, htmlToText, truncateUtf8 } from "../src/mail/text.js";

test("html becomes text without script or style", () => {
  const text = htmlToText("<style>body{}</style><script>alert(1)</script><p>Hello&nbsp;<b>there</b></p>");
  assert.equal(text.includes("alert"), false);
  assert.equal(text.includes("body{}"), false);
  assert.match(text, /Hello there/);
});

test("urls are unique and capped", () => {
  const body = Array.from({ length: 60 }, (_unused, index) => `https://example.com/${index}`).join(" ");
  const urls = extractUrls([`${body} https://example.com/0.`]);
  assert.equal(urls.length, 50);
  assert.equal(urls[0], "https://example.com/0");
});

test("truncation keeps utf-8 characters whole", () => {
  assert.equal(truncateUtf8("éé", 1), "");
  assert.equal(truncateUtf8("éé", 2), "é");
  assert.equal(truncateUtf8("abc", 2), "ab");
});
