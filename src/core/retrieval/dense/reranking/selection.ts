import type { DenseSupportSelection } from "../rescue/contracts.js";
import { OpenContinuityError } from "../../../../shared/errors.js";
/** Rejection may retain previously verified evidence; model failure cannot be disguised as rejection. */
export function chooseRerankingSelection(baseline: DenseSupportSelection, reranked: DenseSupportSelection) {
  if ([baseline, reranked].some(selection => selection.accepted.length > 1 || selection.reason === "verification_unavailable" || selection.reason === "unavailable"))
    throw new OpenContinuityError("STORAGE_ERROR", "Unavailable or invalid reranking selection", 500);
  return reranked.accepted.length || !baseline.accepted.length ? { route: "reranked" as const, selection: reranked }
    : { route: "baseline" as const, selection: baseline };
}
