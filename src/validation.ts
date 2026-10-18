import { SCHEMA_VERSION, type FavoriteLevel, type StateChange, type StateDocument, type StateEntry } from "./types.js";

export function assertDeviceId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(value)) {
    throw new TypeError("deviceId must be 1-64 lowercase ASCII letters, digits, underscores or hyphens, and not a reserved filename");
  }
}

export function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
}

export function assertDateTime(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError("date-time must use YYYY-MM-DDTHH:mm:ss.sssZ");
  }
}

export function assertInteger(value: unknown, minimum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new TypeError(`number must be a safe integer >= ${minimum}`);
}

export function assertFavoriteLevel(value: unknown): asserts value is FavoriteLevel {
  assertInteger(value, 1);
  if (value > 5) throw new TypeError("favorite level must be 1-5");
}

function objectWithFields(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("expected a JSON object");
  const object = value as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(object, key)) ||
    Object.keys(object).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new TypeError(`expected fields: ${required.join(", ")}`);
  }
  return object;
}

export function assertChange(input: unknown, withRevision = false): asserts input is StateChange {
  const change = objectWithFields(input, withRevision ? ["key", "value", "revision"] : ["key", "value"]);
  const { key, value } = change;
  if (!Array.isArray(key)) throw new TypeError("key must be an array");
  const length = key[0] === "filter" ? 4 : key[0] === "post" ? 3 : 2;
  if (key.length !== length) throw new TypeError("invalid key length");
  assertNonEmptyString(key[1], "threadId or scope");
  switch (key[0]) {
    case "metadata":
    case "view":
    case "count":
    case "favorite":
      break;
    case "post":
      assertInteger(key[2], 1);
      break;
    case "filter":
      assertNonEmptyString(key[2], "targetType");
      assertNonEmptyString(key[3], "target");
      break;
    default:
      throw new TypeError(`unknown key kind: ${String(key[0])}`);
  }
  if (withRevision) assertInteger(change.revision, 1);
  if (value === null) return;
  switch (key[0]) {
    case "metadata": {
      const metadata = objectWithFields(value, ["title", "url"]);
      assertNonEmptyString(metadata.title, "title");
      assertNonEmptyString(metadata.url, "url");
      try { new URL(metadata.url); } catch { throw new TypeError("url must be absolute"); }
      break;
    }
    case "view": {
      const view = objectWithFields(value, ["position", "viewedAt"], ["firstPosition"]);
      assertInteger(view.position, 0);
      assertDateTime(view.viewedAt);
      if (Object.hasOwn(view, "firstPosition")) {
        assertInteger(view.firstPosition, 0);
        if (view.firstPosition > view.position) throw new TypeError("firstPosition must be <= position");
      }
      break;
    }
    case "count":
      assertInteger(value, 0);
      break;
    case "favorite":
      assertFavoriteLevel(value);
      break;
    case "post":
      if (value !== true) throw new TypeError("post value must be true or null");
      break;
    case "filter": {
      const filter = objectWithFields(value, ["effect", "isRegex", "updatedAt"], ["hitAt"]);
      assertNonEmptyString(filter.effect, "effect");
      if (typeof filter.isRegex !== "boolean") throw new TypeError("isRegex must be a boolean");
      assertDateTime(filter.updatedAt);
      if (Object.hasOwn(filter, "hitAt")) assertDateTime(filter.hitAt);
      break;
    }
  }
}

export function assertDocument(input: unknown): asserts input is StateDocument {
  const document = objectWithFields(input, ["v", "deviceId", "revision", "entries"]);
  if (document.v !== SCHEMA_VERSION) throw new TypeError(`unsupported schema version: ${String(document.v)}`);
  assertDeviceId(document.deviceId);
  assertInteger(document.revision, 1);
  if (!Array.isArray(document.entries) || document.entries.length === 0) throw new TypeError("entries must be a non-empty array");
  const keys = new Set<string>();
  let latest = 0;
  for (const entry of document.entries) {
    assertChange(entry, true);
    const revision = (entry as StateEntry).revision;
    latest = Math.max(latest, revision);
    if (revision > document.revision) throw new TypeError("entry revision exceeds document revision");
    const key = JSON.stringify(entry.key);
    if (keys.has(key)) throw new TypeError("duplicate entry key");
    keys.add(key);
  }
  if (latest !== document.revision) throw new TypeError("document revision must equal its latest entry revision");
}
