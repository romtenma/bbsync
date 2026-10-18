import { createScope, filterDocuments } from "./scope.js";
import { documentsEqual, mergeDeviceDocuments, readDocuments, type StateStore } from "./store.js";
import type { StateDocument, SynchronizeResult, SyncPolicy } from "./types.js";
import { assertSyncPolicy } from "./validation.js";

/** Transfer only in-scope entries, preserving every other saved entry. */
export async function synchronizeStores(left: StateStore, right: StateStore, policy: SyncPolicy & { readonly now?: Date }): Promise<SynchronizeResult> {
  assertSyncPolicy(policy);
  const leftSource = await readDocuments(left);
  const rightSource = await readDocuments(right);
  const include = createScope([...leftSource, ...rightSource], policy, policy.now ?? new Date(), true);
  const leftDocuments = new Map(filterDocuments(leftSource, include).map((doc) => [doc.deviceId, doc]));
  const rightDocuments = new Map(filterDocuments(rightSource, include).map((doc) => [doc.deviceId, doc]));
  const toLeft: StateDocument[] = [];
  const toRight: StateDocument[] = [];
  for (const deviceId of new Set([...leftDocuments.keys(), ...rightDocuments.keys()])) {
    const a = leftDocuments.get(deviceId);
    const b = rightDocuments.get(deviceId);
    if (a === undefined) toLeft.push(b!);
    else if (b === undefined) toRight.push(a);
    else {
      const merged = mergeDeviceDocuments(a, b);
      if (!documentsEqual(a, merged)) toLeft.push(b);
      if (!documentsEqual(b, merged)) toRight.push(a);
    }
  }
  for (const document of toLeft) await left.writeDocument(document);
  for (const document of toRight) await right.writeDocument(document);
  return { copiedToLeft: toLeft.length, copiedToRight: toRight.length };
}
