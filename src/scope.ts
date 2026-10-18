import { mergeDocuments } from "./project.js";
import { documentFromEntries } from "./store.js";
import {
  DEFAULT_HISTORY_RETENTION_MS, type StateChange, type StateDocument,
  type StateEntry, type SyncPolicy, type TabState, type ThreadView,
} from "./types.js";

export function filterDocuments(documents: readonly StateDocument[], include: (entry: StateEntry) => boolean): StateDocument[] {
  return documents.flatMap((document) => {
    const entries = document.entries.filter(include);
    return entries.length === 0 ? [] : [documentFromEntries(document.deviceId, entries)];
  });
}

export function favoriteThreads(documents: readonly StateDocument[]): Set<string> {
  const entries = mergeDocuments(filterDocuments(documents, (entry) => entry.key[0] === "favorite"));
  return new Set([...entries.values()].filter((entry) => entry.value !== null).map((entry) => entry.key[1]!));
}

/** Recording local history is allowed from level 2; its public/transfer scope is recent history. */
export function canWrite(change: StateChange, policy: SyncPolicy, favorites: ReadonlySet<string>): boolean {
  switch (change.key[0]) {
    case "favorite": return true;
    case "filter": return policy.syncLevel >= 3;
    case "tabs": return policy.syncLevel >= 4;
    case "post": return policy.syncLevel >= 5;
    default: return policy.syncLevel >= 2 || favorites.has(change.key[1]);
  }
}

/** Transfer also considers the peer's previous view so recent history deletions reach stale copies. */
export function createScope(documents: readonly StateDocument[], policy: SyncPolicy, now: Date, forTransfer = false): (entry: StateChange) => boolean {
  const time = now.getTime();
  if (!Number.isFinite(time)) throw new TypeError("clock must return a valid date");
  const cutoff = time - (policy.historyRetentionMs ?? DEFAULT_HISTORY_RETENTION_MS);
  const isRecent = (view: ThreadView) => {
    const viewedAt = Date.parse(view.viewedAt);
    return viewedAt >= cutoff && viewedAt <= time;
  };
  const favorites = favoriteThreads(documents);
  const recent = new Set<string>();
  if (policy.syncLevel >= 2) {
    for (const document of documents) for (const entry of document.entries) {
      if (entry.key[0] === "view" && entry.value !== null && isRecent(entry.value as ThreadView)) {
        recent.add(entry.key[1]);
      }
    }
  }
  const context = mergeDocuments(filterDocuments(documents, (entry) =>
    (entry.key[0] === "view" && recent.has(entry.key[1])) ||
    (entry.key[0] === "tabs" && policy.syncLevel >= 4) ||
    (entry.key[0] === "post" && policy.syncLevel >= 5)));
  if (!forTransfer) {
    recent.clear();
    for (const entry of context.values()) {
      if (entry.key[0] === "view" && entry.value !== null && isRecent(entry.value as ThreadView)) {
        recent.add(entry.key[1]);
      }
    }
  }
  const related = new Set<string>();
  for (const entry of context.values()) {
    if (entry.value === null) continue;
    if (entry.key[0] === "post") related.add(entry.key[1]);
    if (entry.key[0] === "tabs") for (const tab of (entry.value as TabState).tabs) related.add(tab.threadId);
  }
  return ({ key }) => {
    switch (key[0]) {
      case "favorite": return true;
      case "filter": return policy.syncLevel >= 3;
      case "tabs": return policy.syncLevel >= 4;
      case "post": return policy.syncLevel >= 5;
      case "metadata": return favorites.has(key[1]) || recent.has(key[1]) || related.has(key[1]);
      default: return favorites.has(key[1]) || recent.has(key[1]);
    }
  };
}
