import { Effect, type Layer, Schema } from "effect";
import type { ControlPlaneDb, ControlPlaneError } from "../../application/src/ports.ts";
import { consistentCommittedTerms } from "../../application/src/rewards/song-megapot-contributions.ts";
import { canonicalBodyHash } from "../../application/src/use-cases/content/common.ts";
import { HashV2, IdV2 } from "../../contracts/src/rewards-song-contributions-v2.ts";
import {
  SharedSongMegapotParticipationV2,
  SharedSongParticipantRuleV2,
} from "../../contracts/src/shared-song-megapot-participation.ts";
import { withRetainedControlPlaneCommandTransaction } from "./control-plane-command-transaction.ts";

// Full policy documents remain inside the server. Their original hashes are
// checked before producing the strictly allowlisted participant disclosures.
const PolicyDocument = Schema.Struct({
  binding_id: IdV2,
  policy_id: IdV2,
  activity: Schema.Literals(["study", "karaoke", "dance"]),
  kind: Schema.Literals([
    "study_session_first_pass_v2",
    "karaoke_qualification_v1",
    "karaoke_qualification_v2",
    "dance_owner_verdict_v1",
  ]),
  policy_hash: HashV2,
  document: Schema.Record(Schema.String, Schema.Unknown),
  currently_available: Schema.Boolean,
});
const Packet = Schema.Struct({
  projection: Schema.Struct({
    ...SharedSongMegapotParticipationV2.fields,
    qualification_rules: Schema.Array(Schema.Unknown),
  }),
  qualification_documents: Schema.Array(PolicyDocument).check(
    Schema.isMinLength(3),
    Schema.isMaxLength(3),
  ),
});
const decodePacket = Schema.decodeUnknownSync(Schema.NullOr(Packet), {
  onExcessProperty: "error",
});

export const decodeSharedSongParticipation = Effect.fn("SharedSongParticipation.decode")(function* (
  value: unknown,
  community: string,
  post: string,
) {
  const packet = yield* Effect.sync(() => decodePacket(value));
  if (packet === null) return null;
  const { projection } = packet;
  if (
    projection.target.community_id !== community ||
    projection.target.post_id !== post ||
    !(yield* consistentCommittedTerms(projection.terms, projection.target))
  )
    throw new Error("Shared pot participant provenance unavailable");
  const rules: SharedSongParticipantRuleV2[] = [];
  for (const binding of projection.terms.qualification_bindings) {
    const matches = packet.qualification_documents.filter(
      (document) =>
        document.binding_id === binding.binding_id &&
        document.policy_id === binding.qualification_policy_id &&
        document.activity === binding.activity &&
        document.policy_hash === binding.qualification_policy_hash,
    );
    const document = matches[0];
    if (matches.length !== 1 || document === undefined)
      throw new Error("Shared pot qualification unavailable");
    const { policy_hash: embeddedHash, ...body } = document.document;
    const hash = yield* canonicalBodyHash([
      "pirate.shared-song-qualification-policy.v1",
      document.policy_id,
      document.activity,
      document.kind,
      body,
    ]);
    if (
      hash !== binding.qualification_policy_hash ||
      (binding.activity === "dance" && embeddedHash !== hash)
    )
      throw new Error("Shared pot qualification hash unavailable");
    const identity = {
      kind: document.kind,
      qualification_policy_version_id: document.policy_id,
    };
    const rule =
      document.kind === "study_session_first_pass_v2"
        ? { ...identity, required_correct_bps: body.required_correct_bps }
        : document.kind === "dance_owner_verdict_v1"
          ? { ...identity, grading_mode: body.grading_mode, verdict: body.verdict }
          : {
              ...identity,
              minimum_scored_line_count: body.minimum_scored_line_count,
              minimum_coverage_bps: body.minimum_coverage_bps,
              minimum_final_score_bps: body.minimum_final_score_bps,
              ...(document.kind === "karaoke_qualification_v2"
                ? { eligible_playback_kinds: body.eligible_playback_kinds }
                : {}),
            };
    rules.push(
      Schema.decodeUnknownSync(SharedSongParticipantRuleV2, { onExcessProperty: "error" })({
        binding,
        rule,
        currently_available: document.currently_available,
      }),
    );
  }
  return Schema.decodeUnknownSync(SharedSongMegapotParticipationV2, {
    onExcessProperty: "error",
  })({ ...projection, qualification_rules: rules });
});

/** One STABLE read function uses the calling statement's snapshot. The
 * transaction wrapper supplies the maintained connection and deadline bounds. */
export function makeSharedSongMegapotParticipationReader(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>,
) {
  return async (account: string, community: string, post: string) => {
    return Effect.runPromise(
      withRetainedControlPlaneCommandTransaction((tx) =>
        Effect.gen(function* () {
          const result = yield* tx.execute<{ packet: unknown }>({
            label: "shared-song.participation.read",
            text: "SELECT read_shared_song_megapot_participation_v2($1,$2,$3) AS packet",
            values: [account, community, post],
            readonly: true,
          });
          if (
            result.rows.length !== 1 ||
            result.rows[0] === undefined ||
            !Object.hasOwn(result.rows[0], "packet")
          )
            throw new Error("Shared pot participation unavailable");
          return yield* decodeSharedSongParticipation(result.rows[0].packet, community, post);
        }),
      ).pipe(Effect.provide(runtime)),
    );
  };
}
