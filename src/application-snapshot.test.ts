import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BbsSync, LocalStateStore, entryKey, type StateChange, type StateDocument, type StateStore } from "./index.js";

const now = new Date("2026-10-19T00:00:00.000Z");
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "bbsync-application-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new LocalStateStore(join(root, "local"));
  const remote = new LocalStateStore(join(root, "remote"));
  const sync = new BbsSync({ storage, deviceId: "local", syncLevel: 5, clock: () => now });
  return { root, storage, remote, sync };
}

test("application snapshot replays all explicit deletion kinds after reopening and zero-copy sync", async (t) => {
  const { root, storage, remote, sync } = await fixture(t);
  const changes: StateChange[] = [
    { key: ["favorite", "t"], value: null }, { key: ["view", "t"], value: null },
    { key: ["count", "t"], value: null }, { key: ["metadata", "t"], value: null },
    { key: ["post", "t", 1], value: null }, { key: ["tabs"], value: null },
    { key: ["filter", "scope", "ID", "u"], value: null },
  ];
  await sync.update(changes);
  const snapshot = await sync.getApplicationSnapshot();
  assert.equal(snapshot.entries.length, 7);
  assert.ok(snapshot.entries.every((entry) => entry.value === null && entry.deviceId === "local" && entry.revision === 1));
  await sync.synchronizeWith(remote);
  assert.deepEqual(await sync.synchronizeWith(remote), { copiedToLeft: 0, copiedToRight: 0 });
  const reopened = new BbsSync({ storage: new LocalStateStore(join(root, "local")), deviceId: "local", syncLevel: 5, clock: () => now });
  assert.deepEqual(await reopened.getApplicationSnapshot(), snapshot);
  assert.equal((await sync.getStates()).size, 0);
  assert.equal((await storage.readDocument("local"))!.entries.length, 7);
  const peer = new BbsSync({ storage: remote, deviceId: "peer", syncLevel: 5, clock: () => now });
  assert.deepEqual((await peer.getApplicationSnapshot()).entries, snapshot.entries);
});

test("level and retention omissions do not generate deletions; explicit history deletion never expires", async (t) => {
  const { storage, sync } = await fixture(t);
  await sync.update([
    { key: ["view", "expired"], value: { position: 1, viewedAt: "2020-01-01T00:00:00.000Z" } },
    { key: ["count", "expired"], value: 2 },
    { key: ["view", "deleted"], value: null }, { key: ["count", "deleted"], value: null },
    { key: ["tabs"], value: null },
  ]);
  const level2 = new BbsSync({ storage, deviceId: "local", syncLevel: 2, clock: () => now });
  assert.deepEqual((await level2.getApplicationSnapshot()).entries.map((entry) => entry.key), [["count", "deleted"], ["view", "deleted"]]);
  const level1 = new BbsSync({ storage, deviceId: "local", syncLevel: 1, clock: () => now });
  assert.deepEqual((await level1.getApplicationSnapshot()).entries, []);
  const wide = new BbsSync({ storage, deviceId: "local", syncLevel: 2, historyRetentionMs: Number.MAX_SAFE_INTEGER, clock: () => now });
  assert.ok((await wide.getApplicationSnapshot()).entries.some((entry) => entry.key[1] === "expired" && entry.value !== null));
});

test("an old null is not exposed instead of a newer out-of-period value", async (t) => {
  const { storage, sync } = await fixture(t);
  await storage.writeDocument({ v: 3, deviceId: "old", revision: 1, entries: [{ key: ["view", "t"], value: null, revision: 1 }] });
  await storage.writeDocument({ v: 3, deviceId: "new", revision: 2, entries: [{ key: ["view", "t"],
    value: { position: 1, viewedAt: "2020-01-01T00:00:00.000Z" }, revision: 2 }] });
  assert.deepEqual((await sync.getApplicationSnapshot()).entries, []);
});

test("snapshot uses one document collection and one clock evaluation", async (t) => {
  const { storage } = await fixture(t);
  await storage.writeDocument({ v: 3, deviceId: "a", revision: 1, entries: [{ key: ["favorite", "t"], value: 1, revision: 1 }] });
  let lists = 0, reads = 0, clocks = 0;
  const counted: StateStore = { listDocuments: () => { lists++; return storage.listDocuments(); },
    readDocument: (id) => { reads++; return storage.readDocument(id); }, writeDocument: (doc) => storage.writeDocument(doc) };
  const sync = new BbsSync({ storage: counted, deviceId: "local", syncLevel: 5, clock: () => { clocks++; return now; } });
  const result = await sync.getApplicationSnapshot();
  assert.deepEqual([lists, reads, clocks], [1, 1, 1]);
  assert.equal(result.evaluatedAt, now.toISOString());
  assert.deepEqual(result.policy, { syncLevel: 5, historyRetentionMs: 30 * 86_400_000 });
});

test("journal retry preserves revisions after ambiguous success and later edits", async (t) => {
  const { storage } = await fixture(t);
  let fail = true;
  const ambiguous: StateStore = { listDocuments: () => storage.listDocuments(), readDocument: (id) => storage.readDocument(id),
    async writeDocument(doc) { await storage.writeDocument(doc); if (fail) { fail = false; throw new Error("response lost"); } } };
  const sync = new BbsSync({ storage: ambiguous, deviceId: "local", syncLevel: 5 });
  let prepared: StateDocument | undefined;
  await assert.rejects(() => sync.updateWithJournal([{ key: ["favorite", "t"], value: 1 }], async (doc) => { prepared = doc; }), /response lost/);
  await sync.setFavorite("t", 5);
  const reopened = new BbsSync({ storage, deviceId: "local", syncLevel: 5 });
  await reopened.commitPreparedUpdate(prepared!);
  assert.equal((await reopened.getStates()).get("t")!.favoriteLevel, 5);
  assert.equal((await storage.readDocument("local"))!.revision, 2);
  await assert.rejects(() => reopened.commitPreparedUpdate({ ...prepared!, deviceId: "other" }), /another device/);
});

test("failed journaled writes reserve revisions and restart replay precedes new updates", async (t) => {
  const { storage } = await fixture(t);
  let fail = true;
  const unstable: StateStore = { listDocuments: () => storage.listDocuments(), readDocument: (id) => storage.readDocument(id),
    async writeDocument(doc) { if (fail) { fail = false; throw new Error("offline"); } await storage.writeDocument(doc); } };
  const sync = new BbsSync({ storage: unstable, deviceId: "local", syncLevel: 5 });
  let prepared: StateDocument | undefined;
  await assert.rejects(() => sync.updateWithJournal([{ key: ["favorite", "t"], value: 1 }], async (doc) => { prepared = doc; }));
  await sync.setFavorite("other", 2);
  await sync.commitPreparedUpdate(prepared!);
  const snapshot = await sync.getApplicationSnapshot();
  assert.equal(snapshot.entries.find((entry) => entryKey(entry.key) === entryKey(["favorite", "other"]))!.revision, 2);
  const low = new BbsSync({ storage, deviceId: "local", syncLevel: 1 });
  await assert.rejects(() => low.commitPreparedUpdate({ v: 3, deviceId: "local", revision: 3,
    entries: [{ key: ["tabs"], value: null, revision: 3 }] }), /policy/);
});

test("level 1 can replay a prepared history and favorite removal after membership changed", async (t) => {
  const { storage } = await fixture(t);
  const sync = new BbsSync({ storage, deviceId: "local", syncLevel: 1 });
  await sync.setFavorite("t", 1);
  let prepared: StateDocument | undefined;
  await sync.updateWithJournal([{ key: ["favorite", "t"], value: null }, { key: ["view", "t"], value: null }], async (doc) => { prepared = doc; });
  const reopened = new BbsSync({ storage, deviceId: "local", syncLevel: 1 });
  await reopened.commitPreparedUpdate(prepared!);
  assert.equal((await storage.readDocument("local"))!.revision, 2);
  assert.deepEqual((await reopened.getApplicationSnapshot()).entries.map((entry) => entry.key), [["favorite", "t"]]);
});

test("partial incoming sync can be applied before retry and lower-revision keys still arrive", async (t) => {
  const { storage, remote } = await fixture(t);
  await remote.writeDocument({ v: 3, deviceId: "a", revision: 20,
    entries: [{ key: ["favorite", "t"], value: 1, revision: 20 }] });
  await remote.writeDocument({ v: 3, deviceId: "b", revision: 1,
    entries: [{ key: ["tabs"], value: null, revision: 1 }] });
  let writes = 0;
  const unstable: StateStore = { listDocuments: () => storage.listDocuments(), readDocument: (id) => storage.readDocument(id),
    async writeDocument(doc) { if (++writes === 2) throw new Error("partial sync"); await storage.writeDocument(doc); } };
  const sync = new BbsSync({ storage: unstable, deviceId: "local", syncLevel: 5 });
  await assert.rejects(() => sync.synchronizeWith(remote), /partial sync/);
  assert.equal((await sync.getApplicationSnapshot()).entries.length, 1);
  await sync.synchronizeWith(remote);
  const entries = (await sync.getApplicationSnapshot()).entries;
  assert.equal(entries.length, 2);
  assert.equal(entries.find((entry) => entry.key[0] === "tabs")!.revision, 1);
});
