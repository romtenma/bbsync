import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { BbsSync, LocalStateStore } from "../dist/index.js";

const keys = Number(process.argv[2] ?? 1000);
const devices = Number(process.argv[3] ?? 3);
const iterations = Number(process.argv[4] ?? 20);
if (![keys, devices, iterations].every((value) => Number.isSafeInteger(value) && value >= 1)) throw new Error("usage: npm run benchmark -- keysPerDevice devices iterations");
const root = await mkdtemp(join(tmpdir(), "bbsync-benchmark-"));
const measure = async (operation) => {
  const samples = [];
  for (let index = 0; index < iterations; index++) { const start = performance.now(); await operation(index); samples.push(performance.now() - start); }
  samples.sort((a, b) => a - b);
  return { p50Ms: samples[Math.floor(samples.length / 2)], p95Ms: samples[Math.min(samples.length - 1, Math.ceil(samples.length * .95) - 1)] };
};
try {
  const storage = new LocalStateStore(join(root, "local"));
  for (let device = 0; device < devices; device++) await storage.writeDocument({ v: 3, deviceId: `device-${device}`, revision: 1,
    entries: Array.from({ length: keys }, (_, key) => ({ key: ["favorite", `t-${device}-${key}`], value: key % 4 === 0 ? null : 1, revision: 1 })) });
  const sync = new BbsSync({ storage, deviceId: "device-0", syncLevel: 5 });
  const remote = new LocalStateStore(join(root, "remote"));
  const snapshot = await measure(() => sync.getApplicationSnapshot());
  const update = await measure((index) => sync.setFavorite(`edit-${index}`, 1));
  const start = performance.now(); await sync.synchronizeWith(remote); const firstSyncMs = performance.now() - start;
  const repeatedSync = await measure(() => sync.synchronizeWith(remote));
  let bytes = 0;
  for (const name of await readdir(join(root, "local/devices"))) bytes += (await stat(join(root, "local/devices", name))).size;
  console.log(JSON.stringify({ node: process.version, platform: process.platform, keysPerDevice: keys, devices, tombstoneRatio: .25,
    iterations, snapshot, update, firstSyncMs, repeatedSync, storedBytes: bytes, rssBytes: process.memoryUsage().rss }, null, 2));
} finally {
  if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error("unexpected benchmark directory");
  await rm(root, { recursive: true, force: true });
}
