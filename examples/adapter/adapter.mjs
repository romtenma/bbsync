// A small file-backed transactional DB for the example. Use one instance/process
// per path; replace transaction() with the host application's DB transaction.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { entryKey } from "@romtenma/bbsync";
import { InitializationError } from "@romtenma/bbsync/http";

export class AdapterDatabase {
  queue = Promise.resolve();
  constructor(path, state) { this.path = path; this.state = state; }

  static async open(path, deviceId = randomUUID()) {
    let state;
    try { state = JSON.parse(await readFile(path, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = { deviceId, rows: {}, receipts: {}, outbox: [], initialization: null };
    }
    const db = new AdapterDatabase(path, state);
    await db.transaction(() => {}); // Persist device identity before any sync update.
    return db;
  }

  async read() { await this.queue; return structuredClone(this.state); }

  transaction(change) {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.state);
      await change(next);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx");
        try { await file.writeFile(JSON.stringify(next)); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
      this.state = next;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  // Import into this DB only. Existing remote stores must not auto-send these values.
  seedLocal(changes) {
    return this.transaction((state) => {
      for (const change of changes) state.rows[entryKey(change.key)] = structuredClone(change);
    });
  }

  // Real user operations enter the durable outbox, independently of receive work.
  userUpdate(changes) {
    const copy = structuredClone(changes);
    return this.transaction((state) => {
      for (const change of copy) {
        if (change.value === null) delete state.rows[entryKey(change.key)];
        else state.rows[entryKey(change.key)] = change;
      }
      state.outbox.push({ id: randomUUID(), changes: copy });
    });
  }
}

const newer = (incoming, saved) => !saved || incoming.revision > saved.revision ||
  (incoming.revision === saved.revision && incoming.deviceId > saved.deviceId);

/** Missing keys are untouched. A pending user edit wins over an older receive. */
export async function applySnapshot(db, snapshot) {
  await db.transaction((state) => {
    const pending = new Set(state.outbox.flatMap((item) => item.changes.map((change) => entryKey(change.key))));
    for (const entry of snapshot.entries) {
      const key = entryKey(entry.key);
      if (pending.has(key) || !newer(entry, state.receipts[key])) continue;
      if (entry.value === null) delete state.rows[key];
      else state.rows[key] = { key: entry.key, value: entry.value };
      state.receipts[key] = { revision: entry.revision, deviceId: entry.deviceId };
    }
  });
}

/** Serialize drain calls; replay saved documents before allocating new revisions. */
export class Adapter {
  drainQueue = Promise.resolve();
  constructor(sync, db) { this.sync = sync; this.db = db; }

  flush() {
    const operation = this.drainQueue.then(async () => {
      if ((await this.db.read()).initialization?.completed === false) throw new Error("resume initialization before flushing user operations");
      for (;;) {
        const item = (await this.db.read()).outbox[0];
        if (!item) return;
        let prepared = item.document;
        if (prepared) await this.sync.commitPreparedUpdate(prepared);
        else await this.sync.updateWithJournal(item.changes, async (document) => {
          prepared = document;
          await this.db.transaction((state) => {
            state.outbox.find((entry) => entry.id === item.id).document = document;
          });
        });
        await this.db.transaction((state) => {
          for (const entry of prepared?.entries ?? []) {
            const key = entryKey(entry.key);
            const receipt = { revision: entry.revision, deviceId: prepared.deviceId };
            if (newer(receipt, state.receipts[key])) state.receipts[key] = receipt;
          }
          state.outbox = state.outbox.filter((entry) => entry.id !== item.id);
        });
      }
    });
    this.drainQueue = operation.catch(() => undefined);
    return operation;
  }

  async synchronize(remote) {
    // Commit journaled local edits before accepting remote DB updates.
    await this.flush();
    try { await this.sync.synchronizeWith(remote); }
    finally { await applySnapshot(this.db, await this.sync.getApplicationSnapshot()); }
  }
}

/** Explicit first seeding only. A completed remote session is never seeded again. */
export async function initializeFromLocal(sync, remote, db) {
  await db.transaction((state) => {
    state.initialization ??= { sessionId: randomUUID(), changes: Object.values(state.rows), completed: false };
  });
  const initial = (await db.read()).initialization;
  if (initial.completed) return;
  let status;
  try { status = await remote.beginInitialization(initial.sessionId, sync.deviceId); }
  catch (error) {
    if (error instanceof InitializationError && !initial.document) {
      // A competing seeder or an existing store rejected us before any local
      // import was prepared. Permit a subsequent normal additional-client join.
      await db.transaction((state) => {
        if (state.initialization?.sessionId === initial.sessionId && !state.initialization.document) state.initialization = null;
      });
    }
    throw error; // An ambiguous network result keeps the session for recovery.
  }
  if (status.state === "aborted") throw new Error("initialization was aborted; inspect partial data before continuing");
  if (status.state === "active") {
    if (initial.document) await sync.commitPreparedUpdate(initial.document);
    else await sync.updateWithJournal(initial.changes, async (document) => {
      await db.transaction((state) => { state.initialization.document = document; });
    });
    await sync.synchronizeWith(remote.withInitialization(initial.sessionId));
    await remote.finishInitialization(initial.sessionId);
  }
  await db.transaction((state) => { state.initialization.completed = true; });
}
