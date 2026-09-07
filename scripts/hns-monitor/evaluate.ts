import { createHash } from "node:crypto";
import type { MonitorSnapshot } from "./snapshot.ts";

export interface MonitorCondition {
  readonly subject: string;
  readonly code: string;
}

export interface Checkpoint {
  readonly root: string;
  readonly activation_generation: string;
  readonly due_at: number;
}

export const monitorSubject = (root: string): string =>
  `root-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;

export function evaluateMonitorSnapshot(
  snapshot: MonitorSnapshot,
  checkpoints: readonly Checkpoint[],
): MonitorCondition[] {
  const conditions: MonitorCondition[] = [];
  if (snapshot.heartbeat_remaining === null || snapshot.heartbeat_remaining <= 0)
    conditions.push({ subject: "scheduler", code: "heartbeat_stale" });
  for (const root of snapshot.roots) {
    const subject = monitorSubject(root.root);
    const add = (code: string) => conditions.push({ subject, code });
    if (!root.healthy) add("health_unhealthy");
    if (root.inventory_remaining === null || root.health_remaining === null)
      add("serving_evidence_missing");
    else if (Math.min(root.inventory_remaining, root.health_remaining) < 2 * 86400)
      add("serving_validity_low");
    if (root.terminal) add("renewal_terminal");
    // created_at measures total job age; retry updates must not reset the alert clock.
    if (root.delayed_age !== null && root.delayed_age >= 3 * 3600) add("renewal_delayed");
    if (!root.imported) {
      const checkpoint = checkpoints.find(
        (entry) =>
          entry.root === root.root && entry.activation_generation === root.activation_generation,
      );
      if (
        (checkpoint !== undefined && checkpoint.due_at <= snapshot.observed_at) ||
        root.inventory_age === null ||
        root.inventory_age >= 5 * 86400
      )
        add("inventory_checkpoint_missed");
    }
  }
  return conditions;
}
