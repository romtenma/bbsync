import assert from "node:assert/strict";
import test from "node:test";

import { DocumentConflictError } from "./errors.js";
import type { StateStore } from "./store.js";
import type { StateDocument, StateEntry } from "./types.js";

export interface StateStoreFixture {
  readonly store: StateStore;
  readonly cleanup: () => Promise<void>;
}

export function registerStateStoreContractTests(name: string, create: () => Promise<StateStoreFixture>): void {
  const scenario = (description: string, run: (store: StateStore) => Promise<void>) => {
    test(`${name}: ${description}`, async () => {
      const fixture = await create();
      try { await run(fixture.store); } finally { await fixture.cleanup(); }
    });
  };

  const first: StateDocument = {
    v: 3, deviceId: "desktop", revision: 1,
    entries: [{ key: ["favorite", "thread-1"], value: 3, revision: 1 }],
  };
  const second: StateDocument = {
    ...first, revision: 2,
    entries: [...first.entries, { key: ["post", "thread-1", 10], value: null, revision: 2 }],
  };

  scenario("starts empty and round-trips independent copies", async (store) => {
    assert.deepEqual(await store.listDocuments(), []);
    assert.equal(await store.readDocument("desktop"), undefined);
    const input = structuredClone(first);
    const pending = store.writeDocument(input);
    (input as { revision: number }).revision = 99;
    await pending;
    assert.deepEqual(await store.listDocuments(), ["desktop"]);
    const read = (await store.readDocument("desktop"))!;
    assert.deepEqual(read, first);
    (read as { revision: number }).revision = 42;
    assert.deepEqual(await store.readDocument("desktop"), first);
  });

  scenario("keeps newest revision under concurrent writes and accepts stale retries", async (store) => {
    await Promise.all([store.writeDocument(second), store.writeDocument(first), store.writeDocument(second)]);
    assert.deepEqual(await store.readDocument("desktop"), second);
  });

  scenario("ignores object field order and entry enumeration order", async (store) => {
    await store.writeDocument(second);
    await store.writeDocument({
      entries: [...second.entries].reverse().map((entry) => ({ value: entry.value, revision: entry.revision, key: entry.key } as StateEntry)),
      revision: 2, deviceId: "desktop", v: 3,
    });
    assert.deepEqual(await store.readDocument("desktop"), second);
  });

  scenario("rejects same-revision forks and recovers the write queue", async (store) => {
    await store.writeDocument(first);
    await assert.rejects(() => store.writeDocument({
      ...first, entries: [{ key: ["favorite", "thread-1"], value: 5, revision: 1 }],
    }), DocumentConflictError);
    await store.writeDocument(second);
    assert.deepEqual(await store.readDocument("desktop"), second);
  });

  scenario("ignores nested JSON object order without weakening value comparison", async (store) => {
    await store.writeDocument({ ...first, entries: [{ key: ["metadata", "t"],
      value: { title: "Title", url: "https://example.com/t" }, revision: 1 }] });
    await store.writeDocument({ ...first, entries: [{ key: ["metadata", "t"],
      value: { url: "https://example.com/t", title: "Title" }, revision: 1 }] });
    await assert.rejects(() => store.writeDocument({ ...first, entries: [{ key: ["metadata", "t"],
      value: { title: "Changed", url: "https://example.com/t" }, revision: 1 }] }), DocumentConflictError);
  });

  scenario("retains old keys and rejects changes without a new item revision", async (store) => {
    await store.writeDocument(second);
    await assert.rejects(() => store.writeDocument({
      ...second, revision: 3, entries: [{ key: ["favorite", "thread-1"], value: 5, revision: 3 }],
    }), DocumentConflictError);
    await assert.rejects(() => store.writeDocument({
      ...second, revision: 3,
      entries: [
        { key: ["favorite", "thread-1"], value: 5, revision: 1 },
        { key: ["post", "thread-1", 10], value: true, revision: 3 },
      ],
    }), DocumentConflictError);
    await store.writeDocument({
      ...second, revision: 3,
      entries: [second.entries[0]!, { key: ["post", "thread-1", 10], value: true, revision: 3 }],
    });
  });

  scenario("validates device IDs, schema, keys and values before writing", async (store) => {
    const invalid: unknown[] = [
      { ...first, v: 2 },
      { ...first, deviceId: "../escape" },
      { ...first, deviceId: "Desktop" },
      { ...first, deviceId: "con" },
      { ...first, entries: [] },
      { ...first, entries: [...first.entries, ...first.entries] },
      { ...first, revision: 2 },
      { ...first, entries: [{ key: ["favorite", "t"], value: 6, revision: 1 }] },
      { ...first, entries: [{ key: ["count", "t"], value: 0.5, revision: 1 }] },
      { ...first, entries: [{ key: ["unknown", "t"], value: null, revision: 1 }] },
    ];
    for (const value of invalid) await assert.rejects(() => store.writeDocument(value as StateDocument), TypeError);
    assert.deepEqual(await store.listDocuments(), []);
  });
}
