import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { ModeratedDanceSessionView } from "../../contracts/src/dance-moderated-intake.ts";
import { ChainV2, TermsV2 } from "../../contracts/src/rewards-song-contributions-v2.ts";
import { moderatedDanceContextFixture } from "../../testing/src/moderated-dance-context-fixture.ts";
import {
  decodeModeratedDanceCaptureContext,
  decodeModeratedDanceOwnerRubric,
} from "./dance-moderated-context.ts";

const read = async (f: Awaited<ReturnType<typeof moderatedDanceContextFixture>>, enabled = false) =>
  Effect.runPromise(decodeModeratedDanceCaptureContext(f.packet, f.actor, enabled));

describe("moderated Dance original frozen-context projection", () => {
  test("practice stays rewardless under a money-admitted captured policy, with exact private disclosures", async () => {
    const f = await moderatedDanceContextFixture();
    const wire = await read(f);
    expect(wire.reward_mode).toBe("practice");
    expect(wire.objectives).toEqual([]);
    expect(wire.rewards_enabled).toBe(false);
    expect(wire.disclosure).toEqual(f.packet.disclosure);
    expect(wire.session).toEqual(
      Schema.decodeUnknownSync(ModeratedDanceSessionView)(f.packet.session),
    );
    for (const forbidden of [
      "accountId",
      "accountFenceRevision",
      "profile",
      "safety_policy",
      "disposition",
      "reference_digest",
      "segment_terms_hash",
    ])
      expect(Object.hasOwn(wire, forbidden)).toBe(false);
  });
  test("resolves original shared terms, categorical Dance policy and asset while Rewards is off", async () => {
    const f = await moderatedDanceContextFixture(true);
    const wire = await read(f);
    expect(wire.reward_mode).toBe("reward_eligible");
    expect(wire.rewards_enabled).toBe(false);
    expect(wire.objectives).toHaveLength(1);
    expect(wire.objectives[0]?.terms).toEqual(Schema.decodeUnknownSync(TermsV2)(f.resolved.terms));
    expect(wire.objectives[0]?.binding.numeric_floor_bps).toBeNull();
    expect(wire.objectives[0]?.chain_id).toBe(
      Schema.decodeUnknownSync(ChainV2)(f.resolved.chain_id),
    );
    expect((await read(f, true)).rewards_enabled).toBe(true);
    expect(wire.captured_policy.qualification_policy_hash).toBe(
      f.resolved.binding.qualification_policy_hash,
    );
  });
  test("funding added after a practice capture cannot supply a missing objective", async () => {
    const f = await moderatedDanceContextFixture();
    f.packet.objectives.push(f.resolved);
    await expect(read(f)).rejects.toBeDefined();
  });
  test.each(["terms", "policy", "rubric", "consent", "retention", "publication", "reference"])(
    "rejects original %s tampering",
    async (kind) => {
      const f = await moderatedDanceContextFixture(true);
      if (kind === "terms") f.packet.terms.capture.bodyEndMs++;
      if (kind === "policy")
        f.packet.terms.capture.policy = {
          ...f.packet.terms.capture.policy,
          rubricVersion: "foreign-rubric",
        };
      if (kind === "reference") f.packet.reference.video_render_revision = "foreign-render";
      if (kind === "rubric") f.packet.disclosure.owner_rubric_text = "Foreign rubric";
      if (kind === "consent") f.packet.disclosure.consent_text = "Foreign consent";
      if (kind === "retention") f.packet.disclosure.retention_text = "Foreign retention";
      if (kind === "publication") f.packet.disclosure.publication_text = "Foreign publication";
      await expect(read(f)).rejects.toBeDefined();
    },
  );
  test.each([
    "missing",
    "duplicate",
    "foreign_objective",
    "foreign_binding",
    "foreign_song",
    "foreign_audio",
    "foreign_document",
    "changed_terms",
  ])("rejects %s resolution without omission or downgrade", async (kind) => {
    const f = await moderatedDanceContextFixture(true),
      o = f.resolved;
    if (kind === "missing") f.packet.objectives = [];
    if (kind === "duplicate") f.packet.objectives.push(structuredClone(o));
    if (kind === "foreign_objective") o.binding.objective_id = "foreign-objective";
    if (kind === "foreign_binding") o.binding.binding_id = "foreign-binding";
    if (kind === "foreign_song") o.target.post_id = "foreign-song";
    if (kind === "foreign_audio") o.target.audio_revision++;
    if (kind === "foreign_document") o.qualification_document.producer_id = "foreign-producer";
    if (kind === "changed_terms")
      o.terms.ticket_price_ceiling_atomic = (
        BigInt(o.terms.ticket_price_ceiling_atomic) + 1n
      ).toString();
    await expect(read(f)).rejects.toBeDefined();
  });
  test.each(["accountId", "communityId", "sessionId"])(
    "rejects the wrong requesting %s",
    async (field) => {
      const f = await moderatedDanceContextFixture();
      await expect(
        Effect.runPromise(
          decodeModeratedDanceCaptureContext(
            f.packet,
            { ...f.actor, [field]: "foreign-target" },
            false,
          ),
        ),
      ).rejects.toBeDefined();
    },
  );
  test("owner gets only revision-bound captured rubric, with no dancer or benefit data", async () => {
    const f = await moderatedDanceContextFixture(true);
    const wire = await Effect.runPromise(
      decodeModeratedDanceOwnerRubric(f.ownerPacket, f.actor.communityId, f.ownerPacket.review_id),
    );
    expect(wire.rubric_text).toBe(f.packet.disclosure.owner_rubric_text);
    expect(wire.review_revision).toBe(2);
    expect(Object.keys(wire).sort()).toEqual(
      [
        "version",
        "community_id",
        "review_id",
        "review_revision",
        "session_terms_hash",
        "policy_hash",
        "rubric_version",
        "rubric_hash",
        "rubric_text",
        "attestation_version",
      ].sort(),
    );
    await expect(
      Effect.runPromise(
        decodeModeratedDanceOwnerRubric(f.ownerPacket, f.actor.communityId, "foreign-review"),
      ),
    ).rejects.toBeDefined();
    f.ownerPacket.disclosure.owner_rubric_text =
      "Rotated current rubric is not historical authority";
    await expect(
      Effect.runPromise(
        decodeModeratedDanceOwnerRubric(
          f.ownerPacket,
          f.actor.communityId,
          f.ownerPacket.review_id,
        ),
      ),
    ).rejects.toBeDefined();
  });
  test("old closed session reply still decodes unchanged and does not silently accept context fields", async () => {
    const f = await moderatedDanceContextFixture();
    const decode = Schema.decodeUnknownSync(ModeratedDanceSessionView, {
      onExcessProperty: "error",
    });
    expect(decode(f.packet.session)).toEqual(
      Schema.decodeUnknownSync(ModeratedDanceSessionView)(f.packet.session),
    );
    expect(() => decode({ ...f.packet.session, reward_mode: "practice" })).toThrow();
  });
});
