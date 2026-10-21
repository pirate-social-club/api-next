import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import type { MonitorCondition } from "./evaluate.ts";

export type MonitorSignal = "success" | "failure";

/** Every completed observation must reach the external missing-run detector. */
export async function deliverMonitorConditions(
  conditions: readonly MonitorCondition[],
  deliver: (state: MonitorSignal) => Promise<void>,
): Promise<"delivered"> {
  await deliver(conditions.length === 0 ? "success" : "failure");
  return "delivered";
}

export function makeMonitorHeartbeatSender(
  python: string,
  sender: string,
  credentialPath: string,
  label = "hns-operator-monitor",
): (state: MonitorSignal) => Promise<void> {
  if (![python, sender, credentialPath].every(isAbsolute))
    throw new Error("monitor delivery requires absolute runtime paths");
  return (state) =>
    new Promise<void>((resolve, reject) => {
      execFile(
        python,
        ["-I", sender, "--state", state, "--label", label],
        {
          timeout: 35_000,
          killSignal: "SIGKILL",
          maxBuffer: 1024,
          // This child receives no database credential or project management key.
          env: { LANG: "C.UTF-8", HNS_HEALTHCHECK_URL_FILE: credentialPath },
        },
        (error) => (error ? reject(new Error("HNS monitor delivery unavailable")) : resolve()),
      );
    });
}
