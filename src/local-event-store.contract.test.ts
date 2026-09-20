import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerEventStoreContractTests } from "./event-store.contract.js";
import { LocalEventStore } from "./local-event-store.js";

registerEventStoreContractTests("LocalEventStore", async () => {
  const root = await mkdtemp(join(tmpdir(), "bbsync-contract-"));
  return {
    store: new LocalEventStore(root, {
      maxEventsPerSegment: 2,
      retainSegmentsPerDevice: 1,
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
});
