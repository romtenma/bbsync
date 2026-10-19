import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BbsSync, LocalStateStore, entryKey, type StateDocument } from "./index.js";
import { HttpStateStore, InitializationError, startStateStoreServer } from "./http.js";

const example = await import(new URL("../examples/adapter/adapter.mjs", import.meta.url).href);
const { AdapterDatabase, Adapter, applySnapshot, initializeFromLocal } = example;

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "bbsync-adapter-"));
  const server = await startStateStoreServer({ rootDirectory: join(root, "remote"), token: "test" });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const db = await AdapterDatabase.open(join(root, "db.json"), "local");
  const local = new LocalStateStore(join(root, "local"));
  const sync = new BbsSync({ storage: local, deviceId: "local", syncLevel: 5 });
  const remote = new HttpStateStore({ url: server.url, token: "test" });
  return { root, db, local, sync, remote };
}
const favorite = (value: 1 | 5 | null) => ({ key: ["favorite", "t"] as const, value });

test("adapter atomically applies receipts, retries failed DB transactions and preserves concurrent user edits", async (t) => {
  const { db, sync } = await fixture(t);
  await sync.setFavorite("t", 1);
  const snapshot = await sync.getApplicationSnapshot();
  const transaction = db.transaction.bind(db);
  let fail = true;
  db.transaction = (fn: (state: unknown) => unknown) => transaction(async (state: unknown) => {
    await fn(state); if (fail) { fail = false; throw new Error("DB failed"); }
  });
  await assert.rejects(() => applySnapshot(db, snapshot), /DB failed/);
  assert.deepEqual((await db.read()).receipts, {});
  await applySnapshot(db, snapshot);
  assert.equal((await db.read()).rows[entryKey(["favorite", "t"])].value, 1);
  await db.userUpdate([favorite(5)]);
  await applySnapshot(db, snapshot);
  assert.equal((await db.read()).rows[entryKey(["favorite", "t"])].value, 5);
  await new Adapter(sync, db).flush();
  await applySnapshot(db, snapshot); // Old receive cannot undo an already flushed edit.
  assert.equal((await db.read()).rows[entryKey(["favorite", "t"])].value, 5);
  assert.equal((await db.read()).outbox.length, 0);
});

test("adapter restarts a saved outbox document without generating another revision", async (t) => {
  const { root, db, local } = await fixture(t);
  let fail = true;
  const sync = new BbsSync({ deviceId: "local", syncLevel: 5, storage: {
    listDocuments: () => local.listDocuments(), readDocument: (id) => local.readDocument(id),
    async writeDocument(doc) { await local.writeDocument(doc); if (fail) { fail = false; throw new Error("lost response"); } },
  } });
  await db.userUpdate([favorite(1)]);
  await assert.rejects(() => new Adapter(sync, db).flush(), /lost response/);
  const reopened = await AdapterDatabase.open(join(root, "db.json"));
  await new Adapter(new BbsSync({ deviceId: "local", syncLevel: 5, storage: local }), reopened).flush();
  assert.equal((await local.readDocument("local"))!.revision, 1);
  assert.equal((await reopened.read()).outbox.length, 0);
});

test("initial import resumes after completion response loss without overwriting later remote edits", async (t) => {
  const { root, db, local, sync, remote } = await fixture(t);
  await db.seedLocal([favorite(1)]);
  const ambiguous = {
    beginInitialization: remote.beginInitialization.bind(remote), withInitialization: remote.withInitialization.bind(remote),
    async finishInitialization(session: string) { await remote.finishInitialization(session); throw new Error("lost completion"); },
  };
  await assert.rejects(() => initializeFromLocal(sync, ambiguous, db), /lost completion/);
  const document: StateDocument = { v: 3, deviceId: "other", revision: 10, entries: [{ ...favorite(5), revision: 10 }] };
  await remote.writeDocument(document);
  const reopened = await AdapterDatabase.open(join(root, "db.json"));
  const restarted = new BbsSync({ storage: local, deviceId: "local", syncLevel: 5 });
  await initializeFromLocal(restarted, remote, reopened);
  await new Adapter(restarted, reopened).synchronize(remote);
  assert.equal((await reopened.read()).rows[entryKey(["favorite", "t"])].value, 5);
  assert.equal((await local.readDocument("local"))!.revision, 1);
});

test("additional client receives remote deletion and does not import old local values", async (t) => {
  const { db, sync, remote } = await fixture(t);
  await db.seedLocal([favorite(1)]);
  await remote.writeDocument({ v: 3, deviceId: "other", revision: 2, entries: [{ ...favorite(null), revision: 2 }] });
  await new Adapter(sync, db).synchronize(remote);
  assert.equal((await db.read()).rows[entryKey(["favorite", "t"])], undefined);
  assert.equal(await remote.readDocument("local"), undefined);
});

test("raising adapter level receives an older-revision deletion without clearing omitted local values", async (t) => {
  const { db, local, remote } = await fixture(t);
  const key = ["filter", "scope", "ID", "user"] as const;
  await db.seedLocal([{ key, value: { effect: "OMIT", isRegex: false, updatedAt: "2026-10-19T00:00:00.000Z" } },
    { key: ["favorite", "local-only"], value: 1 }]);
  await remote.writeDocument({ v: 3, deviceId: "other", revision: 20, entries: [
    { key: ["favorite", "remote"], value: 1, revision: 20 }, { key, value: null, revision: 1 },
  ] });
  const low = new BbsSync({ storage: local, deviceId: "local", syncLevel: 1 });
  await new Adapter(low, db).synchronize(remote);
  assert.ok((await db.read()).rows[entryKey(key)]);
  const high = new BbsSync({ storage: local, deviceId: "local", syncLevel: 3 });
  await new Adapter(high, db).synchronize(remote);
  const state = await db.read();
  assert.equal(state.rows[entryKey(key)], undefined);
  assert.equal(state.receipts[entryKey(key)].revision, 1);
  assert.ok(state.rows[entryKey(["favorite", "local-only"])]);
  assert.equal(await remote.readDocument("local"), undefined);
});

test("rejected initial seeding can subsequently join an existing store without sending old values", async (t) => {
  const { db, sync, remote } = await fixture(t);
  await db.seedLocal([favorite(1)]);
  await remote.writeDocument({ v: 3, deviceId: "other", revision: 2, entries: [{ ...favorite(5), revision: 2 }] });
  await assert.rejects(() => initializeFromLocal(sync, remote, db), InitializationError);
  assert.equal((await db.read()).initialization, null);
  await new Adapter(sync, db).synchronize(remote);
  assert.equal((await db.read()).rows[entryKey(["favorite", "t"])].value, 5);
  assert.equal(await remote.readDocument("local"), undefined);
});
