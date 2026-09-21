import {
  EVENT_SCHEMA_VERSION,
  type FavoriteLevel,
  type SegmentRef,
  type SegmentCoverage,
  type SnapshotThreadMetadata,
  type SnapshotViewed,
  type SnapshotFilter,
  type SnapshotHistoryCleared,
  type StateSnapshot,
  type SyncEvent,
} from "./types.js";

const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertSafeComponent(value: string, name: string): void {
  if (!SAFE_COMPONENT.test(value)) {
    throw new TypeError(
      `${name} must contain only ASCII letters, digits, dot, underscore, or hyphen`,
    );
  }
}

export function assertSegmentRef(ref: SegmentRef): void {
  assertSafeComponent(ref.deviceId, "deviceId");
  assertSafeComponent(ref.segmentId, "segmentId");
}

export function assertEvent(value: unknown): asserts value is SyncEvent {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("event must be an object");
  }

  const event = value as Record<string, unknown>;
  if (event.v !== EVENT_SCHEMA_VERSION) {
    throw new TypeError(`unsupported event schema version: ${String(event.v)}`);
  }

  for (const field of ["id", "deviceId", "occurredAt"] as const) {
    if (typeof event[field] !== "string" || event[field].length === 0) {
      throw new TypeError(`event.${field} must be a non-empty string`);
    }
  }

  assertSafeComponent(event.id as string, "event.id");
  assertSafeComponent(event.deviceId as string, "event.deviceId");

  if (Number.isNaN(Date.parse(event.occurredAt as string))) {
    throw new TypeError("event.occurredAt must be a valid date-time string");
  }

  if (event.type !== "filter.set" && event.type !== "filter.cleared") {
    if (typeof event.threadId !== "string" || event.threadId.length === 0) {
      throw new TypeError("event.threadId must be a non-empty string");
    }
  } else {
    assertFilterKey(event.scope, event.targetType, event.target);
    if (event.type === "filter.set") {
      assertFilterEffect(event.effect);
      if (event.isRegex !== undefined && typeof event.isRegex !== "boolean") {
        throw new TypeError("event.isRegex must be a boolean");
      }
    }
    assertDateTime(event.updatedAt, "event.updatedAt");
    if (event.type === "filter.set" && event.hitAt !== undefined && event.hitAt !== null) {
      assertDateTime(event.hitAt, "event.hitAt");
    }
  }

  switch (event.type) {
    case "thread.metadata.updated":
      assertThreadMetadata(event.title, event.url, "event");
      break;
    case "thread.viewed":
      assertPosition(event.position, true);
      break;
    case "thread.history.cleared":
      break;
    case "thread.response-count.observed":
      assertPosition(event.responseCount, true);
      break;
    case "thread.favorite.set":
      assertFavoriteLevel(event.level);
      break;
    case "thread.favorite.cleared":
      break;
    case "thread.post.recorded":
      assertPosition(event.position, false);
      break;
    case "thread.post.cleared":
      assertPosition(event.position, false);
      break;
    case "filter.set":
    case "filter.cleared":
      break;
    default:
      throw new TypeError(`unsupported event type: ${String(event.type)}`);
  }
}

export function assertPosition(value: unknown, allowZero: boolean): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`position must be a safe integer greater than or equal to ${minimum}`);
  }
}

export function assertThreadId(threadId: string): void {
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new TypeError("threadId must be a non-empty string");
  }
}

export function assertSnapshot(value: unknown): asserts value is StateSnapshot {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("snapshot must be an object");
  }
  const snapshot = value as Record<string, unknown>;
  if (snapshot.v !== EVENT_SCHEMA_VERSION) {
    throw new TypeError(`unsupported snapshot schema version: ${String(snapshot.v)}`);
  }
  if (typeof snapshot.deviceId !== "string") {
    throw new TypeError("snapshot.deviceId must be a string");
  }
  assertSafeComponent(snapshot.deviceId, "snapshot.deviceId");
  if (!Number.isSafeInteger(snapshot.revision) || (snapshot.revision as number) < 1) {
    throw new TypeError("snapshot.revision must be a positive safe integer");
  }
  if (typeof snapshot.createdAt !== "string" || Number.isNaN(Date.parse(snapshot.createdAt))) {
    throw new TypeError("snapshot.createdAt must be a valid date-time string");
  }
  if (!Array.isArray(snapshot.threads)) {
    throw new TypeError("snapshot.threads must be an array");
  }
  if (!Array.isArray(snapshot.coveredSegments)) {
    throw new TypeError("snapshot.coveredSegments must be an array");
  }
  for (const coverage of snapshot.coveredSegments) {
    assertSegmentCoverage(coverage);
  }
  for (const thread of snapshot.threads) {
    assertSnapshotThread(thread);
  }
  if (!Array.isArray(snapshot.filters)) {
    throw new TypeError("snapshot.filters must be an array");
  }
  for (const filter of snapshot.filters) {
    assertSnapshotFilter(filter);
  }
}

function assertSegmentCoverage(value: unknown): asserts value is SegmentCoverage {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("snapshot segment coverage must be an object");
  }
  const coverage = value as Record<string, unknown>;
  assertSafeComponent(coverage.segmentId as string, "snapshot segmentId");
  if (!Number.isSafeInteger(coverage.eventCount) || (coverage.eventCount as number) < 0) {
    throw new TypeError("snapshot eventCount must be a non-negative safe integer");
  }
}

function assertSnapshotThread(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("snapshot thread must be an object");
  }
  const thread = value as Record<string, unknown>;
  assertThreadId(thread.threadId as string);
  if (thread.metadata !== undefined) {
    assertSnapshotThreadMetadata(thread.metadata);
  }
  if (
    thread.lastReadPosition !== undefined &&
    (!Number.isSafeInteger(thread.lastReadPosition) || (thread.lastReadPosition as number) < 0)
  ) {
    throw new TypeError("snapshot lastReadPosition must be a non-negative safe integer");
  }
  if (
    thread.responseCount !== undefined &&
    (!Number.isSafeInteger(thread.responseCount) || (thread.responseCount as number) < 0)
  ) {
    throw new TypeError("snapshot responseCount must be a non-negative safe integer");
  }
  if (thread.lastViewed !== undefined) {
    assertSnapshotViewed(thread.lastViewed);
  }
  if (thread.historyCleared !== undefined) {
    assertSnapshotHistoryCleared(thread.historyCleared);
  }
  if (!Array.isArray(thread.postPositions) || thread.postPositions.some(
    (position) => !Number.isSafeInteger(position) || (position as number) < 1,
  )) {
    throw new TypeError("snapshot postPositions must contain positive safe integers");
  }
  if (thread.postCleared !== undefined) {
    if (!Array.isArray(thread.postCleared)) {
      throw new TypeError("snapshot postCleared must be an array");
    }
    for (const marker of thread.postCleared) {
      assertSnapshotPostCleared(marker);
    }
  }
  if (thread.favorite !== undefined) {
    if (typeof thread.favorite !== "object" || thread.favorite === null) {
      throw new TypeError("snapshot favorite must be an object");
    }
    const favorite = thread.favorite as Record<string, unknown>;
    if (typeof favorite.cleared !== "boolean") {
      throw new TypeError("snapshot favorite.cleared must be boolean");
    }
    if (favorite.cleared) {
      if (favorite.level !== undefined) {
        throw new TypeError("cleared snapshot favorite must not have a level");
      }
    } else {
      assertFavoriteLevel(favorite.level);
    }
    for (const field of ["occurredAt", "deviceId", "eventId"] as const) {
      if (typeof favorite[field] !== "string" || favorite[field].length === 0) {
        throw new TypeError(`snapshot favorite.${field} must be a non-empty string`);
      }
    }
    if (Number.isNaN(Date.parse(favorite.occurredAt as string))) {
      throw new TypeError("snapshot favorite.occurredAt must be a valid date-time string");
    }
    assertSafeComponent(favorite.deviceId as string, "snapshot favorite.deviceId");
    assertSafeComponent(favorite.eventId as string, "snapshot favorite.eventId");
  }
}

function assertSnapshotPostCleared(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("snapshot post-cleared marker must be an object");
  }
  const marker = value as Record<string, unknown>;
  assertPosition(marker.position, false);
  assertDateTime(marker.occurredAt, "snapshot postCleared.occurredAt");
  for (const field of ["deviceId", "eventId"] as const) {
    if (typeof marker[field] !== "string" || marker[field].length === 0) {
      throw new TypeError(`snapshot postCleared.${field} must be a non-empty string`);
    }
    assertSafeComponent(marker[field] as string, `snapshot postCleared.${field}`);
  }
}

function assertSnapshotThreadMetadata(
  value: unknown,
): asserts value is SnapshotThreadMetadata {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("snapshot thread metadata must be an object");
  }
  const metadata = value as Record<string, unknown>;
  assertThreadMetadata(metadata.title, metadata.url, "snapshot metadata");
  assertDateTime(metadata.occurredAt, "snapshot metadata.occurredAt");
  for (const field of ["deviceId", "eventId"] as const) {
    if (typeof metadata[field] !== "string" || metadata[field].length === 0) {
      throw new TypeError(`snapshot metadata.${field} must be a non-empty string`);
    }
    assertSafeComponent(metadata[field] as string, `snapshot metadata.${field}`);
  }
}

export function assertThreadMetadata(
  title: unknown,
  url: unknown,
  prefix = "thread metadata",
): void {
  if (typeof title !== "string" || title.length === 0) {
    throw new TypeError(`${prefix}.title must be a non-empty string`);
  }
  if (typeof url !== "string" || url.length === 0) {
    throw new TypeError(`${prefix}.url must be a non-empty string`);
  }
  try {
    new URL(url);
  } catch {
    throw new TypeError(`${prefix}.url must be an absolute URL`);
  }
}

function assertSnapshotViewed(value: unknown): asserts value is SnapshotViewed {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("snapshot lastViewed must be an object");
  }
  const viewed = value as Record<string, unknown>;
  if (typeof viewed.occurredAt !== "string" || Number.isNaN(Date.parse(viewed.occurredAt))) {
    throw new TypeError("snapshot lastViewed.occurredAt must be a valid date-time string");
  }
  for (const field of ["deviceId", "eventId"] as const) {
    if (typeof viewed[field] !== "string" || viewed[field].length === 0) {
      throw new TypeError(`snapshot lastViewed.${field} must be a non-empty string`);
    }
    assertSafeComponent(viewed[field] as string, `snapshot lastViewed.${field}`);
  }
}

function assertSnapshotHistoryCleared(
  value: unknown,
): asserts value is SnapshotHistoryCleared {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("snapshot historyCleared must be an object");
  }
  const cleared = value as Record<string, unknown>;
  if (
    typeof cleared.occurredAt !== "string" ||
    Number.isNaN(Date.parse(cleared.occurredAt))
  ) {
    throw new TypeError("snapshot historyCleared.occurredAt must be a valid date-time string");
  }
  for (const field of ["deviceId", "eventId"] as const) {
    if (typeof cleared[field] !== "string" || cleared[field].length === 0) {
      throw new TypeError(`snapshot historyCleared.${field} must be a non-empty string`);
    }
    assertSafeComponent(cleared[field] as string, `snapshot historyCleared.${field}`);
  }
}

function assertSnapshotFilter(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("snapshot filter must be an object");
  }
  const filter = value as Record<string, unknown>;
  assertFilterKey(filter.scope, filter.targetType, filter.target);
  assertFilterEffect(filter.effect, "snapshot filter");
  if (filter.isRegex !== undefined && typeof filter.isRegex !== "boolean") {
    throw new TypeError("snapshot filter.isRegex must be a boolean");
  }
  assertDateTime(filter.updatedAt, "snapshot filter.updatedAt");
  if (filter.hitAt !== undefined) {
    assertDateTime(filter.hitAt, "snapshot filter.hitAt");
  }
  if (typeof filter.cleared !== "boolean") {
    throw new TypeError("snapshot filter.cleared must be boolean");
  }
  for (const field of ["deviceId", "eventId"] as const) {
    if (typeof filter[field] !== "string" || filter[field].length === 0) {
      throw new TypeError(`snapshot filter.${field} must be a non-empty string`);
    }
    assertSafeComponent(filter[field] as string, `snapshot filter.${field}`);
  }
}

export function assertFilterKey(
  scope: unknown,
  targetType: unknown,
  target: unknown,
): void {
  if (typeof scope !== "string" || scope.length === 0) {
    throw new TypeError("filter scope must be a non-empty string");
  }
  if (typeof targetType !== "string" || targetType.length === 0) {
    throw new TypeError("filter targetType must be a non-empty string");
  }
  if (typeof target !== "string" || target.length === 0) {
    throw new TypeError("filter target must be a non-empty string");
  }
}

export function assertFilterEffect(value: unknown, name = "filter effect"): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

export function assertDateTime(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${name} must be a valid date-time string`);
  }
}

export function assertFavoriteLevel(value: unknown): asserts value is FavoriteLevel {
  if (value !== 1 && value !== 2 && value !== 3 && value !== 4 && value !== 5) {
    throw new TypeError("favorite level must be an integer from 1 to 5");
  }
}
