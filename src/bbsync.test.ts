import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BbsSync } from "./bbsync.js";
import { LocalEventStore } from "./local-event-store.js";
import {
  projectDetailedThreadStates,
  projectFilterStates,
} from "./project.js";
import type { SyncEvent } from "./types.js";

test("projects bulletin-board state from JSONL events", async () => {
  const fixture = await createFixture();
  try {
    const sync = createSync(fixture.left, "desktop", "2026-09-20T00:00:00Z");
    await sync.append([
      { type: "thread.viewed", threadId: "example/thread-1", position: 10 },
      { type: "thread.viewed", threadId: "example/thread-1", position: 8 },
      {
        type: "thread.response-count.observed",
        threadId: "example/thread-1",
        responseCount: 15,
      },
      {
        type: "thread.response-count.observed",
        threadId: "example/thread-1",
        responseCount: 14,
      },
      { type: "thread.favorite.set", threadId: "example/thread-1", level: 3 },
      { type: "thread.post.recorded", threadId: "example/thread-1", position: 11 },
      { type: "thread.post.recorded", threadId: "example/thread-1", position: 11 },
    ]);

    assert.deepEqual(await sync.getThreadState("example/thread-1"), {
      threadId: "example/thread-1",
      lastReadPosition: 10,
      responseCount: 15,
      lastViewedAt: "2026-09-20T00:00:00.000Z",
      favoriteLevel: 3,
      postPositions: [11],
    });
  } finally {
    await fixture.cleanup();
  }
});

test("clears a post position and keeps the deletion marker through sync and compaction", async () => {
  const fixture = await createFixture(1, 0);
  try {
    const desktop = createSync(fixture.left, "desktop", "2026-09-20T00:00:00Z");
    const mobile = createSync(fixture.right, "mobile", "2026-09-20T00:00:00Z");

    await desktop.recordPost("thread-1", 11);
    const cleared = await desktop.clearPost("thread-1", 11);
    assert.equal(cleared.type, "thread.post.cleared");
    assert.deepEqual(await desktop.getThreadState("thread-1"), {
      threadId: "thread-1",
      postPositions: [],
    });

    const snapshot = await desktop.compact();
    assert.deepEqual(snapshot.threads[0]?.postCleared, [{
      position: 11,
      occurredAt: "2026-09-20T00:00:00.000Z",
      deviceId: "desktop",
      eventId: "id-desktop-2",
    }]);

    await mobile.append([{
      type: "thread.post.recorded",
      threadId: "thread-1",
      position: 11,
      occurredAt: "2026-09-19T23:59:00.000Z",
    }]);
    await desktop.synchronizeWith(mobile.storage);
    assert.deepEqual(await desktop.getThreadState("thread-1"), {
      threadId: "thread-1",
      postPositions: [],
    });

    await desktop.append([{
      type: "thread.post.recorded",
      threadId: "thread-1",
      position: 11,
      occurredAt: "2026-09-20T00:01:00.000Z",
    }]);
    assert.deepEqual(await desktop.getThreadState("thread-1"), {
      threadId: "thread-1",
      postPositions: [11],
    });
  } finally {
    await fixture.cleanup();
  }
});

test("clears synchronized thread history without removing favorites or posts", async () => {
  const fixture = await createFixture();
  try {
    const desktop = createSync(fixture.left, "desktop", "2026-09-20T00:00:00Z");
    const mobile = createSync(fixture.right, "mobile", "2026-09-20T00:00:00Z");

    await desktop.append([
      {
        type: "thread.viewed",
        threadId: "thread-1",
        position: 20,
        occurredAt: "2026-09-20T00:00:00.000Z",
      },
      { type: "thread.favorite.set", threadId: "thread-1", level: 3 },
      { type: "thread.post.recorded", threadId: "thread-1", position: 21 },
      {
        type: "thread.history.cleared",
        threadId: "thread-1",
        occurredAt: "2026-09-20T00:01:00.000Z",
      },
    ]);

    assert.deepEqual(await desktop.getThreadState("thread-1"), {
      threadId: "thread-1",
      favoriteLevel: 3,
      postPositions: [21],
    });

    await desktop.synchronizeWith(mobile.storage);
    assert.deepEqual(await mobile.getThreadState("thread-1"), {
      threadId: "thread-1",
      favoriteLevel: 3,
      postPositions: [21],
    });

    await mobile.append([{
      type: "thread.viewed",
      threadId: "thread-1",
      position: 19,
      occurredAt: "2026-09-20T00:00:30.000Z",
    }]);
    await desktop.synchronizeWith(mobile.storage);
    assert.deepEqual(await desktop.getThreadState("thread-1"), {
      threadId: "thread-1",
      favoriteLevel: 3,
      postPositions: [21],
    });

    await mobile.append([{
      type: "thread.viewed",
      threadId: "thread-1",
      position: 4,
      occurredAt: "2026-09-20T00:02:00.000Z",
    }]);
    await desktop.synchronizeWith(mobile.storage);
    assert.deepEqual(await desktop.getThreadState("thread-1"), {
      threadId: "thread-1",
      lastReadPosition: 4,
      lastViewedAt: "2026-09-20T00:02:00.000Z",
      favoriteLevel: 3,
      postPositions: [21],
    });
  } finally {
    await fixture.cleanup();
  }
});

test("keeps a history deletion marker through compaction", async () => {
  const fixture = await createFixture(1, 0);
  try {
    const desktop = createSync(fixture.left, "desktop", "2026-09-20T00:00:00Z");
    const mobile = createSync(fixture.right, "mobile", "2026-09-20T00:00:00Z");
    await desktop.append([
      {
        type: "thread.viewed",
        threadId: "thread-1",
        position: 12,
        occurredAt: "2026-09-20T00:00:00.000Z",
      },
      {
        type: "thread.history.cleared",
        threadId: "thread-1",
        occurredAt: "2026-09-20T00:01:00.000Z",
      },
    ]);

    const snapshot = await desktop.compact();
    assert.deepEqual(snapshot.threads[0]?.historyCleared, {
      occurredAt: "2026-09-20T00:01:00.000Z",
      deviceId: "desktop",
      eventId: "id-desktop-2",
    });
    assert.equal(await desktop.getThreadState("thread-1"), undefined);

    await desktop.synchronizeWith(mobile.storage);
    assert.equal(await mobile.getThreadState("thread-1"), undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("syncs thread title and URL without changing the thread key", async () => {
  const fixture = await createFixture();
  try {
    const desktop = createSync(fixture.left, "desktop", "2026-09-20T00:00:00Z");
    const mobile = createSync(fixture.right, "mobile", "2026-09-20T00:01:00Z");

    const event = await desktop.setThreadMetadata(
      "egg.5ch.net/software/1234567890",
      "最初のタイトル",
      "https://egg.5ch.net/test/read.cgi/software/1234567890/",
    );
    assert.equal(event.v, 2);
    assert.equal(event.type, "thread.metadata.updated");
    assert.equal(event.threadId, "egg.5ch.net/software/1234567890");

    await desktop.synchronizeWith(mobile.storage);
    assert.deepEqual(
      await mobile.getThreadState("egg.5ch.net/software/1234567890"),
      {
        threadId: "egg.5ch.net/software/1234567890",
        title: "最初のタイトル",
        url: "https://egg.5ch.net/test/read.cgi/software/1234567890/",
        postPositions: [],
      },
    );

    await mobile.setThreadMetadata(
      "egg.5ch.net/software/1234567890",
      "更新後のタイトル",
      "https://egg.5ch.net/test/read.cgi/software/1234567890/",
    );
    await desktop.synchronizeWith(mobile.storage);

    const expected = {
      threadId: "egg.5ch.net/software/1234567890",
      title: "更新後のタイトル",
      url: "https://egg.5ch.net/test/read.cgi/software/1234567890/",
      postPositions: [],
    };
    assert.deepEqual(await desktop.getThreadState("egg.5ch.net/software/1234567890"), expected);
    assert.deepEqual(await mobile.getThreadState("egg.5ch.net/software/1234567890"), expected);
  } finally {
    await fixture.cleanup();
  }
});

test("preserves thread metadata conflict information through compaction", async () => {
  const fixture = await createFixture(1, 0);
  try {
    const desktop = createSync(fixture.left, "desktop", "2026-09-20T00:01:00Z");
    const offline = createSync(fixture.right, "mobile", "2026-09-20T00:00:00Z");
    await desktop.setThreadMetadata(
      "thread-1",
      "新しいタイトル",
      "https://example.com/thread/1",
    );
    const snapshot = await desktop.compact();
    assert.deepEqual(snapshot.threads[0]?.metadata, {
      title: "新しいタイトル",
      url: "https://example.com/thread/1",
      occurredAt: "2026-09-20T00:01:00.000Z",
      deviceId: "desktop",
      eventId: "id-desktop-1",
    });

    await offline.setThreadMetadata(
      "thread-1",
      "古いタイトル",
      "https://example.net/old-thread/1",
    );
    await desktop.synchronizeWith(offline.storage);

    assert.deepEqual(await desktop.getThreadState("thread-1"), {
      threadId: "thread-1",
      title: "新しいタイトル",
      url: "https://example.com/thread/1",
      postPositions: [],
    });
  } finally {
    await fixture.cleanup();
  }
});

test("validates thread metadata", async () => {
  const fixture = await createFixture();
  try {
    const sync = createSync(fixture.left, "desktop", "2026-09-20T00:00:00Z");
    await assert.rejects(
      () => sync.setThreadMetadata("thread-1", "", "https://example.com/thread/1"),
      /title must be a non-empty string/,
    );
    await assert.rejects(
      () => sync.setThreadMetadata("thread-1", "タイトル", "/thread/1"),
      /url must be an absolute URL/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("defaults an omitted favorite level to one", async () => {
  const fixture = await createFixture();
  try {
    const sync = createSync(fixture.left, "desktop", "2026-09-20T00:00:00Z");
    const event = await sync.setFavorite("thread-1");
    assert.equal(event.type, "thread.favorite.set");
    assert.equal(event.level, 1);
    assert.deepEqual(await sync.getThreadState("thread-1"), {
      threadId: "thread-1",
      favoriteLevel: 1,
      postPositions: [],
    });
    await assert.rejects(() => sync.setFavorite("thread-1", 0 as never), /1 to 5/);
    await assert.rejects(() => sync.setFavorite("thread-1", 6 as never), /1 to 5/);
    const cleared = await sync.clearFavorite("thread-1");
    assert.equal(cleared.type, "thread.favorite.cleared");
    assert.deepEqual(await sync.getThreadState("thread-1"), {
      threadId: "thread-1",
      postPositions: [],
    });
  } finally {
    await fixture.cleanup();
  }
});

test("synchronizes rotated segments in both directions", async () => {
  const fixture = await createFixture();
  try {
    const desktop = createSync(fixture.left, "desktop", "2026-09-20T00:00:00Z");
    const mobile = createSync(fixture.right, "mobile", "2026-09-20T00:01:00Z");

    await desktop.recordThreadView("example/thread-1", 20);
    await desktop.setFavorite("example/thread-1", 3);
    await mobile.recordThreadView("example/thread-1", 25);
    await mobile.setFavorite("example/thread-1", 2);
    await mobile.recordPost("example/thread-1", 26);

    assert.deepEqual(await desktop.synchronizeWith(mobile.storage), {
      copiedToLeft: 1,
      copiedToRight: 1,
      copiedSnapshotsToLeft: 0,
      copiedSnapshotsToRight: 0,
    });
    assert.deepEqual(await desktop.synchronizeWith(mobile.storage), {
      copiedToLeft: 0,
      copiedToRight: 0,
      copiedSnapshotsToLeft: 0,
      copiedSnapshotsToRight: 0,
    });

    const expected = {
      threadId: "example/thread-1",
      lastReadPosition: 25,
      lastViewedAt: "2026-09-20T00:01:00.000Z",
      favoriteLevel: 2,
      postPositions: [26],
    };
    assert.deepEqual(await desktop.getThreadState("example/thread-1"), expected);
    assert.deepEqual(await mobile.getThreadState("example/thread-1"), expected);
  } finally {
    await fixture.cleanup();
  }
});

test("rotates segments at the configured event count", async () => {
  const fixture = await createFixture(2);
  try {
    const sync = createSync(fixture.left, "desktop", "2026-09-20T00:00:00Z");
    await sync.append([
      { type: "thread.viewed", threadId: "thread-1", position: 1 },
      { type: "thread.viewed", threadId: "thread-1", position: 2 },
      { type: "thread.viewed", threadId: "thread-1", position: 3 },
      { type: "thread.post.recorded", threadId: "thread-1", position: 4 },
      { type: "thread.favorite.set", threadId: "thread-1", level: 4 },
    ]);

    const refs = await fixture.left.listSegments();
    assert.equal(refs.length, 3);
    assert.deepEqual(
      await Promise.all(refs.map(async (ref) => (await fixture.left.readSegment(ref)).length)),
      [2, 2, 1],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("synchronizes an active segment again when it has grown", async () => {
  const fixture = await createFixture(3);
  try {
    const desktop = createSync(fixture.left, "desktop", "2026-09-20T00:00:00Z");
    await desktop.recordThreadView("thread-1", 1);
    assert.deepEqual(await desktop.synchronizeWith(fixture.right), {
      copiedToLeft: 0,
      copiedToRight: 1,
      copiedSnapshotsToLeft: 0,
      copiedSnapshotsToRight: 0,
    });

    await desktop.recordThreadView("thread-1", 2);
    assert.deepEqual(await desktop.synchronizeWith(fixture.right), {
      copiedToLeft: 0,
      copiedToRight: 1,
      copiedSnapshotsToLeft: 0,
      copiedSnapshotsToRight: 0,
    });
    assert.equal(
      (await fixture.right.readSegment((await fixture.right.listSegments())[0]!)).length,
      2,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("compacts old events into a per-device snapshot", async () => {
  const fixture = await createFixture(2, 1);
  try {
    const desktop = createSync(fixture.left, "desktop", "2026-09-20T00:00:00Z");
    await desktop.append([
      { type: "thread.viewed", threadId: "thread-1", position: 1 },
      { type: "thread.viewed", threadId: "thread-1", position: 2 },
      { type: "thread.viewed", threadId: "thread-1", position: 3 },
      { type: "thread.favorite.set", threadId: "thread-1", level: 4 },
      { type: "thread.post.recorded", threadId: "thread-1", position: 4 },
    ]);

    const snapshot = await desktop.compact();
    assert.equal(snapshot.revision, 1);
    assert.equal((await fixture.left.listSegments()).length, 1);
    assert.deepEqual(await desktop.getThreadState("thread-1"), {
      threadId: "thread-1",
      lastReadPosition: 3,
      lastViewedAt: "2026-09-20T00:00:00.000Z",
      favoriteLevel: 4,
      postPositions: [4],
    });

    assert.deepEqual(await desktop.synchronizeWith(fixture.right), {
      copiedToLeft: 0,
      copiedToRight: 1,
      copiedSnapshotsToLeft: 0,
      copiedSnapshotsToRight: 1,
    });
    assert.deepEqual(await new BbsSync({
      storage: fixture.right,
      deviceId: "mobile",
    }).getThreadState("thread-1"), {
      threadId: "thread-1",
      lastReadPosition: 3,
      lastViewedAt: "2026-09-20T00:00:00.000Z",
      favoriteLevel: 4,
      postPositions: [4],
    });
  } finally {
    await fixture.cleanup();
  }
});

test("keeps events added after the snapshot coverage", async () => {
  const fixture = await createFixture(1, 0);
  try {
    const desktop = createSync(fixture.left, "desktop", "2026-09-20T00:00:00Z");
    await desktop.recordThreadView("thread-1", 1);
    await desktop.compact();
    assert.equal((await fixture.left.listSegments()).length, 0);

    await desktop.recordThreadView("thread-1", 2);
    await desktop.synchronizeWith(fixture.right);

    assert.deepEqual(await new BbsSync({
      storage: fixture.right,
      deviceId: "mobile",
    }).getThreadState("thread-1"), {
      threadId: "thread-1",
      lastReadPosition: 2,
      lastViewedAt: "2026-09-20T00:00:00.000Z",
      postPositions: [],
    });
  } finally {
    await fixture.cleanup();
  }
});

test("keeps a cleared favorite over an older offline level", async () => {
  const fixture = await createFixture(2, 1);
  try {
    const desktop = createSync(fixture.left, "desktop", "2026-09-20T00:00:00Z");
    const offline = createSync(fixture.right, "mobile", "2026-09-19T00:00:00Z");
    await desktop.setFavorite("thread-1", 4);
    await desktop.clearFavorite("thread-1");
    await desktop.compact();
    await offline.setFavorite("thread-1", 5);

    await desktop.synchronizeWith(offline.storage);
    assert.deepEqual(await desktop.getThreadState("thread-1"), {
      threadId: "thread-1",
      postPositions: [],
    });
  } finally {
    await fixture.cleanup();
  }
});

test("synchronizes filter targets, effects, timestamps, and scopes", async () => {
  const fixture = await createFixture();
  try {
    const desktop = createSync(fixture.left, "desktop", "2026-09-20T00:00:00Z");
    await desktop.addFilter("egg.5ch.net/software", "TEXT", "NGワード", "NOP", {
      updatedAt: "2026-09-20T00:01:00.000Z",
      hitAt: "2026-09-20T00:00:30.000Z",
    });
    await desktop.setFilter("egg.5ch.net/software", "ID", "ABCDEFG", "HIDE", {
      updatedAt: "2026-09-20T00:02:00.000Z",
    });
    await desktop.addFilter("egg.5ch.net/news", "ID", "ABCDEFG", "HIGHLIGHT", {
      updatedAt: "2026-09-20T00:03:00.000Z",
    });

    assert.deepEqual(await desktop.getFilters("egg.5ch.net/software"), [
      {
        scope: "egg.5ch.net/software",
        targetType: "ID",
        target: "ABCDEFG",
        effect: "HIDE",
        updatedAt: "2026-09-20T00:02:00.000Z",
      },
      {
        scope: "egg.5ch.net/software",
        targetType: "TEXT",
        target: "NGワード",
        effect: "NOP",
        updatedAt: "2026-09-20T00:01:00.000Z",
        hitAt: "2026-09-20T00:00:30.000Z",
      },
    ]);

    await desktop.synchronizeWith(fixture.right);
    assert.deepEqual(await new BbsSync({
      storage: fixture.right,
      deviceId: "mobile",
    }).getFilters(), await desktop.getFilters());
  } finally {
    await fixture.cleanup();
  }
});

test("keeps a newer filter removal over an older offline update after compaction", async () => {
  const fixture = await createFixture(2, 1);
  try {
    const desktop = createSync(fixture.left, "desktop", "2026-09-20T00:00:00Z");
    const offline = createSync(fixture.right, "mobile", "2026-09-19T00:00:00Z");
    await desktop.addFilter("egg.5ch.net/software", "ID", "ABCDEFG", "HIDE", {
      updatedAt: "2026-09-20T00:00:00.000Z",
    });
    await desktop.clearFilter("egg.5ch.net/software", "ID", "ABCDEFG", {
      updatedAt: "2026-09-20T00:01:00.000Z",
    });
    await desktop.compact();
    await offline.addFilter("egg.5ch.net/software", "ID", "ABCDEFG", "HIDE", {
      updatedAt: "2026-09-19T23:00:00.000Z",
      hitAt: "2026-09-19T22:59:00.000Z",
    });

    await desktop.synchronizeWith(offline.storage);
    assert.deepEqual(await desktop.getFilters(), []);
    assert.deepEqual(await new BbsSync({
      storage: offline.storage,
      deviceId: "mobile",
    }).getFilters(), []);
  } finally {
    await fixture.cleanup();
  }
});

test("uses locale-independent ordinal tie-breaks", () => {
  const occurredAt = "2026-09-20T00:00:00.000Z";
  const events: SyncEvent[] = [
    {
      v: 2,
      id: "favorite-a",
      deviceId: "device-a",
      occurredAt,
      threadId: "thread-1",
      type: "thread.favorite.set",
      level: 1,
    },
    {
      v: 2,
      id: "favorite-b",
      deviceId: "device_a",
      occurredAt,
      threadId: "thread-1",
      type: "thread.favorite.set",
      level: 5,
    },
    {
      v: 2,
      id: "filter-a",
      deviceId: "device-a",
      occurredAt,
      type: "filter.set",
      scope: "egg.5ch.net/software",
      targetType: "ID",
      target: "ABCDEFG",
      effect: "HIDE",
      updatedAt: occurredAt,
    },
    {
      v: 2,
      id: "filter-b",
      deviceId: "device_a",
      occurredAt,
      type: "filter.cleared",
      scope: "egg.5ch.net/software",
      targetType: "ID",
      target: "ABCDEFG",
      updatedAt: occurredAt,
    },
  ];

  const thread = projectDetailedThreadStates(events).get("thread-1");
  assert.equal(thread?.favoriteLevel, 5);
  assert.equal(thread?.favoriteEvent?.deviceId, "device_a");

  const filter = [...projectFilterStates(events).values()][0];
  assert.equal(filter?.cleared, true);
  assert.equal(filter?.deviceId, "device_a");
});

test("retains only the newest global post positions across threads during compaction", async () => {
  const fixture = await createFixture(10, 0);
  try {
    const sync = createSync(fixture.left, "desktop", "2026-09-20T00:00:00Z");
    await sync.append([
      { type: "thread.post.recorded", threadId: "thread-1", position: 10, occurredAt: "2026-09-01T00:00:00Z" },
      { type: "thread.post.recorded", threadId: "thread-2", position: 20, occurredAt: "2026-09-02T00:00:00Z" },
      { type: "thread.post.recorded", threadId: "thread-1", position: 11, occurredAt: "2026-09-03T00:00:00Z" },
      { type: "thread.post.recorded", threadId: "thread-3", position: 30, occurredAt: "2026-09-04T00:00:00Z" },
      { type: "thread.post.recorded", threadId: "thread-2", position: 21, occurredAt: "2026-09-05T00:00:00Z" },
    ]);

    const snapshot = await sync.compact({ maxGlobalPostPositions: 3 });
    const thread1 = snapshot.threads.find((t) => t.threadId === "thread-1");
    const thread2 = snapshot.threads.find((t) => t.threadId === "thread-2");
    const thread3 = snapshot.threads.find((t) => t.threadId === "thread-3");

    // The 3 newest posts are: thread-1:11 (09-03), thread-3:30 (09-04), thread-2:21 (09-05)
    // Older posts (thread-1:10, thread-2:20) are trimmed
    assert.deepEqual(thread1?.postPositions, [11]);
    assert.deepEqual(thread2?.postPositions, [21]);
    assert.deepEqual(thread3?.postPositions, [30]);
  } finally {
    await fixture.cleanup();
  }
});

test("prunes inactive threads (older than 30 days, no favorite, no posts) from snapshot", async () => {
  const fixture = await createFixture(10, 0);
  try {
    // Current sync time is 2026-09-30
    const sync = createSync(fixture.left, "desktop", "2026-09-30T00:00:00Z");
    await sync.append([
      // Thread A: Viewed 40 days ago (2026-08-21), no favorite, no posts -> should be pruned
      { type: "thread.viewed", threadId: "thread-a", position: 5, occurredAt: "2026-08-21T00:00:00Z" },
      // Thread B: Viewed 40 days ago, but has active favorite -> must be kept
      { type: "thread.viewed", threadId: "thread-b", position: 10, occurredAt: "2026-08-21T00:00:00Z" },
      { type: "thread.favorite.set", threadId: "thread-b", level: 3, occurredAt: "2026-08-21T00:00:00Z" },
      // Thread C: Viewed 40 days ago, but has post position -> must be kept
      { type: "thread.viewed", threadId: "thread-c", position: 15, occurredAt: "2026-08-21T00:00:00Z" },
      { type: "thread.post.recorded", threadId: "thread-c", position: 12, occurredAt: "2026-08-21T00:00:00Z" },
      // Thread D: Viewed 10 days ago (2026-09-20), within 30 days -> must be kept
      { type: "thread.viewed", threadId: "thread-d", position: 20, occurredAt: "2026-09-20T00:00:00Z" },
      // Thread E: Viewed 40 days ago, favorite set and cleared -> should be pruned
      { type: "thread.viewed", threadId: "thread-e", position: 25, occurredAt: "2026-08-21T00:00:00Z" },
      { type: "thread.favorite.set", threadId: "thread-e", level: 2, occurredAt: "2026-08-21T00:00:00Z" },
      { type: "thread.favorite.cleared", threadId: "thread-e", occurredAt: "2026-08-21T01:00:00Z" },
    ]);

    const snapshot = await sync.compact();
    const threadIds = snapshot.threads.map((t) => t.threadId);
    assert.deepEqual(threadIds, ["thread-b", "thread-c", "thread-d"]);
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture(
  maxEventsPerSegment = 1_000,
  retainSegmentsPerDevice = 1,
): Promise<{
  left: LocalEventStore;
  right: LocalEventStore;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "bbsync-test-"));
  return {
    left: new LocalEventStore(join(root, "left"), {
      maxEventsPerSegment,
      retainSegmentsPerDevice,
    }),
    right: new LocalEventStore(join(root, "right"), {
      maxEventsPerSegment,
      retainSegmentsPerDevice,
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function createSync(
  storage: LocalEventStore,
  deviceId: string,
  time: string,
): BbsSync {
  let sequence = 0;
  return new BbsSync({
    storage,
    deviceId,
    clock: () => new Date(time),
    idGenerator: () => `id-${deviceId}-${++sequence}`,
  });
}
