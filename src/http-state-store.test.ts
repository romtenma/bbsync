import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BbsSync, LocalStateStore, type StateDocument } from "./index.js";
import { HttpStateStore, HttpStateStoreError, InitializationError, startStateStoreServer } from "./http.js";
import { registerStateStoreContractTests, registerSharedStateStoreContractTests } from "./testing.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bbsync-http-"));
  const server = await startStateStoreServer({ rootDirectory: root, token: "test-token" });
  const store = new HttpStateStore({ url: server.url, token: "test-token" });
  return { root, server, store, cleanup: async () => { await server.close(); await rm(root, { recursive: true, force: true }); } };
}
registerStateStoreContractTests("HttpStateStore", fixture);
registerSharedStateStoreContractTests("HttpStateStore", async () => {
  const f = await fixture();
  return { clients: [f.store, new HttpStateStore({ url: f.server.url, token: "test-token" })], cleanup: f.cleanup };
});
const document: StateDocument = { v: 3, deviceId: "a", revision: 1, entries: [{ key: ["favorite", "t"], value: 1, revision: 1 }] };

test("gateway rejects unauthorized clients, mismatched paths and duplicate ownership", async () => {
  const f = await fixture();
  try {
    const unauthorized = new HttpStateStore({ url: f.server.url, token: "wrong" });
    await assert.rejects(() => unauthorized.listDocuments(), (error: unknown) => error instanceof HttpStateStoreError && error.status === 401);
    await assert.rejects(() => startStateStoreServer({ rootDirectory: f.root, token: "another" }), /EEXIST/);
    await assert.rejects(() => f.store.beginInitialization("invalid session", "a"), TypeError);
    const result = await fetch(`${f.server.url}/documents/b`, { method: "PUT", headers: { authorization: "Bearer test-token" }, body: JSON.stringify(document) });
    assert.equal(result.status, 400);
    await result.body?.cancel();
    assert.deepEqual(await f.store.listDocuments(), []);
  } finally { await f.cleanup(); }
});

test("initialization is exclusive, resumable and durable across server restart", async () => {
  const f = await fixture();
  let restarted: Awaited<ReturnType<typeof startStateStoreServer>> | undefined;
  try {
    const results = await Promise.allSettled([f.store.beginInitialization("session-a", "a"), f.store.beginInitialization("session-b", "b")]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const state = await f.store.getInitialization();
    assert.equal(state.state, "active");
    if (state.state !== "active") throw new Error("expected active session");
    await assert.rejects(() => f.store.writeDocument(document), InitializationError);
    await assert.rejects(() => f.store.listDocuments(), InitializationError);
    const owner = f.store.withInitialization(state.sessionId);
    const owned = { ...document, deviceId: state.deviceId };
    await owner.writeDocument(owned);
    await f.server.close();
    restarted = await startStateStoreServer({ rootDirectory: f.root, token: "test-token" });
    const reopened = new HttpStateStore({ url: restarted.url, token: "test-token" });
    assert.deepEqual(await reopened.beginInitialization(state.sessionId, state.deviceId), state);
    await reopened.withInitialization(state.sessionId).writeDocument(owned);
    await reopened.finishInitialization(state.sessionId);
    await reopened.finishInitialization(state.sessionId); // lost completion response
    assert.equal((await reopened.beginInitialization(state.sessionId, state.deviceId)).state, "complete");
    await assert.rejects(() => reopened.withInitialization(state.sessionId).writeDocument(owned), InitializationError);
    await assert.rejects(() => reopened.beginInitialization("other-session", "c"), InitializationError);
    await reopened.writeDocument({ ...document, deviceId: "c" });
  } finally { await restarted?.close(); await f.cleanup(); }
});

test("initialization abort keeps partial data and releases normal writes", async () => {
  const f = await fixture();
  try {
    await f.store.beginInitialization("session", "a");
    await f.store.withInitialization("session").writeDocument(document);
    await f.store.abortInitialization("session");
    await f.store.abortInitialization("session");
    await f.store.writeDocument({ ...document, deviceId: "b" });
    assert.deepEqual(await f.store.listDocuments(), ["a", "b"]);
    await assert.rejects(() => f.store.finishInitialization("session"), InitializationError);
  } finally { await f.cleanup(); }
});

test("independent processes retain concurrent partial documents", { timeout: 15_000 }, async () => {
  const f = await fixture();
  const children: ReturnType<typeof spawn>[] = [];
  try {
    const moduleUrl = new URL("./http-state-store.js", import.meta.url).href;
    const source = `import { HttpStateStore } from ${JSON.stringify(moduleUrl)};
      const store = new HttpStateStore({url:process.argv[1],token:'test-token'});
      process.stdout.write('ready\\n');
      await new Promise(resolve => process.stdin.once('data',resolve));
      await store.writeDocument({v:3,deviceId:'writer',revision:1,entries:[{key:['favorite',process.argv[2]],value:1,revision:1}]});`;
    for (const key of ["a", "b"]) {
      const child = spawn(process.execPath, ["--input-type=module", "-e", source, f.server.url, key], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      children.push(child);
    }
    await Promise.all(children.map((child) => once(child.stdout!, "data")));
    const exits = children.map((child) => once(child, "exit"));
    children.forEach((child) => child.stdin!.end("go"));
    const codes = await Promise.all(exits);
    assert.ok(codes.every(([code]) => code === 0));
    assert.equal((await f.store.readDocument("writer"))!.entries.length, 2);
  } finally { children.forEach((child) => { if (child.exitCode === null) child.kill(); }); await f.cleanup(); }
});

test("abrupt server exit preserves data and requires explicit stale-lock recovery", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "bbsync-crash-"));
  let restarted: Awaited<ReturnType<typeof startStateStoreServer>> | undefined;
  const source = `import { startStateStoreServer } from ${JSON.stringify(new URL("./state-store-server.js", import.meta.url).href)};
    const server = await startStateStoreServer({rootDirectory:process.argv[1],token:'test'});
    process.stdout.write(server.url+'\\n');`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, root], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  try {
    const [output] = await once(child.stdout!, "data");
    const remote = new HttpStateStore({ url: String(output).trim(), token: "test" });
    await remote.writeDocument(document);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    await assert.rejects(() => startStateStoreServer({ rootDirectory: root, token: "test" }), /EEXIST/);
    // The owning process is now confirmed dead; emulate explicit operator recovery.
    await rm(join(root, ".bbsync-server.lock"));
    restarted = await startStateStoreServer({ rootDirectory: root, token: "test" });
    assert.deepEqual(await new HttpStateStore({ url: restarted.url, token: "test" }).readDocument("a"), document);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await restarted?.close(); await rm(root, { recursive: true, force: true });
  }
});

test("two device writers converge after interrupted synchronization", async () => {
  const f = await fixture();
  try {
    const leftStore = new LocalStateStore(join(f.root, "left-local"));
    const rightStore = new LocalStateStore(join(f.root, "right-local"));
    const left = new BbsSync({ storage: leftStore, deviceId: "a", syncLevel: 5 });
    const right = new BbsSync({ storage: rightStore, deviceId: "b", syncLevel: 5 });
    await left.setFavorite("t", 1); await right.setFavorite("t", 5);
    let loseResponse = true;
    const unstable = { listDocuments: () => f.store.listDocuments(), readDocument: (id: string) => f.store.readDocument(id),
      async writeDocument(doc: StateDocument) { await f.store.writeDocument(doc); if (loseResponse) { loseResponse = false; throw new Error("response lost"); } } };
    await assert.rejects(() => left.synchronizeWith(unstable), /response lost/);
    await right.synchronizeWith(f.store);
    await left.synchronizeWith(f.store);
    await right.synchronizeWith(f.store);
    assert.equal((await left.getThreadState("t"))!.favoriteLevel, 5);
    assert.deepEqual(await left.getStates(), await right.getStates());
    assert.deepEqual(await right.synchronizeWith(f.store), { copiedToLeft: 0, copiedToRight: 0 });
  } finally { await f.cleanup(); }
});
