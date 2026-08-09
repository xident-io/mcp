import { z } from "zod";
import { ALL_TOOLS } from "./tools/registry.js";

/**
 * The published tool contract, in a form that can be diffed.
 *
 * Tool names and input schemas are a customer-facing promise exactly like the
 * v1 JSON response shapes: once an agent in production calls
 * `xident_start_test_verification`, renaming it breaks that agent. Changes are
 * additive-only — new OPTIONAL inputs are fine, renames and removals are not.
 */
export interface ToolContractEntry {
  name: string;
  title: string;
  inputSchema: unknown;
  annotations: Record<string, unknown>;
}

export function toolContract(): ToolContractEntry[] {
  return ALL_TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    inputSchema: z.toJSONSchema(z.object(t.inputSchema)),
    annotations: { ...t.annotations },
  }));
}
