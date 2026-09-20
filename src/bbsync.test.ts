import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BbsSync } from "./bbsync.js";
import { LocalEventStore } from "./local-event-store.js";
import {
  projectDetailedThreadStates,
  projectMuteStates,
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

test("syncs thread title and URL without changing the thread key", async () => {
  const fixture = await createFixture();
  try {
    const desktop = createSync(fixture.left, "desktop", "2026-09-20T00:00:00Z");
    const mobile = createSync(fixture.right, "mobile", "2026-09-20T00:01:00Z");

    const event = await desktop.setThreadMetadata(
      "@5ch/software/1234567890",
      "最初のタイトル",
      "https://egg.5ch.net/test/read.cgi/software/1234567890/",
    );
    assert.equal(event.v, 1);
    assert.equal(event.type, "thread.metadata.updated");
    assert.equal(event.threadId, "@5ch/software/1234567890");

    await desktop.synchronizeWith(mobile.storage);
    assert.deepEqual(
      await mobile.getThreadState("@5ch/software/1234567890"),
      {
        threadId: "@5ch/software/1234567890",
        title: "最初のタイトル",
        url: "https://egg.5ch.net/test/read.cgi/software/1234567890/",
        postPositions: [],
      },
    );

    await mobile.setThreadMetadata(
      "@5ch/software/1234567890",
      "更新後のタイトル",
      "https://itest.5ch.net/test/read.cgi/software/1234567890/",
    );
    await desktop.synchronizeWith(mobile.storage);

    const expected = {
      threadId: "@5ch/software/1234567890",
      title: "更新後のタイトル",
      url: "https://itest.5ch.net/test/read.cgi/software/1234567890/",
      postPositions: [],
    };
    assert.deepEqual(await desktop.getThreadState("@5ch/software/1234567890"), expected);
    assert.deepEqual(await mobile.getThreadState("@5ch/software/1234567890"), expected);
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

test("synchronizes opaque mute values with timestamps and scopes", async () => {
  const fixture = await createFixture();
  try {
    const desktop = createSync(fixture.left, "desktop", "2026-09-20T00:00:00Z");
    await desktop.addMute("5ch/software", "TEXT:NGワード", {
      updatedAt: "2026-09-20T00:01:00.000Z",
      hitAt: "2026-09-20T00:00:30.000Z",
    });
    await desktop.setMute("5ch/software", "ID:ABCDEFG", {
      updatedAt: "2026-09-20T00:02:00.000Z",
    });
    await desktop.addMute("5ch/news", "ID:ABCDEFG", {
      updatedAt: "2026-09-20T00:03:00.000Z",
    });

    assert.deepEqual(await desktop.getMutes("5ch/software"), [
      {
        scope: "5ch/software",
        value: "ID:ABCDEFG",
        updatedAt: "2026-09-20T00:02:00.000Z",
      },
      {
        scope: "5ch/software",
        value: "TEXT:NGワード",
        updatedAt: "2026-09-20T00:01:00.000Z",
        hitAt: "2026-09-20T00:00:30.000Z",
      },
    ]);

    await desktop.synchronizeWith(fixture.right);
    assert.deepEqual(await new BbsSync({
      storage: fixture.right,
      deviceId: "mobile",
    }).getMutes(), await desktop.getMutes());
  } finally {
    await fixture.cleanup();
  }
});

test("keeps a newer mute removal over an older offline update after compaction", async () => {
  const fixture = await createFixture(2, 1);
  try {
    const desktop = createSync(fixture.left, "desktop", "2026-09-20T00:00:00Z");
    const offline = createSync(fixture.right, "mobile", "2026-09-19T00:00:00Z");
    await desktop.addMute("5ch/software", "ID:ABCDEFG", {
      updatedAt: "2026-09-20T00:00:00.000Z",
    });
    await desktop.clearMute("5ch/software", "ID:ABCDEFG", {
      updatedAt: "2026-09-20T00:01:00.000Z",
    });
    await desktop.compact();
    await offline.addMute("5ch/software", "ID:ABCDEFG", {
      updatedAt: "2026-09-19T23:00:00.000Z",
      hitAt: "2026-09-19T22:59:00.000Z",
    });

    await desktop.synchronizeWith(offline.storage);
    assert.deepEqual(await desktop.getMutes(), []);
    assert.deepEqual(await new BbsSync({
      storage: offline.storage,
      deviceId: "mobile",
    }).getMutes(), []);
  } finally {
    await fixture.cleanup();
  }
});

test("uses locale-independent ordinal tie-breaks", () => {
  const occurredAt = "2026-09-20T00:00:00.000Z";
  const events: SyncEvent[] = [
    {
      v: 1,
      id: "favorite-a",
      deviceId: "device-a",
      occurredAt,
      threadId: "thread-1",
      type: "thread.favorite.set",
      level: 1,
    },
    {
      v: 1,
      id: "favorite-b",
      deviceId: "device_a",
      occurredAt,
      threadId: "thread-1",
      type: "thread.favorite.set",
      level: 5,
    },
    {
      v: 1,
      id: "mute-a",
      deviceId: "device-a",
      occurredAt,
      type: "mute.set",
      scope: "5ch/software",
      value: "ID:ABCDEFG",
      updatedAt: occurredAt,
    },
    {
      v: 1,
      id: "mute-b",
      deviceId: "device_a",
      occurredAt,
      type: "mute.cleared",
      scope: "5ch/software",
      value: "ID:ABCDEFG",
      updatedAt: occurredAt,
    },
  ];

  const thread = projectDetailedThreadStates(events).get("thread-1");
  assert.equal(thread?.favoriteLevel, 5);
  assert.equal(thread?.favoriteEvent?.deviceId, "device_a");

  const mute = [...projectMuteStates(events).values()][0];
  assert.equal(mute?.cleared, true);
  assert.equal(mute?.deviceId, "device_a");
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
