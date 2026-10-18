import { compareStrings } from "./encoding.js";
import { mergeDocuments, projectFilters, projectThreads } from "./project.js";
import { canWrite, createScope, favoriteThreads, filterDocuments } from "./scope.js";
import { entryKey, readDocuments, type StateStore } from "./store.js";
import { synchronizeStores } from "./synchronize.js";
import {
  DEFAULT_HISTORY_RETENTION_MS, SCHEMA_VERSION, type FavoriteLevel, type FilterEntry, type FilterValue,
  type StateChange, type StateEntry, type SynchronizeResult, type ThreadState, type SyncLevel, type SyncPolicy, type TabState,
} from "./types.js";
import { assertChange, assertDeviceId, assertFavoriteLevel, assertInteger, assertNonEmptyString, assertSyncPolicy } from "./validation.js";

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
      let maximum = 0;
      for (const document of documents) maximum = Math.max(maximum, document.revision);
      if (maximum === Number.MAX_SAFE_INTEGER) throw new RangeError("logical revision exhausted; update cannot be saved");
      const revision = maximum + 1;
      const entries: StateEntry[] = allowed.map((change) => ({ ...change, revision }));
      await this.storage.writeDocument({
        v: SCHEMA_VERSION,
        deviceId: this.deviceId,
        revision,
        entries: entries.sort((a, b) => compareStrings(entryKey(a.key), entryKey(b.key))),
      });
    });
    this.updateQueue = operation.catch(() => undefined);
    return operation;
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
