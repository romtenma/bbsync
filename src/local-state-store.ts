import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { documentsEqual, mergeDeviceDocuments, type StateStore } from "./store.js";
import type { StateDocument } from "./types.js";
import { assertDeviceId, assertDocument, assertNonEmptyString } from "./validation.js";

/** Use one instance per directory and one writer per deviceId. */
export class LocalStateStore implements StateStore {
  readonly rootDirectory: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(rootDirectory: string) {
    assertNonEmptyString(rootDirectory, "rootDirectory");
    this.rootDirectory = rootDirectory;
  }

  async listDocuments(): Promise<readonly string[]> {
    try {
      const entries = await readdir(join(this.rootDirectory, "devices"), { withFileTypes: true });
      const devices: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) throw new TypeError("legacy device directory: use a new data directory for v3");
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const deviceId = entry.name.slice(0, -5);
        assertDeviceId(deviceId);
        devices.push(deviceId);
      }
      return devices.sort();
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  async readDocument(deviceId: string): Promise<StateDocument | undefined> {
    assertDeviceId(deviceId);
    try {
      const document: unknown = JSON.parse(await readFile(this.documentPath(deviceId), "utf8"));
      assertDocument(document);
      if (document.deviceId !== deviceId) throw new TypeError("document deviceId does not match its path");
      return document;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async writeDocument(document: StateDocument): Promise<void> {
    assertDocument(document);
    const copy = structuredClone(document);
    const operation = this.writeQueue.then(() => this.writeWithoutLock(copy));
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async writeWithoutLock(document: StateDocument): Promise<void> {
    await this.listDocuments();
    const existing = await this.readDocument(document.deviceId);
    const merged = mergeDeviceDocuments(existing, document);
    if (existing !== undefined && documentsEqual(existing, merged)) return;
    await mkdir(join(this.rootDirectory, "devices"), { recursive: true });
    const path = this.documentPath(document.deviceId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(merged)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private documentPath(deviceId: string): string {
    return join(this.rootDirectory, "devices", `${deviceId}.json`);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
