import type { Autonomy, Risk } from "../types.js";

export type Decision = "run" | "approve" | "block";

/**
 * The approval matrix. Destructive actions always need a human; internal Haley writes
 * (notes, KB, ticket fields) never do.
 *
 *                read  internal  write    destructive
 *  read_only     run   run       block    block
 *  supervised    run   run       approve  approve
 *  autonomous    run   run       run      approve
 */
export function decide(autonomy: Autonomy, risk: Risk): Decision {
  if (risk === "read" || risk === "internal") return "run";
  if (autonomy === "read_only") return "block";
  if (risk === "destructive") return "approve";
  return autonomy === "autonomous" ? "run" : "approve";
}
