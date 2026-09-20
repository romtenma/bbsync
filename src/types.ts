export const EVENT_SCHEMA_VERSION = 2 as const;

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

/** A browser-defined filter target type. */
export type FilterTargetType = string;

/** A browser-defined filter effect. */
export type FilterEffect = string;

export interface SnapshotFilter {
  readonly scope: string;
  readonly targetType: FilterTargetType;
  readonly target: string;
  readonly effect: FilterEffect;
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
  readonly filters: readonly SnapshotFilter[];
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

export interface FilterSetEvent extends BaseEvent {
  readonly type: "filter.set";
  readonly scope: string;
  readonly targetType: FilterTargetType;
  readonly target: string;
  readonly effect: FilterEffect;
  readonly updatedAt: string;
  readonly hitAt?: string | null;
}

export interface FilterClearedEvent extends BaseEvent {
  readonly type: "filter.cleared";
  readonly scope: string;
  readonly targetType: FilterTargetType;
  readonly target: string;
  readonly updatedAt: string;
}

export type SyncEvent =
  | ThreadMetadataUpdatedEvent
  | ThreadViewedEvent
  | ThreadResponseCountObservedEvent
  | FavoriteSetEvent
  | FavoriteClearedEvent
  | PostRecordedEvent
  | FilterSetEvent
  | FilterClearedEvent;

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

export interface FilterSetInput extends BaseEventInput {
  readonly type: "filter.set";
  readonly scope: string;
  readonly targetType: FilterTargetType;
  readonly target: string;
  readonly effect: FilterEffect;
  readonly updatedAt?: string;
  readonly hitAt?: string | null;
}

export interface FilterClearedInput extends BaseEventInput {
  readonly type: "filter.cleared";
  readonly scope: string;
  readonly targetType: FilterTargetType;
  readonly target: string;
  readonly updatedAt?: string;
}

export type SyncEventInput =
  | ThreadMetadataUpdatedInput
  | ThreadViewedInput
  | ThreadResponseCountObservedInput
  | FavoriteSetInput
  | FavoriteClearedInput
  | PostRecordedInput
  | FilterSetInput
  | FilterClearedInput;

export interface FilterEntry {
  readonly scope: string;
  readonly targetType: FilterTargetType;
  readonly target: string;
  readonly effect: FilterEffect;
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

export const DEFAULT_MAX_GLOBAL_POST_POSITIONS = 1_000;
export const DEFAULT_THREAD_RETENTION_PERIOD_MS = 30 * 24 * 60 * 60 * 1_000;

export interface CompactOptions {
  /** Maximum number of total post positions across all threads to retain. Defaults to 1,000. */
  readonly maxGlobalPostPositions?: number;
  /** Inactive thread retention period in milliseconds. Defaults to 30 days. */
  readonly retentionPeriodMs?: number;
}

