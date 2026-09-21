import assert from "node:assert/strict";
import test from "node:test";

import { normalizeHostname } from "./server.js";

test("normalizes a server hostname without replacing it with a logical alias", () => {
  assert.equal(normalizeHostname("https://egg.5ch.net/test/read.cgi/software/123/"), "egg.5ch.net");
  assert.equal(normalizeHostname("https://may.2chan.net/b/"), "may.2chan.net");
  assert.equal(normalizeHostname("https://sub.testtest.net:8443/"), "sub.testtest.net");
});

test("normalizes hostname syntax before using it as an identifier component", () => {
  assert.equal(normalizeHostname("https://User:pass@5CH.NET:443/path?q=1#part"), "5ch.net");
  assert.equal(normalizeHostname("Example.COM."), "example.com");
});

test("rejects an empty or invalid hostname", () => {
  assert.throws(() => normalizeHostname(""), /non-empty string/);
  assert.throws(() => normalizeHostname("https://"), /invalid URL or hostname/);
});
