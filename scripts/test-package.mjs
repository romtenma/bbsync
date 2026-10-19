import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "bbsync-package-"));
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run with npm run test:package");
const run = (args, cwd = root) => {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${args[0]} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
try {
  const packed = JSON.parse(run([npm, "pack", "--ignore-scripts", "--json", "--pack-destination", temporary, "--cache", join(root, ".npm-cache")]))[0];
  for (const required of ["dist/testing.js", "dist/state-store.contract.js", "dist/http.js", "examples/adapter/adapter.mjs"]) {
    assert.ok(packed.files.some((file) => file.path === required), `missing packed file ${required}`);
  }
  assert.ok(!packed.files.some((file) => file.path.endsWith(".test.js")));
  const consumer = join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run([npm, "install", join(temporary, packed.filename), "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", join(root, ".npm-cache")], consumer);
  await writeFile(join(consumer, "smoke.ts"), `
    import { BbsSync, LocalStateStore, type ApplicationSnapshot, type StateDocument } from '@romtenma/bbsync';
    import { HttpStateStore, startStateStoreServer } from '@romtenma/bbsync/http';
    import { registerStateStoreContractTests, registerSharedStateStoreContractTests, type StateStoreFixture } from '@romtenma/bbsync/testing';
    const sync = new BbsSync({storage:new LocalStateStore('local'),deviceId:'a',syncLevel:5});
    const snapshot: ApplicationSnapshot = await sync.getApplicationSnapshot();
    await sync.updateWithJournal([], async (document: StateDocument) => { await sync.storage.writeDocument(document); });
    void [snapshot, HttpStateStore, startStateStoreServer, registerStateStoreContractTests, registerSharedStateStoreContractTests];
  `);
  run([join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "smoke.ts"], consumer);
  await writeFile(join(consumer, "smoke.test.mjs"), `
    import { mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { HttpStateStore, startStateStoreServer } from '@romtenma/bbsync/http';
    import { registerStateStoreContractTests, registerSharedStateStoreContractTests } from '@romtenma/bbsync/testing';
    async function fixture() {
      const root = await mkdtemp(join(tmpdir(),'bbsync-consumer-'));
      const server = await startStateStoreServer({rootDirectory:root,token:'test'});
      const client = () => new HttpStateStore({url:server.url,token:'test'});
      return {store:client(),clients:[client(),client()],cleanup:async()=>{await server.close();await rm(root,{recursive:true,force:true});}};
    }
    registerStateStoreContractTests('installed tgz', fixture);
    registerSharedStateStoreContractTests('installed tgz', fixture);
    await import('./node_modules/@romtenma/bbsync/examples/adapter/adapter.mjs');
  `);
  const output = run(["--test", "smoke.test.mjs"], consumer);
  console.log(output.trim());
  console.log(`Package ${packed.filename}: external imports, declarations, contract tests and example passed`);
} finally {
  if (dirname(resolve(temporary)) !== resolve(tmpdir())) throw new Error("unexpected package test directory");
  await rm(temporary, { recursive: true, force: true });
}
