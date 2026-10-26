/**
 * Provisions what a shared-song (Study, singing and Dance) pool needs before any funder
 * can fund it under the Safe pool pilot on staging: one funding profile, one reward
 * template with its three qualification bindings, the template's admission in one
 * community, and the funding work envelopes for the funder and each named song slot.
 * Without these rows bind_initial_shared_song_pot_v2 has nothing to load, and no leg
 * can admit Dance. The context producer then writes the schedule witness and leg
 * snapshot itself.
 *
 * Every qualification hash is computed the way the context producer recomputes it, from
 * the activity's current policy document, and the Dance binding takes its admission
 * from the community's money-admitted Dance review policy. Megapot initializes only the
 * current drawing, so each pot plans one drawing.
 *
 * Without --apply it only reads and prints the rows. With --apply it inserts them in one
 * transaction, refusing if any of them already exists. It never signs or sends, and it
 * refuses outside staging and development.
 *
 *   API_NEXT_ENV=staging CONTROL_PLANE_POSTGRES_ADMIN_URL=... \
 *     bun scripts/provision-shared-song-pot.ts --community <id> --funder <account-id> \
 *       --slot <slot-id> [--slot <slot-id> ...] [--apply]
 */
import { parseArgs } from "node:util";
import { Effect, Schema } from "effect";
import { Client } from "pg";
import { digestFundingPreimageV2 } from "../packages/application/src/rewards/song-megapot-contributions.ts";
import { canonicalBodyHash } from "../packages/application/src/use-cases/content/common.ts";
import * as C from "../packages/contracts/src/rewards-song-contributions-v2.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

export const SHARED_SONG_ATTESTATION = "megapot-base-sepolia-v2-safe-pilot";
const PROFILE_ID = "shared-song-safe-pilot-staging-v1";
const TEMPLATE_ID = "shared-song-safe-pilot-staging-template-v1";
const DISCLOSURE = "shared-song-safe-pilot-staging-disclosure-v1";
const ACCEPTED_BY = "workspace_owner";
// One Megapot ticket on Base Sepolia costs 0.01 test USDC.
const TICKET_ATOMIC = "10000";
export const ENTRY_CUTOFF_SECONDS = 120;
const PURCHASE_LEAD_SECONDS = 900;
const KINDS = {
  study: "study_session_first_pass_v2",
  karaoke: "karaoke_qualification_v2",
  dance: "dance_owner_verdict_v1",
} as const;
type Activity = keyof typeof KINDS;

type QualificationDocument = Readonly<{
  policyId: string;
  activity: Activity;
  kind: string;
  document: Record<string, unknown>;
}>;

type SharedSongProvisioningInput = Readonly<{
  communityId: string;
  funderAccountId: string;
  slotIds: readonly string[];
  attestationId: string;
  chainId: number;
  documents: readonly QualificationDocument[];
  danceAdmission: Readonly<{ admissionVersion: string; admissionHash: string }>;
  validFrom: string;
  validUntil: string;
}>;

const hash = (value: unknown) => Effect.runPromise(canonicalBodyHash(value));
const named = (domain: string, body: unknown) => hash([domain, body]);

/** The context producer's own recomputation, so a mismatch fails here, not at funding. */
function qualificationPolicyHash(document: QualificationDocument) {
  const { policy_hash: _ignored, ...body } = document.document;
  return hash([
    "pirate.shared-song-qualification-policy.v1",
    document.policyId,
    document.activity,
    document.kind,
    body,
  ]);
}

function numericFloor(document: QualificationDocument) {
  const value =
    document.activity === "study"
      ? document.document.required_correct_bps
      : document.document.minimum_final_score_bps;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10_000)
    throw new Error(`${document.activity} policy has no numeric floor`);
  return value;
}

export async function buildSharedSongProvisioning(input: SharedSongProvisioningInput) {
  if (input.slotIds.length === 0) throw new Error("at least one song slot is required");
  const validUntilMs = Date.parse(input.validUntil);
  const bindings: C.QualificationTemplateV2[] = [];
  for (const activity of ["study", "karaoke", "dance"] as const) {
    const document = input.documents.find((d) => d.activity === activity);
    if (document === undefined || document.kind !== KINDS[activity])
      throw new Error(`current ${activity} qualification policy unavailable`);
    const policyHash = await qualificationPolicyHash(document);
    if (activity === "dance" && document.document.policy_hash !== policyHash)
      throw new Error("Dance qualification document hash does not match its body");
    const admission =
      activity === "dance"
        ? {
            admission_id: input.danceAdmission.admissionVersion,
            admission_hash: input.danceAdmission.admissionHash,
          }
        : {
            admission_id: `${PROFILE_ID}:${activity}`,
            admission_hash: await named("pirate.shared-song-numeric-admission.v1", {
              profile_id: PROFILE_ID,
              activity,
              qualification_policy_id: document.policyId,
            }),
          };
    bindings.push(
      Schema.decodeUnknownSync(C.QualificationTemplateV2)({
        template_key: `${TEMPLATE_ID}:${activity}`,
        activity,
        grading_family: activity === "dance" ? "moderator_verdict" : "numeric",
        qualification_policy_id: document.policyId,
        qualification_policy_hash: policyHash,
        numeric_floor_bps: activity === "dance" ? null : numericFloor(document),
        choreography_scope: activity === "dance" ? "any_policy_accepted" : "not_applicable",
        ...admission,
        disclosure_version: DISCLOSURE,
      }),
    );
  }

  let recovery = Schema.decodeUnknownSync(C.CancellationRecoveryPolicyV2)({
    object: "nonce_cancellation_recovery_policy",
    version: "nonce-cancellation-recovery-v1",
    policy_id: `${PROFILE_ID}:recovery`,
    policy_hash: "0".repeat(64),
    chain_id: input.chainId,
    valid_from: input.validFrom,
    valid_until: input.validUntil,
    dispatch_ttl_seconds: 180,
    max_preparations_per_contribution: 2,
    fee_policy_id: `${PROFILE_ID}:fee`,
    fee_policy_hash: await named("pirate.shared-song-fee-policy.v1", { fee: "none" }),
    attestation_contract_version: "megapot-v2-current-recovery-v1",
  });
  recovery = {
    ...recovery,
    policy_hash: await Effect.runPromise(
      digestFundingPreimageV2(C.cancellationPolicyPreimageV2(recovery)),
    ),
  };
  const receiptPolicyHash = await named("pirate.shared-song-receipt-policy.v1", {
    requiredConfirmations: 3,
  });
  const policy = {
    reconciliation: {
      maxAttempts: 5,
      leaseMs: 60_000,
      maximumBlocks: 200,
      maximumLogs: 50,
      receipt: {
        policyHash: receiptPolicyHash,
        requiredConfirmations: 3,
        maximumClockSkewMs: 30_000,
        maximumObservationAgeMs: 300_000,
      },
    },
    // One funder contribution per pot, and no pot accepts a second funder.
    maxActiveAccount: 1,
    maxActiveAccountLeg: 1,
    maxLegLiabilities: 1,
    maxAdmittedLeg: 1,
    maxAdmittedAccountLeg: 1,
    workPerInstruction: 10,
    economicsPolicyHash: await named("pirate.shared-song-economics.v1", {
      ticket_atomic: TICKET_ATOMIC,
      max_drawings: 1,
    }),
    gasPolicyHash: await named("pirate.shared-song-gas.v1", { payer: "funder" }),
    custodyPolicyHash: await named("pirate.shared-song-custody.v1", {
      custody: "safe_owner_v1",
      attestation_id: input.attestationId,
    }),
  };
  const capacityProfile = {
    maxDrawings: 1,
    reservationMs: 60_000,
    safetyMarginMs: 30_000,
    maximumWitnessAgeMs: 120_000,
    validUntil: validUntilMs,
    attestationValidUntil: validUntilMs,
    priceCeilingAtomic: TICKET_ATOMIC,
    minimumAtomic: TICKET_ATOMIC,
  };
  const noncePolicy = {
    hash: await named("pirate.shared-song-nonce-policy.v1", { maxAgeMs: 120_000 }),
    maxAgeMs: 120_000,
  };
  const profileBody = {
    profile_id: PROFILE_ID,
    valid_until: input.validUntil,
    policy,
    capacity_profile: capacityProfile,
    nonce_policy: noncePolicy,
    recovery_policy: recovery,
  };
  const profile = {
    ...profileBody,
    profile_hash: await named("pirate.shared-song-funding-profile.v1", profileBody),
  };

  const operationalProfile = {
    disclosureVersion: DISCLOSURE,
    feePolicyId: recovery.fee_policy_id,
    scheduleRuleId: "megapot-v2-current-initialized-drawing",
    scheduleRuleHash: await named("pirate.shared-song-schedule-rule.v1", {
      source: "currentDrawingId",
      initialized_only: true,
    }),
    priceRuleHash: await named("pirate.shared-song-price-rule.v1", {
      source: "drawing ticketPrice",
      ceiling_atomic: TICKET_ATOMIC,
    }),
    finalityPolicyId: "base-sepolia-three-confirmations",
    cadenceSeconds: "1800",
    entryCutoffSeconds: ENTRY_CUTOFF_SECONDS,
    // The Safe purchase is prepared only while SAFE_POOL_MINIMUM_ENTRY_SECONDS (600 on
    // staging) of entry time remain before the cutoff. Funding therefore closes earlier,
    // leaving time for the transfer's confirmations, the scan and leg activation.
    purchaseLeadSeconds: PURCHASE_LEAD_SECONDS,
    maximumContextAttempts: 50,
    contextLeaseMs: 60_000,
    maximumContextWorkPerAccount: 200,
    maximumContextWorkGlobal: 1_000,
    contextWorkPerAttempt: 1,
    inboundRequiredGasWei: "1000000000000",
    // The producer requires custody to hold at least this much native gas. The owner key
    // pays for Safe executions, so a token amount is enough.
    refundEnvelopeMinimumWei: "1",
    legalActivationGate: "test_only",
    initializedDrawingIds: [],
  };
  const rewardPolicy = {
    version: "shared_song_megapot_v2",
    pool_entry: "qualifying_account",
    claim_verification: "megapot_claim_time_verification_v1",
  };
  const compiledPlan = {
    version: "shared_song_megapot_v2",
    activities: ["study", "karaoke", "dance"],
  };
  const templateBody = {
    template_id: TEMPLATE_ID,
    community_id: input.communityId,
    profile_id: PROFILE_ID,
    attestation_id: input.attestationId,
    reward_policy: rewardPolicy,
    compiled_plan: compiledPlan,
    qualification_templates: bindings,
    operational_profile: operationalProfile,
    valid_from: input.validFrom,
    valid_until: input.validUntil,
  };
  const templateHash = await named("pirate.shared-song-reward-template.v1", templateBody);
  const template = {
    ...templateBody,
    template_hash: templateHash,
    accepted_by: ACCEPTED_BY,
    accepted_receipt_hash: await named("pirate.shared-song-template-acceptance.v1", {
      template_hash: templateHash,
      accepted_by: ACCEPTED_BY,
    }),
  };
  const admissionBody = {
    community_id: input.communityId,
    template_id: TEMPLATE_ID,
    template_hash: templateHash,
    effective_at: input.validFrom,
    valid_until: input.validUntil,
  };
  const admission = {
    ...admissionBody,
    accepted: true,
    accepted_by: ACCEPTED_BY,
    admission_hash: await named("pirate.shared-song-template-admission.v1", admissionBody),
  };
  // Admission locks the funder's, the slot's and the global envelope; an empty slot's
  // envelope becomes the leg's when the pot binds.
  const envelopes = [
    { work_id: `global:funding:${PROFILE_ID}`, scope: "global", scope_key: "funding" },
    {
      work_id: `account:${input.funderAccountId}:${PROFILE_ID}`,
      scope: "account",
      scope_key: input.funderAccountId,
    },
    ...input.slotIds.map((slot) => ({
      work_id: `leg:empty-slot:${slot}:${PROFILE_ID}`,
      scope: "leg",
      scope_key: `empty-slot:${slot}`,
    })),
  ].map((envelope) => ({
    ...envelope,
    profile_id: PROFILE_ID,
    allocated: 100,
    valid_until: input.validUntil,
  }));
  return { profile, template, admission, envelopes };
}

type SharedSongProvisioning = Awaited<ReturnType<typeof buildSharedSongProvisioning>>;

type Query = Pick<Client, "query">;

/** Reads the inputs; it refuses rather than guesses when any is missing or ambiguous. */
export async function readSharedSongProvisioningInput(
  db: Query,
  args: { communityId: string; funderAccountId: string; slotIds: readonly string[] },
): Promise<SharedSongProvisioningInput> {
  const attestation = (
    await db.query(
      `SELECT attestation_id, chain_id::int AS chain_id FROM megapot_deployment_attestations
        WHERE attestation_id=$1 AND status='active' AND retired_at IS NULL`,
      [SHARED_SONG_ATTESTATION],
    )
  ).rows[0];
  if (attestation === undefined) throw new Error("active Safe pilot attestation unavailable");
  const documents = (
    await db.query(
      `SELECT q.qualification_policy_version_id AS "policyId", q.activity_key AS activity,
              q.policy_kind AS kind, q.policy_document AS document
         FROM activity_registry registry
         JOIN qualification_policy_versions q
           ON q.qualification_policy_version_id=registry.current_policy_version_id
        WHERE registry.activity_key IN ('study','karaoke','dance') AND registry.status='active'`,
    )
  ).rows as QualificationDocument[];
  const dance = documents.find((d) => d.activity === "dance");
  const admissions = (
    await db.query(
      `SELECT p.review_policy->>'admissionVersion' AS "admissionVersion",
              p.review_policy->>'admissionHash' AS "admissionHash",
              greatest(p.valid_from, a.effective_at, clock_timestamp()) AS valid_from,
              least(p.valid_until, a.valid_until) AS valid_until
         FROM dance_review_policy_admissions_v1 a
         JOIN dance_review_policy_versions_v1 p USING (policy_id)
        WHERE a.community_id=$1 AND a.accepted AND a.effective_at<=clock_timestamp()
          AND a.valid_until>clock_timestamp() AND p.valid_from<=clock_timestamp()
          AND p.valid_until>clock_timestamp() AND p.review_policy->>'admission'='money_admitted'
          AND p.qualification_policy_version_id=$2`,
      [args.communityId, dance?.policyId ?? null],
    )
  ).rows;
  if (admissions.length !== 1)
    throw new Error(`expected one money-admitted Dance policy, found ${admissions.length}`);
  const [admission] = admissions;
  const slots = (
    await db.query(
      `SELECT slot_id FROM reward_song_slots_v2
        WHERE slot_id = ANY($1::text[]) AND community_id=$2 AND status='open' AND target IS NULL`,
      [args.slotIds, args.communityId],
    )
  ).rows;
  if (slots.length !== new Set(args.slotIds).size || slots.length !== args.slotIds.length)
    throw new Error("every slot must be a distinct open empty slot in the community");
  const funder = (
    await db.query("SELECT 1 FROM users WHERE user_id=$1 AND status='active'", [
      args.funderAccountId,
    ])
  ).rows;
  if (funder.length !== 1) throw new Error("funder account unavailable");
  return {
    communityId: args.communityId,
    funderAccountId: args.funderAccountId,
    slotIds: args.slotIds,
    attestationId: attestation.attestation_id,
    chainId: attestation.chain_id,
    documents,
    danceAdmission: {
      admissionVersion: admission.admissionVersion,
      admissionHash: admission.admissionHash,
    },
    validFrom: new Date(admission.valid_from).toISOString(),
    validUntil: new Date(admission.valid_until).toISOString(),
  };
}

const json = (value: unknown) => JSON.stringify(value);

/** One transaction; any existing row with the same identity refuses the whole write. */
export async function applySharedSongProvisioning(db: Query, rows: SharedSongProvisioning) {
  const { profile, template, admission, envelopes } = rows;
  await db.query("BEGIN");
  try {
    await db.query(
      `INSERT INTO reward_funding_profiles_v2(profile_id,profile_hash,accepted,valid_until,policy,
         capacity_profile,nonce_policy,recovery_policy)
       VALUES($1,$2,TRUE,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb)`,
      [
        profile.profile_id,
        profile.profile_hash,
        profile.valid_until,
        json(profile.policy),
        json(profile.capacity_profile),
        json(profile.nonce_policy),
        json(profile.recovery_policy),
      ],
    );
    await db.query(
      `INSERT INTO reward_shared_song_templates_v2(template_id,community_id,profile_id,template_hash,
         attestation_id,reward_policy,compiled_plan,qualification_templates,operational_profile,
         accepted_by,accepted_receipt_hash,valid_from,valid_until)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13)`,
      [
        template.template_id,
        template.community_id,
        template.profile_id,
        template.template_hash,
        template.attestation_id,
        json(template.reward_policy),
        json(template.compiled_plan),
        json(template.qualification_templates),
        json(template.operational_profile),
        template.accepted_by,
        template.accepted_receipt_hash,
        template.valid_from,
        template.valid_until,
      ],
    );
    await db.query(
      `INSERT INTO reward_shared_song_template_admissions_v2(community_id,template_id,accepted,
         admission_hash,accepted_by,effective_at,valid_until)
       VALUES($1,$2,TRUE,$3,$4,$5,$6)`,
      [
        admission.community_id,
        admission.template_id,
        admission.admission_hash,
        admission.accepted_by,
        admission.effective_at,
        admission.valid_until,
      ],
    );
    for (const e of envelopes)
      await db.query(
        `INSERT INTO reward_funding_work_envelopes_v2(work_id,scope,scope_key,profile_id,
           contribution_id,allocated,used,reserved,valid_until,payload)
         VALUES($1,$2,$3,$4,NULL,$5,0,0,$6,NULL)`,
        [e.work_id, e.scope, e.scope_key, e.profile_id, e.allocated, e.valid_until],
      );
    const ready = (
      await db.query("SELECT shared_song_qualification_templates_ready_v2($1) AS ready", [
        template.template_id,
      ])
    ).rows[0];
    if (ready?.ready !== true) throw new Error("template qualification bindings are not ready");
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      community: { type: "string" },
      funder: { type: "string" },
      slot: { type: "string", multiple: true },
      apply: { type: "boolean", default: false },
    },
  });
  const environment = process.env.API_NEXT_ENV;
  if (environment !== "staging" && environment !== "development")
    throw new Error("shared-song provisioning runs on staging or development only");
  const adminUrl = process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL?.trim();
  if (!adminUrl || !values.community || !values.funder || !values.slot?.length)
    throw new Error("CONTROL_PLANE_POSTGRES_ADMIN_URL, --community, --funder and --slot required");
  const client = new Client({
    connectionString: normalizePostgresConnectionString(adminUrl),
    connectionTimeoutMillis: 5_000,
    options: "-c search_path=api_next,pg_catalog",
  });
  await client.connect();
  try {
    const input = await readSharedSongProvisioningInput(client, {
      communityId: values.community,
      funderAccountId: values.funder,
      slotIds: values.slot,
    });
    const rows = await buildSharedSongProvisioning(input);
    console.log(JSON.stringify({ action: values.apply ? "apply" : "dry-run", ...rows }, null, 2));
    if (values.apply) {
      await applySharedSongProvisioning(client, rows);
      console.log(
        JSON.stringify({ action: "applied", template_hash: rows.template.template_hash }),
      );
    }
  } finally {
    await client.end();
  }
}
