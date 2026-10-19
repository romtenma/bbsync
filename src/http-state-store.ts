import { DocumentConflictError, HttpStateStoreError, InitializationError } from "./errors.js";
import type { StateStore } from "./store.js";
import type { StateDocument } from "./types.js";
import { assertDeviceId, assertDocument, assertInteger, assertNonEmptyString, assertSessionId } from "./validation.js";

export type InitializationStatus =
  | { readonly state: "empty" | "existing" }
  | { readonly state: "active" | "complete" | "aborted"; readonly sessionId: string; readonly deviceId: string };

export interface HttpStateStoreOptions {
  readonly url: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly initializationSession?: string;
}

/** Independent clients share the server's serialized merge-and-save queue. */
export class HttpStateStore implements StateStore {
  private readonly options: HttpStateStoreOptions;
  constructor(options: HttpStateStoreOptions) {
    const url = new URL(options.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new TypeError("expected an HTTP(S) base URL without credentials, query or fragment");
    }
    assertNonEmptyString(options.token, "token");
    assertInteger(options.timeoutMs ?? 30_000, 1);
    if (options.initializationSession !== undefined) assertSessionId(options.initializationSession);
    this.options = { ...options, url: url.href.replace(/\/$/, "") };
  }

  withInitialization(sessionId: string): HttpStateStore {
    return new HttpStateStore({ ...this.options, initializationSession: sessionId });
  }

  async listDocuments(): Promise<readonly string[]> {
    const result: unknown = await this.request("GET", "/documents");
    if (!Array.isArray(result)) throw new TypeError("invalid document list response");
    const seen = new Set<string>();
    for (const id of result) {
      assertDeviceId(id);
      if (seen.has(id)) throw new TypeError("duplicate deviceId in response");
      seen.add(id);
    }
    return result as string[];
  }

  async readDocument(deviceId: string): Promise<StateDocument | undefined> {
    assertDeviceId(deviceId);
    const result: unknown = await this.request("GET", `/documents/${deviceId}`, undefined, true);
    if (result === undefined) return undefined;
    assertDocument(result);
    if (result.deviceId !== deviceId) throw new TypeError("document deviceId does not match its path");
    return result;
  }

  async writeDocument(document: StateDocument): Promise<void> {
    assertDocument(document);
    // Serialize before the first await; callers may immediately mutate their input.
    await this.request("PUT", `/documents/${document.deviceId}`, JSON.stringify(document));
  }

  async getInitialization(): Promise<InitializationStatus> {
    return this.readStatus(await this.request("GET", "/initialization"));
  }

  async beginInitialization(sessionId: string, deviceId: string): Promise<InitializationStatus> {
    assertSessionId(sessionId);
    assertDeviceId(deviceId);
    return this.readStatus(await this.request("POST", "/initialization/begin", JSON.stringify({ sessionId, deviceId })));
  }

  async finishInitialization(sessionId: string): Promise<InitializationStatus> {
    return this.endInitialization("finish", sessionId);
  }

  async abortInitialization(sessionId: string): Promise<InitializationStatus> {
    return this.endInitialization("abort", sessionId);
  }

  private async endInitialization(action: string, sessionId: string): Promise<InitializationStatus> {
    assertSessionId(sessionId);
    return this.readStatus(await this.request("POST", `/initialization/${action}`, JSON.stringify({ sessionId })));
  }

  private readStatus(value: unknown): InitializationStatus {
    if (typeof value !== "object" || value === null) throw new TypeError("invalid initialization response");
    const status = value as Record<string, unknown>;
    if (status.state === "empty" || status.state === "existing") return { state: status.state };
    if (!["active", "complete", "aborted"].includes(String(status.state))) throw new TypeError("invalid initialization state");
    assertSessionId(status.sessionId);
    assertDeviceId(status.deviceId);
    return { state: status.state as "active" | "complete" | "aborted", sessionId: status.sessionId, deviceId: status.deviceId };
  }

  private async request(method: string, path: string, body?: string, allowMissing = false): Promise<unknown> {
    const response = await fetch(`${this.options.url}${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json",
        ...(this.options.initializationSession === undefined ? {} : { "x-bbsync-session": this.options.initializationSession }) },
      ...(body === undefined ? {} : { body }),
    });
    if (response.status === 404 && allowMissing) { await response.body?.cancel(); return undefined; }
    if (response.status === 204) return undefined;
    let result: unknown;
    try { result = await response.json(); }
    catch (error) {
      if (response.ok) throw error;
      throw new HttpStateStoreError(response.status, `HTTP ${response.status}`);
    }
    if (response.ok) return result;
    const error = result as { code?: string; message?: string; deviceId?: unknown; revision?: unknown };
    if (response.status === 409 && error?.code === "document_conflict") {
      assertDeviceId(error.deviceId); assertInteger(error.revision, 1);
      throw new DocumentConflictError(error.deviceId, error.revision);
    }
    const message = typeof error?.message === "string" ? error.message : `HTTP ${response.status}`;
    if (response.status === 409 && error?.code === "initialization") throw new InitializationError(message);
    if (response.status === 400) throw new TypeError(message);
    throw new HttpStateStoreError(response.status, message);
  }
}
