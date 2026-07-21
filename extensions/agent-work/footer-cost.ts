import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Read only valid delegated OpenRouter outcome cost for one opaque Pi session. */
export async function readAgentOpenRouterCost(root: string | undefined, sessionId: string | undefined): Promise<number> {
  if (!root || !sessionId) return 0;
  try {
    const text = await readFile(join(root, ".agent-work", "routing-decisions.jsonl"), "utf8");
    let total = 0;
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      try {
        const record = JSON.parse(line);
        const cost = record?.usage?.cost;
        if (
          record?.type === "outcome"
          && record.sessionId === sessionId
          && typeof record.model === "string"
          && record.model.startsWith("openrouter/")
          && typeof cost === "number"
          && Number.isFinite(cost)
          && cost >= 0
        ) total += cost;
      } catch {
        // Ignore a partial or malformed telemetry line.
      }
    }
    return total;
  } catch {
    return 0;
  }
}
