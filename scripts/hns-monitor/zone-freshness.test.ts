import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { decodeHnsAuthorityInventoryBytes } from "@pirate/application/namespace-ownership/hns-authority-inventory";
import { probeZoneFreshness } from "./zone-freshness.ts";

test("zone helper receives dynamic inventory targets without inherited operator credentials", async () => {
  const fixture = JSON.parse(
    gunzipSync(
      await Bun.file(
        new URL("../hns-continuity/fixtures/continuity-observation.json.gz", import.meta.url),
      ).arrayBuffer(),
    ).toString(),
  );
  const inventoryHex: string = fixture.state.inventory.bytes_hex;
  const { inventory } = await decodeHnsAuthorityInventoryBytes(Buffer.from(inventoryHex, "hex"));
  const primary = inventory.authoritative_nameserver_glue[0]?.authority_address;
  if (primary === undefined) throw new Error("Fixture authority missing");
  const directory = await mkdtemp(join(tmpdir(), "hns-zone-helper-"));
  const script = join(directory, "probe.py");
  const config = {
    python: "/usr/bin/python3",
    script,
    driver_port: 4081,
    driver_reference: "fixture:driver",
    primary_authority_address: primary,
  };
  const root = { root: "fixture", pin: "ab".repeat(32), inventory_hex: inventoryHex };
  try {
    await Bun.write(
      script,
      `import json,os,sys
value=json.load(sys.stdin)
assert set(os.environ).issubset({"LANG","LC_CTYPE"})
assert len(value["authorities"]) == 2
assert {a["role"] for a in value["authorities"]} == {"primary","secondary"}
assert value["root"] == "fixture"
print(json.dumps({"conditions":["secondary_zone_lag"]}))
`,
    );
    expect(await probeZoneFreshness(config, root)).toEqual(["secondary_zone_lag"]);
    expect(await probeZoneFreshness(config, { ...root, inventory_hex: null })).toEqual([
      "dns_inventory_missing",
    ]);
    expect(
      await probeZoneFreshness({ ...config, primary_authority_address: "192.0.2.99" }, root),
    ).toEqual(["dns_authority_topology_invalid"]);
    await Bun.write(script, 'print("private malformed response")\n');
    expect(await probeZoneFreshness(config, root)).toEqual(["dns_observation_unavailable"]);
    await Bun.write(script, 'print("x" * 10000)\n');
    expect(await probeZoneFreshness(config, root)).toEqual(["dns_observation_unavailable"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
