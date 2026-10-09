import { z } from "zod";

const patterns = z.array(z.string().trim().toLowerCase().min(1).max(200)).max(50).default([]);

/** A client policy rule as technicians (and Haley's suggestions) submit it; see PolicyRule in types.ts. */
export const policyRuleInput = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  tools: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  risks: z.array(z.enum(["write", "destructive"])).default([]),
  targets: patterns,
  departments: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  requesters: patterns,
  effect: z.enum(["allow", "approve", "deny"]),
  approvers: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  minAssurance: z.enum(["email", "chat", "directory", "mfa", "technician"]).default("directory"),
});

export type PolicyRuleInput = z.infer<typeof policyRuleInput>;
