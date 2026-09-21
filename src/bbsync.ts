import { randomUUID } from "node:crypto";

import {
  readProjectedStates,
  readProjectedFilters,
  snapshotFromStates,
  isProjectedThreadStateVisible,
} from "./project.js";
import type { EventStore } from "./store.js";
import { synchronizeStores } from "./synchronize.js";
import {
  EVENT_SCHEMA_VERSION,
  type CompactOptions,
  type FavoriteLevel,
  type SyncEvent,
  type SyncEventInput,
  type SynchronizeResult,
  type SegmentCoverage,
  type StateSnapshot,
  type ThreadState,
  type FilterEntry,
  type FilterTargetType,
  type FilterEffect,
} from "./types.js";
import {
  assertDateTime,
  assertFilterKey,
  assertFilterEffect,
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

  async clearThreadHistory(threadId: string): Promise<SyncEvent> {
    const [event] = await this.append([
      { type: "thread.history.cleared", threadId },
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

  async clearPost(threadId: string, position: number): Promise<SyncEvent> {
    const [event] = await this.append([
      { type: "thread.post.cleared", threadId, position },
    ]);
    return event!;
  }

  async recordResponseCount(threadId: string, responseCount: number): Promise<SyncEvent> {
    const [event] = await this.append([
      { type: "thread.response-count.observed", threadId, responseCount },
    ]);
    return event!;
  }

  async addFilter(
    scope: string,
    targetType: FilterTargetType,
    target: string,
    effect: FilterEffect,
    options: { readonly updatedAt?: string; readonly hitAt?: string | null } = {},
  ): Promise<SyncEvent> {
    const [event] = await this.append([{
      type: "filter.set",
      scope,
      targetType,
      target,
      effect,
      ...(options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
      ...(options.hitAt === undefined ? {} : { hitAt: options.hitAt }),
    }]);
    return event!;
  }

  async setFilter(
    scope: string,
    targetType: FilterTargetType,
    target: string,
    effect: FilterEffect,
    options: { readonly updatedAt?: string; readonly hitAt?: string | null } = {},
  ): Promise<SyncEvent> {
    return this.addFilter(scope, targetType, target, effect, options);
  }

  async removeFilter(
    scope: string,
    targetType: FilterTargetType,
    target: string,
    options: { readonly updatedAt?: string } = {},
  ): Promise<SyncEvent> {
    const [event] = await this.append([{
      type: "filter.cleared",
      scope,
      targetType,
      target,
      ...(options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
    }]);
    return event!;
  }

  async clearFilter(
    scope: string,
    targetType: FilterTargetType,
    target: string,
    options: { readonly updatedAt?: string } = {},
  ): Promise<SyncEvent> {
    return this.removeFilter(scope, targetType, target, options);
  }

  async getFilters(scope?: string): Promise<readonly FilterEntry[]> {
    const projected = await readProjectedFilters(this.storage);
    return [...projected.values()]
      .filter((filter) => !filter.cleared && (scope === undefined || filter.scope === scope))
      .map((filter) => ({
        scope: filter.scope,
        targetType: filter.targetType,
        target: filter.target,
        effect: filter.effect,
        updatedAt: filter.updatedAt,
        ...(filter.hitAt === undefined ? {} : { hitAt: filter.hitAt }),
      }));
  }

  async getStates(): Promise<ReadonlyMap<string, ThreadState>> {
    const projected = await readProjectedStates(this.storage);
    return new Map(
      [...projected.entries()]
        .filter(([, state]) => isProjectedThreadStateVisible(state))
        .map(([threadId, state]) => [
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

  async compact(options?: CompactOptions): Promise<StateSnapshot> {
    const states = await readProjectedStates(this.storage);
    const filters = await readProjectedFilters(this.storage);
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
      filters,
      options,
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
      case "filter.set": {
        assertFilterKey(input.scope, input.targetType, input.target);
        assertFilterEffect(input.effect);
        const updatedAt = input.updatedAt ?? occurredAt;
        assertDateTime(updatedAt, "updatedAt");
        if (input.hitAt !== undefined && input.hitAt !== null) {
          assertDateTime(input.hitAt, "hitAt");
        }
        return {
          ...base,
          type: input.type,
          scope: input.scope,
          targetType: input.targetType,
          target: input.target,
          effect: input.effect,
          updatedAt,
          ...(input.hitAt === undefined ? {} : { hitAt: input.hitAt }),
        };
      }
      case "filter.cleared": {
        assertFilterKey(input.scope, input.targetType, input.target);
        const updatedAt = input.updatedAt ?? occurredAt;
        assertDateTime(updatedAt, "updatedAt");
        return {
          ...base,
          type: input.type,
          scope: input.scope,
          targetType: input.targetType,
          target: input.target,
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
    input: Exclude<SyncEventInput, { type: "filter.set" | "filter.cleared" }>,
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
      case "thread.history.cleared":
        return { ...threadBase, type: input.type };
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
      case "thread.post.cleared":
        assertPosition(input.position, false);
        return { ...threadBase, type: input.type, position: input.position };
    }
  }
}
