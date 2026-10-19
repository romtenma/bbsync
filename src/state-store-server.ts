import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { DocumentConflictError, InitializationError } from "./errors.js";
import type { InitializationStatus } from "./http-state-store.js";
import { LocalStateStore } from "./local-state-store.js";
import type { StateDocument } from "./types.js";
import { assertDeviceId, assertInteger, assertNonEmptyString, assertSessionId } from "./validation.js";

export interface StateStoreServerOptions {
  readonly rootDirectory: string;
  /** One server/root/token per user. Terminate TLS before exposing beyond loopback. */
  readonly token: string;
  readonly host?: string;
  readonly port?: number;
  readonly maxRequestBytes?: number;
}

export interface StateStoreServer {
  readonly url: string;
  readonly lockFile: string;
  close(): Promise<void>;
}

/** Sole owner of a local directory. A stale lock requires explicit operator recovery. */
export async function startStateStoreServer(options: StateStoreServerOptions): Promise<StateStoreServer> {
  assertNonEmptyString(options.rootDirectory, "rootDirectory");
  assertNonEmptyString(options.token, "token");
  assertInteger(options.port ?? 0, 0);
  if ((options.port ?? 0) > 65_535) throw new TypeError("port must be <= 65535");
  const limit = options.maxRequestBytes ?? 16 * 1024 * 1024;
  assertInteger(limit, 1);
  const root = resolve(options.rootDirectory);
  await mkdir(root, { recursive: true });
  const lockFile = join(root, ".bbsync-server.lock");
  const lock = await open(lockFile, "wx");
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), owner: randomUUID() }));
    await lock.sync();
  } catch (error) { await lock.close(); await rm(lockFile, { force: true }); throw error; }
  const store = new LocalStateStore(root);
  const statePath = join(root, ".bbsync-initialization.json");
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const operation = queue.then(run);
    queue = operation.catch(() => undefined);
    return operation;
  };
  const readStatus = async (): Promise<InitializationStatus> => {
    let value: unknown;
    try { value = JSON.parse(await readFile(statePath, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: (await store.listDocuments()).length === 0 ? "empty" : "existing" };
      throw error;
    }
    const state = value as Record<string, unknown> | null;
    if (!state || !["active", "complete", "aborted"].includes(String(state.state))) throw new TypeError("invalid persisted initialization state");
    assertSessionId(state.sessionId); assertDeviceId(state.deviceId);
    return state as unknown as InitializationStatus;
  };
  const saveStatus = async (status: InitializationStatus): Promise<void> => {
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx");
      try { await file.writeFile(`${JSON.stringify(status)}\n`); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, statePath);
    } finally { await rm(temporary, { force: true }); }
  };
  const tokenHash = createHash("sha256").update(`Bearer ${options.token}`).digest();
  const send = (response: ServerResponse, status: number, value?: unknown) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(value === undefined ? undefined : JSON.stringify(value));
  };
  const body = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > limit) throw new TypeError("request body too large");
      chunks.push(buffer);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("expected JSON object");
    return value as Record<string, unknown>;
  };
  const server = createServer((request, response) => {
    void (async () => {
      const supplied = createHash("sha256").update(request.headers.authorization ?? "").digest();
      if (!timingSafeEqual(tokenHash, supplied)) { request.resume(); send(response, 401, { message: "unauthorized" }); return; }
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      // Read bodies before entering the queue: a slow uploader must not hold the store lock.
      const input = request.method === "PUT" || request.method === "POST" ? await body(request) : undefined;
      await serial(async () => {
        if (request.method === "GET" && (path === "/documents" || path.startsWith("/documents/"))) {
          const state = await readStatus();
          if (state.state === "active" && request.headers["x-bbsync-session"] !== state.sessionId) {
            throw new InitializationError("initialization is active; retry reads after completion");
          }
        }
        if (request.method === "GET" && path === "/documents") { send(response, 200, await store.listDocuments()); return; }
        if (request.method === "GET" && path === "/initialization") { send(response, 200, await readStatus()); return; }
        if (path.startsWith("/documents/")) {
          const deviceId = path.slice("/documents/".length);
          assertDeviceId(deviceId);
          if (request.method === "GET") {
            const document = await store.readDocument(deviceId);
            send(response, document === undefined ? 404 : 200, document ?? { message: "document not found" }); return;
          }
          if (request.method === "PUT") {
            const state = await readStatus();
            const session = request.headers["x-bbsync-session"];
            if (state.state === "active") {
              if (session !== state.sessionId || deviceId !== state.deviceId) throw new InitializationError("initialization is active; only its owner may write");
            } else if (session !== undefined) throw new InitializationError("initialization session is no longer active");
            if (input?.deviceId !== deviceId) throw new TypeError("document deviceId does not match its path");
            await store.writeDocument(input as unknown as StateDocument);
            send(response, 204); return;
          }
        }
        if (request.method === "POST" && ["/initialization/begin", "/initialization/finish", "/initialization/abort"].includes(path)) {
          assertSessionId(input?.sessionId);
          const state = await readStatus();
          if (path.endsWith("/begin")) {
            assertDeviceId(input.deviceId);
            if (state.state === "empty") {
              const next = { state: "active" as const, sessionId: input.sessionId, deviceId: input.deviceId };
              await saveStatus(next); send(response, 200, next); return;
            }
            if ("sessionId" in state && state.sessionId === input.sessionId && state.deviceId === input.deviceId) {
              send(response, 200, state); return;
            }
            throw new InitializationError("store is already initialized or owned by another session");
          }
          if (!("sessionId" in state) || state.sessionId !== input.sessionId) throw new InitializationError("initialization session does not match");
          const action = path.endsWith("/finish") ? "complete" : "aborted";
          if (state.state !== "active" && state.state !== action) throw new InitializationError("initialization session is already closed");
          const next = { ...state, state: action as "complete" | "aborted" };
          await saveStatus(next); send(response, 200, next); return;
        }
        send(response, 404, { message: "endpoint not found" });
      });
    })().catch((error: unknown) => {
      if (response.destroyed || response.headersSent) return;
      if (error instanceof DocumentConflictError) send(response, 409, { code: "document_conflict", deviceId: error.deviceId, revision: error.revision, message: error.message });
      else if (error instanceof InitializationError) send(response, 409, { code: "initialization", message: error.message });
      else if (error instanceof TypeError || error instanceof SyntaxError) send(response, 400, { message: error.message });
      else send(response, 500, { message: "state store operation failed" });
    });
  });
  server.requestTimeout = 30_000;
  try {
    await readStatus(); // Fail closed on corrupt initialization metadata before listening.
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => { server.off("error", reject); accept(); });
    });
  } catch (error) { await lock.close(); await rm(lockFile, { force: true }); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  const host = address.address.includes(":") ? `[${address.address}]` : address.address;
  let closing: Promise<void> | undefined;
  return { url: `http://${host}:${address.port}`, lockFile,
    close() {
      closing ??= (async () => {
        await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
        await queue;
        await lock.close();
        await rm(lockFile, { force: true });
      })();
      return closing;
    },
  };
}
