import { describe, expect, test } from "bun:test";
import { ControlPlaneDb, type ControlPlaneStatement } from "@pirate/application";
import { Effect, Layer } from "effect";
import {
  createMediaSubmissionState,
  type MediaSubmissionState,
  type TrustedSongAnalysis,
} from "../../domain/src/media-submission.ts";
import { makeMediaReferenceResolver } from "./media-reference-resolver.ts";

const now = Date.parse("2026-09-08T00:00:00Z");
const currentHash = "a".repeat(64);
const sourceHash = "b".repeat(64);
const analysis: TrustedSongAnalysis = {
  version: "song-trusted-analysis-v1",
  operationId: "operation-current",
  audioRevision: 2,
  analysisRevision: 3,
  canonicalAudioSha256: currentHash,
  finalizedAudioRef: "current-audio",
  probeEvidenceRef: "probe-current",
  embeddedMetadata: {
    evidenceRef: "metadata",
    adapterRevision: "metadata-v1",
    trackTitle: null,
    cover: { status: "absent", reasonCode: "not_embedded" },
  },
  lyricsAnalysis: { status: "not_applicable" },
  acr: {
    decision: "requires_reference",
    evidenceRef: "acr-current",
    policyRevision: "acr-decision-v1",
    adapterRevision: "acr-v1",
  },
  mediaSafety: "allow",
  lyricsSafety: "not_applicable",
  boundReference: null,
};
const submission: MediaSubmissionState = {
  ...createMediaSubmissionState({
    event: "submission_reserved",
    actorId: "account",
    personaId: "persona",
    expectedCreationRevision: 0,
    submissionId: "current",
    operationId: "operation-current",
    communityId: "community",
    title: "Derivative",
    songType: "remix",
    reservationId: "reservation",
  }),
  status: "action_required",
  phase: null,
  audioRevision: 2,
  analysisRevision: 3,
  creationRevision: 7,
  audio: {
    audioRevision: 2,
    immutableRef: "current-audio",
    canonicalSha256: currentHash,
    contentType: "audio/mpeg",
    sizeBytes: 10,
  },
  analysis,
  action: {
    kind: "reference_required",
    referenceRequestRef: "request",
    heldRevision: 7,
    expiresAt: "2026-09-09T00:00:00Z",
  },
};
const source = {
  submission_id: "source",
  operation_id: "operation-source",
  asset_id: "source-post",
  audio_revision: 1,
  analysis_revision: 4,
  canonical_audio_sha256: sourceHash,
  acr_adapter_revision: "acr-v1",
  license_preset: "commercial-remix",
  commercial_remix_share_bps: 1234,
};
function attempt(which: "source" | "current", match = "recording") {
  return {
    attempt_id: `attempt-${which}`,
    evidence_ref: `retained-${which}`,
    adapter_revision: "identification-port-v1",
    result: {
      kind: "acr",
      value: {
        outcome: "retained_reference_match",
        context: {
          version: "media-identification-attempt-context-v1",
          operationId: `operation-${which}`,
          audioRevision: which === "source" ? 1 : 2,
          analysisRevision: which === "source" ? 4 : 3,
          canonicalAudioSha256: which === "source" ? sourceHash : currentHash,
          requestId: `request-${which}`,
          adapterRevision: "acr-v1",
        },
        evidence: {
          version: "media-identification-match-evidence-v1",
          provider: "acrcloud",
          matchKind: "custom",
          providerMatchId: match,
        },
      },
    },
  };
}
const input = {
  actorUserId: "account",
  submission,
  referenceRequestRef: "request",
  upstreamAssetId: source.asset_id,
};
function fixture(
  options: {
    sources?: readonly object[];
    current?: readonly object[];
    upstream?: readonly object[];
  } = {},
) {
  const statements: ControlPlaneStatement[] = [];
  const execute: ControlPlaneDb["Service"]["execute"] = (statement) => {
    statements.push(statement);
    const rows =
      statement.label === "media-reference.source"
        ? (options.sources ?? [source])
        : statement.label === "media-reference.source-recording-authority"
          ? (options.upstream ?? [
              { identification_evidence: attempt("source").result.value },
            ])
        : statement.values?.[0] === "current"
          ? (options.current ?? [attempt("current")])
          : [];
    return Effect.succeed({ rows: rows as readonly never[], rowCount: rows.length });
  };
  return {
    statements,
    resolver: makeMediaReferenceResolver(
      Layer.succeed(ControlPlaneDb, { execute, withTransaction: (use) => use({ execute }) }),
      () => now,
    ),
  };
}

describe("production song reference resolver", () => {
  test("verifies both recordings and inherits exact terms while fencing the current audio", async () => {
    const f = fixture();
    const bound = await f.resolver.resolve(input);
    expect(bound).toMatchObject({
      assetId: source.asset_id,
      evidenceAudioRevision: 2,
      evidenceAnalysisRevision: 3,
      evidenceAudioSha256: currentHash,
      upstreamCommercialRevShareBps: 1234,
      inheritedLicensePreset: "commercial-remix",
      inheritedCommercialRevShareBps: 1234,
    });
    expect(bound?.evidenceRef).toMatch(/^song-reference-v1-[0-9a-f]{64}$/u);
    expect(await f.resolver.resolve(input)).toEqual(bound);
    expect(f.statements.every((s) => s.readonly)).toBe(true);
    expect(f.statements[0]?.values).toEqual([source.asset_id, "account"]);
    expect(f.statements[0]?.text).toContain("can_account_view_content_rating_v1");
    expect(f.statements[0]?.text).toContain("m.status='member'");
  });
  test("preserves explicit zero and refuses a non-remix source", async () => {
    expect(
      await fixture({ sources: [{ ...source, commercial_remix_share_bps: 0 }] }).resolver.resolve(
        input,
      ),
    ).toMatchObject({ upstreamCommercialRevShareBps: 0 });
    await expect(
      fixture({
        sources: [{ ...source, license_preset: "non-commercial", commercial_remix_share_bps: 0 }],
      }).resolver.resolve(input),
    ).rejects.toMatchObject({ details: { reason_code: "reference_source_terms_unavailable" } });
  });
  test("rejects absent, hidden, ambiguous or off-platform sources without disclosing identity", async () => {
    for (const sources of [[], [source, source]])
      await expect(fixture({ sources }).resolver.resolve(input)).rejects.toMatchObject({
        details: { reason_code: "reference_source_unavailable" },
      });
  });
  test("rejects unrelated, missing and contradictory recording evidence", async () => {
    for (const upstream of [
      [],
      [{ identification_evidence: attempt("source", "different").result.value }],
      [
        { identification_evidence: attempt("source").result.value },
        { identification_evidence: attempt("source", "different").result.value },
      ],
    ])
      await expect(fixture({ upstream }).resolver.resolve(input)).rejects.toMatchObject({
        details: { reason_code: "reference_recording_unverified" },
      });
  });
  test("rejects stale audio hash and wrong operation evidence", async () => {
    for (const change of [
      { canonicalAudioSha256: "c".repeat(64) },
      { operationId: "foreign" },
      { analysisRevision: 2 },
      { adapterRevision: "foreign-adapter" },
    ]) {
      const bad = attempt("current");
      Object.assign(bad.result.value.context, change);
      await expect(fixture({ current: [bad] }).resolver.resolve(input)).rejects.toMatchObject({
        details: { reason_code: "reference_recording_unverified" },
      });
    }
  });
  test("refuses expired or foreign requests before any database access", async () => {
    const f = fixture();
    for (const update of [
      { actorUserId: "other" },
      { referenceRequestRef: "other" },
      {
        submission: {
          ...submission,
          action: {
            kind: "reference_required" as const,
            referenceRequestRef: "request",
            heldRevision: 7,
            expiresAt: "2026-09-07T00:00:00Z",
          },
        },
      },
    ])
      await expect(f.resolver.resolve({ ...input, ...update })).rejects.toMatchObject({
        details: { reason_code: "reference_request_invalid" },
      });
    expect(f.statements).toHaveLength(0);
  });
  test("does not default missing or malformed source terms", async () => {
    for (const commercial_remix_share_bps of [-1, 10001, 1.5, undefined])
      await expect(
        fixture({ sources: [{ ...source, commercial_remix_share_bps }] }).resolver.resolve(input),
      ).rejects.toMatchObject({ details: { reason_code: "reference_source_terms_unavailable" } });
  });
});
