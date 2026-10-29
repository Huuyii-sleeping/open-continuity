import { expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../../src/core/pagination/records.js";
it("record cursors: bind namespace and filters, rejecting legacy reuse", () => {
  const cursor = encodeCursor("memory", "2031-01-01T00:00:00Z", "fictional-id", "fictional-filter-a");
  expect(decodeCursor(cursor, "memory", "fictional-filter-a")?.id).toBe("fictional-id");
  for (const [kind, fingerprint] of [["event", "fictional-filter-a"], ["memory", "fictional-filter-b"]] as const) expect(() => decodeCursor(cursor, kind, fingerprint)).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  expect(() => decodeCursor(encodeCursor("memory", "2031-01-01T00:00:00Z", "fictional-id"), "memory", "fictional-filter-a")).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
});
