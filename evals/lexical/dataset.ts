import { readFileSync } from "node:fs";
import { z } from "zod";
import { diagnosticCaseSchema, validateCases } from "../diagnostics/dataset.js";

/** Frozen, exposed synthetic acceptance. No corpus-dependent labels or semantic synonym dictionaries. */
export function loadLexicalCases(path = "evals/datasets/lexical-fallback-v1.json") {
  const raw = z.object({ version: z.literal("lexical-fallback-v1"), provenance: z.literal("wholly_fictional_personal_project"),
    acceptance: z.literal("fixed_but_exposed_not_blind_heldout"), cases: z.array(z.record(z.string(), z.unknown())).min(1) }).strict().parse(JSON.parse(readFileSync(path, "utf8")));
  return validateCases(raw.cases.map(item => diagnosticCaseSchema.parse({ partition: "acceptance_exposed", status: "challenge",
    rationale: "Fixed wholly fictional lexical acceptance, exposed before measurement. Not blind heldout.", ...item })));
}
