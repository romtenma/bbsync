import { canonicalJson, compareStrings } from "./encoding.js";
import { DocumentConflictError } from "./errors.js";
import type { StateDocument, StateKey } from "./types.js";
import { assertDeviceId, assertDocument } from "./validation.js";

/** Writes are atomic and serialized. Documents and their keys are never removed. */
export interface StateStore {
  listDocuments(): Promise<readonly string[]>;
  readDocument(deviceId: string): Promise<StateDocument | undefined>;
  /** Ignore older revisions, accept equal contents, reject forks or lost entries. */
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

/** A newer file must preserve old keys and advance every changed item. */
export function assertDocumentSuccessor(existing: StateDocument, candidate: StateDocument): void {
  const next = new Map(candidate.entries.map((entry) => [entryKey(entry.key), entry]));
  for (const old of existing.entries) {
    const entry = next.get(entryKey(old.key));
    if (entry === undefined ||
      (canonicalJson(entry) !== canonicalJson(old) && entry.revision <= existing.revision)) {
      throw new DocumentConflictError(candidate.deviceId, candidate.revision);
    }
    next.delete(entryKey(old.key));
  }
  if ([...next.values()].some((entry) => entry.revision <= existing.revision)) {
    throw new DocumentConflictError(candidate.deviceId, candidate.revision);
  }
}
