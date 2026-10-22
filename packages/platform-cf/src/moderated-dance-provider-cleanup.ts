import { Schema } from "effect";
import type { makeSongVideoCloudConvertTransport } from "./song-video-cloudconvert-transport.ts";

const Id = Schema.NonEmptyString;
const Claim = Schema.Struct({
  effectId: Id,
  provider: Schema.Literals(["cloudconvert", "qencode"]),
  tag: Schema.NullOr(Id),
  jobId: Schema.NullOr(Id),
  token: Id,
});
type Call = (label: string, text: string, values: readonly unknown[]) => Promise<unknown>;
type Provider = Pick<
  ReturnType<typeof makeSongVideoCloudConvertTransport>,
  "inspect" | "findByTag" | "remove"
>;
type Proof = Readonly<{
  outcome: "deleted" | "observed_absent" | "unknown";
  jobId: string | null;
  tag: string | null;
  reason?: "route_unavailable" | "identity_unresolved" | "identity_mismatch" | "provider_unknown";
}>;

/** A durable original cleanup intent owns one exact provider job. Deletion is
 * idempotent for that identity; every retry first observes it. Nothing here
 * creates, starts or replaces a processing job, or treats a tag miss as absence. */
export function makeModeratedDanceProviderCleanup(
  input: Readonly<{
    call: Call;
    provider?: Provider | undefined;
    randomId?: (() => string) | undefined;
  }>,
) {
  return {
    async run(): Promise<void> {
      const raw = await input.call(
        "dance.provider-cleanup.claim",
        "SELECT claim_moderated_dance_provider_cleanup_v1($1) AS packet",
        [(input.randomId ?? (() => crypto.randomUUID()))()],
      );
      if (raw === null) return;
      const claim = Schema.decodeUnknownSync(Claim, { onExcessProperty: "error" })(raw);
      const finish = (proof: Proof) =>
        input.call(
          "dance.provider-cleanup.finish",
          "SELECT finish_moderated_dance_provider_cleanup_v1($1,$2,$3::jsonb) AS packet",
          [claim.effectId, claim.token, JSON.stringify(proof)],
        );
      const provider = input.provider;
      if (claim.provider !== "cloudconvert" || provider === undefined) {
        await finish({
          outcome: "unknown",
          jobId: claim.jobId,
          tag: claim.tag,
          reason: "route_unavailable",
        });
        return;
      }
      if (claim.tag === null) {
        await finish({
          outcome: "unknown",
          jobId: claim.jobId,
          tag: null,
          reason: "identity_unresolved",
        });
        return;
      }
      let jobId = claim.jobId;
      if (jobId === null) {
        let found: Awaited<ReturnType<Provider["findByTag"]>>;
        try {
          found = await provider.findByTag(claim.tag);
        } catch {
          await finish({ outcome: "unknown", jobId, tag: claim.tag, reason: "provider_unknown" });
          return;
        }
        if (found === null || found.tag !== claim.tag) {
          await finish({
            outcome: "unknown",
            jobId,
            tag: claim.tag,
            reason: found === null ? "identity_unresolved" : "identity_mismatch",
          });
          return;
        }
        jobId = found.id;
        // An uncertain identity COMMIT must escape before DELETE. Recovery uses
        // the same original effect, never another create or inferred new job.
        await input.call(
          "dance.provider-cleanup.identify",
          "SELECT identify_moderated_dance_provider_cleanup_v1($1,$2,$3,$4) AS packet",
          [claim.effectId, claim.token, jobId, claim.tag],
        );
      }
      let proof: Proof;
      try {
        const observed = await provider.inspect(jobId);
        if (observed === null) proof = { outcome: "observed_absent", jobId, tag: claim.tag };
        else if (observed.id !== jobId || observed.tag !== claim.tag)
          proof = { outcome: "unknown", jobId, tag: claim.tag, reason: "identity_mismatch" };
        else {
          await provider.remove(jobId);
          proof = { outcome: "deleted", jobId, tag: claim.tag };
        }
      } catch {
        proof = { outcome: "unknown", jobId, tag: claim.tag, reason: "provider_unknown" };
      }
      // Persistence is outside the provider catch. A lost result COMMIT cannot
      // repeat DELETE in this invocation; a later claim observes the same job.
      await finish(proof);
    },
  };
}
