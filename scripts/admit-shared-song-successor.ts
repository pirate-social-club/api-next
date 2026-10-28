/** One staging template successor. Default is read-only preview. Apply requires
 * the exact preview hashes and paused brake revision, with no live run lease.
 * Only a new immutable template and the existing admission pointer are written;
 * funding profiles, envelopes, counters, slots and original history stay intact.
 */
import { parseArgs } from "node:util";
import { Effect, Schema } from "effect";
import { Client } from "pg";
import { canonicalBodyHash } from "../packages/application/src/use-cases/content/common.ts";
import * as C from "../packages/contracts/src/rewards-song-contributions-v2.ts";
import {
  SHARED_SONG_SUCCESSOR_PRICE_RULE,
  SHARED_SONG_SUCCESSOR_RULE,
  SHARED_SONG_SUCCESSOR_RULE_ID,
} from "../packages/platform-cf/src/shared-song-successor-schedule.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

const Source = Schema.Struct({
  template_id: C.IdV2,
  community_id: C.IdV2,
  profile_id: C.IdV2,
  attestation_id: C.IdV2,
  template_hash: C.HashV2,
  reward_policy: Schema.Record(Schema.String, Schema.Unknown),
  compiled_plan: Schema.Record(Schema.String, Schema.Unknown),
  qualification_templates: Schema.Array(C.QualificationTemplateV2).check(
    Schema.isMinLength(3),
    Schema.isMaxLength(3),
  ),
  operational_profile: Schema.Record(Schema.String, Schema.Unknown),
  valid_from: C.InstantV2,
  valid_until: C.InstantV2,
});
const Input = Schema.Struct({
  source: Source,
  admissionHash: C.HashV2,
  admissionEffectiveAt: C.InstantV2,
  admissionValidUntil: C.InstantV2,
  profileAccepted: Schema.Boolean,
  profileValidUntil: C.InstantV2,
  capacity: Schema.Record(Schema.String, Schema.Unknown),
  policy: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  chainId: C.ChainV2,
  environment: Schema.Literals(["test", "staging"]),
  jackpotAddress: C.AddressV2,
  jackpotCodeHash: C.TxHashV2,
});
const named = (domain: string, value: unknown) =>
  Effect.runPromise(canonicalBodyHash([domain, value]));
type Query = Pick<Client, "query">;
const ownerRole = "workspace_owner";

type TemplateChange = "successor_schedule" | "single_funder_terms";

export async function buildSharedSongSuccessorTemplate(
  raw: unknown,
  change: TemplateChange = "successor_schedule",
) {
  const input = Schema.decodeUnknownSync(Input, { onExcessProperty: "error" })(raw);
  const { template_hash: predecessorHash, ...previous } = input.source;
  const rule = SHARED_SONG_SUCCESSOR_RULE;
  const generation =
    previous.profile_id === "shared-song-safe-pilot-staging-v1"
      ? 1
      : previous.profile_id === "shared-song-safe-pilot-staging-v2"
        ? 2
        : null;
  if (
    predecessorHash !== (await named("pirate.shared-song-reward-template.v1", previous)) ||
    generation === null ||
    (change === "successor_schedule" &&
      previous.template_id !== `shared-song-safe-pilot-staging-template-v${generation}`) ||
    (generation === 2 &&
      previous.operational_profile.emptyBehavior !== "single_funder_ticket_first_v1") ||
    previous.attestation_id !== "megapot-base-sepolia-v2-safe-pilot" ||
    (change === "successor_schedule" &&
      previous.operational_profile.scheduleRuleId !== "megapot-v2-current-initialized-drawing") ||
    previous.operational_profile.cadenceSeconds !== "1800" ||
    previous.operational_profile.entryCutoffSeconds !== rule.entryCutoffSeconds ||
    (change === "successor_schedule" &&
      previous.operational_profile.purchaseLeadSeconds !== rule.purchaseLeadSeconds) ||
    previous.operational_profile.legalActivationGate !== "test_only" ||
    input.capacity.maxDrawings !== 1 ||
    input.capacity.priceCeilingAtomic !== SHARED_SONG_SUCCESSOR_PRICE_RULE.ticketAtomic ||
    !input.profileAccepted ||
    input.profileValidUntil < previous.valid_until ||
    input.admissionEffectiveAt !== previous.valid_from ||
    input.admissionValidUntil !== previous.valid_until ||
    input.chainId !== rule.chainId ||
    input.jackpotAddress !== rule.jackpotAddress ||
    input.jackpotCodeHash !== rule.jackpotCodeHash
  )
    throw Error("accepted predecessor template/profile/deployment unavailable");
  if (
    change === "single_funder_terms" &&
    (!previous.template_id.startsWith("shared-song-safe-pilot-staging-") ||
      previous.operational_profile.scheduleRuleId !== SHARED_SONG_SUCCESSOR_RULE_ID ||
      [
        "maxActiveAccount",
        "maxActiveAccountLeg",
        "maxLegLiabilities",
        "maxAdmittedLeg",
        "maxAdmittedAccountLeg",
      ].some((key) => input.policy?.[key] !== 1))
  )
    throw Error("single-funder accepted successor profile required");
  const body = {
    ...previous,
    template_id:
      change === "single_funder_terms"
        ? "shared-song-safe-pilot-staging-single-funder-template-v1"
        : `shared-song-safe-pilot-staging-successor-template-v${generation}`,
    operational_profile:
      change === "single_funder_terms"
        ? {
            ...previous.operational_profile,
            emptyBehavior: "single_funder_ticket_first_v1",
            disclosureVersion: "shared-song-safe-pilot-staging-single-funder-disclosure-v1",
          }
        : {
            ...previous.operational_profile,
            disclosureVersion: `shared-song-safe-pilot-staging-successor-disclosure-v${generation}`,
            scheduleRuleId: SHARED_SONG_SUCCESSOR_RULE_ID,
            scheduleRuleHash: await named("pirate.shared-song-schedule-rule.v2", rule),
            priceRuleHash: await named(
              "pirate.shared-song-price-rule.v2",
              SHARED_SONG_SUCCESSOR_PRICE_RULE,
            ),
            initializedDrawingIds: [],
          },
  };
  const templateHash = await named("pirate.shared-song-reward-template.v1", body);
  const admissionBody = {
    community_id: body.community_id,
    template_id: body.template_id,
    template_hash: templateHash,
    effective_at: body.valid_from,
    valid_until: body.valid_until,
  };
  return {
    predecessorHash,
    expectedAdmissionHash: input.admissionHash,
    template: {
      ...body,
      template_hash: templateHash,
      accepted_by: ownerRole,
      accepted_receipt_hash: await named("pirate.shared-song-template-acceptance.v1", {
        template_hash: templateHash,
        predecessor_template_hash: predecessorHash,
        accepted_by: ownerRole,
      }),
    },
    admission: {
      ...admissionBody,
      accepted: true,
      accepted_by: ownerRole,
      admission_hash: await named("pirate.shared-song-template-admission.v1", admissionBody),
    },
  };
}

export async function readSharedSongSuccessorTemplate(
  db: Query,
  communityId: string,
  locked = false,
  change: TemplateChange = "successor_schedule",
) {
  const result = await db.query(
    `SELECT jsonb_build_object('source',jsonb_build_object(
      'template_id',t.template_id,'community_id',t.community_id,'profile_id',t.profile_id,
      'attestation_id',t.attestation_id,'template_hash',t.template_hash,'reward_policy',t.reward_policy,
      'compiled_plan',t.compiled_plan,'qualification_templates',t.qualification_templates,
      'operational_profile',t.operational_profile,
      'valid_from',to_char(t.valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'valid_until',to_char(t.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      'admissionHash',a.admission_hash,
      'admissionEffectiveAt',to_char(a.effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'admissionValidUntil',to_char(a.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'profileAccepted',p.accepted,'capacity',p.capacity_profile,'policy',p.policy,
      'profileValidUntil',to_char(p.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'chainId',d.chain_id,'environment',d.environment,'jackpotAddress',d.jackpot_address,
      'jackpotCodeHash',d.jackpot_code_hash) packet
      FROM reward_shared_song_template_admissions_v2 a
      JOIN reward_shared_song_templates_v2 t USING(community_id,template_id)
      JOIN reward_funding_profiles_v2 p USING(profile_id)
      JOIN megapot_deployment_attestations d ON d.attestation_id=t.attestation_id
      WHERE a.community_id=$1 AND a.accepted AND a.effective_at<=clock_timestamp()
        AND a.valid_until>clock_timestamp() AND t.valid_from<=clock_timestamp()
        AND t.valid_until>clock_timestamp() AND p.valid_until>clock_timestamp()
        AND d.status='active' AND d.retired_at IS NULL
        AND shared_song_qualification_templates_ready_v2(t.template_id)
      ${locked ? "FOR UPDATE OF a FOR SHARE OF t,p,d" : ""}`,
    [communityId],
  );
  if (result.rows.length !== 1) throw Error("one current admitted predecessor is required");
  return buildSharedSongSuccessorTemplate(result.rows[0].packet, change);
}

export async function applySharedSongSuccessorTemplate(
  db: Query,
  input: {
    communityId: string;
    expectedAdmissionHash: string;
    expectedTemplateHash: string;
    expectedBrakeRevision: number;
    change?: TemplateChange;
  },
) {
  Schema.decodeUnknownSync(C.HashV2)(input.expectedAdmissionHash);
  Schema.decodeUnknownSync(C.HashV2)(input.expectedTemplateHash);
  Schema.decodeUnknownSync(C.RevisionV2)(input.expectedBrakeRevision);
  await db.query("BEGIN");
  let commitStarted = false;
  try {
    const brake = (
      await db.query(
        "SELECT paused,revision::text FROM reward_operations_control WHERE singleton FOR UPDATE",
      )
    ).rows[0];
    const lease = (
      await db.query(
        "SELECT (run_id IS NOT NULL AND clock_timestamp()<expires_at AND clock_timestamp()<absolute_deadline) live FROM reward_operations_run_lease WHERE singleton FOR SHARE",
      )
    ).rows[0];
    if (
      brake?.paused !== true ||
      brake.revision !== String(input.expectedBrakeRevision) ||
      lease?.live !== false
    )
      throw Error("exact paused brake and no live run required");
    const plan = await readSharedSongSuccessorTemplate(db, input.communityId, true, input.change);
    if (
      plan.expectedAdmissionHash !== input.expectedAdmissionHash ||
      plan.template.template_hash !== input.expectedTemplateHash
    )
      throw Error("reviewed template/admission changed");
    const t = plan.template,
      a = plan.admission;
    await db.query(
      `INSERT INTO reward_shared_song_templates_v2(template_id,community_id,profile_id,template_hash,
      attestation_id,reward_policy,compiled_plan,qualification_templates,operational_profile,accepted_by,
      accepted_receipt_hash,valid_from,valid_until) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13)`,
      [
        t.template_id,
        t.community_id,
        t.profile_id,
        t.template_hash,
        t.attestation_id,
        JSON.stringify(t.reward_policy),
        JSON.stringify(t.compiled_plan),
        JSON.stringify(t.qualification_templates),
        JSON.stringify(t.operational_profile),
        t.accepted_by,
        t.accepted_receipt_hash,
        t.valid_from,
        t.valid_until,
      ],
    );
    const updated = await db.query(
      `UPDATE reward_shared_song_template_admissions_v2 SET template_id=$2,
      admission_hash=$3,accepted_by=$4,effective_at=$5,valid_until=$6 WHERE community_id=$1 AND admission_hash=$7 AND accepted`,
      [
        a.community_id,
        a.template_id,
        a.admission_hash,
        a.accepted_by,
        a.effective_at,
        a.valid_until,
        input.expectedAdmissionHash,
      ],
    );
    if (updated.rowCount !== 1) throw Error("admission compare-and-swap refused");
    commitStarted = true;
    await db.query("COMMIT");
    return plan;
  } catch (error) {
    const primary = commitStarted
      ? new Error(
          "successor template COMMIT outcome unknown; inspect admission before any further action",
          { cause: error },
        )
      : error;
    try {
      await db.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [primary, rollbackError],
        "successor template failed and rollback was not acknowledged",
      );
    }
    throw primary;
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      community: { type: "string" },
      apply: { type: "boolean", default: false },
      "single-funder-terms": { type: "boolean", default: false },
      "expected-admission-hash": { type: "string" },
      "expected-template-hash": { type: "string" },
      "expected-brake-revision": { type: "string" },
    },
  });
  if (!["staging", "development"].includes(process.env.API_NEXT_ENV ?? ""))
    throw Error("staging/development only");
  const url = process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL?.trim();
  if (!url || !values.community)
    throw Error("CONTROL_PLANE_POSTGRES_ADMIN_URL and --community required");
  const db = new Client({
    connectionString: normalizePostgresConnectionString(url),
    options: "-c search_path=api_next,pg_catalog",
    connectionTimeoutMillis: 5000,
  });
  await db.connect();
  try {
    let plan: Awaited<ReturnType<typeof buildSharedSongSuccessorTemplate>>;
    if (values.apply)
      plan = await applySharedSongSuccessorTemplate(db, {
        communityId: values.community,
        expectedAdmissionHash: values["expected-admission-hash"] ?? "",
        expectedTemplateHash: values["expected-template-hash"] ?? "",
        expectedBrakeRevision: Number(values["expected-brake-revision"]),
        change: values["single-funder-terms"] ? "single_funder_terms" : "successor_schedule",
      });
    else {
      await db.query("BEGIN READ ONLY");
      try {
        plan = await readSharedSongSuccessorTemplate(
          db,
          values.community,
          false,
          values["single-funder-terms"] ? "single_funder_terms" : "successor_schedule",
        );
      } finally {
        await db.query("ROLLBACK");
      }
    }
    console.log(JSON.stringify({ action: values.apply ? "applied" : "preview", ...plan }, null, 2));
  } finally {
    await db.end();
  }
}
