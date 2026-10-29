export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
export function mergeJsonObjects(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const merged = Object.hasOwn(result, key) && isJsonObject(result[key]) && isJsonObject(value) ? mergeJsonObjects(result[key], value) : value;
    // Treat __proto__/constructor as ordinary JSON keys, never prototype setters.
    Object.defineProperty(result, key, { value: merged, enumerable: true, configurable: true, writable: true });
  }
  return result;
}
