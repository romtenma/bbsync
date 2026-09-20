import type { EventStore } from "./store.js";
import { EVENT_SCHEMA_VERSION } from "./types.js";
import type {
  FavoriteClearedEvent,
  FavoriteSetEvent,
  SegmentCoverage,
  SnapshotFavorite,
  SnapshotThreadMetadata,
  SnapshotThreadState,
  SnapshotViewed,
  SnapshotMute,
  StateSnapshot,
  SyncEvent,
  ThreadState,
  FavoriteLevel,
  MuteEntry,
} from "./types.js";

export interface ProjectedThreadState extends ThreadState {
  readonly metadata?: SnapshotThreadMetadata;
  readonly lastViewed?: SnapshotViewed;
  readonly favoriteEvent?: SnapshotFavorite;
}

export interface ProjectedMuteState extends MuteEntry {
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
  favoriteLevel?: FavoriteLevel;
  favoriteEvent?: SnapshotFavorite;
  postPositions: Set<number>;
}

interface MutableMuteState extends ProjectedMuteState {}

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

export async function readProjectedMutes(
  store: EventStore,
): Promise<ReadonlyMap<string, ProjectedMuteState>> {
  const snapshots = await Promise.all(
    (await store.listSnapshots()).map((deviceId) => store.readSnapshot(deviceId)),
  );
  const seeds = snapshots.flatMap((snapshot) =>
    snapshot === undefined ? [] : snapshot.mutes,
  );
  return projectMuteStates(await readAllEvents(store), seeds);
}

export function snapshotFromStates(
  deviceId: string,
  revision: number,
  createdAt: string,
  coveredSegments: readonly SegmentCoverage[],
  states: ReadonlyMap<string, ProjectedThreadState>,
  mutes: ReadonlyMap<string, ProjectedMuteState> = new Map(),
): StateSnapshot {
  return {
    v: EVENT_SCHEMA_VERSION,
    deviceId,
    revision,
    createdAt,
    coveredSegments: [...coveredSegments],
    threads: [...states.values()]
      .sort((left, right) => left.threadId.localeCompare(right.threadId))
      .map((state) => ({
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
        ...(state.favoriteEvent === undefined
          ? {}
          : { favorite: state.favoriteEvent }),
        postPositions: [...state.postPositions],
      })),
    mutes: [...mutes.values()]
      .sort(compareMuteStates)
      .map((mute) => ({
        scope: mute.scope,
        value: mute.value,
        updatedAt: mute.updatedAt,
        ...(mute.hitAt === undefined ? {} : { hitAt: mute.hitAt }),
        cleared: mute.cleared,
        deviceId: mute.deviceId,
        eventId: mute.eventId,
      })),
  };
}

export function projectMuteStates(
  events: readonly SyncEvent[],
  seeds: readonly SnapshotMute[] = [],
): ReadonlyMap<string, ProjectedMuteState> {
  const states = new Map<string, MutableMuteState>();

  for (const seed of seeds) {
    const key = muteKey(seed.scope, seed.value);
    const current = states.get(key);
    if (current === undefined || compareMuteStates(current, seed) < 0) {
      states.set(key, { ...seed });
    }
  }

  for (const event of events) {
    if (event.type !== "mute.set" && event.type !== "mute.cleared") continue;
    const candidate: MutableMuteState = event.type === "mute.set"
      ? {
          scope: event.scope,
          value: event.value,
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
          value: event.value,
          updatedAt: event.updatedAt,
          cleared: true,
          deviceId: event.deviceId,
          eventId: event.id,
        };
    const key = muteKey(candidate.scope, candidate.value);
    const current = states.get(key);
    if (current === undefined || compareMuteStates(current, candidate) < 0) {
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
    [...projectDetailedThreadStates(events).entries()].map(([threadId, state]) => [
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
      seed.metadata !== undefined &&
      (state.metadata === undefined ||
        compareMetadataEvents(state.metadata, seed.metadata) < 0)
    ) {
      state.metadata = seed.metadata;
    }
    if (seed.lastReadPosition !== undefined) {
      state.lastReadPosition = Math.max(
        state.lastReadPosition ?? 0,
        seed.lastReadPosition,
      );
    }
    if (seed.responseCount !== undefined) {
      state.responseCount = Math.max(
        state.responseCount ?? 0,
        seed.responseCount,
      );
    }
    if (
      seed.lastViewed !== undefined &&
      (state.lastViewed === undefined ||
        compareViewedEvents(state.lastViewed, seed.lastViewed) < 0)
    ) {
      state.lastViewed = seed.lastViewed;
    }
    for (const position of seed.postPositions) {
      state.postPositions.add(position);
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

  for (const event of events) {
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
      case "thread.response-count.observed":
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
      case "thread.post.recorded":
        state.postPositions.add(event.position);
        break;
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
          ...(state.favoriteLevel === undefined
            ? {}
            : { favoriteLevel: state.favoriteLevel }),
          ...(state.favoriteEvent === undefined
            ? {}
            : { favoriteEvent: state.favoriteEvent }),
          postPositions: [...state.postPositions].sort((left, right) => left - right),
        },
      ]),
  );
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
    };
    states.set(threadId, state);
  }
  return state;
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

function compareMuteStates(
  left: Pick<ProjectedMuteState, "updatedAt" | "deviceId" | "eventId">,
  right: Pick<ProjectedMuteState, "updatedAt" | "deviceId" | "eventId">,
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

function muteKey(scope: string, value: string): string {
  return JSON.stringify([scope, value]);
}
