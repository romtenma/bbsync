import { compareStrings } from "./encoding.js";
import { mergeDocuments, projectFilters, projectThreads } from "./project.js";
import { canWrite, createScope, favoriteThreads, filterDocuments } from "./scope.js";
import { entryKey, readDocuments, type StateStore } from "./store.js";
import { synchronizeStores } from "./synchronize.js";
import {
  DEFAULT_HISTORY_RETENTION_MS, SCHEMA_VERSION, type FavoriteLevel, type FilterEntry, type FilterValue,
  type ApplicationSnapshot, type StateChange, type StateDocument, type StateEntry, type SynchronizeResult, type ThreadState, type SyncLevel, type SyncPolicy, type TabState,
} from "./types.js";
import { assertChange, assertDeviceId, assertDocument, assertFavoriteLevel, assertInteger, assertNonEmptyString, assertSyncPolicy } from "./validation.js";

export interface BbsSyncOptions extends SyncPolicy {
  readonly storage: StateStore;
  readonly deviceId: string;
  /** Used for display timestamps and history cutoff, never revision ordering. */
  readonly clock?: () => Date;
}

export class BbsSync {
  readonly storage: StateStore;
  readonly deviceId: string;
  readonly syncLevel: SyncLevel;
  readonly historyRetentionMs: number;
  private readonly clock: () => Date;
  private updateQueue: Promise<void> = Promise.resolve();
  private reservedRevision = 0;

  constructor(options: BbsSyncOptions) {
    assertDeviceId(options.deviceId);
    assertSyncPolicy(options);
    this.storage = options.storage;
    this.deviceId = options.deviceId;
    this.syncLevel = options.syncLevel;
    this.historyRetentionMs = options.historyRetentionMs ?? DEFAULT_HISTORY_RETENTION_MS;
    this.clock = options.clock ?? (() => new Date());
  }

  /** Apply distinct keys together, with one logical revision and one file write. */
  async update(changes: readonly StateChange[]): Promise<void> {
    return this.applyUpdate(changes);
  }

  /** Persist the prepared document in an application journal BEFORE saving it.
   * Replay journaled documents with commitPreparedUpdate before new updates on startup.
   * The callback must not call back into this instance's queued methods.
   */
  async updateWithJournal(changes: readonly StateChange[], journal: (document: StateDocument) => Promise<void>): Promise<void> {
    return this.applyUpdate(changes, journal);
  }

  private async applyUpdate(changes: readonly StateChange[], journal?: (document: StateDocument) => Promise<void>): Promise<void> {
    const keys = new Set<string>();
    for (const change of changes) {
      assertChange(change);
      const key = entryKey(change.key);
      if (keys.has(key)) throw new TypeError("duplicate change key");
      keys.add(key);
    }
    if (changes.length === 0) return;
    const copy = structuredClone(changes);
    const operation = this.updateQueue.then(async () => {
      const documents = await readDocuments(this.storage);
      const favorites = favoriteThreads(documents);
      for (const change of copy) if (change.key[0] === "favorite" && change.value !== null) favorites.add(change.key[1]);
      const allowed = copy.filter((change) => canWrite(change, this, favorites));
      if (allowed.length === 0) return;
      let maximum = this.reservedRevision;
      for (const document of documents) maximum = Math.max(maximum, document.revision);
      if (maximum === Number.MAX_SAFE_INTEGER) throw new RangeError("logical revision exhausted; update cannot be saved");
      const revision = maximum + 1;
      if (journal !== undefined) this.reservedRevision = revision;
      const entries: StateEntry[] = allowed.map((change) => ({ ...change, revision }));
      const document: StateDocument = {
        v: SCHEMA_VERSION,
        deviceId: this.deviceId,
        revision,
        entries: entries.sort((a, b) => compareStrings(entryKey(a.key), entryKey(b.key))),
      };
      if (journal !== undefined) await journal(structuredClone(document));
      await this.storage.writeDocument(document);
    });
    this.updateQueue = operation.catch(() => undefined);
    return operation;
  }

  /** Retry an already journaled update without issuing a new revision. */
  async commitPreparedUpdate(document: StateDocument): Promise<void> {
    assertDocument(document);
    if (document.deviceId !== this.deviceId) throw new TypeError("prepared update belongs to another device");
    const copy = structuredClone(document);
    const operation = this.updateQueue.then(async () => {
      // Membership may have changed since preparation (including the prepared
      // favorite removal itself). Replay the original scope, checking only
      // supported levels; never reinterpret a saved intent against today's values.
      if (copy.entries.some(({ key }) =>
        (key[0] === "filter" && this.syncLevel < 3) ||
        (key[0] === "tabs" && this.syncLevel < 4) ||
        (key[0] === "post" && this.syncLevel < 5))) {
        throw new TypeError("prepared update exceeds the current sync policy; restore its policy before replay");
      }
      this.reservedRevision = Math.max(this.reservedRevision, copy.revision);
      await this.storage.writeDocument(copy);
    });
    this.updateQueue = operation.catch(() => undefined);
    return operation;
  }

  /** Replayable application state, including explicit deletions and their origins. */
  async getApplicationSnapshot(): Promise<ApplicationSnapshot> {
    await this.updateQueue;
    const documents = await readDocuments(this.storage);
    const now = this.clock();
    const entries = mergeDocuments(filterDocuments(documents, createScope(documents, this, now)));
    return {
      evaluatedAt: now.toISOString(),
      policy: { syncLevel: this.syncLevel, historyRetentionMs: this.historyRetentionMs },
      entries: [...entries.values()],
    };
  }

  async setThreadMetadata(threadId: string, title: string, url: string): Promise<void> {
    return this.update([{ key: ["metadata", threadId], value: { title, url } }]);
  }

  async recordThreadView(threadId: string, position: number, firstPosition?: number): Promise<void> {
    return this.update([{
      key: ["view", threadId],
      value: { position, ...(firstPosition === undefined ? {} : { firstPosition }), viewedAt: this.clock().toISOString() },
    }]);
  }

  async recordResponseCount(threadId: string, responseCount: number): Promise<void> {
    assertInteger(responseCount, 0);
    return this.update([{ key: ["count", threadId], value: responseCount }]);
  }

  async clearThreadHistory(threadId: string): Promise<void> {
    return this.update([{ key: ["view", threadId], value: null }, { key: ["count", threadId], value: null }]);
  }

  async setFavorite(threadId: string, level: FavoriteLevel = 1): Promise<void> {
    assertFavoriteLevel(level);
    return this.update([{ key: ["favorite", threadId], value: level }]);
  }

  async clearFavorite(threadId: string): Promise<void> {
    return this.update([{ key: ["favorite", threadId], value: null }]);
  }

  async recordPost(threadId: string, position: number): Promise<void> {
    return this.update([{ key: ["post", threadId, position], value: true }]);
  }

  async clearPost(threadId: string, position: number): Promise<void> {
    return this.update([{ key: ["post", threadId, position], value: null }]);
  }

  async setFilter(
    scope: string, targetType: string, target: string, effect: string,
    options: { readonly isRegex?: boolean; readonly updatedAt?: string; readonly hitAt?: string } = {},
  ): Promise<void> {
    const value: FilterValue = {
      effect, isRegex: options.isRegex === undefined ? false : options.isRegex,
      updatedAt: options.updatedAt === undefined ? this.clock().toISOString() : options.updatedAt,
      ...(options.hitAt === undefined ? {} : { hitAt: options.hitAt }),
    };
    return this.update([{ key: ["filter", scope, targetType, target], value }]);
  }

  async clearFilter(scope: string, targetType: string, target: string): Promise<void> {
    return this.update([{ key: ["filter", scope, targetType, target], value: null }]);
  }

  async setTabs(value: TabState): Promise<void> {
    return this.update([{ key: ["tabs"], value }]);
  }

  async clearTabs(): Promise<void> {
    return this.update([{ key: ["tabs"], value: null }]);
  }

  async getTabs(): Promise<TabState | undefined> {
    if (this.syncLevel < 4) return undefined;
    const value = (await this.readScopedEntries()).get(entryKey(["tabs"]))?.value;
    return value === null || value === undefined ? undefined : value as TabState;
  }

  async getStates(): Promise<ReadonlyMap<string, ThreadState>> {
    return projectThreads(await this.readScopedEntries(), this.syncLevel >= 5);
  }

  async getThreadState(threadId: string): Promise<ThreadState | undefined> {
    assertNonEmptyString(threadId, "threadId");
    return (await this.getStates()).get(threadId);
  }

  async getFilters(scope?: string): Promise<readonly FilterEntry[] | undefined> {
    if (this.syncLevel < 3) return undefined;
    if (scope !== undefined) assertNonEmptyString(scope, "scope");
    return projectFilters(await this.readScopedEntries(), scope);
  }

  async synchronizeWith(remote: StateStore): Promise<SynchronizeResult> {
    await this.updateQueue;
    return synchronizeStores(this.storage, remote, { syncLevel: this.syncLevel, historyRetentionMs: this.historyRetentionMs, now: this.clock() });
  }

  private async readScopedEntries() {
    const documents = await readDocuments(this.storage);
    return mergeDocuments(filterDocuments(documents, createScope(documents, this, this.clock())));
  }
}
