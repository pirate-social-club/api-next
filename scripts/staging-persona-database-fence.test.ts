import { expect, test } from "bun:test";
import { Schema } from "effect";
import { FenceEvidence } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  assertFenceEvidenceShape,
  canonicalFenceTime,
  emitDatabaseFenceProof,
  emitFenceEvidence,
  encodeFenceEvidenceArtifact,
  runtimeIdentityFingerprint,
} from "./staging-persona-database-fence";

const runtime = (name: string) => ({
  identityFingerprint: runtimeIdentityFingerprint(name),
  activeSessions: 0,
  databaseCreateDenied: true,
  elevatedMembershipsDenied: true,
  inheritedPrivilegesDenied: true,
  publicPrivilegesDenied: true,
  setRoleDenied: true,
  ownershipDenied: true,
  schemaAccessDenied: true,
  tableAccessDenied: true,
  sequenceAccessDenied: true,
  securityDefinerDenied: true,
  writeProbeDenied: true,
  reconnectDenied: true,
});

const observation = {
  otherSessions: 0,
  preparedTransactions: 0,
  activeTransactions: 0,
  runtimeIdentities: [runtime("runtime-http"), runtime("runtime-jobs")],
} as const;

test("emits positive proof only after every runtime identity is drained and denied", () => {
  expect(emitDatabaseFenceProof(observation)).toMatchObject({
    databaseWrites: true,
    reconnectDenied: true,
    runtimeSessions: 0,
    runtimeIdentityFingerprints: [
      runtimeIdentityFingerprint("runtime-http"),
      runtimeIdentityFingerprint("runtime-jobs"),
    ],
  });
  for (const change of [
    { otherSessions: 1 },
    { preparedTransactions: 1 },
    { activeTransactions: 1 },
    {
      runtimeIdentities: [
        runtime("runtime-http"),
        { ...runtime("runtime-jobs"), reconnectDenied: false },
      ],
    },
    {
      runtimeIdentities: [
        { ...runtime("runtime-http"), inheritedPrivilegesDenied: false },
        runtime("runtime-jobs"),
      ],
    },
  ]) {
    expect(() => emitDatabaseFenceProof({ ...observation, ...change })).toThrow();
  }
});

test("composes exact FenceEvidence and preserves the residual disposition binding", () => {
  const evidence = emitFenceEvidence({
    verifiedAtMs: 1_757_200_000_123,
    ingress: true,
    producers: true,
    residualDispositionId: "a".repeat(64),
    database: observation,
  });
  expect(evidence).toMatchObject({
    verifiedAt: "2025-09-06T23:06:40.123Z",
    ingress: true,
    producers: true,
    databaseWrites: true,
    reconnectDenied: true,
    runtimeSessions: 0,
    residualDispositionId: "a".repeat(64),
  });
  assertFenceEvidenceShape(evidence);
  expect(() =>
    emitFenceEvidence({
      verifiedAtMs: 1_757_200_000_123,
      ingress: false,
      producers: true,
      residualDispositionId: "a".repeat(64),
      database: observation,
    }),
  ).toThrow("fence_components_unproven");
});

test("artifact bytes are scope-bound and hashable without exposing role names", () => {
  const evidence = emitFenceEvidence({
    verifiedAtMs: 1_757_200_000_123,
    ingress: true,
    producers: true,
    residualDispositionId: "b".repeat(64),
    database: observation,
  });
  const artifact = encodeFenceEvidenceArtifact(
    {
      target: { objectId: "object", bucket: "bucket" },
      phase: "post-fence",
      epoch: "c".repeat(64),
    },
    evidence,
  );
  expect(artifact.id).toMatch(/^[a-f0-9]{64}$/);
  expect(artifact.bytes).not.toContain("runtime-http");
  expect(artifact.bytes).not.toContain("runtimeIdentityFingerprints");
  expect(() =>
    Schema.decodeUnknownSync(FenceEvidence, { onExcessProperty: "error" })(
      JSON.parse(artifact.bytes).data,
    ),
  ).not.toThrow();
  expect(Object.keys(JSON.parse(artifact.bytes).data).sort()).toEqual([
    "databaseWrites",
    "ingress",
    "producers",
    "reconnectDenied",
    "residualDispositionId",
    "runtimeSessions",
    "verifiedAt",
  ]);
});

test("canonicalizes only exact UTC millisecond timestamps", () => {
  expect(canonicalFenceTime(0)).toBe("1970-01-01T00:00:00.000Z");
  expect(() => canonicalFenceTime(-1)).toThrow("time_unproven");
});
