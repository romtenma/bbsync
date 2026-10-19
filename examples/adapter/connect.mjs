import { join } from "node:path";
import { BbsSync, LocalStateStore } from "@romtenma/bbsync";
import { HttpStateStore } from "@romtenma/bbsync/http";
import { Adapter, AdapterDatabase, initializeFromLocal } from "./adapter.mjs";

const root = process.argv[2] ?? "./bbsync-client";
if (!process.env.BBSYNC_URL || !process.env.BBSYNC_TOKEN) throw new Error("Set BBSYNC_URL and BBSYNC_TOKEN");
const db = await AdapterDatabase.open(join(root, "application.json"));
const sync = new BbsSync({ storage: new LocalStateStore(join(root, "state")),
  deviceId: (await db.read()).deviceId, syncLevel: 5 });
const remote = new HttpStateStore({ url: process.env.BBSYNC_URL, token: process.env.BBSYNC_TOKEN });
if (process.argv.includes("--initialize") || (await db.read()).initialization?.completed === false) {
  await initializeFromLocal(sync, remote, db);
}
const status = await remote.getInitialization();
if (status.state === "active") throw new Error("another device is still initializing; retry after it finishes");
await new Adapter(sync, db).synchronize(remote);
console.log(JSON.stringify((await db.read()).rows, null, 2));
