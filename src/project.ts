import type { EventStore } from "./store.js";
import {
  DEFAULT_MAX_GLOBAL_POST_POSITIONS,
  DEFAULT_THREAD_RETENTION_PERIOD_MS,
  EVENT_SCHEMA_VERSION,
  type CompactOptions,
  type FavoriteClearedEvent,
  type FavoriteSetEvent,
  type SegmentCoverage,
  type SnapshotFavorite,
  type SnapshotThreadMetadata,
  type SnapshotThreadState,
  type SnapshotViewed,
  type SnapshotHistoryCleared,
  type SnapshotFilter,
  type StateSnapshot,
  type SyncEvent,
  type ThreadState,
  type FavoriteLevel,
  type FilterEntry,
} from "./types.js";

export interface ProjectedPostRecord {
  readonly threadId: string;
  readonly position: number;
  readonly occurredAt: string;
  readonly deviceId: string;
  readonly eventId: string;
}

export interface ProjectedThreadState extends ThreadState {
  readonly metadata?: SnapshotThreadMetadata;
  readonly lastViewed?: SnapshotViewed;
  readonly historyCleared?: SnapshotHistoryCleared;
  readonly favoriteEvent?: SnapshotFavorite;
  readonly postRecords?: readonly ProjectedPostRecord[];
}

export interface ProjectedFilterState extends FilterEntry {
  readonly cleared: boolean;
  readonly deviceId: string;
  readonly eventId: string;
}

interface MutableThreadState {
  threadId: string;
  metadata?: SnapshotThreadMetadata;
  lastReadPosition?: number;
  responseCount?: number;
  lastViewed?: SnapshotViewed;
  historyCleared?: SnapshotHistoryCleared;
  favoriteLevel?: FavoriteLevel;
  favoriteEvent?: SnapshotFavorite;
  postPositions: Set<number>;
  postRecords: Map<number, ProjectedPostRecord>;
}

interface MutableFilterState extends ProjectedFilterState {}

export async function readAllEvents(
  store: EventStore,
): Promise<readonly SyncEvent[]> {
  const eventsById = new Map<string, SyncEvent>();
  for (const ref of await store.listSegments()) {
    for (const event of await store.readSegment(ref)) {
      const existing = eventsById.get(event.id);
      if (existing === undefined) {
        eventsById.set(event.id, event);
      } else if (JSON.stringify(existing) !== JSON.stringify(event)) {
        throw new Error(`event id collision with different contents: ${event.id}`);
      }
    }
  }
  return [...eventsById.values()];
}

export async function readProjectedStates(
  store: EventStore,
): Promise<ReadonlyMap<string, ProjectedThreadState>> {
  const snapshots = await Promise.all(
    (await store.listSnapshots()).map((deviceId) => store.readSnapshot(deviceId)),
  );
  const seeds = snapshots.flatMap((snapshot) =>
    snapshot === undefined ? [] : snapshot.threads,
  );
  return projectDetailedThreadStates(await readAllEvents(store), seeds);
}

export async function readProjectedFilters(
  store: EventStore,
): Promise<ReadonlyMap<string, ProjectedFilterState>> {
  const snapshots = await Promise.all(
    (await store.listSnapshots()).map((deviceId) => store.readSnapshot(deviceId)),
  );
  const seeds = snapshots.flatMap((snapshot) =>
    snapshot === undefined ? [] : snapshot.filters,
  );
  return projectFilterStates(await readAllEvents(store), seeds);
}

export function snapshotFromStates(
  deviceId: string,
  revision: number,
  createdAt: string,
  coveredSegments: readonly SegmentCoverage[],
  states: ReadonlyMap<string, ProjectedThreadState>,
  filters: ReadonlyMap<string, ProjectedFilterState> = new Map(),
  options: CompactOptions = {},
): StateSnapshot {
  const maxGlobalPostPositions =
    options.maxGlobalPostPositions ?? DEFAULT_MAX_GLOBAL_POST_POSITIONS;
  const retentionPeriodMs =
    options.retentionPeriodMs ?? DEFAULT_THREAD_RETENTION_PERIOD_MS;
  const createdAtMs = Date.parse(createdAt);

  const allPostRecords: ProjectedPostRecord[] = [];
  for (const state of states.values()) {
    if (state.postRecords !== undefined && state.postRecords.length > 0) {
      allPostRecords.push(...state.postRecords);
    } else {
      for (const position of state.postPositions) {
        allPostRecords.push({
          threadId: state.threadId,
          position,
          occurredAt: state.lastViewed?.occurredAt ?? "1970-01-01T00:00:00.000Z",
          deviceId: "",
          eventId: "",
        });
      }
    }
  }

  allPostRecords.sort(comparePostRecords);
  const retainedPostRecords =
    allPostRecords.length > maxGlobalPostPositions
      ? allPostRecords.slice(-maxGlobalPostPositions)
      : allPostRecords;

  const retainedPostsByThread = new Map<string, Set<number>>();
  for (const record of retainedPostRecords) {
    let set = retainedPostsByThread.get(record.threadId);
    if (set === undefined) {
      set = new Set<number>();
      retainedPostsByThread.set(record.threadId, set);
    }
    set.add(record.position);
  }

  const threads: SnapshotThreadState[] = [];
  for (const state of states.values()) {
    const postPositions = [
      ...(retainedPostsByThread.get(state.threadId) ?? []),
    ].sort((left, right) => left - right);
    const hasFavorite =
      state.favoriteEvent !== undefined &&
      !state.favoriteEvent.cleared &&
      state.favoriteLevel !== undefined;
    const hasPosts = postPositions.length > 0;
    const activityTimestamps: number[] = [];
    if (state.lastViewed !== undefined) {
      const ts = Date.parse(state.lastViewed.occurredAt);
      if (!Number.isNaN(ts)) activityTimestamps.push(ts);
    }
    if (state.historyCleared === undefined && state.metadata !== undefined) {
      const ts = Date.parse(state.metadata.occurredAt);
      if (!Number.isNaN(ts)) activityTimestamps.push(ts);
    }
    const lastActivityAt =
      activityTimestamps.length > 0
        ? Math.max(...activityTimestamps)
        : undefined;
    const isRecent =
      lastActivityAt !== undefined &&
      createdAtMs - lastActivityAt < retentionPeriodMs;
    const hasHistoryClear = state.historyCleared !== undefined;

    if (!hasFavorite && !hasPosts && !isRecent && !hasHistoryClear) {
      continue;
    }

    threads.push({
      threadId: state.threadId,
      ...(state.metadata === undefined ? {} : { metadata: state.metadata }),
      ...(state.lastReadPosition === undefined
        ? {}
        : { lastReadPosition: state.lastReadPosition }),
      ...(state.responseCount === undefined
        ? {}
        : { responseCount: state.responseCount }),
      ...(state.lastViewed === undefined
        ? {}
        : { lastViewed: state.lastViewed }),
      ...(state.historyCleared === undefined
        ? {}
        : { historyCleared: state.historyCleared }),
      ...(state.favoriteEvent === undefined
        ? {}
        : { favorite: state.favoriteEvent }),
      postPositions,
    });
  }

  threads.sort((left, right) => left.threadId.localeCompare(right.threadId));

  return {
    v: EVENT_SCHEMA_VERSION,
    deviceId,
    revision,
    createdAt,
    coveredSegments: [...coveredSegments],
    threads,
    filters: [...filters.values()]
      .sort(compareFilterStates)
      .map((filter) => ({
        scope: filter.scope,
        targetType: filter.targetType,
        target: filter.target,
        effect: filter.effect,
        updatedAt: filter.updatedAt,
        ...(filter.hitAt === undefined ? {} : { hitAt: filter.hitAt }),
        cleared: filter.cleared,
        deviceId: filter.deviceId,
        eventId: filter.eventId,
      })),
  };
}

export function projectFilterStates(
  events: readonly SyncEvent[],
  seeds: readonly SnapshotFilter[] = [],
): ReadonlyMap<string, ProjectedFilterState> {
  const states = new Map<string, MutableFilterState>();

  for (const seed of seeds) {
    const key = filterKey(seed.scope, seed.targetType, seed.target);
    const current = states.get(key);
    if (current === undefined || compareFilterStates(current, seed) < 0) {
      states.set(key, { ...seed });
    }
  }

  for (const event of events) {
    if (event.type !== "filter.set" && event.type !== "filter.cleared") continue;
    const candidate: MutableFilterState = event.type === "filter.set"
      ? {
          scope: event.scope,
          targetType: event.targetType,
          target: event.target,
          effect: event.effect,
          updatedAt: event.updatedAt,
          ...(event.hitAt === undefined || event.hitAt === null
            ? {}
            : { hitAt: event.hitAt }),
          cleared: false,
          deviceId: event.deviceId,
          eventId: event.id,
        }
      : {
          scope: event.scope,
          targetType: event.targetType,
          target: event.target,
          effect: "OMIT",
          updatedAt: event.updatedAt,
          cleared: true,
          deviceId: event.deviceId,
          eventId: event.id,
        };
    const key = filterKey(candidate.scope, candidate.targetType, candidate.target);
    const current = states.get(key);
    if (current === undefined || compareFilterStates(current, candidate) < 0) {
      states.set(key, candidate);
    }
  }

  return new Map(
    [...states.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function projectThreadStates(
  events: readonly SyncEvent[],
): ReadonlyMap<string, ThreadState> {
  return new Map(
    [...projectDetailedThreadStates(events).entries()]
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

export function projectDetailedThreadStates(
  events: readonly SyncEvent[],
  seeds: readonly SnapshotThreadState[] = [],
): ReadonlyMap<string, ProjectedThreadState> {
  const mutableStates = new Map<string, MutableThreadState>();

  for (const seed of seeds) {
    const state = getOrCreateState(mutableStates, seed.threadId);
    if (
      seed.historyCleared !== undefined &&
      (state.historyCleared === undefined ||
        compareHistoryMarkers(state.historyCleared, seed.historyCleared) < 0)
    ) {
      state.historyCleared = seed.historyCleared;
      state.lastReadPosition = undefined;
      state.responseCount = undefined;
      state.lastViewed = undefined;
    }

    const seedIsCurrentHistoryEpoch =
      seed.historyCleared === undefined
        ? state.historyCleared === undefined
        : state.historyCleared !== undefined &&
          compareHistoryMarkers(state.historyCleared, seed.historyCleared) === 0;

    if (
      seed.metadata !== undefined &&
      (state.metadata === undefined ||
        compareMetadataEvents(state.metadata, seed.metadata) < 0)
    ) {
      state.metadata = seed.metadata;
    }
    if (seedIsCurrentHistoryEpoch && seed.lastReadPosition !== undefined) {
      state.lastReadPosition = Math.max(
        state.lastReadPosition ?? 0,
        seed.lastReadPosition,
      );
    }
    if (seedIsCurrentHistoryEpoch && seed.responseCount !== undefined) {
      state.responseCount = Math.max(
        state.responseCount ?? 0,
        seed.responseCount,
      );
    }
    if (
      seedIsCurrentHistoryEpoch &&
      seed.lastViewed !== undefined &&
      (state.lastViewed === undefined ||
        compareViewedEvents(state.lastViewed, seed.lastViewed) < 0)
    ) {
      state.lastViewed = seed.lastViewed;
    }
    for (const position of seed.postPositions) {
      state.postPositions.add(position);
      if (!state.postRecords.has(position)) {
        state.postRecords.set(position, {
          threadId: seed.threadId,
          position,
          occurredAt: seed.lastViewed?.occurredAt ?? "1970-01-01T00:00:00.000Z",
          deviceId: "",
          eventId: "",
        });
      }
    }
    if (
      seed.favorite !== undefined &&
      (state.favoriteEvent === undefined ||
        compareFavoriteEvents(state.favoriteEvent, seed.favorite) < 0)
    ) {
      state.favoriteLevel = seed.favorite.level;
      if (seed.favorite.cleared) {
        state.favoriteLevel = undefined;
      }
      state.favoriteEvent = seed.favorite;
    }
  }

  const orderedEvents = [...events].sort(compareEventOrder);
  for (const event of orderedEvents) {
    if (!("threadId" in event)) continue;
    const state = getOrCreateState(mutableStates, event.threadId);

    switch (event.type) {
      case "thread.metadata.updated":
        if (!isAfterHistoryClear(event, state.historyCleared)) break;
        if (
          state.metadata === undefined ||
          compareMetadataEvents(state.metadata, event) < 0
        ) {
          state.metadata = {
            title: event.title,
            url: event.url,
            occurredAt: event.occurredAt,
            deviceId: event.deviceId,
            eventId: event.id,
          };
        }
        break;
      case "thread.viewed":
        if (!isAfterHistoryClear(event, state.historyCleared)) break;
        state.lastReadPosition = Math.max(
          state.lastReadPosition ?? 0,
          event.position,
        );
        if (
          state.lastViewed === undefined ||
          compareViewedEvents(state.lastViewed, event) < 0
        ) {
          state.lastViewed = {
            occurredAt: event.occurredAt,
            deviceId: event.deviceId,
            eventId: event.id,
          };
        }
        break;
      case "thread.history.cleared":
        if (
          state.historyCleared === undefined ||
          compareHistoryMarkers(state.historyCleared, event) < 0
        ) {
          state.historyCleared = {
            occurredAt: event.occurredAt,
            deviceId: event.deviceId,
            eventId: event.id,
          };
          state.lastReadPosition = undefined;
          state.responseCount = undefined;
          state.lastViewed = undefined;
        }
        break;
      case "thread.response-count.observed":
        if (!isAfterHistoryClear(event, state.historyCleared)) break;
        state.responseCount = Math.max(
          state.responseCount ?? 0,
          event.responseCount,
        );
        break;
      case "thread.favorite.set":
        if (
          state.favoriteEvent === undefined ||
          compareFavoriteEvents(state.favoriteEvent, event) < 0
        ) {
          state.favoriteLevel = event.level;
          state.favoriteEvent = {
            cleared: false,
            level: event.level,
            occurredAt: event.occurredAt,
            deviceId: event.deviceId,
            eventId: event.id,
          };
        }
        break;
      case "thread.favorite.cleared":
        if (
          state.favoriteEvent === undefined ||
          compareFavoriteEvents(state.favoriteEvent, event) < 0
        ) {
          state.favoriteLevel = undefined;
          state.favoriteEvent = {
            cleared: true,
            occurredAt: event.occurredAt,
            deviceId: event.deviceId,
            eventId: event.id,
          };
        }
        break;
      case "thread.post.recorded": {
        state.postPositions.add(event.position);
        const candidateRecord: ProjectedPostRecord = {
          threadId: event.threadId,
          position: event.position,
          occurredAt: event.occurredAt,
          deviceId: event.deviceId,
          eventId: event.id,
        };
        const existingRecord = state.postRecords.get(event.position);
        if (
          existingRecord === undefined ||
          comparePostRecords(existingRecord, candidateRecord) < 0
        ) {
          state.postRecords.set(event.position, candidateRecord);
        }
        break;
      }
    }
  }

  return new Map<string, ProjectedThreadState>(
    [...mutableStates.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([threadId, state]) => [
        threadId,
        {
          threadId,
          ...(state.metadata === undefined
            ? {}
            : {
                title: state.metadata.title,
                url: state.metadata.url,
                metadata: state.metadata,
              }),
          ...(state.lastReadPosition === undefined
            ? {}
            : { lastReadPosition: state.lastReadPosition }),
          ...(state.responseCount === undefined
            ? {}
            : { responseCount: state.responseCount }),
          ...(state.lastViewed === undefined
            ? {}
            : { lastViewed: state.lastViewed }),
          ...(state.historyCleared === undefined
            ? {}
            : { historyCleared: state.historyCleared }),
          ...(state.favoriteLevel === undefined
            ? {}
            : { favoriteLevel: state.favoriteLevel }),
          ...(state.favoriteEvent === undefined
            ? {}
            : { favoriteEvent: state.favoriteEvent }),
          postPositions: [...state.postPositions].sort((left, right) => left - right),
          postRecords: [...state.postRecords.values()],
        },
      ]),
  );
}

/** Returns whether a projected state should be exposed as a thread history entry. */
export function isProjectedThreadStateVisible(
  state: ProjectedThreadState,
): boolean {
  if (state.favoriteLevel !== undefined || state.postPositions.length > 0) {
    return true;
  }
  if (state.historyCleared !== undefined) {
    return state.lastReadPosition !== undefined || state.lastViewed !== undefined;
  }
  // Preserve the pre-existing behavior for states that have never received
  // a history-clear marker, including an explicitly cleared favorite.
  return true;
}

function getOrCreateState(
  states: Map<string, MutableThreadState>,
  threadId: string,
): MutableThreadState {
  let state = states.get(threadId);
  if (state === undefined) {
    state = {
      threadId,
      postPositions: new Set<number>(),
      postRecords: new Map<number, ProjectedPostRecord>(),
    };
    states.set(threadId, state);
  }
  return state;
}

function comparePostRecords(
  left: ProjectedPostRecord,
  right: ProjectedPostRecord,
): number {
  return (
    Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
    compareOrdinal(left.deviceId, right.deviceId) ||
    compareOrdinal(left.eventId, right.eventId) ||
    compareOrdinal(left.threadId, right.threadId) ||
    left.position - right.position
  );
}

function compareEventOrder(left: SyncEvent, right: SyncEvent): number {
  return (
    Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
    compareOrdinal(left.deviceId, right.deviceId) ||
    compareOrdinal(left.id, right.id)
  );
}

function compareFavoriteEvents(
  left: FavoriteSetEvent | FavoriteClearedEvent | SnapshotFavorite,
  right: FavoriteSetEvent | FavoriteClearedEvent | SnapshotFavorite,
): number {
  return (
    Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
    compareOrdinal(left.deviceId, right.deviceId) ||
    compareOrdinal(
      "id" in left ? left.id : left.eventId,
      "id" in right ? right.id : right.eventId,
    )
  );
}

function compareMetadataEvents(
  left: SnapshotThreadMetadata | { occurredAt: string; deviceId: string; id: string },
  right: SnapshotThreadMetadata | { occurredAt: string; deviceId: string; id: string },
): number {
  return (
    Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
    compareOrdinal(left.deviceId, right.deviceId) ||
    compareOrdinal(
      "id" in left ? left.id : left.eventId,
      "id" in right ? right.id : right.eventId,
    )
  );
}

function compareViewedEvents(
  left: SnapshotViewed | { occurredAt: string; deviceId: string; id: string },
  right: SnapshotViewed | { occurredAt: string; deviceId: string; id: string },
): number {
  return (
    Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
    compareOrdinal(left.deviceId, right.deviceId) ||
    compareOrdinal(
      "id" in left ? left.id : left.eventId,
      "id" in right ? right.id : right.eventId,
    )
  );
}

function compareHistoryMarkers(
  left: SnapshotHistoryCleared | { occurredAt: string; deviceId: string; id: string },
  right: SnapshotHistoryCleared | { occurredAt: string; deviceId: string; id: string },
): number {
  return (
    Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
    compareOrdinal(left.deviceId, right.deviceId) ||
    compareOrdinal(
      "id" in left ? left.id : left.eventId,
      "id" in right ? right.id : right.eventId,
    )
  );
}

function isAfterHistoryClear(
  event: { occurredAt: string; deviceId: string; id: string },
  historyCleared: SnapshotHistoryCleared | undefined,
): boolean {
  return (
    historyCleared === undefined || compareHistoryMarkers(historyCleared, event) < 0
  );
}

function compareFilterStates(
  left: Pick<ProjectedFilterState, "updatedAt" | "deviceId" | "eventId">,
  right: Pick<ProjectedFilterState, "updatedAt" | "deviceId" | "eventId">,
): number {
  return (
    Date.parse(left.updatedAt) - Date.parse(right.updatedAt) ||
    compareOrdinal(left.deviceId, right.deviceId) ||
    compareOrdinal(left.eventId, right.eventId)
  );
}

/** Locale-independent ordering for protocol tie-break fields. */
function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function filterKey(scope: string, targetType: string, target: string): string {
  return JSON.stringify([scope, targetType, target]);
}
