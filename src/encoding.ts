/** JSON object order is immaterial; array order remains significant. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
