import {
  EVENT_SCHEMA_VERSION,
  type FavoriteLevel,
  type SegmentRef,
  type SegmentCoverage,
  type SnapshotViewed,
  type SnapshotMute,
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

  if (event.type !== "mute.set" && event.type !== "mute.cleared") {
    if (typeof event.threadId !== "string" || event.threadId.length === 0) {
      throw new TypeError("event.threadId must be a non-empty string");
    }
  } else {
    assertMuteKey(event.scope, event.value);
    assertDateTime(event.updatedAt, "event.updatedAt");
    if (event.type === "mute.set" && event.hitAt !== undefined && event.hitAt !== null) {
      assertDateTime(event.hitAt, "event.hitAt");
    }
  }

  switch (event.type) {
    case "thread.viewed":
      assertPosition(event.position, true);
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
    case "mute.set":
    case "mute.cleared":
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
  if (!Array.isArray(snapshot.mutes)) {
    throw new TypeError("snapshot.mutes must be an array");
  }
  for (const mute of snapshot.mutes) {
    assertSnapshotMute(mute);
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
  if (!Array.isArray(thread.postPositions) || thread.postPositions.some(
    (position) => !Number.isSafeInteger(position) || (position as number) < 1,
  )) {
    throw new TypeError("snapshot postPositions must contain positive safe integers");
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

function assertSnapshotMute(value: unknown): asserts value is SnapshotMute {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("snapshot mute must be an object");
  }
  const mute = value as Record<string, unknown>;
  assertMuteKey(mute.scope, mute.value);
  assertDateTime(mute.updatedAt, "snapshot mute.updatedAt");
  if (mute.hitAt !== undefined) {
    assertDateTime(mute.hitAt, "snapshot mute.hitAt");
  }
  if (typeof mute.cleared !== "boolean") {
    throw new TypeError("snapshot mute.cleared must be boolean");
  }
  for (const field of ["deviceId", "eventId"] as const) {
    if (typeof mute[field] !== "string" || mute[field].length === 0) {
      throw new TypeError(`snapshot mute.${field} must be a non-empty string`);
    }
    assertSafeComponent(mute[field] as string, `snapshot mute.${field}`);
  }
}

export function assertMuteKey(scope: unknown, value: unknown): void {
  if (typeof scope !== "string" || scope.length === 0) {
    throw new TypeError("mute scope must be a non-empty string");
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("mute value must be a non-empty string");
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
