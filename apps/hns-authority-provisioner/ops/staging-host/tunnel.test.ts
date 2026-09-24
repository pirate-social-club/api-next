import { expect, test } from "bun:test";

test("staging connector uses protected credentials, loopback metrics and bounded resources", async () => {
  const unit = await Bun.file(
    new URL("./pirate-hns-staging-tunnel.service", import.meta.url),
  ).text();
  expect(unit).toContain("DynamicUser=yes\n");
  expect(unit).toContain("Slice=pirate-hns-staging.slice\n");
  expect(unit).toContain("LoadCredential=tunnel-token:/etc/pirate-hns-staging/tunnel-token\n");
  expect(unit).toContain(
    "--token-file /run/credentials/pirate-hns-staging-tunnel.service/tunnel-token\n",
  );
  expect(unit).not.toContain("--token ");
  expect(unit).not.toContain("Environment=");
  expect(unit).toContain("--no-autoupdate --metrics 127.0.0.1:4083 --loglevel warn");
  expect(unit).toContain("MemoryMax=96M\n");
  expect(unit).toContain("CPUQuota=15%\n");
  expect(unit).toContain("TasksMax=64\n");
  expect(unit).toContain("CapabilityBoundingSet=\n");
  expect(unit).toContain("ProtectSystem=strict\n");
});
