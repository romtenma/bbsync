import assert from "node:assert/strict";
import test from "node:test";

import { DocumentConflictError } from "./errors.js";
import { mergeDocuments } from "./project.js";
import { mergeDeviceDocuments, type StateStore } from "./store.js";
import { synchronizeStores } from "./synchronize.js";
import type { StateDocument, StateEntry } from "./types.js";

export interface StateStoreFixture {
  readonly store: StateStore;
  readonly cleanup: () => Promise<void>;
}

export interface SharedStateStoreFixture {
  /** Independent clients connected to the same backing store. */
  readonly clients: readonly [StateStore, StateStore];
  readonly cleanup: () => Promise<void>;
}

/** A separate suite: passing the basic suite does not certify shared access. */
export function registerSharedStateStoreContractTests(name: string, create: () => Promise<SharedStateStoreFixture>): void {
  test(`${name}: independent clients retain disjoint concurrent partial writes`, async () => {
    const { clients: [left, right], cleanup } = await create();
    try {
      const make = (key: string): StateDocument => ({ v: 3, deviceId: "writer", revision: 1,
        entries: [{ key: ["favorite", key], value: 1, revision: 1 }] });
      await Promise.all([left.writeDocument(make("a")), right.writeDocument(make("b"))]);
      assert.equal((await left.readDocument("writer"))!.entries.length, 2);
      assert.deepEqual(await left.readDocument("writer"), await right.readDocument("writer"));
    } finally { await cleanup(); }
  });
  test(`${name}: independent clients preserve deletions, reject forks and accept retries`, async () => {
    const { clients: [left, right], cleanup } = await create();
    try {
      const initial: StateDocument = { v: 3, deviceId: "writer", revision: 1,
        entries: [{ key: ["favorite", "a"], value: 1, revision: 1 }] };
      const deleted: StateDocument = { ...initial, revision: 2,
        entries: [{ key: ["favorite", "a"], value: null, revision: 2 }] };
      await Promise.all([left.writeDocument(deleted), right.writeDocument(initial)]);
      await right.writeDocument(deleted);
      assert.equal((await left.readDocument("writer"))!.entries[0]!.value, null);
      await assert.rejects(() => right.writeDocument({ ...deleted,
        entries: [{ key: ["favorite", "a"], value: 3, revision: 2 }] }), DocumentConflictError);
      await right.writeDocument({ ...initial, revision: 3,
        entries: [{ key: ["favorite", "a"], value: 3, revision: 3 }] });
      assert.equal((await left.readDocument("writer"))!.entries[0]!.value, 3);
    } finally { await cleanup(); }
  });
  test(`${name}: synchronization retries partial success and converges through independent clients`, async () => {
    const { clients: [left, right], cleanup } = await create();
    try {
      const documents = new Map<string, StateDocument>();
      const peer: StateStore = {
        listDocuments: async () => [...documents.keys()],
        readDocument: async (id) => structuredClone(documents.get(id)),
        writeDocument: async (doc) => { documents.set(doc.deviceId, mergeDeviceDocuments(documents.get(doc.deviceId), structuredClone(doc))); },
      };
      for (const [deviceId, value] of [["a", 1], ["b", 5]] as const) await peer.writeDocument({
        v: 3, deviceId, revision: 1, entries: [{ key: ["favorite", "t"], value, revision: 1 }],
      });
      let loseResponse = true;
      const unstable: StateStore = {
        listDocuments: () => left.listDocuments(), readDocument: (id) => left.readDocument(id),
        async writeDocument(doc) {
          await left.writeDocument(doc);
          if (loseResponse) { loseResponse = false; throw new Error("injected response loss"); }
        },
      };
      await assert.rejects(() => synchronizeStores(peer, unstable, { syncLevel: 5 }), /injected response loss/);
      assert.equal((await right.listDocuments()).length, 1);
      await synchronizeStores(peer, right, { syncLevel: 5 });
      const saved = await Promise.all((await right.listDocuments()).map((id) => right.readDocument(id)));
      assert.equal([...mergeDocuments(saved as StateDocument[]).values()][0]!.value, 5);
      assert.deepEqual(await synchronizeStores(peer, left, { syncLevel: 5 }), { copiedToLeft: 0, copiedToRight: 0 });
    } finally { await cleanup(); }
  });
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

  scenario("merges partial documents without removing omitted keys", async (store) => {
    await store.writeDocument(second);
    await store.writeDocument({
      ...second, revision: 3, entries: [{ key: ["favorite", "thread-1"], value: 5, revision: 3 }],
    });
    assert.deepEqual((await store.readDocument("desktop"))!.entries, [
      { key: ["favorite", "thread-1"], value: 5, revision: 3 }, second.entries[1]!,
    ]);
    await assert.rejects(() => store.writeDocument({
      ...second, revision: 3,
      entries: [
        { key: ["favorite", "thread-1"], value: 1, revision: 3 },
        { key: ["post", "thread-1", 10], value: true, revision: 3 },
      ],
    }), DocumentConflictError);
    await store.writeDocument({
      ...second, revision: 3,
      entries: [second.entries[0]!, { key: ["post", "thread-1", 10], value: true, revision: 3 }],
    });
  });

  scenario("accepts previously unseen older items and same-revision disjoint subsets", async (store) => {
    await store.writeDocument({ ...first, revision: 10,
      entries: [{ key: ["favorite", "t"], value: 3, revision: 10 }] });
    await store.writeDocument({ ...first, revision: 2,
      entries: [{ key: ["post", "t", 1], value: null, revision: 2 }] });
    await store.writeDocument({ ...first, revision: 10,
      entries: [{ key: ["count", "t"], value: 12, revision: 10 }] });
    const document = (await store.readDocument("desktop"))!;
    assert.equal(document.revision, 10);
    assert.equal(document.entries.length, 3);
    assert.ok(document.entries.some((entry) => entry.key[0] === "post" && entry.value === null));
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
