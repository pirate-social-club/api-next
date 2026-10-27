import { expect, test } from "bun:test";
import type { Client } from "pg";
import { SHARED_SONG_SUCCESSOR_RULE } from "../packages/platform-cf/src/shared-song-successor-schedule.ts";
import { sharedSongParticipantFixture } from "../packages/testing/src/shared-song-participant-fixture.ts";
import {
  applySharedSongSuccessorTemplate,
  buildSharedSongSuccessorTemplate,
} from "./admit-shared-song-successor.ts";
import {
  buildSharedSongProvisioning,
  SHARED_SONG_ATTESTATION,
} from "./provision-shared-song-pot.ts";

async function fixture() {
  const packet = await sharedSongParticipantFixture(new Date());
  const dance = packet.projection.terms.qualification_bindings.find((b) => b.activity === "dance");
  if (!dance) throw Error("Dance binding required");
  const initial = await buildSharedSongProvisioning({
    communityId: "community",
    funderAccountId: "funder",
    slotIds: ["slot"],
    attestationId: SHARED_SONG_ATTESTATION,
    chainId: 84532,
    documents: packet.qualification_documents.map((d) => ({
      policyId: d.policy_id,
      activity: d.activity,
      kind: d.kind,
      document: d.document,
    })),
    danceAdmission: { admissionVersion: dance.admission_id, admissionHash: dance.admission_hash },
    validFrom: "2026-10-27T00:00:00.000Z",
    validUntil: "2026-10-31T18:00:00.000Z",
  });
  const { accepted_by: _role, accepted_receipt_hash: _receipt, ...source } = initial.template;
  return {
    source,
    admissionHash: initial.admission.admission_hash,
    admissionEffectiveAt: initial.admission.effective_at,
    admissionValidUntil: source.valid_until,
    profileAccepted: true,
    profileValidUntil: source.valid_until,
    capacity: initial.profile.capacity_profile,
    chainId: 84532,
    environment: "staging",
    jackpotAddress: SHARED_SONG_SUCCESSOR_RULE.jackpotAddress,
    jackpotCodeHash: SHARED_SONG_SUCCESSOR_RULE.jackpotCodeHash,
  };
}

test("successor preview is deterministic and preserves the accepted qualification/capacity authority", async () => {
  const raw = await fixture(),
    before = structuredClone(raw),
    plan = await buildSharedSongSuccessorTemplate(raw);
  expect(await buildSharedSongSuccessorTemplate(raw)).toEqual(plan);
  expect(raw).toEqual(before);
  expect(plan.template.profile_id).toBe(raw.source.profile_id);
  expect(plan.template.qualification_templates).toEqual(raw.source.qualification_templates);
  for (const key of [
    "maximumContextAttempts",
    "contextWorkPerAttempt",
    "maximumContextWorkGlobal",
    "maximumContextWorkPerAccount",
    "contextLeaseMs",
    "finalityPolicyId",
    "feePolicyId",
    "inboundRequiredGasWei",
    "refundEnvelopeMinimumWei",
  ])
    expect(plan.template.operational_profile[key]).toEqual(
      raw.source.operational_profile[key as keyof typeof raw.source.operational_profile],
    );
  expect(plan.template.valid_until).toBe(raw.source.valid_until);
  expect(plan.template.template_hash).not.toBe(plan.predecessorHash);
  await expect(
    buildSharedSongSuccessorTemplate({ ...raw, environment: "production" }),
  ).rejects.toThrow();
  await expect(
    buildSharedSongSuccessorTemplate({ ...raw, admissionEffectiveAt: "2026-10-27T00:01:00.000Z" }),
  ).rejects.toThrow();
  await expect(
    buildSharedSongSuccessorTemplate({ ...raw, admissionValidUntil: "2026-10-31T17:00:00.000Z" }),
  ).rejects.toThrow();
  await expect(
    buildSharedSongSuccessorTemplate({
      ...raw,
      source: { ...raw.source, template_hash: "f".repeat(64) },
    }),
  ).rejects.toThrow();
});

test("a lost template COMMIT remains unknown and never repeats either mutation", async () => {
  const raw = await fixture(),
    plan = await buildSharedSongSuccessorTemplate(raw),
    trace: string[] = [];
  const lost = new Error("synthetic lost commit response");
  const db = {
    query: async (sql: string) => {
      trace.push(sql);
      if (sql.startsWith("SELECT paused")) return { rows: [{ paused: true, revision: "22" }] };
      if (sql.startsWith("SELECT (run_id")) return { rows: [{ live: false }] };
      if (sql.startsWith("SELECT jsonb_build_object")) return { rows: [{ packet: raw }] };
      if (sql === "COMMIT") throw lost;
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pick<Client, "query">;
  await expect(
    applySharedSongSuccessorTemplate(db, {
      communityId: "community",
      expectedAdmissionHash: plan.expectedAdmissionHash,
      expectedTemplateHash: plan.template.template_hash,
      expectedBrakeRevision: 22,
    }),
  ).rejects.toMatchObject({
    message:
      "successor template COMMIT outcome unknown; inspect admission before any further action",
    cause: lost,
  });
  expect(trace.filter((s) => s.startsWith("INSERT INTO"))).toHaveLength(1);
  expect(
    trace.filter((s) => s.startsWith("UPDATE reward_shared_song_template_admissions")),
  ).toHaveLength(1);
  expect(trace.filter((s) => s === "COMMIT")).toHaveLength(1);
  expect(trace.at(-1)).toBe("ROLLBACK");
});
