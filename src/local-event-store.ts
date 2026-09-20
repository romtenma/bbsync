import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type { EventStore } from "./store.js";
import type { SegmentRef, StateSnapshot, SyncEvent } from "./types.js";
import {
  assertEvent,
  assertSafeComponent,
  assertSegmentRef,
  assertSnapshot,
} from "./validation.js";

export class LocalEventStore implements EventStore {
  readonly rootDirectory: string;
  readonly maxEventsPerSegment: number;
  readonly retainSegmentsPerDevice: number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    rootDirectory: string,
    options: {
      readonly maxEventsPerSegment?: number;
      readonly retainSegmentsPerDevice?: number;
    } = {},
  ) {
    if (rootDirectory.length === 0) {
      throw new TypeError("rootDirectory must not be empty");
    }
    const maxEventsPerSegment = options.maxEventsPerSegment ?? 1_000;
    if (!Number.isSafeInteger(maxEventsPerSegment) || maxEventsPerSegment < 1) {
      throw new TypeError("maxEventsPerSegment must be a positive safe integer");
    }
    const retainSegmentsPerDevice = options.retainSegmentsPerDevice ?? 1;
    if (!Number.isSafeInteger(retainSegmentsPerDevice) || retainSegmentsPerDevice < 0) {
      throw new TypeError("retainSegmentsPerDevice must be a non-negative safe integer");
    }
    this.rootDirectory = rootDirectory;
    this.maxEventsPerSegment = maxEventsPerSegment;
    this.retainSegmentsPerDevice = retainSegmentsPerDevice;
  }

  async appendEvents(
    deviceId: string,
    events: readonly SyncEvent[],
  ): Promise<void> {
    assertSafeDeviceAndEvents(deviceId, events);
    if (events.length === 0) return;

    const operation = this.writeQueue.then(() =>
      this.appendEventsWithoutLock(deviceId, events),
    );
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  async listSegments(): Promise<readonly SegmentRef[]> {
    const devicesDirectory = join(this.rootDirectory, "devices");
    const devices = await readDirectories(devicesDirectory);
    const result: SegmentRef[] = [];

    for (const deviceId of devices) {
      try {
        assertSegmentRef({ deviceId, segmentId: "placeholder" });
      } catch {
        continue;
      }

      const eventsDirectory = join(devicesDirectory, deviceId, "events");
      const entries = await readFiles(eventsDirectory);
      for (const filename of entries) {
        if (!filename.endsWith(".jsonl")) continue;
        const segmentId = filename.slice(0, -".jsonl".length);
        try {
          const ref = { deviceId, segmentId };
          assertSegmentRef(ref);
          result.push(ref);
        } catch {
          // Files outside the module's naming convention are not sync segments.
        }
      }
    }

    return result.sort(compareSegmentRefs);
  }

  async readSegment(ref: SegmentRef): Promise<readonly SyncEvent[]> {
    assertSegmentRef(ref);
    const contents = await readFile(this.segmentPath(ref), "utf8");
    const events: SyncEvent[] = [];

    for (const [index, line] of contents.split(/\r?\n/u).entries()) {
      if (line.trim().length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new SyntaxError(
          `invalid JSON in segment ${ref.deviceId}/${ref.segmentId} at line ${index + 1}`,
          { cause: error },
        );
      }
      assertEvent(value);
      if (value.deviceId !== ref.deviceId) {
        throw new TypeError(
          `event deviceId does not match segment ${ref.deviceId}/${ref.segmentId}`,
        );
      }
      events.push(value);
    }

    return events;
  }

  async writeSegment(
    ref: SegmentRef,
    events: readonly SyncEvent[],
  ): Promise<void> {
    assertSegmentRef(ref);
    for (const event of events) {
      assertEvent(event);
      if (event.deviceId !== ref.deviceId) {
        throw new TypeError("all events must belong to the segment device");
      }
    }

    const path = this.segmentPath(ref);
    const directory = join(this.rootDirectory, "devices", ref.deviceId, "events");
    await mkdir(directory, { recursive: true });

    const contents = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    try {
      const existingEvents = await this.readSegment(ref);
      if (eventsEqual(existingEvents, events)) return;
      if (isEventPrefix(events, existingEvents)) return;
      if (!isEventPrefix(existingEvents, events)) {
        throw new Error(`append-only segment has diverged: ${path}`);
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async listSnapshots(): Promise<readonly string[]> {
    const devicesDirectory = join(this.rootDirectory, "devices");
    const devices = await readDirectories(devicesDirectory);
    const result: string[] = [];
    for (const deviceId of devices) {
      try {
        assertSafeComponent(deviceId, "deviceId");
      } catch {
        continue;
      }
      if ((await this.readSnapshot(deviceId)) !== undefined) {
        result.push(deviceId);
      }
    }
    return result.sort((left, right) => left.localeCompare(right));
  }

  async readSnapshot(deviceId: string): Promise<StateSnapshot | undefined> {
    assertSafeComponent(deviceId, "deviceId");
    try {
      const value: unknown = JSON.parse(
        await readFile(this.snapshotPath(deviceId), "utf8"),
      );
      assertSnapshot(value);
      if (value.deviceId !== deviceId) {
        throw new TypeError("snapshot deviceId does not match its path");
      }
      return value;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async writeSnapshot(snapshot: StateSnapshot): Promise<void> {
    assertSnapshot(snapshot);
    const path = this.snapshotPath(snapshot.deviceId);
    const directory = join(this.rootDirectory, "devices", snapshot.deviceId);
    await mkdir(directory, { recursive: true });
    const existing = await this.readSnapshot(snapshot.deviceId);
    if (existing !== undefined) {
      if (existing.revision > snapshot.revision) return;
      if (existing.revision === snapshot.revision) {
        if (JSON.stringify(existing) === JSON.stringify(snapshot)) return;
        throw new Error(
          `snapshot revision collision: ${snapshot.deviceId}/${snapshot.revision}`,
        );
      }
    }

    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(snapshot)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async pruneSegments(snapshot: StateSnapshot): Promise<void> {
    assertSnapshot(snapshot);
    const deviceId = snapshot.deviceId;
    const refs = (await this.listSegments())
      .filter((ref) => ref.deviceId === deviceId)
      .sort(compareSegmentRefs);
    const coveredCounts = new Map(
      snapshot.coveredSegments.map((coverage) => [coverage.segmentId, coverage.eventCount]),
    );
    const removableCandidates: SegmentRef[] = [];
    for (const ref of refs) {
      const coveredCount = coveredCounts.get(ref.segmentId);
      if (coveredCount === undefined) continue;
      const currentCount = (await this.readSegment(ref)).length;
      if (currentCount === coveredCount) {
        removableCandidates.push(ref);
      }
    }
    const removable = removableCandidates.slice(
      0,
      Math.max(0, removableCandidates.length - this.retainSegmentsPerDevice),
    );
    for (const ref of removable) {
      await rm(this.segmentPath(ref), { force: true });
    }
  }

  private async appendEventsWithoutLock(
    deviceId: string,
    events: readonly SyncEvent[],
  ): Promise<void> {
    let offset = 0;
    while (offset < events.length) {
      const refs = (await this.listSegments()).filter(
        (ref) => ref.deviceId === deviceId,
      );
      let activeRef: SegmentRef | undefined;
      let activeEvents: readonly SyncEvent[] = [];

      for (const ref of [...refs].reverse()) {
        const candidateEvents = await this.readSegment(ref);
        if (candidateEvents.length < this.maxEventsPerSegment) {
          activeRef = ref;
          activeEvents = candidateEvents;
          break;
        }
      }

      if (activeRef === undefined) {
        activeRef = {
          deviceId,
          segmentId: `${Date.now().toString().padStart(13, "0")}-${randomUUID()}`,
        };
      }

      const capacity = this.maxEventsPerSegment - activeEvents.length;
      const addition = events.slice(offset, offset + capacity);
      await this.writeSegment(activeRef, [...activeEvents, ...addition]);
      offset += addition.length;
    }
  }

  private segmentPath(ref: SegmentRef): string {
    return join(
      this.rootDirectory,
      "devices",
      ref.deviceId,
      "events",
      `${ref.segmentId}.jsonl`,
    );
  }

  private snapshotPath(deviceId: string): string {
    return join(this.rootDirectory, "devices", deviceId, "snapshot.json");
  }
}

async function readDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function readFiles(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function compareSegmentRefs(left: SegmentRef, right: SegmentRef): number {
  return (
    left.deviceId.localeCompare(right.deviceId) ||
    left.segmentId.localeCompare(right.segmentId)
  );
}

function assertSafeDeviceAndEvents(
  deviceId: string,
  events: readonly SyncEvent[],
): void {
  assertSegmentRef({ deviceId, segmentId: "placeholder" });
  for (const event of events) {
    assertEvent(event);
    if (event.deviceId !== deviceId) {
      throw new TypeError("all events must belong to the appending device");
    }
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
