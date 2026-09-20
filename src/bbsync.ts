import { randomUUID } from "node:crypto";

import {
  readProjectedStates,
  readProjectedMutes,
  snapshotFromStates,
} from "./project.js";
import type { EventStore } from "./store.js";
import { synchronizeStores } from "./synchronize.js";
import {
  EVENT_SCHEMA_VERSION,
  type FavoriteLevel,
  type SyncEvent,
  type SyncEventInput,
  type SynchronizeResult,
  type SegmentCoverage,
  type StateSnapshot,
  type ThreadState,
  type MuteEntry,
} from "./types.js";
import {
  assertDateTime,
  assertMuteKey,
  assertPosition,
  assertFavoriteLevel,
  assertSafeComponent,
  assertThreadMetadata,
  assertThreadId,
} from "./validation.js";

export interface BbsSyncOptions {
  readonly storage: EventStore;
  readonly deviceId: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
}

export class BbsSync {
  readonly storage: EventStore;
  readonly deviceId: string;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(options: BbsSyncOptions) {
    assertSafeComponent(options.deviceId, "deviceId");
    this.storage = options.storage;
    this.deviceId = options.deviceId;
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? randomUUID;
  }

  async append(inputs: readonly SyncEventInput[]): Promise<readonly SyncEvent[]> {
    if (inputs.length === 0) return [];

    const events = inputs.map((input) => this.createEvent(input));
    await this.storage.appendEvents(this.deviceId, events);
    return events;
  }

  async recordThreadView(
    threadId: string,
    position: number,
  ): Promise<SyncEvent> {
    const [event] = await this.append([
      { type: "thread.viewed", threadId, position },
    ]);
    return event!;
  }

  async setThreadMetadata(
    threadId: string,
    title: string,
    url: string,
  ): Promise<SyncEvent> {
    const [event] = await this.append([
      { type: "thread.metadata.updated", threadId, title, url },
    ]);
    return event!;
  }

  async setFavorite(
    threadId: string,
    level: FavoriteLevel = 1,
  ): Promise<SyncEvent> {
    const [event] = await this.append([
      { type: "thread.favorite.set", threadId, level },
    ]);
    return event!;
  }

  async clearFavorite(threadId: string): Promise<SyncEvent> {
    const [event] = await this.append([
      { type: "thread.favorite.cleared", threadId },
    ]);
    return event!;
  }

  async recordPost(threadId: string, position: number): Promise<SyncEvent> {
    const [event] = await this.append([
      { type: "thread.post.recorded", threadId, position },
    ]);
    return event!;
  }

  async recordResponseCount(threadId: string, responseCount: number): Promise<SyncEvent> {
    const [event] = await this.append([
      { type: "thread.response-count.observed", threadId, responseCount },
    ]);
    return event!;
  }

  async addMute(
    scope: string,
    value: string,
    options: { readonly updatedAt?: string; readonly hitAt?: string | null } = {},
  ): Promise<SyncEvent> {
    const [event] = await this.append([{
      type: "mute.set",
      scope,
      value,
      ...(options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
      ...(options.hitAt === undefined ? {} : { hitAt: options.hitAt }),
    }]);
    return event!;
  }

  async setMute(
    scope: string,
    value: string,
    options: { readonly updatedAt?: string; readonly hitAt?: string | null } = {},
  ): Promise<SyncEvent> {
    return this.addMute(scope, value, options);
  }

  async removeMute(
    scope: string,
    value: string,
    options: { readonly updatedAt?: string } = {},
  ): Promise<SyncEvent> {
    const [event] = await this.append([{
      type: "mute.cleared",
      scope,
      value,
      ...(options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
    }]);
    return event!;
  }

  async clearMute(
    scope: string,
    value: string,
    options: { readonly updatedAt?: string } = {},
  ): Promise<SyncEvent> {
    return this.removeMute(scope, value, options);
  }

  async getMutes(scope?: string): Promise<readonly MuteEntry[]> {
    const projected = await readProjectedMutes(this.storage);
    return [...projected.values()]
      .filter((mute) => !mute.cleared && (scope === undefined || mute.scope === scope))
      .map((mute) => ({
        scope: mute.scope,
        value: mute.value,
        updatedAt: mute.updatedAt,
        ...(mute.hitAt === undefined ? {} : { hitAt: mute.hitAt }),
      }));
  }

  async getStates(): Promise<ReadonlyMap<string, ThreadState>> {
    const projected = await readProjectedStates(this.storage);
    return new Map(
      [...projected.entries()].map(([threadId, state]) => [
        threadId,
        {
          threadId: state.threadId,
          ...(state.metadata === undefined
            ? {}
            : { title: state.metadata.title, url: state.metadata.url }),
          ...(state.lastReadPosition === undefined
            ? {}
            : { lastReadPosition: state.lastReadPosition }),
          ...(state.responseCount === undefined
            ? {}
            : { responseCount: state.responseCount }),
          ...(state.lastViewed === undefined
            ? {}
            : { lastViewedAt: state.lastViewed.occurredAt }),
          ...(state.favoriteLevel === undefined
            ? {}
            : { favoriteLevel: state.favoriteLevel }),
          postPositions: state.postPositions,
        },
      ]),
    );
  }

  async getThreadState(threadId: string): Promise<ThreadState | undefined> {
    assertThreadId(threadId);
    return (await this.getStates()).get(threadId);
  }

  async synchronizeWith(remote: EventStore): Promise<SynchronizeResult> {
    return synchronizeStores(this.storage, remote);
  }

  async compact(): Promise<StateSnapshot> {
    const states = await readProjectedStates(this.storage);
    const mutes = await readProjectedMutes(this.storage);
    const previous = await this.storage.readSnapshot(this.deviceId);
    const coveredSegments: SegmentCoverage[] = [];
    for (const ref of await this.storage.listSegments()) {
      if (ref.deviceId !== this.deviceId) continue;
      coveredSegments.push({
        segmentId: ref.segmentId,
        eventCount: (await this.storage.readSegment(ref)).length,
      });
    }
    const snapshot = snapshotFromStates(
      this.deviceId,
      (previous?.revision ?? 0) + 1,
      this.clock().toISOString(),
      coveredSegments,
      states,
      mutes,
    );
    await this.storage.writeSnapshot(snapshot);
    await this.storage.pruneSegments(snapshot);
    return snapshot;
  }

  private createEvent(input: SyncEventInput): SyncEvent {
    const id = this.idGenerator();
    assertSafeComponent(id, "event.id");
    const occurredAt = input.occurredAt ?? this.clock().toISOString();
    if (Number.isNaN(Date.parse(occurredAt))) {
      throw new TypeError("occurredAt must be a valid date-time string");
    }

    const base = {
      v: EVENT_SCHEMA_VERSION,
      id,
      deviceId: this.deviceId,
      occurredAt,
    };

    switch (input.type) {
      case "mute.set": {
        assertMuteKey(input.scope, input.value);
        const updatedAt = input.updatedAt ?? occurredAt;
        assertDateTime(updatedAt, "updatedAt");
        if (input.hitAt !== undefined && input.hitAt !== null) {
          assertDateTime(input.hitAt, "hitAt");
        }
        return {
          ...base,
          type: input.type,
          scope: input.scope,
          value: input.value,
          updatedAt,
          ...(input.hitAt === undefined ? {} : { hitAt: input.hitAt }),
        };
      }
      case "mute.cleared": {
        assertMuteKey(input.scope, input.value);
        const updatedAt = input.updatedAt ?? occurredAt;
        assertDateTime(updatedAt, "updatedAt");
        return {
          ...base,
          type: input.type,
          scope: input.scope,
          value: input.value,
          updatedAt,
        };
      }
      default:
        assertThreadId(input.threadId);
        return this.createThreadEvent(base, input);
    }
  }

  private createThreadEvent(
    base: {
      readonly v: typeof EVENT_SCHEMA_VERSION;
      readonly id: string;
      readonly deviceId: string;
      readonly occurredAt: string;
    },
    input: Exclude<SyncEventInput, { type: "mute.set" | "mute.cleared" }>,
  ): SyncEvent {
    const threadBase = { ...base, threadId: input.threadId };
    switch (input.type) {
      case "thread.metadata.updated":
        assertThreadMetadata(input.title, input.url);
        return {
          ...threadBase,
          type: input.type,
          title: input.title,
          url: input.url,
        };
      case "thread.viewed":
        assertPosition(input.position, true);
        return { ...threadBase, type: input.type, position: input.position };
      case "thread.response-count.observed":
        assertPosition(input.responseCount, true);
        return { ...threadBase, type: input.type, responseCount: input.responseCount };
      case "thread.favorite.set":
        const level = input.level ?? 1;
        assertFavoriteLevel(level);
        return { ...threadBase, type: input.type, level };
      case "thread.favorite.cleared":
        return { ...threadBase, type: input.type };
      case "thread.post.recorded":
        assertPosition(input.position, false);
        return { ...threadBase, type: input.type, position: input.position };
    }
  }
}
