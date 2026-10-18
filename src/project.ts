import { compareStrings } from "./encoding.js";
import { entryKey, mergeDeviceDocuments } from "./store.js";
import type {
  FavoriteLevel, FilterEntry, FilterValue, MergedEntry, StateDocument,
  ThreadMetadata, ThreadState, ThreadView,
} from "./types.js";
import { assertDocument } from "./validation.js";

/** Every item, including deletion, uses the same (revision, deviceId) order. */
export function mergeDocuments(documents: readonly StateDocument[]): ReadonlyMap<string, MergedEntry> {
  const latest = new Map<string, StateDocument>();
  for (const document of documents) {
    assertDocument(document);
    const previous = latest.get(document.deviceId);
    latest.set(document.deviceId, mergeDeviceDocuments(previous, document));
  }
  const merged = new Map<string, MergedEntry>();
  for (const document of latest.values()) {
    for (const entry of document.entries) {
      const key = entryKey(entry.key);
      const current = merged.get(key);
      if (current === undefined || entry.revision > current.revision ||
        (entry.revision === current.revision && document.deviceId > current.deviceId)) {
        merged.set(key, { ...structuredClone(entry), deviceId: document.deviceId });
      }
    }
  }
  return new Map([...merged].sort(([a], [b]) => compareStrings(a, b)));
}

export function projectThreads(entries: ReadonlyMap<string, MergedEntry>, includePosts = true): ReadonlyMap<string, ThreadState> {
  type MutableThread = { -readonly [K in keyof ThreadState]: ThreadState[K] } & { postPositions?: number[] };
  const threads = new Map<string, MutableThread>();
  for (const { key, value } of entries.values()) {
    if (key[0] === "filter" || key[0] === "tabs" || value === null) continue;
    const threadId = key[1];
    let thread = threads.get(threadId);
    if (thread === undefined) {
      thread = { threadId, ...(includePosts ? { postPositions: [] } : {}) };
      threads.set(threadId, thread);
    }
    switch (key[0]) {
      case "metadata": {
        const metadata = value as ThreadMetadata;
        thread.title = metadata.title;
        thread.url = metadata.url;
        break;
      }
      case "view": {
        const view = value as ThreadView;
        thread.lastReadPosition = view.position;
        thread.lastViewedAt = view.viewedAt;
        if (view.firstPosition !== undefined) thread.firstReadPosition = view.firstPosition;
        break;
      }
      case "count": thread.responseCount = value as number; break;
      case "favorite": thread.favoriteLevel = value as FavoriteLevel; break;
      case "post": thread.postPositions?.push(key[2]); break;
    }
  }
  for (const thread of threads.values()) thread.postPositions?.sort((a, b) => a - b);
  return new Map([...threads].sort(([a], [b]) => compareStrings(a, b)));
}

export function projectFilters(entries: ReadonlyMap<string, MergedEntry>, scope?: string): readonly FilterEntry[] {
  const filters: FilterEntry[] = [];
  for (const { key, value } of entries.values()) {
    if (key[0] !== "filter" || value === null || (scope !== undefined && key[1] !== scope)) continue;
    filters.push({ scope: key[1], targetType: key[2], target: key[3], ...value as FilterValue });
  }
  return filters;
}
