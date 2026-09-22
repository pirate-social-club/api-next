import { expect, test } from "bun:test";
import { startFixtureGateway } from "./hns-staging-gateway-fixture.ts";

test("fixture certificate refuses non-generated roots before opening listeners", async () => {
  await expect(startFixtureGateway("production.invalid")).rejects.toThrow();
});

test("real gateway over TLS forwards the community, refuses unknown hosts and wrong SPKI", async () => {
  const gateway = await startFixtureGateway("e2eabcdef123456");
  try {
    expect(gateway.spki).toMatch(/^[a-f0-9]{64}$/);
    await gateway.verify();
  } finally {
    await gateway.stop();
  }
}, 15000);
