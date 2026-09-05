import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { parseContinuityArguments } from "../hns-continuity.ts";
import { buildContinuityCandidate } from "./candidate.mjs";
import { promoteContinuity } from "./promotion.mjs";

async function fixture() {
  const retained = JSON.parse(
    gunzipSync(
      await Bun.file(
        new URL("./fixtures/continuity-observation.json.gz", import.meta.url),
      ).arrayBuffer(),
    ).toString(),
  );
  return {
    state: { ...retained.state, successor_health_generation: 0 },
    chain: retained.chain,
    primary: retained["zone-primary"],
    secondary: retained["zone-secondary"],
    verification: retained["authority-verification"],
    sourceCommit: "7d3c8aae24240faf7dde3e35fb359f96caa934b7",
  };
}

test("reconstructs a deterministic complete successor from the continuity archive", async () => {
  const input = await fixture();
  const first = await buildContinuityCandidate(input);
  const second = await buildContinuityCandidate(structuredClone(input));
  expect(second.candidate_bytes).toEqual(first.candidate_bytes);
  expect(first.candidate.generations).toEqual({
    dns_activation_generation: 13,
    app_host_activation_generation: 19,
    health_generation: 1,
  });
  expect(first.candidate.artifacts).toHaveLength(5);
});

test("uses the observed successor health generation instead of assuming zero", async () => {
  const input = await fixture();
  input.state.successor_health_generation = 2;
  expect((await buildContinuityCandidate(input)).candidate.generations.health_generation).toBe(3);
  delete input.state.successor_health_generation;
  await expect(buildContinuityCandidate(input)).rejects.toThrow(
    "Successor health generation is missing",
  );
});

test("rejects divergent authorities, modified AXFR bytes, and a certificate mismatch", async () => {
  const divergent = await fixture();
  divergent.secondary.canonical_zone_bytes_hex += "00";
  await expect(buildContinuityCandidate(divergent)).rejects.toThrow("AXFR bytes disagree");
  const modified = await fixture();
  modified.primary.views[0].response_sequence_hex = "00";
  await expect(buildContinuityCandidate(modified)).rejects.toThrow();
  const certificate = await fixture();
  certificate.verification.certificate_spki = "0".repeat(64);
  await expect(buildContinuityCandidate(certificate)).rejects.toThrow("Gateway identity changed");
});

test("rejects an old observation and insufficient certificate serving validity", async () => {
  const stale = await fixture();
  stale.chain.observed_at = "2026-09-04T00:00:00.000Z";
  await expect(buildContinuityCandidate(stale)).rejects.toThrow("Observation window exceeds");
  const expires = await fixture();
  expires.verification.certificate_expires = expires.state.database_time;
  await expect(buildContinuityCandidate(expires)).rejects.toThrow("Gateway proof does not cover");
});

test("refuses changed candidate bytes before opening a database transaction", async () => {
  const input = await fixture();
  const prepared = await buildContinuityCandidate(input);
  let queries = 0;
  await expect(
    promoteContinuity({
      client: {
        query: async () => {
          queries++;
          throw new Error("Database must not be touched");
        },
      },
      state: input.state,
      prepared,
      reviewedCandidateBytes: new Uint8Array([...prepared.candidate_bytes, 10]),
      expectedCandidateSha256: prepared.candidate_sha256,
      mode: "--commit",
    }),
  ).rejects.toThrow("Reviewed candidate bytes changed");
  expect(queries).toBe(0);
});

test("requires an explicit valid mode, directory, root and digest without ambiguous flags", () => {
  expect(() => parseContinuityArguments([])).toThrow();
  expect(() => parseContinuityArguments(["commit", "--directory", "/tmp/ceremony"])).toThrow();
  expect(() =>
    parseContinuityArguments([
      "observe",
      "--directory",
      "/tmp/ceremony",
      "--root",
      "--unsafe",
      "--ssh-host",
      "operator@host",
    ]),
  ).toThrow();
  expect(() =>
    parseContinuityArguments([
      "dry-run",
      "--directory",
      "/tmp/ceremony",
      "--confirm-sha256",
      "a".repeat(64),
      "--directory",
      "/tmp/other",
    ]),
  ).toThrow();
  expect(
    parseContinuityArguments([
      "dry-run",
      "--directory",
      "/tmp/ceremony",
      "--confirm-sha256",
      "a".repeat(64),
    ]).mode,
  ).toBe("dry-run");
});
