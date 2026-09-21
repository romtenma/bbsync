import assert from "node:assert/strict";
import test from "node:test";

import type { EventStore } from "./store.js";
import type { SegmentRef, StateSnapshot, SyncEvent } from "./types.js";

export interface EventStoreFixture {
  readonly store: EventStore;
  readonly cleanup: () => Promise<void>;
}

export type EventStoreFixtureFactory = () => Promise<EventStoreFixture>;

/**
 * Registers the behavior required of every EventStore implementation.
 * A future Google Drive adapter can run the same suite by passing its factory.
 */
export function registerEventStoreContractTests(
  name: string,
  createFixture: EventStoreFixtureFactory,
): void {
  test(`${name}: starts empty`, async () => {
    await withFixture(createFixture, async (store) => {
      assert.deepEqual(await store.listSegments(), []);
      assert.deepEqual(await store.listSnapshots(), []);
    });
  });

  test(`${name}: appends and reads every event kind`, async () => {
    await withFixture(createFixture, async (store) => {
      const events = sampleEvents("desktop");
      await store.appendEvents("desktop", events);

      assert.deepEqual(await flattenSegments(store), events);
      await assert.rejects(
        () => store.appendEvents("mobile", [events[0]!]),
        /appending device/,
      );
    });
  });

  test(`${name}: allows idempotent segment extension and rejects divergence`, async () => {
    await withFixture(createFixture, async (store) => {
      const events = sampleEvents("desktop");
      const ref: SegmentRef = { deviceId: "desktop", segmentId: "manual" };

      await store.writeSegment(ref, [events[0]!]);
      await store.writeSegment(ref, [events[0]!]);
      await store.writeSegment(ref, events.slice(0, 2));
      assert.deepEqual(await store.readSegment(ref), events.slice(0, 2));
      await assert.rejects(
        () => store.writeSegment(ref, [events[1]!]),
        /diverged/,
      );
    });
  });

  test(`${name}: keeps the newest snapshot revision`, async () => {
    await withFixture(createFixture, async (store) => {
      const current = sampleSnapshot(2);
      const stale = sampleSnapshot(1);
      await store.writeSnapshot(current);
      await store.writeSnapshot(stale);
      assert.deepEqual(await store.readSnapshot("desktop"), current);

      await assert.rejects(
        () => store.writeSnapshot({ ...current, createdAt: "2026-09-21T00:00:00.000Z" }),
        /collision/,
      );
    });
  });

  test(`${name}: never prunes a segment outside snapshot coverage`, async () => {
    await withFixture(createFixture, async (store) => {
      const events = sampleEvents("desktop");
      const covered: SegmentRef = { deviceId: "desktop", segmentId: "covered" };
      const recent: SegmentRef = { deviceId: "desktop", segmentId: "recent" };
      await store.writeSegment(covered, [events[0]!]);
      await store.writeSegment(recent, [events[1]!]);
      await store.writeSnapshot({
        ...sampleSnapshot(1),
        coveredSegments: [{ segmentId: covered.segmentId, eventCount: 1 }],
      });

      await store.pruneSegments(await store.readSnapshot("desktop") as StateSnapshot);
      assert.deepEqual(await store.readSegment(recent), [events[1]!]);
    });
  });
}

async function withFixture(
  createFixture: EventStoreFixtureFactory,
  callback: (store: EventStore) => Promise<void>,
): Promise<void> {
  const fixture = await createFixture();
  try {
    await callback(fixture.store);
  } finally {
    await fixture.cleanup();
  }
}

async function flattenSegments(store: EventStore): Promise<readonly SyncEvent[]> {
  const events: SyncEvent[] = [];
  for (const ref of await store.listSegments()) {
    events.push(...await store.readSegment(ref));
  }
  return events;
}

function sampleEvents(deviceId: string): readonly SyncEvent[] {
  return [
    {
      v: 2,
      id: `${deviceId}-metadata`,
      deviceId,
      occurredAt: "2026-09-20T00:00:00.000Z",
      threadId: "thread-1",
      type: "thread.metadata.updated",
      title: "Thread title",
      url: "https://example.com/thread/1",
    },
    {
      v: 2,
      id: `${deviceId}-view`,
      deviceId,
      occurredAt: "2026-09-20T00:00:00.000Z",
      threadId: "thread-1",
      type: "thread.viewed",
      position: 10,
      firstPosition: 8,
    },
    {
      v: 2,
      id: `${deviceId}-count`,
      deviceId,
      occurredAt: "2026-09-20T00:00:01.000Z",
      threadId: "thread-1",
      type: "thread.response-count.observed",
      responseCount: 12,
    },
    {
      v: 2,
      id: `${deviceId}-favorite`,
      deviceId,
      occurredAt: "2026-09-20T00:00:02.000Z",
      threadId: "thread-1",
      type: "thread.favorite.set",
      level: 3,
    },
    {
      v: 2,
      id: `${deviceId}-post`,
      deviceId,
      occurredAt: "2026-09-20T00:00:03.000Z",
      threadId: "thread-1",
      type: "thread.post.recorded",
      position: 11,
    },
    {
      v: 2,
      id: `${deviceId}-post-cleared`,
      deviceId,
      occurredAt: "2026-09-20T00:00:03.500Z",
      threadId: "thread-1",
      type: "thread.post.cleared",
      position: 11,
    },
    {
      v: 2,
      id: `${deviceId}-filter-set`,
      deviceId,
      occurredAt: "2026-09-20T00:00:04.000Z",
      type: "filter.set",
      scope: "egg.5ch.net/software",
      targetType: "ID",
      target: "ABCDEFG",
      effect: "OMIT",
      isRegex: false,
      updatedAt: "2026-09-20T00:00:04.000Z",
      hitAt: "2026-09-20T00:00:03.500Z",
    },
    {
      v: 2,
      id: `${deviceId}-filter-cleared`,
      deviceId,
      occurredAt: "2026-09-20T00:00:05.000Z",
      type: "filter.cleared",
      scope: "egg.5ch.net/software",
      targetType: "ID",
      target: "ABCDEFG",
      updatedAt: "2026-09-20T00:00:05.000Z",
    },
  ];
}

function sampleSnapshot(revision: number): StateSnapshot {
  return {
    v: 2,
    deviceId: "desktop",
    revision,
    createdAt: `2026-09-20T00:0${revision}:00.000Z`,
    coveredSegments: [],
    threads: [
      {
        threadId: "thread-1",
        lastReadPosition: 10,
        firstReadPosition: 8,
        responseCount: 12,
        lastViewed: {
          occurredAt: "2026-09-20T00:00:00.000Z",
          deviceId: "desktop",
          eventId: "desktop-view",
          firstPosition: 8,
        },
        favorite: {
          cleared: false,
          level: 3,
          occurredAt: "2026-09-20T00:00:02.000Z",
          deviceId: "desktop",
          eventId: "desktop-favorite",
        },
        postPositions: [11],
        postCleared: [{
          position: 12,
          occurredAt: "2026-09-20T00:00:03.500Z",
          deviceId: "desktop",
          eventId: "desktop-post-cleared",
        }],
      },
    ],
    filters: [{
      scope: "egg.5ch.net/software",
      targetType: "ID",
      target: "ABCDEFG",
      effect: "OMIT",
      isRegex: false,
      updatedAt: "2026-09-20T00:00:04.000Z",
      cleared: false,
      deviceId: "desktop",
      eventId: "desktop-filter-set",
    }],
  };
}
