import type {
  SegmentRef,
  StateSnapshot,
  SyncEvent,
} from "./types.js";

/**
 * Storage boundary shared by the local filesystem and the future Google Drive
 * implementation. A segment is append-only until it reaches the store's
 * rotation limit. Rewriting an existing prefix is not allowed.
 */
export interface EventStore {
  appendEvents(
    deviceId: string,
    events: readonly SyncEvent[],
  ): Promise<void>;
  listSegments(): Promise<readonly SegmentRef[]>;
  readSegment(ref: SegmentRef): Promise<readonly SyncEvent[]>;
  writeSegment(
    ref: SegmentRef,
    events: readonly SyncEvent[],
  ): Promise<void>;
  listSnapshots(): Promise<readonly string[]>;
  readSnapshot(deviceId: string): Promise<StateSnapshot | undefined>;
  writeSnapshot(snapshot: StateSnapshot): Promise<void>;
  pruneSegments(snapshot: StateSnapshot): Promise<void>;
}

export function segmentKey(ref: SegmentRef): string {
  return `${ref.deviceId}\u0000${ref.segmentId}`;
}
