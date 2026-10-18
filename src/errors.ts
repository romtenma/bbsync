export class BbsyncError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** One writer assigned different values to the same key and revision. */
export class DocumentConflictError extends BbsyncError {
  constructor(
    readonly deviceId: string,
    readonly revision: number,
  ) {
    super(`device document conflict: ${deviceId}/${revision}`);
  }
}
