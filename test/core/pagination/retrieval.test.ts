import { expect, it } from "vitest";
import { decodeRetrievalCursor, encodeRetrievalCursor } from "../../../src/core/pagination/retrieval.js";
it("ranked cursors: require the ranking policy fingerprint and versioned exact tier", () => {
  const cursor = encodeRetrievalCursor(0.01, "2031-01-01T00:00:00Z", "fictional-id", "fictional-ranking-a", 1);
  expect(decodeRetrievalCursor(cursor, "fictional-ranking-a", true)?.exactTier).toBe(1);
  expect(() => decodeRetrievalCursor(cursor, "fictional-ranking-b", true)).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  expect(() => decodeRetrievalCursor(encodeRetrievalCursor(0.01, "2031-01-01T00:00:00Z", "fictional-id", "fictional-ranking-a"), "fictional-ranking-a", true)).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
});
