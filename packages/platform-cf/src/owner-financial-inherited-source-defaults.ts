/** Finite retained INVOKER surface. These are inherited PUBLIC permissions,
 * never purpose callbacks or new financial grants. Native observer proof retains
 * exact original PUBLIC+owner ACL; this literal additionally closes the candidate.
 */
import type { GuestStudyReadinessCandidate } from "./guest-study-readiness-profile.ts";
export const ownerFinancialInheritedSourceDefaults = [
  {
    result: "boolean",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "active_activity_persona(text,text,text)",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "0a5be528e4d3c6bd3eed04816ebf5e839e9cf24f7ee81e7f9378c6903a5f4db7",
    configuration: null,
  },
  {
    result: "boolean",
    definer: false,
    language: "sql",
    acl_class: "legacy_source_default",
    signature: "active_owned_community_persona(text,text,text)",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "682a7436606b9e51482c72f740c81209ca8de279631b1bc195417dc7e99caad0",
    configuration: null,
  },
  {
    result: "boolean",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "can_account_access_activity_song(text,text,text)",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "ba7562f279f5bfb0f3df9e1ad7372b241edf73c68a0d87f71a92a7b832418606",
    configuration: null,
  },
  {
    result: "boolean",
    definer: false,
    language: "sql",
    acl_class: "legacy_source_default",
    signature: "can_account_view_content_rating_v1(text,text)",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "b115783b5a6dd3d6f95c74597341737d8073cc0986a832ed851a4a5887f92a40",
    configuration: null,
  },
  {
    result: "text",
    definer: false,
    language: "sql",
    acl_class: "legacy_source_default",
    signature: "current_account_age_capability_v1(text)",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "57f499719da6bcdfb8e47d80673f5f2f7fbeac5ab3e1ab71eee99b8ee8fe5164",
    configuration: null,
  },
  {
    result:
      "TABLE(provider_id text, policy_reference text, evidence_expires_at timestamp with time zone)",
    definer: false,
    language: "sql",
    acl_class: "legacy_source_default",
    signature: "current_account_age_evidence_v2(text)",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "090e6c80643f640dbf1d93f32e6ce142fa093a2a37ec784652336dd18b414283",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "freeze_reward_leg_qualification_terms()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "df036e4965c6217aaf3514b35dbe129d602346c2df9d3e3cbc006b6a0a233673",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "gates_v2_append_only_guard()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "08f564af3a898648ba099932fb7d4f781f5f487867b588d89d044c11b706b63b",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "gates_v2_validate_reward_subject_consumption()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "30d2bf7b4f6e551a610c21f0e7036323150fc64af49505f9c9de99bf68542a23",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "guard_activity_qualification()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "623f0a30ba6066b80b78a720db4f8f0c3bcb525d5d5314795d8cc55ba3d761b7",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "guard_asset_bonus_leg_asset()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "86c08f4893e7a18fa99f15435155f27194229f0b62fe45e207bb25d27821f101",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "guard_megapot_allocation_batch_change()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "b0b77ecdf8fc98a2cc4c74bc1d13087bf751337db7696ad5e2a824345dc5e684",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "guard_megapot_commitment_effect()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "e50bda7dae87d7ce4f701a577beefaeabd41c044288d87b438b2a32ad312b995",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "guard_megapot_participant_claim()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "ebfc54623645d438d966b62da9a5a87e3ca29c24b4f5d0fc07cec60d78557c05",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "guard_megapot_participant_claim_guard()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "b94104baf69a1634c0a97c5cd9769828ad20f79a987fe5ac54a68e096557f93f",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "guard_megapot_participant_credit_claim()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "cf79cce090a6be37c79e0b202784bda090808514171ccdf1c670e1786806d432",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "guard_megapot_pool_drawing()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "81c899f212ae00156e0793ea03491c2546f7128068b10e76aad69dc9b2e6c2f9",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "guard_reward_bound_asset_claim_leg()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "2b3353ef9868a07d8d7a1f5b3216a866e0ea9cf61827a30e70edcf2dc7c500a1",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "guard_reward_bound_pool_share()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "70d0b379def6541f856691cc8561e900ac7158f8ea9aaf04d342d71cccb59967",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "guard_song_reward_bundle_claim()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "b089532b9bf1f7b3b8f2f13ae77b821e4ea27ee368b50e83325808273b385e77",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "guard_song_reward_bundle_claim_leg()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "8c6e7e489cd8f72bdbb0868fdd7ae5b9aef7da701910327d4da91b58dce8562e",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "guard_song_reward_offer_leg()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "e55dd5b5178bfdf29ae29fd54333fee60beb0be3fe6b10074a5b50dfc74fcb54",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "guard_sponsor_daily_totals()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "eac2a6237dfb2ff83f9ada0dc8e7bcd029381c470220e55a20ff4aa473872a5c",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "guard_study_v2_activity_authority()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "b47e29a7201d5d5019d40bc0a353dfc699fee21abf13e3dfc5037570d16cf231",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "project_asset_bonus_claim_from_qualification()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "57898363db0cbdbcf28b5073e1f94828892e4c0f912fee1bd226ea87de33eca6",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "protect_telegram_practice_mode()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "830282dfac407628100046bb88f2edbc4f23bb4dac1ed3dda2f27f1e486069f4",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "reject_localization_immutable_mutation()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "b33de46fbe49efcdbdfb5baa5320fa068075e1d6c3d0fc33cf5c480fe2002899",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "reject_megapot_snapshot_change()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "db850f67a07677010bc98926787c0848930109e064f46331db47b3cd8d756305",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "reject_reward_append_only_change()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "7646b73e92112672fe4e67c25dd6b97dbf712a5fbb4a9bd6b7aa129e189aa4a6",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "reject_telegram_practice_qualification()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "4a9a77664260a25711a6d64ad65ddfc503ff9352a4b92d7adf6a9cb11c0eb0cb",
    configuration: null,
  },
  {
    result:
      "TABLE(subject_key_id text, binding_event_id text, binding_epoch bigint, evidence_receipt_id text, evidence_hash text, evidence_expires_at timestamp with time zone, observed_at timestamp with time zone, evidence_count bigint)",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "reward_account_very_evidence_v1(text,timestamp with time zone)",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "10c34c516f12cbe636fa0dc91edcecdd7ae4d7311dbde6391764b42d104477d2",
    configuration: null,
  },
  {
    result: "jsonb",
    definer: false,
    language: "sql",
    acl_class: "legacy_source_default",
    signature: "reward_current_qualification_policies(text[])",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "97ea609d046d44a2e575e856fe8b191ed9ecc75f323f7e37bb1be8ee94a72052",
    configuration: null,
  },
  {
    result: "boolean",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "reward_json_contains_private_identity(jsonb)",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "5b32dbf3e392bd13b41aae6ff6b55f5362cd3c02d4efacc6514cfb45f56c8b6a",
    configuration: null,
  },
  {
    result: "boolean",
    definer: false,
    language: "sql",
    acl_class: "legacy_source_default",
    signature: "reward_leg_accepts_qualification(text,text,text)",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "7c6fa7110664b454ade6d2605f5dfd7b482c17ad98680092c7675c658e3b7ffa",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "validate_asset_bonus_leg_accounting()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "ed4306da0406779c9ed971a1811d2ca9f4bb1148d04cddc2ff802c0cb5dce709",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "validate_megapot_fallback_cutoff()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "2378879b6f9473ef6bf5b17c2797b1056e8d6e523d8042a255de070218bacc21",
    configuration: null,
  },
  {
    result: "trigger",
    definer: false,
    language: "plpgsql",
    acl_class: "legacy_source_default",
    signature: "validate_megapot_pool_drawing_transition()",
    controlled: false,
    source_acl: [
      {
        grantee: "@NATIVE_OWNER@",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
      {
        grantee: "PUBLIC",
        grantor: "@NATIVE_OWNER@",
        is_grantable: false,
        privilege_type: "EXECUTE",
      },
    ],
    body_sha256: "ec94290e71a88c648869ce0adc28071c96fc78e618b180b986a9842575ee8727",
    configuration: null,
  },
] as const;
export function readOwnerFinancialInheritedSourceDefaults(
  candidate: GuestStudyReadinessCandidate,
): readonly string[] {
  const supplied = candidate.inherited_source_default_signatures;
  const exact = ownerFinancialInheritedSourceDefaults.map((row) => row.signature);
  if (
    supplied === undefined ||
    supplied.length !== 37 ||
    new Set(supplied).size !== 37 ||
    JSON.stringify([...supplied].sort()) !== JSON.stringify([...exact].sort())
  )
    throw new Error("Financial inherited source surface unavailable");
  for (const original of ownerFinancialInheritedSourceDefaults) {
    const frames = candidate.required_frames.filter(
      (frame) => frame.signature === original.signature,
    );
    const frame = frames[0];
    const bodies = candidate.native_function_bodies.filter(
      (body) => body.name === original.signature.slice(0, original.signature.indexOf("(")),
    );
    const body = bodies[0];
    if (
      frames.length !== 1 ||
      frame === undefined ||
      frame.definer ||
      frame.configuration !== "none" ||
      frame.body_sha256 !== original.body_sha256 ||
      bodies.length !== 1 ||
      body === undefined ||
      body.definer ||
      body.configuration !== "none" ||
      body.body_sha256 !== original.body_sha256
    )
      throw new Error("Financial inherited source frame unavailable");
  }
  return exact;
}
