import { compareStrings } from "./encoding.js";
import { DocumentConflictError } from "./errors.js";
import { assertDocumentSuccessor, documentsEqual, entryKey } from "./store.js";
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
    if (previous !== undefined) {
      if (previous.revision === document.revision) {
        if (!documentsEqual(previous, document)) throw new DocumentConflictError(document.deviceId, document.revision);
        continue;
      }
      const [older, newer] = previous.revision < document.revision ? [previous, document] : [document, previous];
      assertDocumentSuccessor(older, newer);
      if (previous.revision > document.revision) continue;
    }
    latest.set(document.deviceId, document);
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

export function projectThreads(entries: ReadonlyMap<string, MergedEntry>): ReadonlyMap<string, ThreadState> {
  type MutableThread = { -readonly [K in keyof ThreadState]: ThreadState[K] } & { postPositions: number[] };
  const threads = new Map<string, MutableThread>();
  for (const { key, value } of entries.values()) {
    if (key[0] === "filter" || value === null) continue;
    const threadId = key[1];
    let thread = threads.get(threadId);
    if (thread === undefined) {
      thread = { threadId, postPositions: [] };
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
      case "post": thread.postPositions.push(key[2]); break;
    }
  }
  for (const thread of threads.values()) thread.postPositions.sort((a, b) => a - b);
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
