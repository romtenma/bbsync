import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalStateStore } from "./local-state-store.js";
import { registerStateStoreContractTests } from "./state-store.contract.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bbsync-v3-contract-"));
  return { root, store: new LocalStateStore(root), cleanup: () => rm(root, { recursive: true, force: true }) };
}

registerStateStoreContractTests("LocalStateStore", fixture);

test("reads persisted documents after reopening and rejects corrupt files", async () => {
  const { root, store, cleanup } = await fixture();
  try {
    const document = { v: 3 as const, deviceId: "desktop", revision: 1,
      entries: [{ key: ["count", "t"] as const, value: 2, revision: 1 }] };
    await store.writeDocument(document);
    assert.deepEqual(await new LocalStateStore(root).readDocument("desktop"), document);
    assert.deepEqual(JSON.parse(await readFile(join(root, "devices", "desktop.json"), "utf8")), document);
    await writeFile(join(root, "devices", "desktop.json"), "{broken");
    await assert.rejects(() => store.readDocument("desktop"), SyntaxError);
    await writeFile(join(root, "devices", "desktop.json"), JSON.stringify({ ...document, deviceId: "mobile" }));
    await assert.rejects(() => store.readDocument("desktop"), /does not match/);
  } finally { await cleanup(); }
});

test("reports legacy directories without altering v2 data", async () => {
  const { root, store, cleanup } = await fixture();
  try {
    const legacy = join(root, "devices", "desktop", "events");
    await mkdir(legacy, { recursive: true });
    const path = join(legacy, "old.jsonl");
    await writeFile(path, '{"v":2}\n');
    await assert.rejects(() => store.listDocuments(), /new data directory for v3/);
    await assert.rejects(() => store.writeDocument({ v: 3, deviceId: "desktop", revision: 1,
      entries: [{ key: ["favorite", "t"], value: null, revision: 1 }] }), /new data directory for v3/);
    assert.equal(await readFile(path, "utf8"), '{"v":2}\n');
  } finally { await cleanup(); }
});
