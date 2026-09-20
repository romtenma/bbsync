import { segmentKey, type EventStore } from "./store.js";
import type {
  SegmentRef,
  StateSnapshot,
  SyncEvent,
  SynchronizeResult,
} from "./types.js";

/** Copies missing segments and the newest per-device snapshots in both directions. */
export async function synchronizeStores(
  left: EventStore,
  right: EventStore,
): Promise<SynchronizeResult> {
  const leftRefs = await left.listSegments();
  const rightRefs = await right.listSegments();
  const leftKeys = new Set(leftRefs.map(segmentKey));
  const rightKeys = new Set(rightRefs.map(segmentKey));
  const leftByKey = new Map(leftRefs.map((ref) => [segmentKey(ref), ref]));
  const rightByKey = new Map(rightRefs.map((ref) => [segmentKey(ref), ref]));

  const toLeft = rightRefs.filter((ref) => !leftKeys.has(segmentKey(ref)));
  const toRight = leftRefs.filter((ref) => !rightKeys.has(segmentKey(ref)));

  const snapshotResult = await synchronizeSnapshots(left, right);

  await copySegments(right, left, toLeft);
  await copySegments(left, right, toRight);

  let updatedLeft = 0;
  let updatedRight = 0;
  for (const [key, leftRef] of leftByKey) {
    const rightRef = rightByKey.get(key);
    if (rightRef === undefined) continue;
    const leftEvents = await left.readSegment(leftRef);
    const rightEvents = await right.readSegment(rightRef);
    if (eventsEqual(leftEvents, rightEvents)) continue;

    if (isEventPrefix(leftEvents, rightEvents)) {
      await left.writeSegment(leftRef, rightEvents);
      updatedLeft += 1;
    } else if (isEventPrefix(rightEvents, leftEvents)) {
      await right.writeSegment(rightRef, leftEvents);
      updatedRight += 1;
    } else {
      throw new Error(
        `append-only segment has diverged: ${leftRef.deviceId}/${leftRef.segmentId}`,
      );
    }
  }

  const snapshots = new Map<string, StateSnapshot>();
  for (const deviceId of new Set([
    ...(await left.listSnapshots()),
    ...(await right.listSnapshots()),
  ])) {
    const snapshot = await left.readSnapshot(deviceId) ?? await right.readSnapshot(deviceId);
    if (snapshot !== undefined) snapshots.set(deviceId, snapshot);
  }
  for (const snapshot of snapshots.values()) {
    await left.pruneSegments(snapshot);
    await right.pruneSegments(snapshot);
  }

  return {
    copiedToLeft: toLeft.length + updatedLeft,
    copiedToRight: toRight.length + updatedRight,
    copiedSnapshotsToLeft: snapshotResult.copiedToLeft,
    copiedSnapshotsToRight: snapshotResult.copiedToRight,
  };
}

async function synchronizeSnapshots(
  left: EventStore,
  right: EventStore,
): Promise<{ copiedToLeft: number; copiedToRight: number }> {
  const deviceIds = new Set([
    ...(await left.listSnapshots()),
    ...(await right.listSnapshots()),
  ]);
  let copiedToLeft = 0;
  let copiedToRight = 0;

  for (const deviceId of deviceIds) {
    const leftSnapshot = await left.readSnapshot(deviceId);
    const rightSnapshot = await right.readSnapshot(deviceId);
    if (leftSnapshot === undefined && rightSnapshot !== undefined) {
      await left.writeSnapshot(rightSnapshot);
      copiedToLeft += 1;
    } else if (rightSnapshot === undefined && leftSnapshot !== undefined) {
      await right.writeSnapshot(leftSnapshot);
      copiedToRight += 1;
    } else if (leftSnapshot !== undefined && rightSnapshot !== undefined) {
      if (leftSnapshot.revision > rightSnapshot.revision) {
        await right.writeSnapshot(leftSnapshot);
        copiedToRight += 1;
      } else if (rightSnapshot.revision > leftSnapshot.revision) {
        await left.writeSnapshot(rightSnapshot);
        copiedToLeft += 1;
      } else if (!snapshotsEqual(leftSnapshot, rightSnapshot)) {
        throw new Error(`snapshot revision collision: ${deviceId}/${leftSnapshot.revision}`);
      }
    }
  }

  return { copiedToLeft, copiedToRight };
}

async function copySegments(
  source: EventStore,
  destination: EventStore,
  refs: readonly SegmentRef[],
): Promise<void> {
  for (const ref of refs) {
    const events = await source.readSegment(ref);
    await destination.writeSegment(ref, events);
  }
}

function isEventPrefix(
  prefix: readonly SyncEvent[],
  complete: readonly SyncEvent[],
): boolean {
  return (
    prefix.length <= complete.length &&
    prefix.every(
      (event, index) => JSON.stringify(event) === JSON.stringify(complete[index]),
    )
  );
}

function eventsEqual(
  left: readonly SyncEvent[],
  right: readonly SyncEvent[],
): boolean {
  return left.length === right.length && isEventPrefix(left, right);
}

function snapshotsEqual(left: StateSnapshot, right: StateSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
