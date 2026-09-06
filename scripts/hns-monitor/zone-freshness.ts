import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { decodeHnsAuthorityInventoryBytes } from "@pirate/application/namespace-ownership/hns-authority-inventory";
import { Schema } from "effect";

const Address = Schema.String.check(Schema.makeFilter((value) => isIP(value) !== 0));
const AbsolutePath = Schema.String.check(Schema.makeFilter(isAbsolute));
export const ZoneFreshnessConfig = Schema.Struct({
  python: AbsolutePath,
  script: AbsolutePath,
  driver_port: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1024, maximum: 65535 }),
  ),
  driver_reference: Schema.String.check(
    Schema.isPattern(/^[a-z][a-z0-9-]{0,63}:[a-z0-9][a-z0-9._-]*$/u),
  ),
  primary_authority_address: Address,
});
const Result = Schema.Struct({
  conditions: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-z_]{1,80}$/u))),
});
type Config = Schema.Schema.Type<typeof ZoneFreshnessConfig>;

export async function probeZoneFreshness(
  config: Config,
  root: { root: string; pin: string; inventory_hex: string | null },
): Promise<ReadonlyArray<string>> {
  try {
    if (root.inventory_hex === null) return ["dns_inventory_missing"];
    const { inventory } = await decodeHnsAuthorityInventoryBytes(
      Buffer.from(root.inventory_hex, "hex"),
    );
    const active = inventory.authoritative_nameserver_glue.filter((entry) => entry.active);
    const addresses = [...new Set(active.map((entry) => entry.authority_address))];
    if (addresses.length !== 2 || !addresses.includes(config.primary_authority_address))
      return ["dns_authority_topology_invalid"];
    const input = JSON.stringify({
      root: root.root,
      pin: root.pin,
      driver_port: config.driver_port,
      driver_reference: config.driver_reference,
      authorities: addresses.map((address) => ({
        address,
        role: address === config.primary_authority_address ? "primary" : "secondary",
      })),
    });
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        config.python,
        ["-I", config.script],
        {
          timeout: 35_000,
          killSignal: "SIGKILL",
          maxBuffer: 4096,
          // The DNS helper needs neither the database credential nor the webhook.
          env: { LANG: "C.UTF-8" },
        },
        (error, stdout) =>
          error ? reject(new Error("DNS observation unavailable")) : resolve(stdout),
      );
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    });
    const result = Schema.decodeUnknownSync(Result)(JSON.parse(output), {
      onExcessProperty: "error",
    });
    return result.conditions.length <= 8 ? result.conditions : ["dns_observation_invalid"];
  } catch {
    return ["dns_observation_unavailable"];
  }
}
