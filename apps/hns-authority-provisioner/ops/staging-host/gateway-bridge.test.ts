import { expect, test } from "bun:test";
import configuration from "./caddy-tls.json";

test("private TLS bridge binds only the isolated interface and loopback gateway", async () => {
  const socket = await Bun.file(
    new URL("./pirate-hns-staging-gateway-bridge.socket", import.meta.url),
  ).text();
  const service = await Bun.file(
    new URL("./pirate-hns-staging-gateway-bridge.service", import.meta.url),
  ).text();
  const listeners = [...socket.matchAll(/^ListenStream=(.+)$/gm)].map((match) => match[1]);
  expect(listeners).toEqual(["172.31.254.1:4269"]);
  const listener = listeners[0];
  if (listener === undefined) throw new Error("missing private listener");
  expect(configuration.apps.http.servers.staging.routes[0]?.handle[2]?.upstreams).toEqual([
    { dial: listener },
  ]);
  expect(socket).toContain("BindToDevice=phnsstage0\n");
  expect(socket).toContain("Accept=no\n");
  expect(socket).toContain("IPAddressDeny=any\n");
  expect([...socket.matchAll(/^IPAddressAllow=(.+)$/gm)].map((match) => match[1])).toEqual([
    "172.31.254.2/32",
  ]);
  expect(service).toContain(
    "ExecStart=/usr/lib/systemd/systemd-socket-proxyd --connections-max=64 127.0.0.1:4269\n",
  );
  expect(service).toContain("Type=simple\n");
  expect(service).not.toContain("Type=notify\n");
  expect(service).toContain("Slice=pirate-hns-staging.slice\n");
  expect(service).toContain("IPAddressDeny=any\n");
  expect([...service.matchAll(/^IPAddressAllow=(.+)$/gm)].map((match) => match[1])).toEqual([
    "127.0.0.1/32",
  ]);
  expect(service).toContain("DynamicUser=yes\n");
  expect(service).toContain("MemoryMax=16M\n");
  expect(service).toContain("CPUQuota=5%\n");
  expect(service).toContain("TasksMax=16\n");
});

test("staging gateway uses its own bounded service and credentials", async () => {
  const service = await Bun.file(
    new URL("./pirate-hns-staging-gateway.service", import.meta.url),
  ).text();
  expect(service).toContain("Slice=pirate-hns-staging.slice\n");
  expect(service).toContain("DynamicUser=yes\n");
  expect(service).toContain("MemoryMax=128M\n");
  expect(service).toContain("CPUQuota=15%\n");
  expect(service).toContain("--mode staging-private-tls --manifest ");
  expect(service).toContain("/srv/pirate-hns-staging/gateway/current/");
  expect([...service.matchAll(/^LoadCredential=.*:(.+)$/gm)].map((match) => match[1])).toEqual([
    "/etc/pirate-hns-staging/gateway/authority-database-url",
    "/etc/pirate-hns-staging/gateway/forwarder-key-registry.json",
    "/etc/pirate-hns-staging/gateway/solid-access-client-id",
    "/etc/pirate-hns-staging/gateway/solid-access-client-secret",
  ]);
  expect(service).not.toContain("/etc/pirate/");
});

test("staging provisioner retains cutover guard and isolated credentials", async () => {
  const service = await Bun.file(
    new URL("./pirate-hns-staging-provisioner.service", import.meta.url),
  ).text();
  expect(service).toContain("Slice=pirate-hns-staging.slice\n");
  expect(service).toContain("DynamicUser=yes\n");
  expect(service).toContain("MemoryMax=192M\n");
  expect(service).toContain("CPUQuota=20%\n");
  expect(service).toContain("EnvironmentFile=/etc/pirate-hns-staging/provisioner.env\n");
  expect(service).toContain(
    "LoadCredential=hns_axfr_tsig_secret:/etc/pirate-hns-staging/axfr-tsig-secret\n",
  );
  expect(service).toContain("--verify-schema --manifest ");
  expect(service).toContain("--serve\n");
  expect(service).not.toContain("/etc/pirate/");
});
