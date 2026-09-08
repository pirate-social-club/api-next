import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { MediaReferenceResolver } from "@pirate/application/media/submission-service";
import { Conflict, InternalError } from "@pirate/contracts";
import { canonicalJson } from "@pirate/domain";
import { Effect, type Layer, Schema } from "effect";

const Text = Schema.String.check(Schema.isMinLength(1));
const Positive = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const Source = Schema.Struct({
  submission_id: Text,
  operation_id: Text,
  asset_id: Text,
  audio_revision: Positive,
  analysis_revision: Positive,
  canonical_audio_sha256: Hash,
  acr_adapter_revision: Text,
  license_preset: Schema.Literals(["non-commercial", "commercial-use", "commercial-remix"]),
  commercial_remix_share_bps: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: 10_000 }),
  ),
});
const Attempt = Schema.Struct({
  attempt_id: Text,
  evidence_ref: Text,
  adapter_revision: Text,
  result: Schema.Struct({
    kind: Schema.Literal("acr"),
    value: Schema.Struct({
      outcome: Schema.Literal("retained_reference_match"),
      context: Schema.Struct({
        version: Schema.Literal("media-identification-attempt-context-v1"),
        operationId: Text,
        audioRevision: Positive,
        analysisRevision: Positive,
        canonicalAudioSha256: Hash,
        requestId: Text,
        adapterRevision: Text,
      }),
      evidence: Schema.Struct({
        version: Schema.Literal("media-identification-match-evidence-v1"),
        provider: Schema.Literal("acrcloud"),
        matchKind: Schema.Literals(["music", "custom"]),
        providerMatchId: Text,
      }),
    }),
  }),
});
const AuthorityEvidence = Schema.Struct({
  context: Attempt.fields.result.fields.value.fields.context,
  outcome: Schema.Literal("retained_reference_match"),
  evidence: Attempt.fields.result.fields.value.fields.evidence,
});

const reject = (reason: string): never => {
  throw new Conflict({
    message: "The source recording could not be verified",
    details: { reason_code: reason },
  });
};

/** Explicit candidate binding only. Provider identities stay private. */
export function makeMediaReferenceResolver(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  now: () => number = Date.now,
): MediaReferenceResolver {
  const query = (label: string, text: string, values: readonly (string | number)[]) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.execute<Readonly<Record<string, unknown>>>({
          label,
          text,
          values,
          readonly: true,
        });
      }).pipe(
        Effect.provide(runtime),
        Effect.mapError(
          () => new InternalError({ message: "Media reference evidence could not be read" }),
        ),
      ),
    );

  const matches = async (identity: {
    submissionId: string;
    operationId: string;
    audioRevision: number;
    analysisRevision: number;
    canonicalAudioSha256: string;
    adapterRevision: string;
  }) => {
    const rows = await query(
      "media-reference.matches",
      `SELECT attempt_id,evidence_ref,adapter_revision,result
      FROM media_processing_attempts
      WHERE submission_id=$1 AND operation_id=$2 AND audio_revision=$3 AND analysis_revision=$4
        AND stage IN ('acr_primary','acr_alternate') AND state='succeeded'
        AND input_kind='audio' AND input_revision=$3 AND input_hash=$5
        AND result->>'kind'='acr' AND result->'value'->>'outcome'='retained_reference_match'
      ORDER BY attempt_id LIMIT 7`,
      [
        identity.submissionId,
        identity.operationId,
        identity.audioRevision,
        identity.analysisRevision,
        identity.canonicalAudioSha256,
      ],
    );
    if (rows.rows.length > 6) return reject("reference_recording_unverified");
    return rows.rows.map((row) => {
      const attempt = Schema.decodeUnknownSync(Attempt)(row);
      const context = attempt.result.value.context;
      if (
        context.operationId !== identity.operationId ||
        context.audioRevision !== identity.audioRevision ||
        context.analysisRevision !== identity.analysisRevision ||
        context.canonicalAudioSha256 !== identity.canonicalAudioSha256 ||
        attempt.adapter_revision !== "identification-port-v1" ||
        context.adapterRevision !== identity.adapterRevision
      )
        return reject("reference_recording_unverified");
      return attempt;
    });
  };

  return {
    resolve: async (input) => {
      const state = input.submission;
      if (
        state.actorId !== input.actorUserId ||
        state.status !== "action_required" ||
        state.action?.kind !== "reference_required" ||
        state.action.referenceRequestRef !== input.referenceRequestRef ||
        !Number.isFinite(Date.parse(state.action.expiresAt)) ||
        Date.parse(state.action.expiresAt) <= now() ||
        state.audio === null ||
        state.analysis === null ||
        state.analysis.acr.decision !== "requires_reference"
      )
        return reject("reference_request_invalid");
      // Data registration defines asset_id = post_id. Resolve the published
      // post identity, never a provider ID, title or audio storage reference.
      const sourceRows = await query(
        "media-reference.source",
        `SELECT p.submission_id,p.operation_id,
        p.post_id AS asset_id,p.audio_revision::integer,p.analysis_revision::integer,
        p.canonical_audio_sha256,a.acr_adapter_revision,t.license_preset,t.commercial_remix_share_bps::integer
      FROM media_publication_projections p
      JOIN media_post_submissions s ON s.submission_id=p.submission_id AND s.operation_id=p.operation_id
      JOIN media_analysis_evidence a ON a.submission_id=p.submission_id AND a.operation_id=p.operation_id
        AND a.audio_revision=p.audio_revision AND a.analysis_revision=p.analysis_revision
        AND a.canonical_audio_sha256=p.canonical_audio_sha256
      JOIN posts post ON post.community_id=p.community_id AND post.post_id=p.post_id
      JOIN communities c ON c.community_id=p.community_id
      JOIN media_submission_terms t ON t.submission_id=p.submission_id AND t.creation_revision=s.current_terms_revision
      WHERE p.post_id=$1 AND s.status='published' AND post.status='published' AND c.status='active'
        AND (post.visibility='public' OR (post.visibility='members_only' AND EXISTS (
          SELECT 1 FROM community_memberships m WHERE m.community_id=p.community_id AND m.user_id=$2 AND m.status='member')))
        AND (post.content_rating IS NULL OR can_account_view_content_rating_v1($2,post.content_rating))
      LIMIT 2`,
        [input.upstreamAssetId, input.actorUserId],
      );
      if (sourceRows.rows.length !== 1) return reject("reference_source_unavailable");
      let source: Schema.Schema.Type<typeof Source>;
      try {
        source = Schema.decodeUnknownSync(Source)(sourceRows.rows[0]);
      } catch {
        return reject("reference_source_terms_unavailable");
      }
      if (
        source.submission_id === state.submissionId ||
        source.asset_id !== input.upstreamAssetId ||
        source.license_preset !== "commercial-remix"
      ) {
        return reject("reference_source_terms_unavailable");
      }
      let currentMatches: Awaited<ReturnType<typeof matches>>;
      let sourceEvidence: Schema.Schema.Type<typeof AuthorityEvidence>;
      try {
        currentMatches = await matches({
          submissionId: state.submissionId,
          operationId: state.operationId,
          audioRevision: state.audio.audioRevision,
          analysisRevision: state.analysis.analysisRevision,
          canonicalAudioSha256: state.audio.canonicalSha256,
          adapterRevision: state.analysis.acr.adapterRevision,
        });
        const authorityRows = await query(
          "media-reference.source-recording-authority",
          `SELECT identification_evidence
             FROM song_source_recording_registrations
            WHERE asset_id=$1 AND submission_id=$2 AND operation_id=$3 AND state='ready'
              AND audio_revision=$4 AND analysis_revision=$5 AND canonical_audio_sha256=$6
              AND license_preset='commercial-remix' LIMIT 2`,
          [
            source.asset_id,
            source.submission_id,
            source.operation_id,
            source.audio_revision,
            source.analysis_revision,
            source.canonical_audio_sha256,
          ],
        );
        if (authorityRows.rows.length !== 1) return reject("reference_recording_unverified");
        sourceEvidence = Schema.decodeUnknownSync(AuthorityEvidence)(
          authorityRows.rows[0]?.identification_evidence,
        );
      } catch (error) {
        if (error instanceof InternalError || error instanceof Conflict) throw error;
        return reject("reference_recording_unverified");
      }
      const identity = (attempt: Schema.Schema.Type<typeof Attempt>) =>
        canonicalJson({
          provider: attempt.result.value.evidence.provider,
          matchKind: attempt.result.value.evidence.matchKind,
          providerMatchId: attempt.result.value.evidence.providerMatchId,
        });
      const currentIds = new Set(currentMatches.map(identity));
      const sourceIdentity = canonicalJson({
        provider: sourceEvidence.evidence.provider,
        matchKind: sourceEvidence.evidence.matchKind,
        providerMatchId: sourceEvidence.evidence.providerMatchId,
      });
      if (currentIds.size !== 1 || sourceIdentity !== ([...currentIds][0] ?? "")) {
        return reject("reference_recording_unverified");
      }
      const upstreamShare =
        source.license_preset === "commercial-remix" ? source.commercial_remix_share_bps : null;
      const proof = canonicalJson({
        version: "song-reference-binding-v1",
        source,
        submissionId: state.submissionId,
        referenceRequestRef: input.referenceRequestRef,
        audioRevision: state.audio.audioRevision,
        analysisRevision: state.analysis.analysisRevision,
        canonicalAudioSha256: state.audio.canonicalSha256,
        currentEvidence: currentMatches.map((row) => row.evidence_ref),
        sourceEvidence: sourceEvidence.context.requestId,
      });
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof));
      return {
        assetId: source.asset_id,
        evidenceAudioRevision: state.audio.audioRevision,
        evidenceAnalysisRevision: state.analysis.analysisRevision,
        evidenceAudioSha256: state.audio.canonicalSha256,
        evidenceRef: `song-reference-v1-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
        upstreamCommercialRevShareBps: upstreamShare,
        inheritedLicensePreset: source.license_preset,
        inheritedCommercialRevShareBps: upstreamShare,
      };
    },
  };
}
