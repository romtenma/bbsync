export class BbsyncError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface SegmentIdentifier {
  readonly deviceId: string;
  readonly segmentId: string;
}

export class SegmentDivergenceError extends BbsyncError {
  readonly deviceId?: string;
  readonly segmentId?: string;
  readonly path?: string;

  constructor(target: SegmentIdentifier | string, options?: ErrorOptions) {
    const isRef = typeof target === "object" && target !== null && "deviceId" in target && "segmentId" in target;
    const message = isRef
      ? `append-only segment has diverged: ${target.deviceId}/${target.segmentId}`
      : `append-only segment has diverged: ${target}`;
    super(message, options);
    if (isRef) {
      this.deviceId = target.deviceId;
      this.segmentId = target.segmentId;
    } else {
      this.path = target;
    }
  }
}

export class SnapshotCollisionError extends BbsyncError {
  readonly deviceId: string;
  readonly revision: number;

  constructor(deviceId: string, revision: number, options?: ErrorOptions) {
    super(`snapshot revision collision: ${deviceId}/${revision}`, options);
    this.deviceId = deviceId;
    this.revision = revision;
  }
}

export class EventCollisionError extends BbsyncError {
  readonly eventId: string;

  constructor(eventId: string, options?: ErrorOptions) {
    super(`event id collision with different contents: ${eventId}`, options);
    this.eventId = eventId;
  }
}

export class CoverageMismatchError extends BbsyncError {
  readonly deviceId: string;
  readonly segmentId: string;
  readonly coveredCount?: number;
  readonly actualCount?: number;

  constructor(
    deviceId: string,
    segmentId: string,
    options?: {
      readonly coveredCount?: number;
      readonly actualCount?: number;
      readonly cause?: unknown;
    },
  ) {
    super(`snapshot coverage exceeds segment length: ${deviceId}/${segmentId}`, { cause: options?.cause });
    this.deviceId = deviceId;
    this.segmentId = segmentId;
    this.coveredCount = options?.coveredCount;
    this.actualCount = options?.actualCount;
  }
}
