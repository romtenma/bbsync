import assert from "node:assert/strict";
import test from "node:test";

import { normalizeHostname, normalizeSiteKey } from "./site.js";

test("normalizes registered sites to their stable @ keys", () => {
  assert.equal(normalizeSiteKey("https://egg.5ch.net/test/read.cgi/software/123/"), "@5ch");
  assert.equal(normalizeSiteKey("https://5ch.io/"), "@5ch");
  assert.equal(normalizeSiteKey("https://WWW.2CH.NET."), "@5ch");
  assert.equal(normalizeSiteKey("https://sub.bbspink.com/"), "@bbspink");
  assert.equal(normalizeSiteKey("https://open2ch.net:443/"), "@open2ch");
  assert.equal(normalizeSiteKey("https://foo.machi.to/"), "@machi");
  assert.equal(normalizeSiteKey("https://jbbs.shitaraba.net/"), "@shitaraba");
});

test("uses the normalized hostname, including subdomains, for unknown sites", () => {
  assert.equal(normalizeSiteKey("https://testtest.net/board/read.cgi"), "testtest.net");
  assert.equal(normalizeSiteKey("https://Sub.TestTest.net:8443/"), "sub.testtest.net");
});

test("does not match a registered site by an incomplete hostname label", () => {
  assert.equal(normalizeSiteKey("https://not5ch.net/"), "not5ch.net");
  assert.equal(normalizeSiteKey("https://5ch.net.example.org/"), "5ch.net.example.org");
});

test("normalizes hostname syntax before site lookup", () => {
  assert.equal(normalizeHostname("https://User:pass@5CH.NET:443/path?q=1#part"), "5ch.net");
  assert.equal(normalizeHostname("Example.COM."), "example.com");
});

test("rejects an empty or invalid hostname", () => {
  assert.throws(() => normalizeSiteKey(""), /non-empty string/);
  assert.throws(() => normalizeSiteKey("https://"), /invalid URL or hostname/);
});
