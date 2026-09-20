export const EVENT_SCHEMA_VERSION = 1 as const;

export type EventSchemaVersion = typeof EVENT_SCHEMA_VERSION;

export type FavoriteLevel = 1 | 2 | 3 | 4 | 5;

export interface SegmentRef {
  readonly deviceId: string;
  readonly segmentId: string;
}

export interface SnapshotFavorite {
  readonly cleared: boolean;
  readonly level?: FavoriteLevel;
  readonly occurredAt: string;
  readonly deviceId: string;
  readonly eventId: string;
}

export interface SnapshotViewed {
  readonly occurredAt: string;
  readonly deviceId: string;
  readonly eventId: string;
}

export interface SnapshotThreadMetadata {
  readonly title: string;
  readonly url: string;
  readonly occurredAt: string;
  readonly deviceId: string;
  readonly eventId: string;
}

export interface SnapshotThreadState {
  readonly threadId: string;
  readonly metadata?: SnapshotThreadMetadata;
  readonly lastReadPosition?: number;
  readonly responseCount?: number;
  readonly lastViewed?: SnapshotViewed;
  readonly favorite?: SnapshotFavorite;
  readonly postPositions: readonly number[];
}

export interface SnapshotMute {
  readonly scope: string;
  readonly value: string;
  readonly updatedAt: string;
  readonly hitAt?: string;
  readonly cleared: boolean;
  readonly deviceId: string;
  readonly eventId: string;
}

export interface SegmentCoverage {
  readonly segmentId: string;
  readonly eventCount: number;
}

export interface StateSnapshot {
  readonly v: EventSchemaVersion;
  readonly deviceId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly coveredSegments: readonly SegmentCoverage[];
  readonly threads: readonly SnapshotThreadState[];
  readonly mutes: readonly SnapshotMute[];
}

interface BaseEvent {
  readonly v: EventSchemaVersion;
  readonly id: string;
  readonly deviceId: string;
  readonly occurredAt: string;
}

interface BaseThreadEvent extends BaseEvent {
  readonly threadId: string;
}

export interface ThreadViewedEvent extends BaseThreadEvent {
  readonly type: "thread.viewed";
  readonly position: number;
}

export interface ThreadMetadataUpdatedEvent extends BaseThreadEvent {
  readonly v: typeof EVENT_SCHEMA_VERSION;
  readonly type: "thread.metadata.updated";
  readonly title: string;
  readonly url: string;
}

export interface ThreadResponseCountObservedEvent extends BaseThreadEvent {
  readonly type: "thread.response-count.observed";
  readonly responseCount: number;
}

export interface FavoriteSetEvent extends BaseThreadEvent {
  readonly type: "thread.favorite.set";
  readonly level: FavoriteLevel;
}

export interface FavoriteClearedEvent extends BaseThreadEvent {
  readonly type: "thread.favorite.cleared";
}

export interface PostRecordedEvent extends BaseThreadEvent {
  readonly type: "thread.post.recorded";
  readonly position: number;
}

export interface MuteSetEvent extends BaseEvent {
  readonly type: "mute.set";
  readonly scope: string;
  readonly value: string;
  readonly updatedAt: string;
  readonly hitAt?: string | null;
}

export interface MuteClearedEvent extends BaseEvent {
  readonly type: "mute.cleared";
  readonly scope: string;
  readonly value: string;
  readonly updatedAt: string;
}

export type SyncEvent =
  | ThreadMetadataUpdatedEvent
  | ThreadViewedEvent
  | ThreadResponseCountObservedEvent
  | FavoriteSetEvent
  | FavoriteClearedEvent
  | PostRecordedEvent
  | MuteSetEvent
  | MuteClearedEvent;

interface BaseEventInput {
  readonly occurredAt?: string;
}

interface BaseThreadEventInput extends BaseEventInput {
  readonly threadId: string;
}

export interface ThreadViewedInput extends BaseThreadEventInput {
  readonly type: "thread.viewed";
  readonly position: number;
}

export interface ThreadMetadataUpdatedInput extends BaseThreadEventInput {
  readonly type: "thread.metadata.updated";
  readonly title: string;
  readonly url: string;
}

export interface ThreadResponseCountObservedInput extends BaseThreadEventInput {
  readonly type: "thread.response-count.observed";
  readonly responseCount: number;
}

export interface FavoriteSetInput extends BaseThreadEventInput {
  readonly type: "thread.favorite.set";
  readonly level?: FavoriteLevel;
}

export interface FavoriteClearedInput extends BaseThreadEventInput {
  readonly type: "thread.favorite.cleared";
}

export interface PostRecordedInput extends BaseThreadEventInput {
  readonly type: "thread.post.recorded";
  readonly position: number;
}

export interface MuteSetInput extends BaseEventInput {
  readonly type: "mute.set";
  readonly scope: string;
  readonly value: string;
  readonly updatedAt?: string;
  readonly hitAt?: string | null;
}

export interface MuteClearedInput extends BaseEventInput {
  readonly type: "mute.cleared";
  readonly scope: string;
  readonly value: string;
  readonly updatedAt?: string;
}

export type SyncEventInput =
  | ThreadMetadataUpdatedInput
  | ThreadViewedInput
  | ThreadResponseCountObservedInput
  | FavoriteSetInput
  | FavoriteClearedInput
  | PostRecordedInput
  | MuteSetInput
  | MuteClearedInput;

export interface MuteEntry {
  readonly scope: string;
  readonly value: string;
  readonly updatedAt: string;
  readonly hitAt?: string;
}

export interface ThreadState {
  readonly threadId: string;
  readonly title?: string;
  readonly url?: string;
  readonly lastReadPosition?: number;
  readonly responseCount?: number;
  readonly lastViewedAt?: string;
  readonly favoriteLevel?: FavoriteLevel;
  readonly postPositions: readonly number[];
}

export interface SynchronizeResult {
  readonly copiedToLeft: number;
  readonly copiedToRight: number;
  readonly copiedSnapshotsToLeft: number;
  readonly copiedSnapshotsToRight: number;
}
