import { describe, expect, test } from "bun:test";

const stagingUnitUrl = new URL(
  "../ops/systemd/pirate-hns-community-app-gateway-staging-shadow.service",
  import.meta.url,
);
const stagingManifestUrl = new URL(
  "../ops/community/deployment-manifest.staging-shadow.template.json",
  import.meta.url,
);

describe("community gateway staging operations profile", () => {
  test("keeps the staging unit source-closed to its own release and credential roots", async () => {
    const unit = await Bun.file(stagingUnitUrl).text();
    expect(unit).toContain(
      "WorkingDirectory=/srv/pirate-hns-community-app-gateway-staging-shadow/current",
    );
    expect(unit).toContain(
      "--mode staging-shadow --manifest /srv/pirate-hns-community-app-gateway-staging-shadow/current/deployment-manifest.json",
    );
    expect(unit).toContain(
      "hns-community-authority-database-url:/etc/pirate/hns-community-app-gateway-staging-shadow/authority-database-url",
    );
    expect(unit).not.toContain("/srv/pirate-hns-community-app-gateway/current");
    expect(unit).not.toContain("/srv/pirate-hns-community-app-gateway-shadow/current");
    expect(unit).not.toContain("/etc/pirate/hns-community-app-gateway/");
    expect(unit).not.toContain("/etc/pirate/hns-community-app-gateway-shadow/");
  });

  test("pins the staging manifest contract and excludes every production listener", async () => {
    const manifest = JSON.parse(await Bun.file(stagingManifestUrl).text()) as Record<
      string,
      unknown
    >;
    expect(manifest).toMatchObject({
      schema: "pirate-hns-community-app-gateway-staging-deployment-v1",
      mode: "staging-shadow",
      staging_shadow_gateway_listener: "127.0.0.1:4269",
      staging_shadow_health_listener: "127.0.0.1:4271",
      ingress_contract: "pirate-hns-community-app-loopback-preflight-v1",
      public_tls_termination: false,
      profile_utf8_bytes: 622,
      profile_sha256: "c4f4c07252ba10a25467f476cc5b56d50ef9cf02e25ad368a05551d19ba861ed",
    });
    expect(manifest).not.toHaveProperty("production_gateway_listener");
    expect(manifest).not.toHaveProperty("production_health_listener");
    expect(manifest).not.toHaveProperty("shadow_gateway_listener");
    expect(manifest).not.toHaveProperty("shadow_health_listener");
    expect(manifest).not.toHaveProperty("gateway_certificate_spki_sha256");
  });
});
