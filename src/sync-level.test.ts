import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BbsSync, DEFAULT_HISTORY_RETENTION_MS, DocumentConflictError, LocalStateStore,
  type StateChange, type StateDocument, type SyncLevel, type TabState,
} from "./index.js";

const now = new Date("2026-10-19T00:00:00.000Z");
const days = (count: number) => new Date(now.getTime() - count * 86_400_000).toISOString();
const tabs: TabState = { groups: [{ id: "group-1", name: "News" }], tabs: [
  { id: "tab-1", threadId: "tabbed", groupId: "group-1" }, { id: "tab-2", threadId: "recent" },
] };
const filter = { effect: "OMIT", isRegex: false, updatedAt: now.toISOString() };

function document(changes: readonly StateChange[], revision = 1, deviceId = "remote"): StateDocument {
  return { v: 3, deviceId, revision, entries: changes.map((change) => ({ ...change, revision })) };
}

function sample(): StateDocument {
  return document([
    { key: ["favorite", "fav"], value: 3 },
    { key: ["view", "fav"], value: { position: 100, viewedAt: days(90) } },
    { key: ["count", "fav"], value: 120 },
    { key: ["metadata", "fav"], value: { title: "Favorite", url: "https://example.com/fav" } },
    { key: ["view", "recent"], value: { position: 10, viewedAt: days(1) } },
    { key: ["count", "recent"], value: 15 },
    { key: ["metadata", "recent"], value: { title: "Recent", url: "https://example.com/recent" } },
    { key: ["view", "old"], value: { position: 20, viewedAt: days(40) } },
    { key: ["count", "old"], value: 25 },
    { key: ["metadata", "old"], value: { title: "Old", url: "https://example.com/old" } },
    { key: ["filter", "scope", "ID", "user"], value: filter },
    { key: ["tabs"], value: tabs },
    { key: ["metadata", "tabbed"], value: { title: "Tab", url: "https://example.com/tab" } },
    { key: ["post", "posted", 10], value: true },
    { key: ["metadata", "posted"], value: { title: "Post", url: "https://example.com/post" } },
  ]);
}

async function setup(t: { after: (cleanup: () => Promise<void>) => void }, level: SyncLevel, retention?: number) {
  const root = await mkdtemp(join(tmpdir(), "bbsync-level-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = new LocalStateStore(join(root, "local"));
  const remote = new LocalStateStore(join(root, "remote"));
  const client = new BbsSync({ storage: local, deviceId: "local", syncLevel: level,
    ...(retention === undefined ? {} : { historyRetentionMs: retention }), clock: () => now });
  return { local, remote, client };
}

for (const level of [1, 2, 3, 4, 5] as const) {
  test(`level ${level} transfers and exposes only cumulative supported data`, async (t) => {
    const { local, remote, client } = await setup(t, level);
    await remote.writeDocument(sample());
    const before = await remote.readDocument("remote");
    await client.synchronizeWith(remote);
    assert.deepEqual(await remote.readDocument("remote"), before);
    const states = await client.getStates();
    assert.equal(states.get("fav")?.lastReadPosition, 100);
    assert.equal(states.has("recent"), level >= 2);
    assert.equal(states.has("old"), false);
    assert.equal(states.has("tabbed"), level >= 4);
    assert.equal(states.has("posted"), level >= 5);
    assert.equal(Object.hasOwn(states.get("fav")!, "postPositions"), level >= 5);
    assert.deepEqual(await client.getFilters(), level >= 3 ? [{ scope: "scope", targetType: "ID", target: "user", ...filter }] : undefined);
    assert.deepEqual(await client.getTabs(), level >= 4 ? tabs : undefined);
    const entries = (await local.readDocument("remote"))!.entries;
    assert.equal(entries.some((entry) => entry.key[0] === "filter"), level >= 3);
    assert.equal(entries.some((entry) => entry.key[0] === "tabs"), level >= 4);
    assert.equal(entries.some((entry) => entry.key[0] === "post"), level >= 5);
    assert.equal(entries.some((entry) => entry.key[1] === "old"), false);
    assert.deepEqual(await client.synchronizeWith(remote), { copiedToLeft: 0, copiedToRight: 0 });
  });
}

test("level 1 ignores unrelated history and upper-level deletions without advancing revision", async (t) => {
  const { local, client } = await setup(t, 1);
  await client.update([
    { key: ["view", "other"], value: { position: 10, viewedAt: now.toISOString() } },
    { key: ["metadata", "other"], value: { title: "Other", url: "https://example.com/other" } },
    { key: ["count", "other"], value: 10 },
    { key: ["filter", "scope", "ID", "user"], value: null },
    { key: ["tabs"], value: null },
    { key: ["post", "other", 10], value: null },
  ]);
  assert.equal(await local.readDocument("local"), undefined);
  await client.update([
    { key: ["view", "fav"], value: { position: 5, viewedAt: now.toISOString() } },
    { key: ["favorite", "fav"], value: 2 },
  ]);
  assert.equal((await client.getThreadState("fav"))?.lastReadPosition, 5);
  await client.clearFavorite("fav");
  const before = await local.readDocument("local");
  await client.clearThreadHistory("fav");
  assert.deepEqual(await local.readDocument("local"), before);
  assert.equal(await client.getThreadState("fav"), undefined);
});

test("lowering the level preserves existing upper-level values and their revisions", async (t) => {
  const { local, remote } = await setup(t, 5);
  await local.writeDocument({ ...sample(), deviceId: "local" });
  const before = (await local.readDocument("local"))!.entries;
  const low = new BbsSync({ storage: local, deviceId: "local", syncLevel: 1, clock: () => now });
  await low.clearFilter("scope", "ID", "user");
  await low.clearPost("posted", 10);
  await low.clearTabs();
  assert.deepEqual((await local.readDocument("local"))!.entries, before);
  await low.recordThreadView("fav", 50);
  await low.synchronizeWith(remote);
  const after = (await local.readDocument("local"))!.entries;
  for (const entry of before.filter((entry) => entry.key[0] === "filter" || entry.key[0] === "tabs" || entry.key[0] === "post")) {
    assert.deepEqual(after.find((candidate) => JSON.stringify(candidate.key) === JSON.stringify(entry.key)), entry);
  }
  assert.ok((await remote.readDocument("local"))!.entries.every((entry) => entry.key[1] === "fav"));
});

test("raising the level imports missing items even when they have older revisions", async (t) => {
  const { local, remote, client } = await setup(t, 1);
  await remote.writeDocument(sample());
  await client.synchronizeWith(remote);
  await client.recordThreadView("fav", 101);
  await client.synchronizeWith(remote);
  const high = new BbsSync({ storage: local, deviceId: "local", syncLevel: 5, clock: () => now });
  await high.synchronizeWith(remote);
  assert.deepEqual(await high.getTabs(), tabs);
  assert.equal((await high.getFilters())!.length, 1);
  assert.deepEqual((await high.getThreadState("posted"))?.postPositions, [10]);
  assert.equal((await high.getThreadState("fav"))?.lastReadPosition, 101);
  assert.deepEqual(await high.synchronizeWith(remote), { copiedToLeft: 0, copiedToRight: 0 });
});

test("history cutoff is inclusive, configurable, and never deletes saved data", async (t) => {
  const { local, remote, client } = await setup(t, 2);
  assert.equal(client.historyRetentionMs, DEFAULT_HISTORY_RETENTION_MS);
  await local.writeDocument(document([
    { key: ["view", "edge"], value: { position: 1, viewedAt: days(30) } },
    { key: ["view", "expired"], value: { position: 2, viewedAt: new Date(Date.parse(days(30)) - 1).toISOString() } },
    { key: ["view", "old"], value: { position: 3, viewedAt: days(40) } },
    { key: ["view", "future"], value: { position: 4, viewedAt: days(-1) } },
  ]));
  const before = await local.readDocument("remote");
  assert.deepEqual([...(await client.getStates()).keys()], ["edge"]);
  await client.synchronizeWith(remote);
  assert.deepEqual(await local.readDocument("remote"), before);
  const wide = new BbsSync({ storage: local, deviceId: "local", syncLevel: 2, historyRetentionMs: 60 * 86_400_000, clock: () => now });
  assert.equal((await wide.getStates()).size, 3);
  await wide.synchronizeWith(remote);
  assert.equal((await remote.readDocument("remote"))!.entries.length, 3);
});

test("recent history deletion is transferred even when the current view is null", async (t) => {
  const { local, remote, client } = await setup(t, 2);
  await remote.writeDocument(document([
    { key: ["view", "recent"], value: { position: 10, viewedAt: days(1) } },
    { key: ["count", "recent"], value: 15 },
    { key: ["metadata", "recent"], value: { title: "Recent", url: "https://example.com/recent" } },
  ]));
  await client.synchronizeWith(remote);
  await client.clearThreadHistory("recent");
  assert.equal(await client.getThreadState("recent"), undefined);
  await client.synchronizeWith(remote);
  const peer = new BbsSync({ storage: remote, deviceId: "peer", syncLevel: 2, clock: () => now });
  assert.equal(await peer.getThreadState("recent"), undefined);
  assert.ok((await remote.readDocument("local"))!.entries.every((entry) => entry.value === null));
  assert.ok((await local.readDocument("remote"))!.entries.some((entry) => entry.key[0] === "metadata"));
});

test("unsupported conflicts are preserved and only checked when their level is enabled", async (t) => {
  const { local, remote, client } = await setup(t, 1);
  await local.writeDocument(document([
    { key: ["filter", "scope", "ID", "user"], value: filter }, { key: ["favorite", "fav"], value: 1 },
  ]));
  await remote.writeDocument({ v: 3, deviceId: "remote", revision: 2, entries: [
    { key: ["filter", "scope", "ID", "user"], value: { ...filter, effect: "NOP" }, revision: 1 },
    { key: ["favorite", "fav"], value: 3, revision: 2 },
  ] });
  const beforeLeft = await local.readDocument("remote");
  const beforeRight = await remote.readDocument("remote");
  assert.deepEqual(await client.synchronizeWith(remote), { copiedToLeft: 1, copiedToRight: 0 });
  assert.equal((await client.getThreadState("fav"))?.favoriteLevel, 3);
  assert.deepEqual((await local.readDocument("remote"))!.entries.find((entry) => entry.key[0] === "filter"),
    beforeLeft!.entries.find((entry) => entry.key[0] === "filter"));
  assert.deepEqual(await remote.readDocument("remote"), beforeRight);
  const high = new BbsSync({ storage: local, deviceId: "local", syncLevel: 3, clock: () => now });
  await assert.rejects(() => high.synchronizeWith(remote), DocumentConflictError);
});

test("history deletion from the same writer uses the peer's older timestamp", async (t) => {
  const { local, remote, client } = await setup(t, 2);
  await remote.writeDocument(document([{ key: ["view", "recent"], value: { position: 10, viewedAt: days(1) } }]));
  await client.synchronizeWith(remote);
  const writer = new BbsSync({ storage: local, deviceId: "remote", syncLevel: 2, clock: () => now });
  await writer.clearThreadHistory("recent");
  await writer.synchronizeWith(remote);
  assert.deepEqual((await remote.readDocument("remote"))!.entries.map((entry) => entry.value), [null, null]);
  assert.deepEqual(await writer.synchronizeWith(remote), { copiedToLeft: 0, copiedToRight: 0 });
});

test("tabs and groups synchronize as one ordered value and remain untouched below level 4", async (t) => {
  const { local, remote } = await setup(t, 4);
  const high = new BbsSync({ storage: local, deviceId: "local", syncLevel: 4, clock: () => now });
  await high.setTabs(tabs);
  await high.synchronizeWith(remote);
  const peer = new BbsSync({ storage: remote, deviceId: "peer", syncLevel: 4, clock: () => now });
  assert.deepEqual(await peer.getTabs(), tabs);
  await peer.setTabs({ ...tabs, tabs: [...tabs.tabs].reverse() });
  await peer.synchronizeWith(local);
  assert.deepEqual((await high.getTabs())?.tabs, [...tabs.tabs].reverse());
  await peer.clearTabs();
  await peer.synchronizeWith(local);
  assert.equal(await high.getTabs(), undefined);
  await assert.rejects(() => high.setTabs({ groups: [], tabs: [{ id: "t", threadId: "thread", groupId: "missing" }] }), TypeError);
  await assert.rejects(() => high.setTabs({ groups: [], tabs: [{ id: "t", threadId: "a" }, { id: "t", threadId: "b" }] }), TypeError);
});

test("clients require a valid explicit level and a non-negative history period", async (t) => {
  const { local } = await setup(t, 1);
  for (const syncLevel of [undefined, 0, 6, 1.5, NaN]) {
    assert.throws(() => new BbsSync({ storage: local, deviceId: "local", syncLevel: syncLevel as SyncLevel }), TypeError);
  }
  assert.throws(() => new BbsSync({ storage: local, deviceId: "local", syncLevel: 2, historyRetentionMs: -1 }), TypeError);
});
