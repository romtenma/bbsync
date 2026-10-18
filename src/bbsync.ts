import { compareStrings } from "./encoding.js";
import { mergeDocuments, projectFilters, projectThreads } from "./project.js";
import { entryKey, readDocuments, type StateStore } from "./store.js";
import { synchronizeStores } from "./synchronize.js";
import {
  SCHEMA_VERSION, type FavoriteLevel, type FilterEntry, type FilterValue,
  type StateChange, type StateEntry, type SynchronizeResult, type ThreadState,
} from "./types.js";
import { assertChange, assertDeviceId, assertFavoriteLevel, assertInteger, assertNonEmptyString } from "./validation.js";

export interface BbsSyncOptions {
  readonly storage: StateStore;
  readonly deviceId: string;
  /** Used only for display timestamps, never conflict resolution. */
  readonly clock?: () => Date;
}

export class BbsSync {
  readonly storage: StateStore;
  readonly deviceId: string;
  private readonly clock: () => Date;
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(options: BbsSyncOptions) {
    assertDeviceId(options.deviceId);
    this.storage = options.storage;
    this.deviceId = options.deviceId;
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
      let maximum = 0;
      for (const document of documents) maximum = Math.max(maximum, document.revision);
      if (maximum === Number.MAX_SAFE_INTEGER) throw new RangeError("logical revision exhausted; update cannot be saved");
      const revision = maximum + 1;
      const previous = documents.find((document) => document.deviceId === this.deviceId);
      const entries = new Map<string, StateEntry>(previous?.entries.map((entry) => [entryKey(entry.key), entry]));
      for (const change of copy) entries.set(entryKey(change.key), { ...change, revision });
      await this.storage.writeDocument({
        v: SCHEMA_VERSION,
        deviceId: this.deviceId,
        revision,
        entries: [...entries.values()].sort((a, b) => compareStrings(entryKey(a.key), entryKey(b.key))),
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

  async getStates(): Promise<ReadonlyMap<string, ThreadState>> {
    return projectThreads(mergeDocuments(await readDocuments(this.storage)));
  }

  async getThreadState(threadId: string): Promise<ThreadState | undefined> {
    assertNonEmptyString(threadId, "threadId");
    return (await this.getStates()).get(threadId);
  }

  async getFilters(scope?: string): Promise<readonly FilterEntry[]> {
    if (scope !== undefined) assertNonEmptyString(scope, "scope");
    return projectFilters(mergeDocuments(await readDocuments(this.storage)), scope);
  }

  async synchronizeWith(remote: StateStore): Promise<SynchronizeResult> {
    await this.updateQueue;
    return synchronizeStores(this.storage, remote);
  }
}
