import { canonicalJson, compareStrings } from "./encoding.js";
import { DocumentConflictError } from "./errors.js";
import { SCHEMA_VERSION, type StateDocument, type StateEntry, type StateKey } from "./types.js";
import { assertDeviceId, assertDocument } from "./validation.js";

/** Writes are atomic and serialized. Documents and their keys are never removed. */
export interface StateStore {
  listDocuments(): Promise<readonly string[]>;
  readDocument(deviceId: string): Promise<StateDocument | undefined>;
  /** Merge partial documents per key; omitted keys retain their saved values. */
  writeDocument(document: StateDocument): Promise<void>;
}

export function entryKey(key: StateKey): string {
  return JSON.stringify(key);
}

export async function readDocuments(store: StateStore): Promise<readonly StateDocument[]> {
  const documents: StateDocument[] = [];
  const seen = new Set<string>();
  for (const deviceId of await store.listDocuments()) {
    assertDeviceId(deviceId);
    if (seen.has(deviceId)) throw new TypeError("duplicate deviceId");
    seen.add(deviceId);
    const document = await store.readDocument(deviceId);
    if (document === undefined) throw new TypeError(`listed document is missing: ${deviceId}`);
    assertDocument(document);
    if (document.deviceId !== deviceId) throw new TypeError("document deviceId does not match its path");
    documents.push(document);
  }
  return documents;
}

export function documentsEqual(left: StateDocument, right: StateDocument): boolean {
  const ordered = (document: StateDocument) => ({
    ...document,
    entries: [...document.entries].sort((a, b) => compareStrings(entryKey(a.key), entryKey(b.key))),
  });
  return canonicalJson(ordered(left)) === canonicalJson(ordered(right));
}

export function documentFromEntries(deviceId: string, entries: readonly StateEntry[]): StateDocument {
  let revision = 0;
  for (const entry of entries) revision = Math.max(revision, entry.revision);
  return { v: SCHEMA_VERSION, deviceId, revision, entries: [...entries].sort((a, b) => compareStrings(entryKey(a.key), entryKey(b.key))) };
}

/** Partial transfers from the same writer can share a document revision. */
export function mergeDeviceDocuments(existing: StateDocument | undefined, candidate: StateDocument): StateDocument {
  if (existing !== undefined && existing.deviceId !== candidate.deviceId) throw new TypeError("device IDs must match");
  const entries = new Map(existing?.entries.map((entry) => [entryKey(entry.key), entry]));
  for (const entry of candidate.entries) {
    const key = entryKey(entry.key);
    const old = entries.get(key);
    if (old !== undefined && old.revision === entry.revision && canonicalJson(old.value) !== canonicalJson(entry.value)) {
      throw new DocumentConflictError(candidate.deviceId, entry.revision);
    }
    if (old === undefined || old.revision < entry.revision) entries.set(key, entry);
  }
  return documentFromEntries(candidate.deviceId, [...entries.values()]);
}
