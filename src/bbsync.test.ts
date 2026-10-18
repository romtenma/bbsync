import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BbsSync, DocumentConflictError, LocalStateStore, entryKey, mergeDocuments,
  synchronizeStores, type StateChange, type StateDocument, type StateStore,
} from "./index.js";

const date = "2026-10-19T00:00:00.000Z";
const thread = "egg.5ch.net/software/123";

async function setup(t: { after: (cleanup: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "bbsync-v3-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stores = ["a", "b", "c"].map((name) => new LocalStateStore(join(root, name)));
  const [a, b, c] = stores.map((storage, index) => new BbsSync({
    storage, deviceId: ["desktop", "mobile", "tablet"][index]!, clock: () => new Date(date),
  }));
  return { a: a!, b: b!, c: c!, left: stores[0]!, right: stores[1]!, third: stores[2]! };
}

test("records every field and projects only active values", async (t) => {
  const { a } = await setup(t);
  assert.deepEqual(await a.getStates(), new Map());
  await a.setThreadMetadata(thread, "Title", "https://egg.5ch.net/test/read.cgi/software/123/");
  await a.recordThreadView(thread, 125, 110);
  await a.recordResponseCount(thread, 130);
  await a.setFavorite(thread, 3);
  await a.recordPost(thread, 126);
  await a.recordPost(thread, 20);
  await a.recordPost(thread, 126);
  await a.setFilter("egg.5ch.net/software", "WORD", "^ng", "HIGHLIGHT", { isRegex: true, hitAt: date });
  assert.deepEqual(await a.getThreadState(thread), {
    threadId: thread, title: "Title", url: "https://egg.5ch.net/test/read.cgi/software/123/",
    lastReadPosition: 125, firstReadPosition: 110, lastViewedAt: date,
    responseCount: 130, favoriteLevel: 3, postPositions: [20, 126],
  });
  assert.deepEqual(await a.getFilters("egg.5ch.net/software"), [{
    scope: "egg.5ch.net/software", targetType: "WORD", target: "^ng", effect: "HIGHLIGHT",
    isRegex: true, updatedAt: date, hitAt: date,
  }]);
  assert.deepEqual(await a.getFilters("other"), []);
  await a.clearThreadHistory(thread);
  assert.deepEqual(await a.getThreadState(thread), {
    threadId: thread, title: "Title", url: "https://egg.5ch.net/test/read.cgi/software/123/",
    favoriteLevel: 3, postPositions: [20, 126],
  });
});

test("latest view and count replace larger values and omitted optional fields", async (t) => {
  const { a } = await setup(t);
  await a.recordThreadView(thread, 100, 80);
  await a.recordResponseCount(thread, 120);
  await a.recordThreadView(thread, 10);
  await a.recordResponseCount(thread, 15);
  assert.deepEqual(await a.getThreadState(thread), {
    threadId: thread, lastReadPosition: 10, lastViewedAt: date, responseCount: 15, postPositions: [],
  });
  await a.clearThreadHistory(thread);
  assert.equal(await a.getThreadState(thread), undefined);
});

test("synchronization converges, is idempotent and preserves independent keys", async (t) => {
  const { a, b, left, right } = await setup(t);
  await a.setFavorite(thread, 3);
  await b.recordPost(thread, 126);
  assert.deepEqual(await a.synchronizeWith(right), { copiedToLeft: 1, copiedToRight: 1 });
  assert.deepEqual(await a.getStates(), await b.getStates());
  assert.deepEqual(await b.getThreadState(thread), { threadId: thread, favoriteLevel: 3, postPositions: [126] });
  assert.deepEqual(await a.synchronizeWith(right), { copiedToLeft: 0, copiedToRight: 0 });
  await a.setFavorite(thread, 5);
  assert.deepEqual(await b.synchronizeWith(left), { copiedToLeft: 1, copiedToRight: 0 });
  assert.equal((await b.getThreadState(thread))?.favoriteLevel, 5);
});

test("null deletes survive stale offline copies and later explicit updates restore them", async (t) => {
  const { a, b, c, left, right, third } = await setup(t);
  await a.recordThreadView(thread, 100);
  await a.recordResponseCount(thread, 120);
  await a.setFavorite(thread);
  await a.recordPost(thread, 99);
  await a.setFilter("scope", "ID", "user", "OMIT");
  await a.synchronizeWith(right);
  await a.synchronizeWith(third);
  await b.clearThreadHistory(thread);
  await b.clearFavorite(thread);
  await b.clearPost(thread, 99);
  await b.clearFilter("scope", "ID", "user");
  await b.synchronizeWith(left);
  await a.synchronizeWith(third);
  for (const client of [a, b, c]) {
    assert.equal(await client.getThreadState(thread), undefined);
    assert.deepEqual(await client.getFilters(), []);
  }
  const tombstones = (await right.readDocument("mobile"))!.entries;
  assert.equal(tombstones.length, 5);
  assert.ok(tombstones.every((entry) => entry.value === null));
  await c.recordPost(thread, 99);
  await c.synchronizeWith(left);
  await a.synchronizeWith(right);
  assert.deepEqual(await a.getThreadState(thread), { threadId: thread, postPositions: [99] });
  assert.deepEqual(await a.getStates(), await b.getStates());
});

test("logical revisions preserve observed order despite clock reversal or future timestamps", async (t) => {
  const { left, right } = await setup(t);
  const a = new BbsSync({ storage: left, deviceId: "desktop", clock: () => new Date("2099-01-01T00:00:00.000Z") });
  const b = new BbsSync({ storage: right, deviceId: "mobile", clock: () => new Date("2000-01-01T00:00:00.000Z") });
  await a.setFilter("scope", "ID", "user", "OMIT");
  await a.synchronizeWith(right);
  await b.setFilter("scope", "ID", "user", "NOP");
  await b.synchronizeWith(left);
  assert.equal((await a.getFilters())[0]?.effect, "NOP");
  assert.equal((await right.readDocument("mobile"))!.revision, 2);
});

test("item revisions determine conflicts independently of document revisions", () => {
  const a: StateDocument = { v: 3, deviceId: "device-a", revision: 100, entries: [
    { key: ["favorite", thread], value: 1, revision: 1 },
    { key: ["count", thread], value: 20, revision: 100 },
  ] };
  const b: StateDocument = { v: 3, deviceId: "device_b", revision: 2, entries: [
    { key: ["favorite", thread], value: 5, revision: 2 },
  ] };
  const c: StateDocument = { v: 3, deviceId: "device-c", revision: 2, entries: [
    { key: ["favorite", thread], value: null, revision: 2 },
  ] };
  for (const documents of [[a, b, c], [c, b, a], [b, a, c], [a, b, c, b, a]]) {
    const merged = mergeDocuments(documents);
    assert.equal(merged.get(entryKey(["favorite", thread]))?.value, 5);
    assert.deepEqual(merged, mergeDocuments([a, b, c]));
  }
});

test("batch updates are atomic, use one revision, and serialize rapid local changes", async (t) => {
  const { a, left } = await setup(t);
  await a.update([
    { key: ["favorite", thread], value: 2 },
    { key: ["post", thread, 10], value: true },
  ]);
  assert.ok((await left.readDocument("desktop"))!.entries.every((entry) => entry.revision === 1));
  await Promise.all(Array.from({ length: 20 }, (_, n) => a.recordPost(thread, n + 1)));
  assert.equal((await left.readDocument("desktop"))!.revision, 21);
  assert.equal((await a.getThreadState(thread))!.postPositions.length, 20);
  const unchanged = await left.readDocument("desktop");
  await a.update([]);
  await assert.rejects(() => a.update([
    { key: ["favorite", thread], value: 1 }, { key: ["favorite", thread], value: null },
  ]), /duplicate/);
  assert.deepEqual(await left.readDocument("desktop"), unchanged);
});

test("updates recover from failed storage writes without losing previous state", async (t) => {
  const { left } = await setup(t);
  let fail = true;
  const storage: StateStore = {
    listDocuments: () => left.listDocuments(), readDocument: (id) => left.readDocument(id),
    writeDocument: (doc) => { if (fail) { fail = false; return Promise.reject(new Error("offline")); } return left.writeDocument(doc); },
  };
  const client = new BbsSync({ storage, deviceId: "desktop" });
  await assert.rejects(() => client.setFavorite(thread, 3), /offline/);
  await client.setFavorite(thread, 5);
  assert.equal((await client.getThreadState(thread))?.favoriteLevel, 5);
  assert.equal((await left.readDocument("desktop"))!.revision, 1);
});

test("sync detects forks before copying any documents", async (t) => {
  const { a, b, left, right } = await setup(t);
  await a.setFavorite(thread, 3);
  await right.writeDocument({ v: 3, deviceId: "desktop", revision: 1,
    entries: [{ key: ["favorite", thread], value: 5, revision: 1 }] });
  await b.recordPost(thread, 10);
  await assert.rejects(() => synchronizeStores(left, right), DocumentConflictError);
  assert.deepEqual(await left.listDocuments(), ["desktop"]);
});

test("newer forked documents cannot silently discard deletions", async (t) => {
  const { a, left, right } = await setup(t);
  await a.clearFavorite(thread);
  await right.writeDocument({ v: 3, deviceId: "desktop", revision: 2,
    entries: [{ key: ["post", thread, 10], value: true, revision: 2 }] });
  await assert.rejects(() => synchronizeStores(left, right), DocumentConflictError);
});

test("validation rejects malformed values and exhausted logical revisions", async (t) => {
  const { a, left } = await setup(t);
  const invalid: unknown[] = [
    { key: ["view", thread], value: { position: 2, firstPosition: 3, viewedAt: date } },
    { key: ["view", thread], value: { position: 2, viewedAt: "2026-02-30T00:00:00.000Z" } },
    { key: ["metadata", thread], value: { title: "title", url: "/relative" } },
    { key: ["post", thread, 0], value: true },
    { key: ["filter", "s", "ID", "x"], value: { effect: "OMIT", isRegex: false, updatedAt: date, hitAt: null } },
    { key: ["count", thread], value: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const change of invalid) await assert.rejects(() => a.update([change as StateChange]), TypeError);
  await left.writeDocument({ v: 3, deviceId: "mobile", revision: Number.MAX_SAFE_INTEGER,
    entries: [{ key: ["favorite", thread], value: 1, revision: Number.MAX_SAFE_INTEGER }] });
  await assert.rejects(() => a.setFavorite(thread), /revision exhausted/);
  assert.equal(await left.readDocument("desktop"), undefined);
});

test("filter tuple keys remain distinct when their strings contain separators", async (t) => {
  const { a } = await setup(t);
  await a.setFilter("a/b", "c", "d", "OMIT");
  await a.setFilter("a", "b/c", "d", "NOP");
  assert.equal((await a.getFilters()).length, 2);
  await a.clearFilter("a/b", "c", "d");
  assert.equal((await a.getFilters())[0]?.effect, "NOP");
});

test("typed setting helpers reject explicit null instead of performing a deletion", async (t) => {
  const { a } = await setup(t);
  await a.setFavorite(thread, 3);
  await assert.rejects(() => a.setFavorite(thread, null as never), TypeError);
  await assert.rejects(() => a.recordResponseCount(thread, null as never), TypeError);
  await assert.rejects(() => a.setFilter("s", "ID", "x", "OMIT", { isRegex: null as never }), TypeError);
  await assert.rejects(() => a.setFilter("s", "ID", "x", "OMIT", { updatedAt: null as never }), TypeError);
  assert.equal((await a.getThreadState(thread))?.favoriteLevel, 3);
});
