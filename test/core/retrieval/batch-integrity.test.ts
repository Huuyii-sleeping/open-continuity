import { expect, it } from "vitest";
import { validateCandidateBatches } from "../../../src/core/retrieval/validation.js";
import { lexicalBatch } from "../../helpers/ranking-route-fixtures.js";

it("batch integrity: unknown no-score model/direction cannot be treated as valid relevance evidence", () => {
  for (const score of [{ model: "none", value: null, direction: "lower_is_better" }, { model: "fictional_unknown", value: null, direction: "not_applicable" }]) {
    const batch = lexicalBatch();
    const invalid = { ...batch, hits: batch.hits.map(hit => ({ ...hit, rankMeaning: "match_order", score })) };
    // Foreign JavaScript stores can return malformed data; exercise that runtime boundary without a type cast.
    expect(() => Reflect.apply(validateCandidateBatches, undefined, [[invalid]])).toThrow(expect.objectContaining({ code: "STORAGE_ERROR" }));
  }
});
it("batch integrity: not-run batches, unknown status and nonboolean truncation cannot claim hits", () => {
  for (const change of [{ implementation: "not_run" }, { status: "fictional_unknown" }, { truncated: "false" }]) {
    const invalid = { ...lexicalBatch(), ...change };
    // Foreign JavaScript stores can return malformed data; exercise that runtime boundary without a type cast.
    expect(() => Reflect.apply(validateCandidateBatches, undefined, [[invalid]])).toThrow(expect.objectContaining({ code: "STORAGE_ERROR" }));
  }
});
