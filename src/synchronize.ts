import { DocumentConflictError } from "./errors.js";
import { assertDocumentSuccessor, documentsEqual, readDocuments, type StateStore } from "./store.js";
import type { StateDocument, SynchronizeResult } from "./types.js";

/** Copy each device's newest complete document in both directions. */
export async function synchronizeStores(left: StateStore, right: StateStore): Promise<SynchronizeResult> {
  const leftDocuments = new Map((await readDocuments(left)).map((doc) => [doc.deviceId, doc]));
  const rightDocuments = new Map((await readDocuments(right)).map((doc) => [doc.deviceId, doc]));
  const toLeft: StateDocument[] = [];
  const toRight: StateDocument[] = [];
  for (const deviceId of new Set([...leftDocuments.keys(), ...rightDocuments.keys()])) {
    const a = leftDocuments.get(deviceId);
    const b = rightDocuments.get(deviceId);
    if (a === undefined) toLeft.push(b!);
    else if (b === undefined) toRight.push(a);
    else if (a.revision === b.revision) {
      if (!documentsEqual(a, b)) throw new DocumentConflictError(deviceId, a.revision);
    } else {
      const [older, newer] = a.revision < b.revision ? [a, b] : [b, a];
      assertDocumentSuccessor(older, newer);
      if (a.revision < b.revision) toLeft.push(b);
      else toRight.push(a);
    }
  }
  for (const document of toLeft) await left.writeDocument(document);
  for (const document of toRight) await right.writeDocument(document);
  return { copiedToLeft: toLeft.length, copiedToRight: toRight.length };
}
