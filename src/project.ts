import { CoverageMismatchError, EventCollisionError } from "./errors.js";
import { segmentKey, type EventStore } from "./store.js";
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
  type SnapshotPostCleared,
  type SnapshotPostRecorded,
  type SnapshotFilter,
  type StateSnapshot,
  type SyncEvent,
  type SegmentRef,
  type ThreadState,
  type FavoriteLevel,
  type FilterEntry,
} from "./types.js";

interface PostRecordBase {
  readonly threadId: string;
  readonly position: number;
  readonly occurredAt: string;
  readonly deviceId: string;
  readonly eventId: string;
}

export interface ProjectedPostRecord extends PostRecordBase {}

export interface ProjectedThreadState extends ThreadState {
  readonly metadata?: SnapshotThreadMetadata;
  readonly lastViewed?: SnapshotViewed;
  readonly historyCleared?: SnapshotHistoryCleared;
  readonly favoriteEvent?: SnapshotFavorite;
  readonly postRecords?: readonly ProjectedPostRecord[];
  readonly postClearRecords?: readonly SnapshotPostCleared[];
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
  firstReadPosition?: number;
  responseCount?: number;
  lastViewed?: SnapshotViewed;
  historyCleared?: SnapshotHistoryCleared;
  favoriteLevel?: FavoriteLevel;
  favoriteEvent?: SnapshotFavorite;
  postPositions: Set<number>;
  postRecords: Map<number, MutablePostRecord>;
}

interface MutablePostRecord extends ProjectedPostRecord {
  readonly cleared: boolean;
}

interface MutableFilterState extends ProjectedFilterState {}

interface StoredSegment {
  readonly ref: SegmentRef;
  readonly events: readonly SyncEvent[];
}

export interface ProjectionSource {
  readonly snapshots: readonly StateSnapshot[];
  readonly segments: readonly StoredSegment[];
  readonly events: readonly SyncEvent[];
}

/** Reads every projection input once so snapshot contents and coverage agree. */
export async function readProjectionSource(
  store: EventStore,
): Promise<ProjectionSource> {
  const snapshotIds = await store.listSnapshots();
  const segmentRefs = await store.listSegments();
  const [snapshotValues, segmentValues] = await Promise.all([
    Promise.all(snapshotIds.map((deviceId) => store.readSnapshot(deviceId))),
    Promise.all(segmentRefs.map(async (ref) => ({
      ref,
      events: await store.readSegment(ref),
    }))),
  ]);
  const snapshots = snapshotValues.flatMap((snapshot) =>
    snapshot === undefined ? [] : [snapshot],
  );
  const segments: readonly StoredSegment[] = segmentValues;
  void deduplicateEvents(segments.flatMap((segment) => segment.events));
  const coveredCounts = new Map<string, number>();
  for (const snapshot of snapshots) {
    for (const coverage of snapshot.coveredSegments) {
      coveredCounts.set(
        segmentKey({
          deviceId: snapshot.deviceId,
          segmentId: coverage.segmentId,
        }),
        coverage.eventCount,
      );
    }
  }
  const coveredEventIds = new Set<string>();
  const uncoveredEvents: SyncEvent[] = [];
  for (const segment of segments) {
    const coveredCount = coveredCounts.get(segmentKey(segment.ref)) ?? 0;
    if (coveredCount > segment.events.length) {
      throw new CoverageMismatchError(
        segment.ref.deviceId,
        segment.ref.segmentId,
        { coveredCount, actualCount: segment.events.length },
      );
    }
    for (const event of segment.events.slice(0, coveredCount)) {
      coveredEventIds.add(event.id);
    }
    uncoveredEvents.push(...segment.events.slice(coveredCount));
  }
  return {
    snapshots,
    segments,
    events: deduplicateEvents(
      uncoveredEvents.filter((event) => !coveredEventIds.has(event.id)),
    ),
  };
}

export async function readAllEvents(
  store: EventStore,
): Promise<readonly SyncEvent[]> {
  const events: SyncEvent[] = [];
  for (const ref of await store.listSegments()) {
    events.push(...await store.readSegment(ref));
  }
  return deduplicateEvents(events);
}

export async function readProjectedStates(
  store: EventStore,
): Promise<ReadonlyMap<string, ProjectedThreadState>> {
  const source = await readProjectionSource(store);
  return projectDetailedThreadStates(
    source.events,
    source.snapshots.flatMap((snapshot) => snapshot.threads),
  );
}

export async function readProjectedFilters(
  store: EventStore,
): Promise<ReadonlyMap<string, ProjectedFilterState>> {
  const source = await readProjectionSource(store);
  return projectFilterStates(
    source.events,
    source.snapshots.flatMap((snapshot) => snapshot.filters),
  );
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

  const retainedPostsByThread = new Map<string, Map<number, ProjectedPostRecord>>();
  for (const record of retainedPostRecords) {
    let records = retainedPostsByThread.get(record.threadId);
    if (records === undefined) {
      records = new Map<number, ProjectedPostRecord>();
      retainedPostsByThread.set(record.threadId, records);
    }
    records.set(record.position, record);
  }

  const threads: SnapshotThreadState[] = [];
  for (const state of states.values()) {
    const retainedRecords = retainedPostsByThread.get(state.threadId) ?? new Map();
    const postPositions = [...retainedRecords.keys()].sort((left, right) => left - right);
    const postRecords: SnapshotPostRecorded[] = postPositions.flatMap((position) => {
      const record = retainedRecords.get(position)!;
      // Old v2 snapshots did not retain this metadata. Keep their position for
      // compatibility, but do not serialize an invalid synthetic marker.
      return record.deviceId.length === 0 || record.eventId.length === 0
        ? []
        : [{
            position: record.position,
            occurredAt: record.occurredAt,
            deviceId: record.deviceId,
            eventId: record.eventId,
          }];
    });
    const postCleared = [...(state.postClearRecords ?? [])].sort(
      (left, right) => left.position - right.position,
    );
    const hasFavoriteState = state.favoriteEvent !== undefined;
    const hasPosts = postPositions.length > 0;
    const hasPostClears = postCleared.length > 0;
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

    if (
      !hasFavoriteState &&
      !hasPosts &&
      !hasPostClears &&
      !isRecent &&
      !hasHistoryClear
    ) {
      continue;
    }

    threads.push({
      threadId: state.threadId,
      ...(state.metadata === undefined ? {} : { metadata: state.metadata }),
      ...(state.lastReadPosition === undefined
        ? {}
        : { lastReadPosition: state.lastReadPosition }),
      ...(state.firstReadPosition === undefined
        ? {}
        : { firstReadPosition: state.firstReadPosition }),
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
      ...(postRecords.length === 0 ? {} : { postRecords }),
      ...(postCleared.length === 0 ? {} : { postCleared }),
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
        isRegex: filter.isRegex,
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
      states.set(key, { ...seed, isRegex: seed.isRegex === true });
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
          isRegex: event.isRegex === true,
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
          isRegex: false,
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
          ...(state.firstReadPosition === undefined
            ? {}
            : { firstReadPosition: state.firstReadPosition }),
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

  // Establish the latest deletion boundary before merging aggregate snapshot
  // values so the outcome does not depend on snapshot enumeration order.
  for (const seed of seeds) {
    const state = getOrCreateState(mutableStates, seed.threadId);
    if (
      seed.historyCleared !== undefined &&
      (state.historyCleared === undefined ||
        compareHistoryMarkers(state.historyCleared, seed.historyCleared) < 0)
    ) {
      state.historyCleared = seed.historyCleared;
      state.lastReadPosition = undefined;
      state.firstReadPosition = undefined;
      state.responseCount = undefined;
      state.lastViewed = undefined;
    }
  }

  for (const seed of seeds) {
    const state = getOrCreateState(mutableStates, seed.threadId);

    const seedIsCurrentHistoryEpoch =
      seed.historyCleared === undefined
        ? state.historyCleared === undefined
        : state.historyCleared !== undefined &&
          compareHistoryMarkers(state.historyCleared, seed.historyCleared) === 0;
    const seedHasViewAfterHistoryClear =
      state.historyCleared !== undefined &&
      seed.lastViewed !== undefined &&
      compareHistoryMarkers(state.historyCleared, seed.lastViewed) < 0;
    const seedCanContributeHistory =
      seedIsCurrentHistoryEpoch || seedHasViewAfterHistoryClear;

    if (
      seed.metadata !== undefined &&
      (state.metadata === undefined ||
        compareMetadataEvents(state.metadata, seed.metadata) < 0)
    ) {
      state.metadata = seed.metadata;
    }
    if (seedCanContributeHistory && seed.lastReadPosition !== undefined) {
      state.lastReadPosition = Math.max(
        state.lastReadPosition ?? 0,
        seed.lastReadPosition,
      );
    }
    if (
      seedIsCurrentHistoryEpoch &&
      seed.lastViewed === undefined &&
      state.lastViewed === undefined &&
      seed.firstReadPosition !== undefined
    ) {
      state.firstReadPosition = seed.firstReadPosition;
    }
    if (seedCanContributeHistory && seed.responseCount !== undefined) {
      state.responseCount = Math.max(
        state.responseCount ?? 0,
        seed.responseCount,
      );
    }
    if (
      seedCanContributeHistory &&
      seed.lastViewed !== undefined &&
      (state.lastViewed === undefined ||
        compareViewedEvents(state.lastViewed, seed.lastViewed) < 0)
    ) {
      state.lastViewed = seed.lastViewed;
      state.firstReadPosition =
        seed.firstReadPosition ?? seed.lastViewed.firstPosition;
    }
    for (const recorded of seed.postRecords ?? []) {
      applyPostMarker(state, {
        threadId: seed.threadId,
        position: recorded.position,
        occurredAt: recorded.occurredAt,
        deviceId: recorded.deviceId,
        eventId: recorded.eventId,
        cleared: false,
      });
    }
    for (const cleared of seed.postCleared ?? []) {
      applyPostMarker(state, {
        threadId: seed.threadId,
        position: cleared.position,
        occurredAt: cleared.occurredAt,
        deviceId: cleared.deviceId,
        eventId: cleared.eventId,
        cleared: true,
      });
    }
    for (const position of seed.postPositions) {
      // Legacy v2 snapshots have no ordering metadata for active positions.
      // Only seed an unknown marker when no explicit recorded/cleared marker
      // exists, making deletion win independently of snapshot enumeration.
      if (!state.postRecords.has(position)) {
        state.postPositions.add(position);
        state.postRecords.set(position, {
          threadId: seed.threadId,
          position,
          occurredAt: "1970-01-01T00:00:00.000Z",
          deviceId: "",
          eventId: "",
          cleared: false,
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
            ...(event.firstPosition === undefined
              ? {}
              : { firstPosition: event.firstPosition }),
          };
          state.firstReadPosition = event.firstPosition;
        }
        break;
      case "thread.history.cleared":
        if (
          state.historyCleared === undefined ||
          compareHistoryMarkers(state.historyCleared, event) < 0
        ) {
          const marker: SnapshotHistoryCleared = {
            occurredAt: event.occurredAt,
            deviceId: event.deviceId,
            eventId: event.id,
          };
          state.historyCleared = marker;
          if (
            state.lastViewed === undefined ||
            compareViewedEvents(state.lastViewed, event) <= 0
          ) {
            state.lastReadPosition = undefined;
            state.firstReadPosition = undefined;
            state.responseCount = undefined;
            state.lastViewed = undefined;
          }
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
        applyPostMarker(state, {
          threadId: event.threadId,
          position: event.position,
          occurredAt: event.occurredAt,
          deviceId: event.deviceId,
          eventId: event.id,
          cleared: false,
        });
        break;
      }
      case "thread.post.cleared": {
        applyPostMarker(state, {
          threadId: event.threadId,
          position: event.position,
          occurredAt: event.occurredAt,
          deviceId: event.deviceId,
          eventId: event.id,
          cleared: true,
        });
        break;
      }
    }
  }

  return new Map<string, ProjectedThreadState>(
    [...mutableStates.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([threadId, state]) => {
        const postRecords = [...state.postRecords.values()]
          .filter((record) => !record.cleared)
          .map(({ cleared: _cleared, ...record }) => record);
        const postClearRecords = [...state.postRecords.values()]
          .filter((record) => record.cleared)
          .map(({ cleared: _cleared, threadId: _threadId, ...record }) => record);
        return [
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
            ...(state.firstReadPosition === undefined
              ? {}
              : { firstReadPosition: state.firstReadPosition }),
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
            postRecords,
            ...(postClearRecords.length === 0 ? {} : { postClearRecords }),
          },
        ] as const;
      }),
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
    return (
      state.lastReadPosition !== undefined ||
      state.firstReadPosition !== undefined ||
      state.lastViewed !== undefined
    );
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
      postRecords: new Map<number, MutablePostRecord>(),
    };
    states.set(threadId, state);
  }
  return state;
}

function applyPostMarker(
  state: MutableThreadState,
  candidate: MutablePostRecord,
): void {
  const existing = state.postRecords.get(candidate.position);
  if (existing !== undefined) {
    const existingHasOrder = hasPostOrder(existing);
    const candidateHasOrder = hasPostOrder(candidate);
    if (!candidateHasOrder || (
      existingHasOrder && comparePostRecords(existing, candidate) >= 0
    )) {
      return;
    }
  }

  state.postRecords.set(candidate.position, candidate);
  if (candidate.cleared) {
    state.postPositions.delete(candidate.position);
  } else {
    state.postPositions.add(candidate.position);
  }
}

function hasPostOrder(record: PostRecordBase): boolean {
  return record.deviceId.length > 0 && record.eventId.length > 0;
}

function comparePostRecords(
  left: PostRecordBase,
  right: PostRecordBase,
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

function deduplicateEvents(events: readonly SyncEvent[]): readonly SyncEvent[] {
  const eventsById = new Map<string, SyncEvent>();
  for (const event of events) {
    const existing = eventsById.get(event.id);
    if (existing === undefined) {
      eventsById.set(event.id, event);
    } else if (JSON.stringify(existing) !== JSON.stringify(event)) {
      throw new EventCollisionError(event.id);
    }
  }
  return [...eventsById.values()];
}
