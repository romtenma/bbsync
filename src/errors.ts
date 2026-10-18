export class BbsyncError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A device document was forked or lost previously saved entries. */
export class DocumentConflictError extends BbsyncError {
  constructor(
    readonly deviceId: string,
    readonly revision: number,
  ) {
    super(`device document conflict: ${deviceId}/${revision}`);
  }
}
