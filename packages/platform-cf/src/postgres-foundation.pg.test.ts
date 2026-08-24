import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";

import { makeDirectPostgresControlPlaneLayer } from "./postgres";
import {
  applyPostgresMigrations,
  MigrationDefinitionInvalid,
  MigrationLedgerMismatch,
  type PostgresMigration,
} from "./postgres-migrations";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";

if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}

const suite = connectionString === undefined ? describe.skip : describe;
const foundationTestCount = 14;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_FOUNDATION_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-foundation-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-foundation-suite-complete\n";
let completedTestCount = 0;
const baselineSql = await Bun.file(
  new URL("../../../db/postgres/schema.sql", import.meta.url),
).text();
const migrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0001_v1_product_slice.sql", import.meta.url),
).text();
const identityMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0002_identity.sql", import.meta.url),
).text();
const m2MigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0003_m2_community_content.sql", import.meta.url),
).text();
const commentLockMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0004_post_comment_lock.sql", import.meta.url),
).text();
const m2BehaviorMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0005_m2_behavior_invariants.sql", import.meta.url),
).text();
const publicProfileMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0006_public_profile_handle_index.sql", import.meta.url),
).text();
const publicProfileInvariantMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0007_public_profile_handle_invariants.sql",
    import.meta.url,
  ),
).text();
const communityRouteSlugMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0008_community_route_slug.sql", import.meta.url),
).text();
const gatesV2MigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0009_gates_v2_foundation.sql", import.meta.url),
).text();
const proofSessionProvenanceMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0010_proof_session_provenance.sql", import.meta.url),
).text();
const verificationStartReservationsMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0011_verification_start_reservations.sql",
    import.meta.url,
  ),
).text();
const verificationCompletionAttemptsMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0012_verification_completion_attempts.sql",
    import.meta.url,
  ),
).text();
const communityPurchaseFundingJournalMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0013_m3_community_purchase_funding_journal.sql",
    import.meta.url,
  ),
).text();
const communityPurchaseFundingPlansMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0014_m3_community_purchase_funding_plans.sql",
    import.meta.url,
  ),
).text();
const identityCredentialsMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0015_identity_credentials.sql", import.meta.url),
).text();
const identityCredentialInvariantsMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0016_identity_credential_invariants.sql",
    import.meta.url,
  ),
).text();
const identityCredentialDeleteGuardMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0017_identity_credential_delete_guard.sql",
    import.meta.url,
  ),
).text();
const fundingDormancyAndRetentionMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0018_m3_funding_dormancy_and_retention.sql",
    import.meta.url,
  ),
).text();
const reconciliationAttemptsMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0019_m3_reconciliation_attempts.sql", import.meta.url),
).text();
const reconciliationFinalizationMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0020_m3_reconciliation_finalization.sql",
    import.meta.url,
  ),
).text();
const communityPurchaseCommerceMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0021_m3_community_purchase_commerce.sql",
    import.meta.url,
  ),
).text();
const communityPurchaseImmutabilityMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0022_m3_community_purchase_immutability.sql",
    import.meta.url,
  ),
).text();
const communityCreationIntentsMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0023_community_creation_intents.sql", import.meta.url),
).text();
const communityCreationPreflightTransitionMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0024_community_creation_preflight_transition.sql",
    import.meta.url,
  ),
).text();
const communityCreationStorageIdentityMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0025_community_creation_storage_identity.sql",
    import.meta.url,
  ),
).text();
const textModerationFoundationMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0026_text_moderation_foundation.sql", import.meta.url),
).text();
const communityRoutesAndCreationRequirementsMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0027_community_routes_and_creation_requirements.sql",
    import.meta.url,
  ),
).text();
const communityCreationRequirementResultGuardMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0028_community_creation_requirement_result_guard.sql",
    import.meta.url,
  ),
).text();
const namespaceOwnershipPersistenceMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0029_namespace_ownership_persistence.sql",
    import.meta.url,
  ),
).text();
const namespaceOwnershipCompletionExpiryMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0030_namespace_ownership_completion_expiry.sql",
    import.meta.url,
  ),
).text();
const communityCreationRouteContractMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0031_community_creation_route_contract.sql",
    import.meta.url,
  ),
).text();
const routeAuthorityVersionMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0032_route_authority_version.sql", import.meta.url),
).text();
const namespaceOwnershipChallengeTopologiesMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0033_namespace_ownership_challenge_topologies.sql",
    import.meta.url,
  ),
).text();
const effectiveActiveRouteMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0034_effective_active_route.sql", import.meta.url),
).text();
const routeRevalidationPersistenceMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0035_route_revalidation_persistence.sql",
    import.meta.url,
  ),
).text();
const routeRevalidationCompletionMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0036_route_revalidation_completion_outcome_guard.sql",
    import.meta.url,
  ),
).text();
const textSubmissionResponseSnapshotMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0037_text_submission_response_snapshot.sql",
    import.meta.url,
  ),
).text();
const communityCreationVeryWebEvidenceMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0038_community_creation_very_web_evidence.sql",
    import.meta.url,
  ),
).text();
const commentsRepliesRuntimeMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0039_comments_replies_runtime.sql", import.meta.url),
).text();
const postVoteActionsMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0040_post_vote_actions.sql", import.meta.url),
).text();
const communityRouteDatabaseExpiryMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0041_community_route_database_expiry.sql",
    import.meta.url,
  ),
).text();
const hnsControlObserverPersistenceMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0042_hns_control_observer_persistence.sql",
    import.meta.url,
  ),
).text();
const mediaSubmissionMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0043_song_media_submission.sql", import.meta.url),
).text();
const optionalRouteV2MigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0044_optional_route_v2.sql", import.meta.url),
).text();
const hnsOwnerAuthorityCustodyMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0045_hns_owner_authority_custody.sql", import.meta.url),
).text();
const accountPersonaWalletPrivacyMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0046_account_persona_wallet_privacy.sql",
    import.meta.url,
  ),
).text();
const hnsOperatorManagedRoutesMigrationSql = await Bun.file(
  new URL("../../../db/postgres/migrations/0047_hns_operator_managed_routes.sql", import.meta.url),
).text();
const hnsFirstPartyHostPersistenceMigrationSql = await Bun.file(
  new URL(
    "../../../db/postgres/migrations/0048_hns_first_party_host_persistence.sql",
    import.meta.url,
  ),
).text();
const checksumManifest = (await Bun.file(
  new URL("../../../db/postgres/migrations/checksums.json", import.meta.url),
).json()) as { readonly migrations: Readonly<Record<string, string>> };

const migration: PostgresMigration = {
  version: "0001_v1_product_slice.sql",
  checksum: checksumManifest.migrations["0001_v1_product_slice.sql"] ?? "",
  sql: migrationSql,
};
const identityMigration: PostgresMigration = {
  version: "0002_identity.sql",
  checksum: checksumManifest.migrations["0002_identity.sql"] ?? "",
  sql: identityMigrationSql,
};
const m2Migration: PostgresMigration = {
  version: "0003_m2_community_content.sql",
  checksum: checksumManifest.migrations["0003_m2_community_content.sql"] ?? "",
  sql: m2MigrationSql,
};
const commentLockMigration: PostgresMigration = {
  version: "0004_post_comment_lock.sql",
  checksum: checksumManifest.migrations["0004_post_comment_lock.sql"] ?? "",
  sql: commentLockMigrationSql,
};
const m2BehaviorMigration: PostgresMigration = {
  version: "0005_m2_behavior_invariants.sql",
  checksum: checksumManifest.migrations["0005_m2_behavior_invariants.sql"] ?? "",
  sql: m2BehaviorMigrationSql,
};
const publicProfileMigration: PostgresMigration = {
  version: "0006_public_profile_handle_index.sql",
  checksum: checksumManifest.migrations["0006_public_profile_handle_index.sql"] ?? "",
  sql: publicProfileMigrationSql,
};
const publicProfileInvariantMigration: PostgresMigration = {
  version: "0007_public_profile_handle_invariants.sql",
  checksum: checksumManifest.migrations["0007_public_profile_handle_invariants.sql"] ?? "",
  sql: publicProfileInvariantMigrationSql,
};
const communityRouteSlugMigration: PostgresMigration = {
  version: "0008_community_route_slug.sql",
  checksum: checksumManifest.migrations["0008_community_route_slug.sql"] ?? "",
  sql: communityRouteSlugMigrationSql,
};
const gatesV2Migration: PostgresMigration = {
  version: "0009_gates_v2_foundation.sql",
  checksum: checksumManifest.migrations["0009_gates_v2_foundation.sql"] ?? "",
  sql: gatesV2MigrationSql,
};
const proofSessionProvenanceMigration: PostgresMigration = {
  version: "0010_proof_session_provenance.sql",
  checksum: checksumManifest.migrations["0010_proof_session_provenance.sql"] ?? "",
  sql: proofSessionProvenanceMigrationSql,
};
const verificationStartReservationsMigration: PostgresMigration = {
  version: "0011_verification_start_reservations.sql",
  checksum: checksumManifest.migrations["0011_verification_start_reservations.sql"] ?? "",
  sql: verificationStartReservationsMigrationSql,
};
const verificationCompletionAttemptsMigration: PostgresMigration = {
  version: "0012_verification_completion_attempts.sql",
  checksum: checksumManifest.migrations["0012_verification_completion_attempts.sql"] ?? "",
  sql: verificationCompletionAttemptsMigrationSql,
};
const communityPurchaseFundingJournalMigration: PostgresMigration = {
  version: "0013_m3_community_purchase_funding_journal.sql",
  checksum: checksumManifest.migrations["0013_m3_community_purchase_funding_journal.sql"] ?? "",
  sql: communityPurchaseFundingJournalMigrationSql,
};
const communityPurchaseFundingPlansMigration: PostgresMigration = {
  version: "0014_m3_community_purchase_funding_plans.sql",
  checksum: checksumManifest.migrations["0014_m3_community_purchase_funding_plans.sql"] ?? "",
  sql: communityPurchaseFundingPlansMigrationSql,
};
const identityCredentialsMigration: PostgresMigration = {
  version: "0015_identity_credentials.sql",
  checksum: checksumManifest.migrations["0015_identity_credentials.sql"] ?? "",
  sql: identityCredentialsMigrationSql,
};
const identityCredentialInvariantsMigration: PostgresMigration = {
  version: "0016_identity_credential_invariants.sql",
  checksum: checksumManifest.migrations["0016_identity_credential_invariants.sql"] ?? "",
  sql: identityCredentialInvariantsMigrationSql,
};
const identityCredentialDeleteGuardMigration: PostgresMigration = {
  version: "0017_identity_credential_delete_guard.sql",
  checksum: checksumManifest.migrations["0017_identity_credential_delete_guard.sql"] ?? "",
  sql: identityCredentialDeleteGuardMigrationSql,
};
const fundingDormancyAndRetentionMigration: PostgresMigration = {
  version: "0018_m3_funding_dormancy_and_retention.sql",
  checksum: checksumManifest.migrations["0018_m3_funding_dormancy_and_retention.sql"] ?? "",
  sql: fundingDormancyAndRetentionMigrationSql,
};
const reconciliationAttemptsMigration: PostgresMigration = {
  version: "0019_m3_reconciliation_attempts.sql",
  checksum: checksumManifest.migrations["0019_m3_reconciliation_attempts.sql"] ?? "",
  sql: reconciliationAttemptsMigrationSql,
};
const reconciliationFinalizationMigration: PostgresMigration = {
  version: "0020_m3_reconciliation_finalization.sql",
  checksum: checksumManifest.migrations["0020_m3_reconciliation_finalization.sql"] ?? "",
  sql: reconciliationFinalizationMigrationSql,
};
const communityPurchaseCommerceMigration: PostgresMigration = {
  version: "0021_m3_community_purchase_commerce.sql",
  checksum: checksumManifest.migrations["0021_m3_community_purchase_commerce.sql"] ?? "",
  sql: communityPurchaseCommerceMigrationSql,
};
const communityPurchaseImmutabilityMigration: PostgresMigration = {
  version: "0022_m3_community_purchase_immutability.sql",
  checksum: checksumManifest.migrations["0022_m3_community_purchase_immutability.sql"] ?? "",
  sql: communityPurchaseImmutabilityMigrationSql,
};
const communityCreationIntentsMigration: PostgresMigration = {
  version: "0023_community_creation_intents.sql",
  checksum: checksumManifest.migrations["0023_community_creation_intents.sql"] ?? "",
  sql: communityCreationIntentsMigrationSql,
};
const communityCreationPreflightTransitionMigration: PostgresMigration = {
  version: "0024_community_creation_preflight_transition.sql",
  checksum: checksumManifest.migrations["0024_community_creation_preflight_transition.sql"] ?? "",
  sql: communityCreationPreflightTransitionMigrationSql,
};
const communityCreationStorageIdentityMigration: PostgresMigration = {
  version: "0025_community_creation_storage_identity.sql",
  checksum: checksumManifest.migrations["0025_community_creation_storage_identity.sql"] ?? "",
  sql: communityCreationStorageIdentityMigrationSql,
};
const textModerationFoundationMigration: PostgresMigration = {
  version: "0026_text_moderation_foundation.sql",
  checksum: checksumManifest.migrations["0026_text_moderation_foundation.sql"] ?? "",
  sql: textModerationFoundationMigrationSql,
};
const communityRoutesAndCreationRequirementsMigration: PostgresMigration = {
  version: "0027_community_routes_and_creation_requirements.sql",
  checksum:
    checksumManifest.migrations["0027_community_routes_and_creation_requirements.sql"] ?? "",
  sql: communityRoutesAndCreationRequirementsMigrationSql,
};
const communityCreationRequirementResultGuardMigration: PostgresMigration = {
  version: "0028_community_creation_requirement_result_guard.sql",
  checksum:
    checksumManifest.migrations["0028_community_creation_requirement_result_guard.sql"] ?? "",
  sql: communityCreationRequirementResultGuardMigrationSql,
};
const namespaceOwnershipPersistenceMigration: PostgresMigration = {
  version: "0029_namespace_ownership_persistence.sql",
  checksum: checksumManifest.migrations["0029_namespace_ownership_persistence.sql"] ?? "",
  sql: namespaceOwnershipPersistenceMigrationSql,
};
const namespaceOwnershipCompletionExpiryMigration: PostgresMigration = {
  version: "0030_namespace_ownership_completion_expiry.sql",
  checksum: checksumManifest.migrations["0030_namespace_ownership_completion_expiry.sql"] ?? "",
  sql: namespaceOwnershipCompletionExpiryMigrationSql,
};
const communityCreationRouteContractMigration: PostgresMigration = {
  version: "0031_community_creation_route_contract.sql",
  checksum: checksumManifest.migrations["0031_community_creation_route_contract.sql"] ?? "",
  sql: communityCreationRouteContractMigrationSql,
};
const routeAuthorityVersionMigration: PostgresMigration = {
  version: "0032_route_authority_version.sql",
  checksum: checksumManifest.migrations["0032_route_authority_version.sql"] ?? "",
  sql: routeAuthorityVersionMigrationSql,
};
const namespaceOwnershipChallengeTopologiesMigration: PostgresMigration = {
  version: "0033_namespace_ownership_challenge_topologies.sql",
  checksum: checksumManifest.migrations["0033_namespace_ownership_challenge_topologies.sql"] ?? "",
  sql: namespaceOwnershipChallengeTopologiesMigrationSql,
};
const effectiveActiveRouteMigration: PostgresMigration = {
  version: "0034_effective_active_route.sql",
  checksum: checksumManifest.migrations["0034_effective_active_route.sql"] ?? "",
  sql: effectiveActiveRouteMigrationSql,
};
const routeRevalidationPersistenceMigration: PostgresMigration = {
  version: "0035_route_revalidation_persistence.sql",
  checksum: checksumManifest.migrations["0035_route_revalidation_persistence.sql"] ?? "",
  sql: routeRevalidationPersistenceMigrationSql,
};
const routeRevalidationCompletionMigration: PostgresMigration = {
  version: "0036_route_revalidation_completion_outcome_guard.sql",
  checksum:
    checksumManifest.migrations["0036_route_revalidation_completion_outcome_guard.sql"] ?? "",
  sql: routeRevalidationCompletionMigrationSql,
};
const textSubmissionResponseSnapshotMigration: PostgresMigration = {
  version: "0037_text_submission_response_snapshot.sql",
  checksum: checksumManifest.migrations["0037_text_submission_response_snapshot.sql"] ?? "",
  sql: textSubmissionResponseSnapshotMigrationSql,
};
const communityCreationVeryWebEvidenceMigration: PostgresMigration = {
  version: "0038_community_creation_very_web_evidence.sql",
  checksum: checksumManifest.migrations["0038_community_creation_very_web_evidence.sql"] ?? "",
  sql: communityCreationVeryWebEvidenceMigrationSql,
};
const commentsRepliesRuntimeMigration: PostgresMigration = {
  version: "0039_comments_replies_runtime.sql",
  checksum: checksumManifest.migrations["0039_comments_replies_runtime.sql"] ?? "",
  sql: commentsRepliesRuntimeMigrationSql,
};
const postVoteActionsMigration: PostgresMigration = {
  version: "0040_post_vote_actions.sql",
  checksum: checksumManifest.migrations["0040_post_vote_actions.sql"] ?? "",
  sql: postVoteActionsMigrationSql,
};
const communityRouteDatabaseExpiryMigration: PostgresMigration = {
  version: "0041_community_route_database_expiry.sql",
  checksum: checksumManifest.migrations["0041_community_route_database_expiry.sql"] ?? "",
  sql: communityRouteDatabaseExpiryMigrationSql,
};
const hnsControlObserverPersistenceMigration: PostgresMigration = {
  version: "0042_hns_control_observer_persistence.sql",
  checksum: checksumManifest.migrations["0042_hns_control_observer_persistence.sql"] ?? "",
  sql: hnsControlObserverPersistenceMigrationSql,
};
const mediaSubmissionMigration: PostgresMigration = {
  version: "0043_song_media_submission.sql",
  checksum: checksumManifest.migrations["0043_song_media_submission.sql"] ?? "",
  sql: mediaSubmissionMigrationSql,
};
const optionalRouteV2Migration: PostgresMigration = {
  version: "0044_optional_route_v2.sql",
  checksum: checksumManifest.migrations["0044_optional_route_v2.sql"] ?? "",
  sql: optionalRouteV2MigrationSql,
};
const hnsOwnerAuthorityCustodyMigration: PostgresMigration = {
  version: "0045_hns_owner_authority_custody.sql",
  checksum: checksumManifest.migrations["0045_hns_owner_authority_custody.sql"] ?? "",
  sql: hnsOwnerAuthorityCustodyMigrationSql,
};
const accountPersonaWalletPrivacyMigration: PostgresMigration = {
  version: "0046_account_persona_wallet_privacy.sql",
  checksum: checksumManifest.migrations["0046_account_persona_wallet_privacy.sql"] ?? "",
  sql: accountPersonaWalletPrivacyMigrationSql,
};
const hnsOperatorManagedRoutesMigration: PostgresMigration = {
  version: "0047_hns_operator_managed_routes.sql",
  checksum: checksumManifest.migrations["0047_hns_operator_managed_routes.sql"] ?? "",
  sql: hnsOperatorManagedRoutesMigrationSql,
};
const hnsFirstPartyHostPersistenceMigration: PostgresMigration = {
  version: "0048_hns_first_party_host_persistence.sql",
  checksum: checksumManifest.migrations["0048_hns_first_party_host_persistence.sql"] ?? "",
  sql: hnsFirstPartyHostPersistenceMigrationSql,
};
const migrations: readonly PostgresMigration[] = [
  migration,
  identityMigration,
  m2Migration,
  commentLockMigration,
  m2BehaviorMigration,
  publicProfileMigration,
  publicProfileInvariantMigration,
  communityRouteSlugMigration,
  gatesV2Migration,
  proofSessionProvenanceMigration,
  verificationStartReservationsMigration,
  verificationCompletionAttemptsMigration,
  communityPurchaseFundingJournalMigration,
  communityPurchaseFundingPlansMigration,
  identityCredentialsMigration,
  identityCredentialInvariantsMigration,
  identityCredentialDeleteGuardMigration,
  fundingDormancyAndRetentionMigration,
  reconciliationAttemptsMigration,
  reconciliationFinalizationMigration,
  communityPurchaseCommerceMigration,
  communityPurchaseImmutabilityMigration,
  communityCreationIntentsMigration,
  communityCreationPreflightTransitionMigration,
  communityCreationStorageIdentityMigration,
  textModerationFoundationMigration,
  communityRoutesAndCreationRequirementsMigration,
  communityCreationRequirementResultGuardMigration,
  namespaceOwnershipPersistenceMigration,
  namespaceOwnershipCompletionExpiryMigration,
  communityCreationRouteContractMigration,
  routeAuthorityVersionMigration,
  namespaceOwnershipChallengeTopologiesMigration,
  effectiveActiveRouteMigration,
  routeRevalidationPersistenceMigration,
  routeRevalidationCompletionMigration,
  textSubmissionResponseSnapshotMigration,
  communityCreationVeryWebEvidenceMigration,
  commentsRepliesRuntimeMigration,
  postVoteActionsMigration,
  communityRouteDatabaseExpiryMigration,
  hnsControlObserverPersistenceMigration,
  mediaSubmissionMigration,
  optionalRouteV2Migration,
  hnsOwnerAuthorityCustodyMigration,
  accountPersonaWalletPrivacyMigration,
  hnsOperatorManagedRoutesMigration,
  hnsFirstPartyHostPersistenceMigration,
];

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function schemaIdentifier(): string {
  return `api_next_foundation_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionForSchema(raw: string, schema: string): string {
  const separator = raw.includes("?") ? "&" : "?";
  const option = encodeURIComponent(`-c search_path=${schema}`);
  return `${raw}${separator}options=${option}`;
}

async function applyMigrations(
  scopedConnectionString: string,
  migrations: readonly PostgresMigration[],
): Promise<unknown> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* ControlPlaneDb;
        return yield* applyPostgresMigrations(migrations);
      }).pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(scopedConnectionString))),
    ),
  );
}

interface SchemaCatalog {
  readonly tables: readonly Record<string, unknown>[];
  readonly columns: readonly Record<string, unknown>[];
  readonly indexes: readonly Record<string, unknown>[];
  readonly constraints: readonly Record<string, unknown>[];
}

async function catalogForSchema(admin: Client, schema: string): Promise<SchemaCatalog> {
  const tables = await admin.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    [schema],
  );
  const columns = await admin.query(
    `SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = $1
     ORDER BY table_name, ordinal_position`,
    [schema],
  );
  const indexes = await admin.query<{
    readonly table_name: string;
    readonly index_name: string;
    readonly indexdef: string;
  }>(
    `SELECT tablename AS table_name, indexname AS index_name, indexdef
     FROM pg_indexes
     WHERE schemaname = $1
     ORDER BY tablename, indexname`,
    [schema],
  );
  const constraints = await admin.query(
    `SELECT relation.relname AS table_name,
            pg_constraint.conname AS constraint_name,
            pg_constraint.contype AS constraint_type,
            pg_get_constraintdef(pg_constraint.oid) AS definition
     FROM pg_constraint
     JOIN pg_class AS relation ON relation.oid = pg_constraint.conrelid
     JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = $1
     ORDER BY relation.relname, constraint_name`,
    [schema],
  );
  return {
    tables: tables.rows,
    columns: columns.rows,
    indexes: indexes.rows.map((index) => ({
      ...index,
      indexdef: index.indexdef.replaceAll(`${schema}.`, ""),
    })),
    constraints: constraints.rows,
  };
}

async function withSchema<A>(
  use: (admin: Client, connection: string, schema: string) => Promise<A>,
): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  const scopedConnectionString = connectionForSchema(connectionString, schema);
  try {
    return await use(admin, scopedConnectionString, schema);
  } finally {
    await admin.query("ROLLBACK");
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function expectForeignKeyFailure(
  admin: Client,
  text: string,
  values: readonly unknown[],
): Promise<void> {
  try {
    await admin.query({ text, values: [...values] });
    throw new Error("expected a composite foreign-key violation");
  } catch (error) {
    expect(error).toMatchObject({ code: "23503" });
  }
}

async function expectPostgresFailure(
  admin: Client,
  code: string,
  text: string,
  values: readonly unknown[],
): Promise<void> {
  try {
    await admin.query({ text, values: [...values] });
    throw new Error(`expected PostgreSQL error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

suite("Postgres 17 product and gates v2 foundation", () => {
  test("applies all migrations and matches the cumulative schema source", async () => {
    await withSchema(async (admin, scopedConnectionString, schema) => {
      expect(checksum(migrationSql)).toBe(migration.checksum);
      expect(checksum(identityMigrationSql)).toBe(identityMigration.checksum);
      expect(checksum(m2MigrationSql)).toBe(m2Migration.checksum);
      expect(checksum(publicProfileMigrationSql)).toBe(publicProfileMigration.checksum);
      expect(checksum(publicProfileInvariantMigrationSql)).toBe(
        publicProfileInvariantMigration.checksum,
      );
      expect(checksum(communityRouteSlugMigrationSql)).toBe(communityRouteSlugMigration.checksum);
      expect(checksum(gatesV2MigrationSql)).toBe(gatesV2Migration.checksum);
      expect(checksum(proofSessionProvenanceMigrationSql)).toBe(
        proofSessionProvenanceMigration.checksum,
      );
      expect(checksum(verificationStartReservationsMigrationSql)).toBe(
        verificationStartReservationsMigration.checksum,
      );
      expect(checksum(communityPurchaseFundingPlansMigrationSql)).toBe(
        communityPurchaseFundingPlansMigration.checksum,
      );
      expect(checksum(identityCredentialsMigrationSql)).toBe(identityCredentialsMigration.checksum);
      expect(checksum(identityCredentialInvariantsMigrationSql)).toBe(
        identityCredentialInvariantsMigration.checksum,
      );
      expect(checksum(identityCredentialDeleteGuardMigrationSql)).toBe(
        identityCredentialDeleteGuardMigration.checksum,
      );
      expect(checksum(fundingDormancyAndRetentionMigrationSql)).toBe(
        fundingDormancyAndRetentionMigration.checksum,
      );
      expect(checksum(reconciliationAttemptsMigrationSql)).toBe(
        reconciliationAttemptsMigration.checksum,
      );
      expect(checksum(reconciliationFinalizationMigrationSql)).toBe(
        reconciliationFinalizationMigration.checksum,
      );
      expect(checksum(communityPurchaseCommerceMigrationSql)).toBe(
        communityPurchaseCommerceMigration.checksum,
      );
      expect(checksum(communityPurchaseImmutabilityMigrationSql)).toBe(
        communityPurchaseImmutabilityMigration.checksum,
      );
      expect(checksum(communityCreationIntentsMigrationSql)).toBe(
        communityCreationIntentsMigration.checksum,
      );
      expect(checksum(communityCreationPreflightTransitionMigrationSql)).toBe(
        communityCreationPreflightTransitionMigration.checksum,
      );
      expect(checksum(communityCreationStorageIdentityMigrationSql)).toBe(
        communityCreationStorageIdentityMigration.checksum,
      );
      expect(checksum(textModerationFoundationMigrationSql)).toBe(
        textModerationFoundationMigration.checksum,
      );
      expect(checksum(communityRoutesAndCreationRequirementsMigrationSql)).toBe(
        communityRoutesAndCreationRequirementsMigration.checksum,
      );
      expect(checksum(communityCreationRequirementResultGuardMigrationSql)).toBe(
        communityCreationRequirementResultGuardMigration.checksum,
      );
      expect(checksum(namespaceOwnershipPersistenceMigrationSql)).toBe(
        namespaceOwnershipPersistenceMigration.checksum,
      );
      expect(checksum(namespaceOwnershipCompletionExpiryMigrationSql)).toBe(
        namespaceOwnershipCompletionExpiryMigration.checksum,
      );
      expect(checksum(communityCreationRouteContractMigrationSql)).toBe(
        communityCreationRouteContractMigration.checksum,
      );
      expect(checksum(routeAuthorityVersionMigrationSql)).toBe(
        routeAuthorityVersionMigration.checksum,
      );
      expect(checksum(namespaceOwnershipChallengeTopologiesMigrationSql)).toBe(
        namespaceOwnershipChallengeTopologiesMigration.checksum,
      );
      expect(checksum(effectiveActiveRouteMigrationSql)).toBe(
        effectiveActiveRouteMigration.checksum,
      );
      expect(checksum(routeRevalidationPersistenceMigrationSql)).toBe(
        routeRevalidationPersistenceMigration.checksum,
      );
      expect(checksum(routeRevalidationCompletionMigrationSql)).toBe(
        routeRevalidationCompletionMigration.checksum,
      );
      expect(checksum(textSubmissionResponseSnapshotMigrationSql)).toBe(
        textSubmissionResponseSnapshotMigration.checksum,
      );
      expect(checksum(communityCreationVeryWebEvidenceMigrationSql)).toBe(
        communityCreationVeryWebEvidenceMigration.checksum,
      );
      expect(checksum(commentsRepliesRuntimeMigrationSql)).toBe(
        commentsRepliesRuntimeMigration.checksum,
      );
      expect(checksum(postVoteActionsMigrationSql)).toBe(postVoteActionsMigration.checksum);
      expect(checksum(communityRouteDatabaseExpiryMigrationSql)).toBe(
        communityRouteDatabaseExpiryMigration.checksum,
      );
      expect(checksum(hnsControlObserverPersistenceMigrationSql)).toBe(
        hnsControlObserverPersistenceMigration.checksum,
      );
      expect(checksum(mediaSubmissionMigrationSql)).toBe(mediaSubmissionMigration.checksum);
      expect(checksum(optionalRouteV2MigrationSql)).toBe(optionalRouteV2Migration.checksum);
      expect(checksum(hnsOwnerAuthorityCustodyMigrationSql)).toBe(
        hnsOwnerAuthorityCustodyMigration.checksum,
      );
      expect(checksum(accountPersonaWalletPrivacyMigrationSql)).toBe(
        accountPersonaWalletPrivacyMigration.checksum,
      );
      expect(checksum(hnsOperatorManagedRoutesMigrationSql)).toBe(
        hnsOperatorManagedRoutesMigration.checksum,
      );
      expect(checksum(hnsFirstPartyHostPersistenceMigrationSql)).toBe(
        hnsFirstPartyHostPersistenceMigration.checksum,
      );
      const version = await admin.query<{ server_version_num: string }>("SHOW server_version_num");
      expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(170000);

      await applyMigrations(scopedConnectionString, migrations);
      const migratedCatalog = await catalogForSchema(admin, schema);
      const baselineSchema = schemaIdentifier();
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(baselineSchema)}`);
      try {
        await admin.query(`SET search_path TO ${quoteIdentifier(baselineSchema)}`);
        await admin.query(baselineSql);
        expect(migratedCatalog).toEqual(await catalogForSchema(admin, baselineSchema));
      } finally {
        await admin.query(`DROP SCHEMA ${quoteIdentifier(baselineSchema)} CASCADE`);
        await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      }

      const tables = await admin.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()",
      );
      expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
        "account_aliases",
        "action_challenges",
        "action_grants",
        "action_intents",
        "active_subject_key_bindings",
        "assertion_bindings",
        "assertion_revalidation_events",
        "assertions",
        "comment_moderation_actions",
        "comment_moderation_cases",
        "comment_publication_projection",
        "comment_reports",
        "comments",
        "communities",
        "community_canonical_route_bindings",
        "community_commerce_allocation_policy_versions",
        "community_commerce_donation_partners",
        "community_commerce_donation_policy_versions",
        "community_commerce_eligibility_policy_versions",
        "community_commerce_listings",
        "community_commerce_money_route_policy_versions",
        "community_commerce_operator_ledger",
        "community_commerce_policy_revisions",
        "community_commerce_pricing_policy_versions",
        "community_commerce_settlement_policy_versions",
        "community_creation_ceremony_attempts",
        "community_creation_ceremony_results",
        "community_creation_intent_revisions",
        "community_creation_intents",
        "community_creation_quota_approvals",
        "community_creation_requirement_states",
        "community_creation_subject_claims",
        "community_feed_projection",
        "community_follows",
        "community_memberships",
        "community_policy_current",
        "community_policy_provider_bindings",
        "community_purchase_allocation_snapshots",
        "community_purchase_availability_reservations",
        "community_purchase_correction_events",
        "community_purchase_donation_snapshots",
        "community_purchase_eligibility_snapshots",
        "community_purchase_funding_journal",
        "community_purchase_funding_plans",
        "community_purchase_funding_receipts",
        "community_purchase_funding_reconciliation_attempts",
        "community_purchase_funding_reconciliation_operator_actions",
        "community_purchase_funding_requests",
        "community_purchase_funding_transaction_claims",
        "community_purchase_funding_transitions",
        "community_purchase_intents",
        "community_purchase_pricing_snapshots",
        "community_purchase_quotes",
        "community_purchase_route_snapshots",
        "community_purchase_settlement_snapshots",
        "community_purchase_verification_snapshots",
        "community_route_app_host_health",
        "community_route_attachment_ceremony_attempts",
        "community_route_attachment_ceremony_results",
        "community_route_attachment_intent_revisions",
        "community_route_attachment_intents",
        "community_route_attachment_requirement_states",
        "community_route_authority_grants",
        "community_route_lifecycle_transitions",
        "community_route_operator_override_audit",
        "community_route_ownership_evidence",
        "community_route_revalidation_completion_attempts",
        "community_route_revalidation_evidence_snapshots",
        "community_route_revalidation_sessions",
        "community_route_revalidation_start_reservations",
        "content_publication_outbox",
        "decision_records",
        "evidence_receipts",
        "hns_authority_inventories",
        "hns_community_app_host_activation_current",
        "hns_community_app_host_activation_revisions",
        "hns_community_app_host_operations",
        "hns_control_observer_configurations",
        "hns_control_observer_operations",
        "hns_control_observer_reservations",
        "hns_control_observer_snapshot_transcript_entries",
        "hns_control_observer_snapshots",
        "hns_dns_zone_activation_current",
        "hns_dns_zone_activation_operations",
        "hns_dns_zone_activation_revisions",
        "hns_dns_zone_health_observations",
        "hns_dns_zone_health_operations",
        "hns_dns_zone_lifecycle_operations",
        "home_feed_projection",
        "identity_credentials",
        "media_alignment_projections",
        "media_analysis_evidence",
        "media_audio_revisions",
        "media_immutable_objects",
        "media_moderation_actions",
        "media_moderation_projections",
        "media_post_submissions",
        "media_processing_attempts",
        "media_publication_decisions",
        "media_publication_projections",
        "media_reference_evidence",
        "media_submission_command_replays",
        "media_submission_events",
        "media_submission_outbox",
        "media_submission_terms",
        "media_timed_lyrics_artifacts",
        "media_transcript_artifacts",
        "media_upload_reservations",
        "moderation_actions",
        "moderation_reports",
        "namespace_ownership_completion_attempts",
        "namespace_ownership_evidence_snapshots",
        "namespace_ownership_sessions",
        "namespace_ownership_start_reservations",
        "observations",
        "operator_managed_root_registry_current",
        "operator_managed_root_registry_versions",
        "operator_managed_route_activations",
        "operator_managed_route_operations",
        "persona_create_actions",
        "persona_profiles",
        "persona_role_presentations",
        "persona_wallet_assignments",
        "personas",
        "platform_operator_route_authority_grants",
        "policy_versions",
        "post_vote_actions",
        "post_votes",
        "posts",
        "proof_session_completion_events",
        "proof_session_presentations",
        "proof_sessions",
        "public_handle_index",
        "reward_subject_consumptions",
        "reward_uniqueness_authorities",
        "schema_migrations",
        "subject_key_binding_events",
        "subject_keys",
        "text_content_held_revisions",
        "text_content_submissions",
        "text_moderation_cases",
        "text_moderation_evidence",
        "text_moderation_policy_current",
        "text_moderation_policy_revisions",
        "used_action_grants",
        "users",
        "verification_completion_attempts",
        "verification_start_reservations",
      ]);

      await admin.query(
        `INSERT INTO users (user_id, status, account)
         VALUES ('credential-user-a', 'active', '{}'::jsonb),
                ('credential-user-b', 'active', '{}'::jsonb)`,
      );
      await admin.query(
        `INSERT INTO identity_credentials (
           credential_id, provider, provider_app_id, provider_subject,
           canonical_user_id, updated_at
         ) VALUES (
           'credential-a', 'privy', 'app-staging', 'did:privy:subject-a',
           'credential-user-a', '2000-01-01T00:00:00Z'
         )`,
      );
      await expectPostgresFailure(
        admin,
        "23514",
        `UPDATE identity_credentials
         SET canonical_user_id = 'credential-user-b'
         WHERE credential_id = 'credential-a'`,
        [],
      );
      await admin.query(
        `UPDATE identity_credentials
         SET status = 'tombstoned', tombstoned_at = '1970-01-01T00:00:00Z'
         WHERE credential_id = 'credential-a'`,
      );
      const tombstone = await admin.query<{
        readonly status: string;
        readonly tombstoned_at: Date | null;
        readonly updated_at: Date;
      }>(
        `SELECT status, tombstoned_at, updated_at
         FROM identity_credentials
         WHERE credential_id = 'credential-a'`,
      );
      expect(tombstone.rows[0]?.status).toBe("tombstoned");
      expect(tombstone.rows[0]?.tombstoned_at).toBeInstanceOf(Date);
      expect(tombstone.rows[0]?.tombstoned_at?.getUTCFullYear()).toBeGreaterThan(1970);
      expect(tombstone.rows[0]?.updated_at.getUTCFullYear()).toBeGreaterThan(2000);
      await expectPostgresFailure(
        admin,
        "23514",
        `UPDATE identity_credentials
         SET status = 'active', tombstoned_at = NULL
         WHERE credential_id = 'credential-a'`,
        [],
      );
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO identity_credentials (
           credential_id, provider, provider_app_id, provider_subject, canonical_user_id
         ) VALUES (
           'credential-reuse', 'privy', 'app-staging', 'did:privy:subject-a',
           'credential-user-b'
         )`,
        [],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        "DELETE FROM identity_credentials WHERE credential_id = 'credential-a'",
        [],
      );

      const gateTriggers = await admin.query<{ trigger_name: string }>(
        `SELECT trigger.tgname AS trigger_name
         FROM pg_trigger AS trigger
         JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = current_schema()
           AND NOT trigger.tgisinternal
           AND (trigger.tgname LIKE '%_append_only'
             OR trigger.tgname IN ('evidence_receipts_validate_metadata', 'assertions_validate_binding'))
         ORDER BY trigger.tgname`,
      );
      expect(gateTriggers.rows.map((row) => row.trigger_name)).toEqual([
        "action_grants_append_only",
        "assertion_bindings_append_only",
        "assertion_revalidation_events_append_only",
        "assertions_append_only",
        "assertions_validate_binding",
        "community_commerce_allocation_policy_append_only",
        "community_commerce_donation_policy_append_only",
        "community_commerce_eligibility_policy_append_only",
        "community_commerce_operator_ledger_append_only",
        "community_commerce_pricing_policy_append_only",
        "community_commerce_route_policy_append_only",
        "community_commerce_settlement_policy_append_only",
        "community_creation_ceremony_attempt_append_only",
        "community_creation_ceremony_result_append_only",
        "community_creation_intent_revision_append_only",
        "community_creation_quota_approval_append_only",
        "community_creation_subject_claim_append_only",
        "community_policy_provider_binding_append_only",
        "community_purchase_allocation_snapshot_append_only",
        "community_purchase_correction_event_append_only",
        "community_purchase_donation_snapshot_append_only",
        "community_purchase_eligibility_snapshot_append_only",
        "community_purchase_funding_claims_append_only",
        "community_purchase_funding_receipts_append_only",
        "community_purchase_funding_transitions_append_only",
        "community_purchase_pricing_snapshot_append_only",
        "community_purchase_route_snapshot_append_only",
        "community_purchase_settlement_snapshot_append_only",
        "community_purchase_verification_snapshot_append_only",
        "community_route_attachment_attempt_append_only",
        "community_route_attachment_result_append_only",
        "community_route_attachment_revision_append_only",
        "community_route_lifecycle_transition_append_only",
        "community_route_ownership_evidence_append_only",
        "community_route_revalidation_snapshot_append_only",
        "decision_records_append_only",
        "evidence_receipts_append_only",
        "evidence_receipts_validate_metadata",
        "hns_authority_inventories_append_only",
        "hns_community_app_host_activation_revisions_append_only",
        "hns_community_app_host_operations_append_only",
        "hns_control_observer_configurations_append_only",
        "hns_control_observer_operations_append_only",
        "hns_control_observer_snapshots_append_only",
        "hns_control_observer_transcript_entries_append_only",
        "hns_dns_zone_activation_revisions_append_only",
        "hns_dns_zone_health_observations_append_only",
        "hns_dns_zone_health_operations_append_only",
        "hns_dns_zone_lifecycle_operations_append_only",
        "media_analysis_evidence_append_only",
        "media_audio_revisions_append_only",
        "media_immutable_objects_append_only",
        "media_moderation_actions_append_only",
        "media_publication_decisions_append_only",
        "media_reference_evidence_append_only",
        "media_submission_command_replays_append_only",
        "media_submission_events_append_only",
        "media_submission_terms_append_only",
        "media_timed_lyrics_artifacts_append_only",
        "media_transcript_artifacts_append_only",
        "namespace_ownership_evidence_snapshot_append_only",
        "observations_append_only",
        "persona_create_actions_append_only",
        "policy_versions_append_only",
        "proof_session_completion_events_append_only",
        "proof_session_presentations_append_only",
        "reward_subject_consumptions_append_only",
        "reward_uniqueness_authorities_append_only",
        "subject_key_binding_events_append_only",
        "subject_keys_append_only",
        "text_content_held_revisions_append_only",
        "text_moderation_evidence_append_only",
        "text_moderation_policy_revisions_append_only",
        "used_action_grants_append_only",
      ]);

      const columns = await admin.query<{
        readonly table_name: string;
        readonly column_name: string;
        readonly is_nullable: string;
      }>(
        `SELECT table_name, column_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND ((table_name = 'communities' AND column_name IN ('membership_mode', 'human_verification_lane', 'route_slug'))
             OR (table_name = 'community_memberships' AND column_name = 'request_note')
             OR (table_name = 'posts' AND column_name IN ('author_user_id', 'body', 'post_type', 'visibility', 'idempotency_key', 'idempotency_body_hash', 'comments_locked'))
             OR (table_name = 'comments' AND column_name IN ('author_user_id', 'body', 'idempotency_key', 'idempotency_body_hash', 'depth'))
             OR (table_name = 'evidence_receipts' AND column_name IN ('provider_configuration_kind', 'provider_configuration_ref', 'provider_configuration_version'))
             OR (table_name = 'proof_sessions' AND column_name IN ('provider_configuration_kind', 'provider_configuration_ref', 'provider_configuration_version'))
             OR (table_name = 'proof_session_presentations' AND column_name IN ('proof_session_id', 'presentation_kind', 'payload', 'created_at')) )`,
      );
      expect(columns.rows).toEqual(
        expect.arrayContaining([
          { table_name: "posts", column_name: "author_user_id", is_nullable: "YES" },
          { table_name: "posts", column_name: "body", is_nullable: "YES" },
          { table_name: "posts", column_name: "post_type", is_nullable: "NO" },
          { table_name: "posts", column_name: "visibility", is_nullable: "NO" },
          { table_name: "posts", column_name: "idempotency_key", is_nullable: "NO" },
          { table_name: "posts", column_name: "idempotency_body_hash", is_nullable: "YES" },
          { table_name: "posts", column_name: "comments_locked", is_nullable: "NO" },
          { table_name: "comments", column_name: "author_user_id", is_nullable: "YES" },
          { table_name: "comments", column_name: "body", is_nullable: "YES" },
          { table_name: "comments", column_name: "idempotency_key", is_nullable: "NO" },
          { table_name: "comments", column_name: "idempotency_body_hash", is_nullable: "YES" },
          { table_name: "comments", column_name: "depth", is_nullable: "NO" },
          {
            table_name: "community_memberships",
            column_name: "request_note",
            is_nullable: "YES",
          },
          { table_name: "communities", column_name: "membership_mode", is_nullable: "NO" },
          {
            table_name: "communities",
            column_name: "human_verification_lane",
            is_nullable: "YES",
          },
          { table_name: "communities", column_name: "route_slug", is_nullable: "YES" },
          {
            table_name: "evidence_receipts",
            column_name: "provider_configuration_kind",
            is_nullable: "NO",
          },
          {
            table_name: "evidence_receipts",
            column_name: "provider_configuration_ref",
            is_nullable: "NO",
          },
          {
            table_name: "evidence_receipts",
            column_name: "provider_configuration_version",
            is_nullable: "NO",
          },
          {
            table_name: "proof_sessions",
            column_name: "provider_configuration_kind",
            is_nullable: "NO",
          },
          {
            table_name: "proof_sessions",
            column_name: "provider_configuration_ref",
            is_nullable: "NO",
          },
          {
            table_name: "proof_sessions",
            column_name: "provider_configuration_version",
            is_nullable: "NO",
          },
          {
            table_name: "proof_session_presentations",
            column_name: "proof_session_id",
            is_nullable: "NO",
          },
          {
            table_name: "proof_session_presentations",
            column_name: "presentation_kind",
            is_nullable: "NO",
          },
          {
            table_name: "proof_session_presentations",
            column_name: "payload",
            is_nullable: "NO",
          },
          {
            table_name: "proof_session_presentations",
            column_name: "created_at",
            is_nullable: "NO",
          },
        ]),
      );

      const postStatus = await admin.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conrelid = 'posts'::regclass AND contype = 'c' AND conname = 'posts_status_check'`,
      );
      expect(postStatus.rows[0]?.definition).toContain("processing");
      expect(postStatus.rows[0]?.definition).toContain("removed");

      const routeSlugIndex = await admin.query<{ indexdef: string }>(
        `SELECT indexdef
           FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'communities_route_slug_uidx'`,
      );
      expect(routeSlugIndex.rows).toHaveLength(1);
      expect(routeSlugIndex.rows[0]?.indexdef).toContain("WHERE (route_slug IS NOT NULL)");

      const communityOrdinals = await admin.query<{
        readonly column_name: string;
        readonly ordinal_position: number;
      }>(
        `SELECT column_name, ordinal_position
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'communities'
          ORDER BY ordinal_position`,
      );
      expect(communityOrdinals.rows).toEqual([
        { column_name: "community_id", ordinal_position: 1 },
        { column_name: "display_name", ordinal_position: 2 },
        { column_name: "status", ordinal_position: 3 },
        { column_name: "created_by_user_id", ordinal_position: 4 },
        { column_name: "created_at", ordinal_position: 5 },
        { column_name: "updated_at", ordinal_position: 6 },
        { column_name: "membership_mode", ordinal_position: 7 },
        { column_name: "human_verification_lane", ordinal_position: 8 },
        { column_name: "route_slug", ordinal_position: 9 },
        { column_name: "description", ordinal_position: 10 },
        { column_name: "canonical_route_binding_id", ordinal_position: 11 },
        { column_name: "route_authority_version", ordinal_position: 12 },
      ]);
    });
    completedTestCount += 1;
  });

  test("refuses to invent provider configuration for an unexpected existing session", async () => {
    await withSchema(async (admin, scopedConnectionString) => {
      await applyMigrations(
        scopedConnectionString,
        migrations.slice(0, migrations.indexOf(proofSessionProvenanceMigration)),
      );
      await admin.query("INSERT INTO users (user_id) VALUES ('unexpected-user')");
      await admin.query(`INSERT INTO proof_sessions (
        proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
        scope_kind, request_mode, protocol_version, environment, status,
        requested_requirements, requested_claim_ids, subject_binding_intent, started_at, expires_at
      ) VALUES (
        'unexpected-session', 'unexpected-user', 'unexpected-intent', '${"f".repeat(64)}',
        'unexpected.provider', 'document', 'unexpected.provider', 'none', 'dynamic',
        'unexpected-v1', 'test', 'pending', '[{"claim_id":"document.valid"}]'::jsonb,
        '["document.valid"]'::jsonb, 'none',
        '2026-08-17T00:00:00.000Z', '2026-08-18T00:00:00.000Z'
      )`);

      await expect(applyMigrations(scopedConnectionString, migrations)).rejects.toBeDefined();
      const applied = await admin.query<{ version: string }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      expect(applied.rows.at(-1)?.version).toBe(gatesV2Migration.version);
      const provenanceColumns = await admin.query<{ count: string }>(
        `SELECT count(*)
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'proof_sessions'
            AND column_name LIKE 'provider_configuration_%'`,
      );
      expect(provenanceColumns.rows[0]?.count).toBe("0");
    });
    completedTestCount += 1;
  });

  test("enforces gates v2 scope, co-reference, policy, and action-grant invariants", async () => {
    await withSchema(async (admin, scopedConnectionString) => {
      await applyMigrations(scopedConnectionString, migrations);
      const now = new Date("2026-08-17T00:00:00.000Z");
      const later = new Date("2026-08-18T00:00:00.000Z");
      const requestHash = "1".repeat(64);
      const evidenceHash = "2".repeat(64);
      const subjectDigest = "3".repeat(64);

      await admin.query({
        text: "INSERT INTO users (user_id) VALUES ($1), ($2)",
        values: ["user-a", "user-b"],
      });
      await expectPostgresFailure(
        admin,
        "23502",
        `INSERT INTO proof_sessions (
          proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
          scope_kind, issuer_rp_scope, request_mode, protocol_version, environment, status,
          requested_requirements, requested_claim_ids, started_at, expires_at,
          provider_configuration_kind, provider_configuration_ref, provider_configuration_version
        ) VALUES ('session-implicit-binding', 'user-a', 'intent-implicit-binding', $1,
          'test.fake', 'document', 'test.fake', 'issuer_rp_scope', 'pirate.example', 'dynamic',
          'fake-v2', 'test', 'pending', '[{"claim_id":"document.valid"}]'::jsonb,
          '["document.valid"]'::jsonb, $2, $3, 'dynamic', 'test-config', '1')`,
        ["0".repeat(64), now, later],
      );
      await admin.query({
        text: "INSERT INTO communities (community_id, display_name, created_by_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
        values: ["community-a", "Community A", "user-a", now],
      });
      await admin.query({
        text: `INSERT INTO proof_sessions (
          proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
          scope_kind, issuer_rp_scope, request_mode, protocol_version, environment, status,
          upstream_session_ref, requested_requirements, requested_claim_ids,
          subject_binding_intent, started_at, expires_at,
          provider_configuration_kind, provider_configuration_ref, provider_configuration_version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'issuer_rp_scope', $8, 'dynamic', $9, $10,
          'pending', 'upstream-a', $11::jsonb, $12::jsonb, 'establish', $13, $14,
          'dynamic', 'test-config', '1')`,
        values: [
          "session-a",
          "user-a",
          "intent-a",
          requestHash,
          "test.fake",
          "document",
          "test.fake",
          "pirate.example",
          "fake-v2",
          "test",
          JSON.stringify([
            { claim_id: "credential.subject_unique" },
            { claim_id: "document.valid" },
          ]),
          JSON.stringify(["credential.subject_unique", "document.valid"]),
          now,
          later,
        ],
      });
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO proof_sessions (
          proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
          scope_kind, issuer_rp_scope, request_mode, protocol_version, environment, status,
          requested_requirements, requested_claim_ids, subject_binding_intent, started_at,
          expires_at, provider_configuration_kind, provider_configuration_ref,
          provider_configuration_version
        ) VALUES ('session-requirement-drift', 'user-b', 'intent-requirement-drift', $1,
          'test.fake', 'document', 'test.fake', 'issuer_rp_scope', 'pirate.example', 'dynamic',
          'fake-v2', 'test', 'pending', '[{"claim_id":"age.minimum","minimum_age":"21"}]'::jsonb,
          '["document.valid"]'::jsonb, 'establish', $2, $3, 'dynamic', 'test-config', '1')`,
        ["9".repeat(64), now, later],
      );
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO proof_sessions (
          proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
          scope_kind, issuer_rp_scope, request_mode, protocol_version, environment, status,
          upstream_session_ref, requested_requirements, requested_claim_ids,
          subject_binding_intent, started_at, expires_at,
          provider_configuration_kind, provider_configuration_ref, provider_configuration_version
        ) VALUES ('session-provider-replay', 'user-b', 'intent-provider-replay', $1,
          'test.fake', 'document', 'test.fake', 'issuer_rp_scope', 'pirate.example', 'dynamic',
          'fake-v2', 'test', 'pending', 'upstream-a',
          '[{"claim_id":"document.valid"}]'::jsonb, '["document.valid"]'::jsonb,
          'establish', $2, $3, 'dynamic', 'test-config', '1')`,
        ["f".repeat(64), now, later],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        "UPDATE proof_sessions SET upstream_session_ref = 'upstream-rebound' WHERE proof_session_id = 'session-a'",
        [],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        `UPDATE proof_sessions
            SET requested_requirements =
              '[{"claim_id":"credential.subject_unique","variant":"changed"},
                {"claim_id":"document.valid"}]'::jsonb
          WHERE proof_session_id = 'session-a'`,
        [],
      );
      await admin.query({
        text: `INSERT INTO subject_keys (
          subject_key_id, issuer, method, scope_kind, issuer_rp_scope,
          subject_digest, digest_algorithm, created_at
        ) VALUES ($1, $2, $3, 'issuer_rp_scope', $4, $5, 'sha256', $6)`,
        values: ["subject-a", "test.fake", "document", "pirate.example", subjectDigest, now],
      });
      await admin.query({
        text: `INSERT INTO subject_keys (
          subject_key_id, issuer, method, scope_kind, issuer_rp_scope,
          subject_digest, digest_algorithm, created_at
        ) VALUES ($1, $2, $3, 'issuer_rp_scope', $4, $5, 'sha256', $6)`,
        values: ["subject-b", "test.fake", "document", "pirate.example", "4".repeat(64), now],
      });
      await admin.query({
        text: `INSERT INTO subject_key_binding_events (
          binding_event_id, subject_key_id, binding_epoch, user_id, proof_session_id,
          binding_kind, previous_binding_event_id, idempotency_key, bound_at
        ) VALUES
          ('binding-event-a', 'subject-a', 1, 'user-a', 'session-a', 'initial', NULL,
            'bind-subject-a', $1),
          ('binding-event-b', 'subject-b', 1, 'user-a', 'session-a', 'initial', NULL,
            'bind-subject-b', $1)`,
        values: [now],
      });
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO subject_keys (
          subject_key_id, issuer, method, scope_kind, issuer_rp_scope,
          subject_digest, digest_algorithm, created_at
        ) VALUES ($1, $2, $3, 'issuer_rp_scope', $4, $5, 'sha256', $6)`,
        ["subject-duplicate", "test.fake", "document", "pirate.example", subjectDigest, now],
      );
      await admin.query({
        text: `INSERT INTO subject_keys (
          subject_key_id, issuer, method, scope_kind, issuer_rp_scope,
          subject_digest, digest_algorithm, created_at
        ) VALUES ($1, $2, $3, 'issuer_rp_scope', $4, $5, 'sha256', $6)`,
        values: [
          "subject-other-scope",
          "test.fake",
          "document",
          "other.example",
          subjectDigest,
          now,
        ],
      });
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO evidence_receipts (
          evidence_receipt_id, proof_session_id, user_id, provider_id, issuer, method,
          scope_kind, issuer_rp_scope, protocol_version, environment, evidence_kind,
          evidence_hash, receipt_metadata, observed_at, provenance_kind, subject_key_id,
          subject_binding_event_id, subject_binding_epoch, provider_configuration_kind,
          provider_configuration_ref, provider_configuration_version
        ) VALUES ($1, $2, $3, $4, $5, $6, 'issuer_rp_scope', $7, $8, $9, $10, $11,
          '{}'::jsonb, $12, 'proof_session', $13, $14, 1, 'dynamic', 'test-config', '1')`,
        [
          "receipt-wrong-provider",
          "session-a",
          "user-a",
          "other.fake",
          "test.fake",
          "document",
          "pirate.example",
          "fake-v2",
          "test",
          "document",
          "a".repeat(64),
          now,
          "subject-a",
          "binding-event-a",
        ],
      );
      await admin.query({
        text: `INSERT INTO evidence_receipts (
          evidence_receipt_id, proof_session_id, user_id, provider_id, issuer, method,
          scope_kind, issuer_rp_scope, protocol_version, environment, evidence_kind,
          evidence_hash, receipt_metadata, observed_at, provenance_kind, subject_key_id,
          subject_binding_event_id, subject_binding_epoch, provider_configuration_kind,
          provider_configuration_ref, provider_configuration_version
        ) VALUES ($1, $2, $3, $4, $5, $6, 'issuer_rp_scope', $7, $8, $9, $10, $11,
          '{}'::jsonb, $12, 'proof_session', $13, $14, 1, 'dynamic', 'test-config', '1')`,
        values: [
          "receipt-a",
          "session-a",
          "user-a",
          "test.fake",
          "test.fake",
          "document",
          "pirate.example",
          "fake-v2",
          "test",
          "document",
          evidenceHash,
          now,
          "subject-a",
          "binding-event-a",
        ],
      });
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO evidence_receipts (
          evidence_receipt_id, proof_session_id, user_id, provider_id, issuer, method,
          scope_kind, issuer_rp_scope, protocol_version, environment, evidence_kind,
          evidence_hash, receipt_metadata, observed_at, provenance_kind,
          provider_configuration_kind, provider_configuration_ref, provider_configuration_version
        ) VALUES ('receipt-wrong-configuration', 'session-a', 'user-a', 'test.fake',
          'test.fake', 'document', 'issuer_rp_scope', 'pirate.example', 'fake-v2', 'test',
          'document', $1, '{}'::jsonb, $2, 'proof_session', 'dynamic', 'other-config', '1')`,
        ["b".repeat(64), now],
      );
      await admin.query({
        text: `INSERT INTO assertion_bindings (
          binding_group_id, user_id, binding_mode, subject_key_id,
          subject_binding_event_id, subject_binding_epoch
        ) VALUES
          ($1, $2, 'same_subject', $3, $4, 1),
          ($5, $2, 'same_subject', $6, $7, 1)`,
        values: [
          "binding-a",
          "user-a",
          "subject-a",
          "binding-event-a",
          "binding-b",
          "subject-b",
          "binding-event-b",
        ],
      });
      await admin.query({
        text: `INSERT INTO assertions (
          assertion_id, binding_group_id, evidence_receipt_id, subject_key_id, user_id,
          claim_id, assertion_value, assurance, observed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
        values: [
          "assertion-a",
          "binding-a",
          "receipt-a",
          "subject-a",
          "user-a",
          "credential.subject_unique",
          JSON.stringify({ subject_unique: true }),
          "document_zk",
          now,
        ],
      });
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO assertions (
          assertion_id, binding_group_id, evidence_receipt_id, subject_key_id, user_id,
          claim_id, assertion_value, assurance, observed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, $8)`,
        [
          "assertion-wrong-anchor",
          "binding-b",
          "receipt-a",
          "subject-a",
          "user-a",
          "document.valid",
          "document_zk",
          now,
        ],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        "UPDATE assertions SET assurance = $1 WHERE assertion_id = $2",
        ["provider_attested", "assertion-a"],
      );

      const completionHash = "d".repeat(64);
      await expectPostgresFailure(
        admin,
        "23514",
        `UPDATE proof_sessions
          SET status = 'completed', completion_idempotency_key = $1,
              completion_result_hash = $2, terminal_at = $3, completed_at = $3,
              updated_at = $3
          WHERE proof_session_id = 'session-a'`,
        ["complete-session-a", completionHash, now],
      );
      await admin.query("BEGIN");
      await admin.query({
        text: `UPDATE proof_sessions
          SET status = 'completed', completion_idempotency_key = $1,
              completion_result_hash = $2, terminal_at = $3, completed_at = $3,
              updated_at = $3
          WHERE proof_session_id = 'session-a'`,
        values: ["complete-session-a", completionHash, now],
      });
      await admin.query({
        text: `INSERT INTO proof_session_completion_events (
          completion_event_id, proof_session_id, actor_id, idempotency_key,
          terminal_status, result_hash, terminal_at
        ) VALUES ('completion-a', 'session-a', 'user-a', $1, 'completed', $2, $3)`,
        values: ["complete-session-a", completionHash, now],
      });
      await admin.query("COMMIT");
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO proof_session_completion_events (
          completion_event_id, proof_session_id, actor_id, idempotency_key,
          terminal_status, result_hash, terminal_at
        ) VALUES ('completion-replay', 'session-a', 'user-a', $1, 'completed', $2, $3)`,
        ["complete-session-a", completionHash, now],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        "UPDATE proof_sessions SET status = 'failed' WHERE proof_session_id = 'session-a'",
        [],
      );

      await admin.query({
        text: `INSERT INTO reward_uniqueness_authorities (
          campaign_id, issuer, method, scope_kind, issuer_rp_scope
        ) VALUES ('campaign-a', 'test.fake', 'document', 'issuer_rp_scope', 'pirate.example'),
          ('campaign-b', 'test.fake', 'document', 'issuer_rp_scope', 'pirate.example')`,
      });
      await admin.query({
        text: `INSERT INTO reward_subject_consumptions (
          reward_subject_consumption_id, campaign_id, subject_key_id, user_id,
          binding_event_id, binding_epoch, evidence_receipt_id
        ) VALUES ('reward-a', 'campaign-a', 'subject-a', 'user-a',
          'binding-event-a', 1, 'receipt-a')`,
      });
      await admin.query({
        text: `INSERT INTO proof_sessions (
          proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
          scope_kind, issuer_rp_scope, request_mode, protocol_version, environment, status,
          requested_requirements, requested_claim_ids, subject_binding_intent, started_at,
          expires_at, provider_configuration_kind, provider_configuration_ref,
          provider_configuration_version
        ) VALUES ('session-ordinary', 'user-b', 'intent-ordinary', $1, 'test.fake',
          'document', 'test.fake', 'issuer_rp_scope', 'pirate.example', 'dynamic', 'fake-v2', 'test',
          'pending', '[{"claim_id":"document.valid"}]'::jsonb,
          '["document.valid"]'::jsonb, 'establish', $2, $3, 'dynamic', 'test-config', '1')`,
        values: ["c".repeat(64), now, later],
      });
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO subject_key_binding_events (
          binding_event_id, subject_key_id, binding_epoch, user_id, proof_session_id,
          binding_kind, previous_binding_event_id, idempotency_key, bound_at
        ) VALUES ('binding-event-unauthorized', 'subject-a', 2, 'user-b', 'session-ordinary',
          'recovery', 'binding-event-a', 'unauthorized-recovery', $1)`,
        [now],
      );
      await admin.query({
        text: `INSERT INTO proof_sessions (
          proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
          scope_kind, issuer_rp_scope, request_mode, protocol_version, environment, status,
          requested_requirements, requested_claim_ids, subject_binding_intent, started_at,
          expires_at, provider_configuration_kind, provider_configuration_ref,
          provider_configuration_version
        ) VALUES ('session-recovery', 'user-b', 'intent-recovery', $1, 'test.fake',
          'document', 'test.fake', 'issuer_rp_scope', 'pirate.example', 'dynamic', 'fake-v2', 'test',
          'pending', '[{"claim_id":"document.valid"}]'::jsonb,
          '["document.valid"]'::jsonb, 'recover', $2, $3, 'dynamic', 'test-config', '1')`,
        values: ["e".repeat(64), now, later],
      });
      await admin.query({
        text: `INSERT INTO subject_key_binding_events (
          binding_event_id, subject_key_id, binding_epoch, user_id, proof_session_id,
          binding_kind, previous_binding_event_id, idempotency_key, bound_at
        ) VALUES ('binding-event-recovery', 'subject-a', 2, 'user-b', 'session-recovery',
          'recovery', 'binding-event-a', 'recover-subject-a', $1)`,
        values: [now],
      });
      expect(
        (
          await admin.query<{ user_id: string; binding_epoch: string }>(
            "SELECT user_id, binding_epoch::text FROM active_subject_key_bindings WHERE subject_key_id = 'subject-a'",
          )
        ).rows[0],
      ).toEqual({ user_id: "user-b", binding_epoch: "2" });
      await expectPostgresFailure(
        admin,
        "23514",
        "UPDATE active_subject_key_bindings SET user_id = 'user-a' WHERE subject_key_id = 'subject-a'",
        [],
      );
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO evidence_receipts (
          evidence_receipt_id, proof_session_id, user_id, provider_id, issuer, method,
          scope_kind, issuer_rp_scope, protocol_version, environment, evidence_kind,
          evidence_hash, receipt_metadata, observed_at, provenance_kind, subject_key_id,
          subject_binding_event_id, subject_binding_epoch, provider_configuration_kind,
          provider_configuration_ref, provider_configuration_version
        ) VALUES ('receipt-provider-replay', 'session-recovery', 'user-b', 'test.fake',
          'test.fake', 'document', 'issuer_rp_scope', 'pirate.example', 'fake-v2', 'test',
          'document', $1, '{}'::jsonb, $2, 'proof_session', 'subject-a',
          'binding-event-recovery', 2, 'dynamic', 'test-config', '1')`,
        [evidenceHash, now],
      );
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO reward_subject_consumptions (
          reward_subject_consumption_id, campaign_id, subject_key_id, user_id,
          binding_event_id, binding_epoch
        ) VALUES ('reward-rebound', 'campaign-a', 'subject-a', 'user-b',
          'binding-event-recovery', 2)`,
        [],
      );
      await admin.query({
        text: `INSERT INTO reward_subject_consumptions (
          reward_subject_consumption_id, campaign_id, subject_key_id, user_id,
          binding_event_id, binding_epoch
        ) VALUES ('reward-other-campaign', 'campaign-b', 'subject-a', 'user-b',
          'binding-event-recovery', 2)`,
      });

      const inventoryResponseHash = "b".repeat(64);
      for (const tokenId of ["1", "2"]) {
        const assetId = `eip155:137/erc721:0x0000000000000000000000000000000000000001/${tokenId}`;
        await admin.query({
          text: `INSERT INTO observations (
            observation_id, user_id, resolver_id, source_id, claim_id, observation_kind,
            subject_ref, observation_value, chain_id, account_caip10, asset_caip19,
            aggregation_mode, trust_mode, completeness, snapshot_ref, source_response_hash,
            descriptor_version, observed_at
          ) VALUES ($1, 'user-a', 'courtyard', 'inventory-response-1', 'asset.ownership',
            'asset_inventory', 'wallet-a', $3::jsonb, 'eip155:137',
            'eip155:137:0x000000000000000000000000000000000000000a', $2, 'any_wallet',
            'provider_asserted', 'complete',
            '{"kind":"provider_snapshot","reference":"inventory-response-1"}'::jsonb,
            $4, '1', $5)`,
          values: [
            `observation-${tokenId}`,
            assetId,
            JSON.stringify({
              kind: "asset_inventory",
              chain_id: "eip155:137",
              account_id: "eip155:137:0x000000000000000000000000000000000000000a",
              asset_id: assetId,
              quantity: "1",
              descriptor: {
                kind: "token",
                schema_version: "1",
                chain_id: "eip155:137",
                asset_id: assetId,
                contract_address: "0x0000000000000000000000000000000000000001",
                token_id: tokenId,
                normalized_match: `courtyard-token-${tokenId}`,
                match_semantics: "exact",
              },
            }),
            inventoryResponseHash,
            now,
          ],
        });
      }
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO observations (
          observation_id, user_id, resolver_id, source_id, claim_id, observation_kind,
          subject_ref, observation_value, chain_id, aggregation_mode, trust_mode, completeness,
          snapshot_ref, source_response_hash, descriptor_version, observed_at
        ) VALUES ('observation-invalid', 'user-a', 'predicate', 'response-2',
          'disclosed.predicate', 'disclosed_predicate', 'user-a', $1::jsonb, 'eip155:137',
          'single_wallet', 'provider_asserted', 'complete', $2::jsonb, $3, '1', $4)`,
        [
          JSON.stringify({ kind: "disclosed_predicate", predicate: "eligible", value: true }),
          JSON.stringify({ kind: "provider_snapshot", reference: "response-2" }),
          "c".repeat(64),
          now,
        ],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        "UPDATE observations SET completeness = 'partial' WHERE observation_id = $1",
        ["observation-1"],
      );

      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO policy_versions (
          policy_version_id, community_id, policy_key, revision, policy_hash, policy,
          compiled_plan, compiler_version, uniqueness_model, policy_purpose,
          created_by_user_id, published_at
        ) VALUES ('policy-reward-unlinked', 'community-a', 'reward-unlinked', 1, $1,
          '{}'::jsonb, '{}'::jsonb, 'v2', '{}'::jsonb, 'reward', 'user-a', $2)`,
        ["0".repeat(64), now],
      );
      await expectPostgresFailure(
        admin,
        "23503",
        `INSERT INTO policy_versions (
          policy_version_id, community_id, policy_key, revision, policy_hash, policy,
          compiled_plan, compiler_version, uniqueness_model, policy_purpose,
          uniqueness_authority_id, created_by_user_id, published_at
        ) VALUES ('policy-reward-missing-authority', 'community-a', 'reward-missing', 1, $1,
          '{}'::jsonb, '{}'::jsonb, 'v2', $2::jsonb, 'reward', 'campaign-missing',
          'user-a', $3)`,
        [
          "1".repeat(64),
          JSON.stringify({ kind: "single_authority", authority_id: "campaign-missing" }),
          now,
        ],
      );
      const policyRows = [
        ["policy-access-v2", "access", "5".repeat(64), "access", { kind: "none" }, null],
        [
          "policy-reward-v2",
          "reward",
          "6".repeat(64),
          "reward",
          { kind: "single_authority", authority_id: "campaign-a" },
          "campaign-a",
        ],
      ] as const;
      for (const [
        policyVersionId,
        policyKey,
        policyHash,
        policyPurpose,
        uniquenessModel,
        authorityId,
      ] of policyRows) {
        await admin.query({
          text: `INSERT INTO policy_versions (
            policy_version_id, community_id, policy_key, revision, policy_hash, policy,
            compiled_plan, compiler_version, uniqueness_model, policy_purpose,
            uniqueness_authority_id, created_by_user_id, published_at
          ) VALUES ($1, 'community-a', $2, 1, $3, '{}'::jsonb, '{}'::jsonb, 'v2',
            $4::jsonb, $5, $6, 'user-a', $7)`,
          values: [
            policyVersionId,
            policyKey,
            policyHash,
            JSON.stringify(uniquenessModel),
            policyPurpose,
            authorityId,
            now,
          ],
        });
        await admin.query({
          text: `INSERT INTO community_policy_current (
            community_id, policy_key, policy_version_id, activated_at
          ) VALUES ('community-a', $1, $2, $3)`,
          values: [policyKey, policyVersionId, now],
        });
      }
      await admin.query({
        text: `INSERT INTO communities (
          community_id, display_name, created_by_user_id, created_at, updated_at,
          route_slug, description
        ) VALUES ('community-b', 'Community B', 'user-b', $1, $1, 'community-b', $2)`,
        values: [now, "Second canonical policy installation"],
      });
      await admin.query({
        text: `INSERT INTO policy_versions (
          policy_version_id, community_id, policy_key, revision, policy_hash, policy,
          compiled_plan, compiler_version, uniqueness_model, policy_purpose,
          created_by_user_id, published_at
        ) VALUES ('policy-access-v2', 'community-b', 'access', 1, $1,
          '{}'::jsonb, '{}'::jsonb, 'v2', '{"kind":"none"}'::jsonb,
          'access', 'user-b', $2)`,
        values: ["7".repeat(64), now],
      });
      for (const [communityId, policyHash] of [
        ["community-a", "5".repeat(64)],
        ["community-b", "7".repeat(64)],
      ] as const) {
        await admin.query({
          text: `INSERT INTO community_policy_provider_bindings (
            community_id, policy_key, policy_version_id,
            verification_requirement_hash, provider_id,
            provider_configuration_kind, provider_configuration_ref,
            provider_configuration_version, method, protocol_version, issuer,
            scope_kind, issuer_rp_scope, issuer_rp_action_scope, request_mode,
            evaluator_id
          ) VALUES ($1, 'access', 'policy-access-v2', $2, 'very.oauth',
            'dynamic', 'very-oauth', '1', 'palm_oauth', 'oauth2-oidc-v1',
            'https://connect.very.org', 'issuer_rp_scope', 'pirate-social', NULL,
            'dynamic', 'curated-human-membership-v1')`,
          values: [communityId, policyHash],
        });
      }
      expect(
        (
          await admin.query<{ count: string }>(
            "SELECT count(*) FROM community_policy_provider_bindings WHERE policy_version_id = 'policy-access-v2'",
          )
        ).rows[0]?.count,
      ).toBe("2");
      expect(
        (
          await admin.query<{ description: string }>(
            "SELECT description FROM communities WHERE community_id = 'community-b'",
          )
        ).rows,
      ).toEqual([{ description: "Second canonical policy installation" }]);
      await expectPostgresFailure(
        admin,
        "23514",
        "UPDATE communities SET route_slug = repeat('a', 257) WHERE community_id = 'community-b'",
        [],
      );
      expect(
        (
          await admin.query<{ count: string }>(
            "SELECT count(*) FROM community_policy_current WHERE community_id = 'community-a'",
          )
        ).rows[0]?.count,
      ).toBe("2");
      await expectPostgresFailure(
        admin,
        "23503",
        `INSERT INTO decision_records (
          decision_record_id, community_id, user_id, policy_version_id, policy_hash,
          evaluation_mode, outcome, winning_witness
        ) VALUES ($1, 'community-a', 'user-a', $2, $3, 'enforce', 'pass', '["open"]'::jsonb)`,
        ["decision-wrong-hash", "policy-access-v2", "6".repeat(64)],
      );
      await admin.query({
        text: `INSERT INTO decision_records (
          decision_record_id, community_id, user_id, policy_version_id, policy_hash,
          evaluation_mode, outcome, winning_witness, request_id
        ) VALUES ('decision-a', 'community-a', 'user-a', 'policy-access-v2', $1,
          'enforce', 'pass', '["assertion-a"]'::jsonb, 'decision-request-a')`,
        values: ["5".repeat(64)],
      });
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO decision_records (
          decision_record_id, community_id, user_id, policy_version_id, policy_hash,
          evaluation_mode, outcome, winning_witness, request_id
        ) VALUES ('decision-replay', 'community-a', 'user-a', 'policy-access-v2', $1,
          'enforce', 'pass', '["assertion-a"]'::jsonb, 'decision-request-a')`,
        ["5".repeat(64)],
      );

      for (const [intentId, payloadHash] of [
        ["action-intent-a", "7".repeat(64)],
        ["action-intent-b", "8".repeat(64)],
      ] as const) {
        await admin.query({
          text: `INSERT INTO action_intents (
            action_intent_id, user_id, community_id, action_kind, action_scope,
            action_payload_hash, intent_binding_hash, idempotency_key, status, expires_at
          ) VALUES ($1, 'user-a', 'community-a', 'create_post', 'community-a', $2, $3,
            $1, 'open', $4)`,
          values: [intentId, payloadHash, "9".repeat(64), later],
        });
      }
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO action_intents (
          action_intent_id, user_id, community_id, action_kind, action_scope,
          action_payload_hash, intent_binding_hash, idempotency_key, status, expires_at
        ) VALUES ('action-intent-replay', 'user-a', 'community-a', 'create_post',
          'community-a', $1, $2, 'action-intent-a', 'open', $3)`,
        ["7".repeat(64), "9".repeat(64), later],
      );
      await admin.query({
        text: `INSERT INTO action_challenges (
          action_challenge_id, action_intent_id, provider_id, challenge_hash, status,
          issued_at, expires_at
        ) VALUES ('challenge-a', 'action-intent-a', 'altcha', $1, 'verified', $2, $3),
          ('challenge-b', 'action-intent-b', 'altcha', $4, 'verified', $2, $3)`,
        values: ["a".repeat(64), now, later, "b".repeat(64)],
      });
      await expectPostgresFailure(
        admin,
        "23503",
        `INSERT INTO action_grants (
          action_grant_id, action_intent_id, action_challenge_id, user_id, provider_id,
          action_kind, action_scope, action_payload_hash, grant_nonce, signed_grant,
          signer_key_id, issued_at, expires_at
        ) VALUES ('grant-wrong', 'action-intent-a', 'challenge-b', 'user-a', 'altcha',
          'create_post', 'community-a', $1, 'nonce-wrong', 'signed', 'key-1', $2, $3)`,
        ["7".repeat(64), now, later],
      );
      await admin.query({
        text: `INSERT INTO action_grants (
          action_grant_id, action_intent_id, action_challenge_id, user_id, provider_id,
          action_kind, action_scope, action_payload_hash, grant_nonce, signed_grant,
          signer_key_id, issued_at, expires_at
        ) VALUES ('grant-a', 'action-intent-a', 'challenge-a', 'user-a', 'altcha',
          'create_post', 'community-a', $1, 'nonce-a', 'signed', 'key-1', $2, $3)`,
        values: ["7".repeat(64), now, later],
      });
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO action_grants (
          action_grant_id, action_intent_id, action_challenge_id, user_id, provider_id,
          action_kind, action_scope, action_payload_hash, grant_nonce, signed_grant,
          signer_key_id, issued_at, expires_at
        ) VALUES ('grant-duplicate-nonce', 'action-intent-b', 'challenge-b', 'user-a',
          'altcha', 'create_post', 'community-a', $1, 'nonce-a', 'signed', 'key-1', $2, $3)`,
        ["8".repeat(64), now, later],
      );
      await expectPostgresFailure(
        admin,
        "23503",
        `INSERT INTO used_action_grants (
          grant_nonce, action_grant_id, action_intent_id, action_kind, action_scope,
          action_payload_hash, action_result_ref
        ) VALUES ('nonce-a', 'grant-a', 'action-intent-a', 'create_post', 'other-community',
          $1, 'post-a')`,
        ["7".repeat(64)],
      );
      await admin.query({
        text: `INSERT INTO action_grants (
          action_grant_id, action_intent_id, action_challenge_id, user_id, provider_id,
          action_kind, action_scope, action_payload_hash, grant_nonce, signed_grant,
          signer_key_id, issued_at, expires_at
        ) VALUES ('grant-b', 'action-intent-b', 'challenge-b', 'user-a', 'altcha',
          'create_post', 'community-a', $1, 'nonce-b', 'signed', 'key-1', $2, $3)`,
        values: ["8".repeat(64), now, later],
      });
      await admin.query({
        text: `INSERT INTO posts (
          community_id, post_id, author_user_id, author_persona_id,
          body, created_at, updated_at
        ) VALUES (
          'community-a', 'post-existing', 'user-a',
          (SELECT persona_id FROM personas WHERE account_id='user-a' AND is_first_persona),
          'existing', $1, $1
        )`,
        values: [now],
      });
      await admin.query("BEGIN");
      try {
        await admin.query({
          text: `INSERT INTO used_action_grants (
            grant_nonce, action_grant_id, action_intent_id, action_kind, action_scope,
            action_payload_hash, action_result_ref
          ) VALUES ('nonce-b', 'grant-b', 'action-intent-b', 'create_post', 'community-a',
            $1, 'post-existing')`,
          values: ["8".repeat(64)],
        });
        await admin.query({
          text: `INSERT INTO posts (
            community_id, post_id, author_user_id, author_persona_id,
            body, created_at, updated_at
          ) VALUES (
            'community-a', 'post-existing', 'user-a',
            (SELECT persona_id FROM personas WHERE account_id='user-a' AND is_first_persona),
            'duplicate', $1, $1
          )`,
          values: [now],
        });
        throw new Error("expected protected action write to fail");
      } catch (error) {
        expect(error).toMatchObject({ code: "23505" });
        await admin.query("ROLLBACK");
      }
      expect(
        (
          await admin.query<{ count: string }>(
            "SELECT count(*) FROM used_action_grants WHERE grant_nonce = 'nonce-b'",
          )
        ).rows[0]?.count,
      ).toBe("0");
      await admin.query({
        text: `INSERT INTO used_action_grants (
          grant_nonce, action_grant_id, action_intent_id, action_kind, action_scope,
          action_payload_hash, action_result_ref
        ) VALUES ('nonce-a', 'grant-a', 'action-intent-a', 'create_post', 'community-a',
          $1, 'post-a')`,
        values: ["7".repeat(64)],
      });
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO used_action_grants (
          grant_nonce, action_grant_id, action_intent_id, action_kind, action_scope,
          action_payload_hash, action_result_ref
        ) VALUES ('nonce-a', 'grant-a', 'action-intent-a', 'create_post', 'community-a',
          $1, 'post-replay')`,
        ["7".repeat(64)],
      );
    });
    completedTestCount += 1;
  });

  test("enforces provider configuration provenance and append-only presentations", async () => {
    await withSchema(async (admin, scopedConnectionString) => {
      await applyMigrations(scopedConnectionString, migrations);
      const now = new Date("2026-08-17T00:00:00.000Z");
      const later = new Date("2026-08-18T00:00:00.000Z");

      await admin.query("INSERT INTO users (user_id) VALUES ('user-a')");

      const insertSession = async (
        id: string,
        requestMode: "curated" | "dynamic",
        configurationKind: "managed" | "dynamic",
        configurationRef: string,
        configurationVersion: string,
      ) => {
        await admin.query({
          text: `INSERT INTO proof_sessions (
            proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
            scope_kind, issuer_rp_scope, request_mode, protocol_version, environment, status,
            requested_requirements, requested_claim_ids, subject_binding_intent, started_at,
            expires_at, provider_configuration_kind, provider_configuration_ref,
            provider_configuration_version
          ) VALUES ($1, 'user-a', $2, $3, 'test.fake', 'document', 'test.fake',
            'issuer_rp_scope', 'pirate.example', $4, 'fake-v2', 'test', 'pending',
            '[{"claim_id":"document.valid"}]'::jsonb, '["document.valid"]'::jsonb,
            'none', $5, $6, $7, $8, $9)`,
          values: [
            id,
            `intent-${id}`,
            "a".repeat(64),
            requestMode,
            now,
            later,
            configurationKind,
            configurationRef,
            configurationVersion,
          ],
        });
      };

      await insertSession("session-dynamic", "dynamic", "dynamic", "dynamic-config", "v1");
      await insertSession("session-curated", "curated", "managed", "managed-config", "v2");

      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO proof_sessions (
          proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
          scope_kind, issuer_rp_scope, request_mode, protocol_version, environment, status,
          requested_requirements, requested_claim_ids, subject_binding_intent, started_at,
          expires_at, provider_configuration_kind, provider_configuration_ref,
          provider_configuration_version
        ) VALUES ('session-curated-wrong-kind', 'user-a', 'intent-curated-wrong-kind', $1,
          'test.fake', 'document', 'test.fake', 'issuer_rp_scope', 'pirate.example', 'curated',
          'fake-v2', 'test', 'pending', '[{"claim_id":"document.valid"}]'::jsonb,
          '["document.valid"]'::jsonb, 'none', $2, $3, 'dynamic', 'config', 'v1')`,
        ["1".repeat(64), now, later],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO proof_sessions (
          proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
          scope_kind, issuer_rp_scope, request_mode, protocol_version, environment, status,
          requested_requirements, requested_claim_ids, subject_binding_intent, started_at,
          expires_at, provider_configuration_kind, provider_configuration_ref,
          provider_configuration_version
        ) VALUES ('session-dynamic-wrong-kind', 'user-a', 'intent-dynamic-wrong-kind', $1,
          'test.fake', 'document', 'test.fake', 'issuer_rp_scope', 'pirate.example', 'dynamic',
          'fake-v2', 'test', 'pending', '[{"claim_id":"document.valid"}]'::jsonb,
          '["document.valid"]'::jsonb, 'none', $2, $3, 'managed', 'config', 'v1')`,
        ["2".repeat(64), now, later],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        "UPDATE proof_sessions SET provider_configuration_ref = ' changed' WHERE proof_session_id = 'session-dynamic'",
        [],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        "UPDATE proof_sessions SET provider_configuration_version = 'v2' WHERE proof_session_id = 'session-dynamic'",
        [],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        "UPDATE proof_sessions SET provider_configuration_kind = 'managed' WHERE proof_session_id = 'session-dynamic'",
        [],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO proof_sessions (
          proof_session_id, actor_id, intent_id, request_hash, provider_id, method, issuer,
          scope_kind, issuer_rp_scope, request_mode, protocol_version, environment, status,
          requested_requirements, requested_claim_ids, subject_binding_intent, started_at,
          expires_at, provider_configuration_kind, provider_configuration_ref,
          provider_configuration_version
        ) VALUES ('session-whitespace-version', 'user-a', 'intent-whitespace-version', $1,
          'test.fake', 'document', 'test.fake', 'issuer_rp_scope', 'pirate.example', 'dynamic',
          'fake-v2', 'test', 'pending', '[{"claim_id":"document.valid"}]'::jsonb,
          '["document.valid"]'::jsonb, 'none', $2, $3, 'dynamic', 'config', 'v1 ')`,
        ["3".repeat(64), now, later],
      );

      await admin.query({
        text: `INSERT INTO proof_session_presentations (
          proof_session_id, presentation_kind, payload
        ) VALUES ('session-dynamic', 'redirect', '{"url":"https://example.test/callback"}'::jsonb)`,
      });
      await expectPostgresFailure(
        admin,
        "23514",
        "UPDATE proof_session_presentations SET payload = '{}'::jsonb WHERE proof_session_id = 'session-dynamic'",
        [],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        "DELETE FROM proof_session_presentations WHERE proof_session_id = 'session-dynamic'",
        [],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO proof_session_presentations (
          proof_session_id, presentation_kind, payload
        ) VALUES ('session-curated', 'unsupported', '{}'::jsonb)`,
        [],
      );
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO proof_session_presentations (
          proof_session_id, presentation_kind, payload
        ) VALUES ('session-curated', 'poll', '[]'::jsonb)`,
        [],
      );
      await expectPostgresFailure(
        admin,
        "23503",
        `INSERT INTO proof_session_presentations (
          proof_session_id, presentation_kind, payload
        ) VALUES ('session-missing', 'none', '{}'::jsonb)`,
        [],
      );
    });
    completedTestCount += 1;
  });

  test("rejects duplicate, out-of-order, and checksum-mismatched migrations", async () => {
    await withSchema(async (_admin, scopedConnectionString) => {
      const duplicate = await applyMigrations(scopedConnectionString, [migration, migration]).catch(
        (error) => error,
      );
      expect(duplicate).toBeInstanceOf(MigrationDefinitionInvalid);
      expect(duplicate).toMatchObject({ reason: "duplicate" });

      const outOfOrder = await applyMigrations(scopedConnectionString, [
        { ...migration, version: "0002_out_of_order.sql" },
        { ...migration, version: "0001_out_of_order.sql" },
      ]).catch((error) => error);
      expect(outOfOrder).toBeInstanceOf(MigrationDefinitionInvalid);
      expect(outOfOrder).toMatchObject({ reason: "out-of-order" });

      await applyMigrations(scopedConnectionString, [migration]);
      const mismatch = await applyMigrations(scopedConnectionString, [
        { ...migration, checksum: "0".repeat(64) },
      ]).catch((error) => error);
      expect(mismatch).toBeInstanceOf(MigrationLedgerMismatch);
      expect(mismatch).toMatchObject({ version: migration.version });

      const secondMigration = { ...migration, version: "0002_follow-up.sql" };
      await withSchema(async (_admin, secondScopedConnectionString) => {
        await applyMigrations(secondScopedConnectionString, [secondMigration]);
        const gap = await applyMigrations(secondScopedConnectionString, [
          migration,
          secondMigration,
        ]).catch((error) => error);
        expect(gap).toBeInstanceOf(MigrationLedgerMismatch);
        expect(gap).toMatchObject({
          reason: "not-prefix",
          version: migration.version,
          expectedVersion: migration.version,
          actualVersion: secondMigration.version,
        });
      });

      await withSchema(async (_admin, secondScopedConnectionString) => {
        await applyMigrations(secondScopedConnectionString, [identityMigration]);
        const gap = await applyMigrations(secondScopedConnectionString, migrations).catch(
          (error) => error,
        );
        expect(gap).toBeInstanceOf(MigrationLedgerMismatch);
        expect(gap).toMatchObject({
          reason: "not-prefix",
          version: migration.version,
          expectedVersion: migration.version,
          actualVersion: identityMigration.version,
        });
      });
    });
    completedTestCount += 1;
  });

  test("rejects cross-community post, comment, and vote references", async () => {
    await withSchema(async (admin, scopedConnectionString) => {
      await applyMigrations(scopedConnectionString, migrations);
      const now = new Date();
      await admin.query("INSERT INTO users (user_id) VALUES ('user-a'), ('user-b')");
      await admin.query({
        text: "INSERT INTO communities (community_id, display_name, created_by_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $4), ($5, $6, $7, $4, $4)",
        values: ["community-a", "A", "user-a", now, "community-b", "B", "user-b"],
      });
      await admin.query({
        text: `INSERT INTO posts (
          community_id, post_id, author_user_id, author_persona_id,
          body, created_at, updated_at
        ) VALUES (
          $1, $2, $3,
          (SELECT persona_id FROM personas WHERE account_id=$3 AND is_first_persona),
          $4, $5, $5
        )`,
        values: ["community-a", "post-a", "user-a", "post", now],
      });

      await expectForeignKeyFailure(
        admin,
        "INSERT INTO comments (community_id, comment_id, post_id, body, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)",
        ["community-b", "comment-b", "post-a", "comment", now],
      );
      await expectForeignKeyFailure(
        admin,
        "INSERT INTO post_votes (community_id, post_vote_id, post_id, user_id, vote_value, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)",
        ["community-b", "vote-b", "post-a", "user-b", 1, now],
      );
    });
    completedTestCount += 1;
  });

  test("scopes repository reads, updates, and deletes by community", async () => {
    await withSchema(async (admin, scopedConnectionString) => {
      await applyMigrations(scopedConnectionString, migrations);
      const now = new Date();
      await admin.query("INSERT INTO users (user_id) VALUES ('user-a'), ('user-b')");
      await admin.query({
        text: "INSERT INTO communities (community_id, display_name, created_by_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $4), ($5, $6, $7, $4, $4)",
        values: ["community-a", "A", "user-a", now, "community-b", "B", "user-b"],
      });
      await admin.query({
        text: `INSERT INTO posts (
          community_id, post_id, author_user_id, author_persona_id,
          body, created_at, updated_at
        ) VALUES
          ($1, $2, $3,
           (SELECT persona_id FROM personas WHERE account_id=$3 AND is_first_persona),
           $4, $5, $5),
          ($6, $7, $8,
           (SELECT persona_id FROM personas WHERE account_id=$8 AND is_first_persona),
           $9, $5, $5)`,
        values: [
          "community-a",
          "post-a",
          "user-a",
          "community A",
          now,
          "community-b",
          "post-b",
          "user-b",
          "community B",
        ],
      });

      const readPost = async (communityId: string, postId: string) =>
        (
          await admin.query<{ readonly body: string }>({
            text: "SELECT body FROM posts WHERE community_id = $1 AND post_id = $2",
            values: [communityId, postId],
          })
        ).rows;

      expect(await readPost("community-a", "post-b")).toEqual([]);
      expect(await readPost("community-b", "post-b")).toEqual([{ body: "community B" }]);

      const wrongUpdate = await admin.query({
        text: "UPDATE posts SET body = $1, updated_at = $2 WHERE community_id = $3 AND post_id = $4",
        values: ["cross-tenant update", now, "community-a", "post-b"],
      });
      expect(wrongUpdate.rowCount).toBe(0);

      const wrongDelete = await admin.query({
        text: "DELETE FROM posts WHERE community_id = $1 AND post_id = $2",
        values: ["community-a", "post-b"],
      });
      expect(wrongDelete.rowCount).toBe(0);
      expect(await readPost("community-b", "post-b")).toEqual([{ body: "community B" }]);

      const ownUpdate = await admin.query({
        text: "UPDATE posts SET body = $1, updated_at = $2 WHERE community_id = $3 AND post_id = $4",
        values: ["updated A", now, "community-a", "post-a"],
      });
      expect(ownUpdate.rowCount).toBe(1);
      const ownDelete = await admin.query({
        text: "DELETE FROM posts WHERE community_id = $1 AND post_id = $2",
        values: ["community-a", "post-a"],
      });
      expect(ownDelete.rowCount).toBe(1);
      expect(await readPost("community-a", "post-a")).toEqual([]);
      expect(await readPost("community-b", "post-b")).toEqual([{ body: "community B" }]);
    });
    completedTestCount += 1;
  });

  test("fences community creation revisions, idempotency, and terminal quota outcomes", async () => {
    await withSchema(async (admin, scopedConnectionString) => {
      await applyMigrations(scopedConnectionString, migrations);
      await admin.query("INSERT INTO users (user_id) VALUES ('creator-a')");
      await admin.query(
        `INSERT INTO community_creation_intents (
           intent_id, actor_id, create_idempotency_key, create_request_hash,
           revision, status, draft, canonical_policy_revision, canonical_policy_hash,
           verification_requirement_hash, verification_provider_id,
           provider_configuration_kind, provider_configuration_ref,
           provider_configuration_version, expires_at
         ) VALUES (
           'creation-a', 'creator-a', 'create-key-a', repeat('a', 64),
           1, 'draft', '{"name":"Jazleeuw"}'::jsonb, 1, repeat('b', 64),
           repeat('c', 64), 'very.oauth', 'dynamic', 'very-oauth', '1',
           clock_timestamp() + interval '1 hour'
         )`,
      );
      await admin.query(
        `INSERT INTO community_creation_intent_revisions (
           intent_id, revision, actor_id, operation_kind, idempotency_key,
           request_hash, status, state_snapshot
         ) VALUES (
           'creation-a', 1, 'creator-a', 'create', 'create-key-a',
           repeat('a', 64), 'draft', '{"status":"draft"}'::jsonb
         )`,
      );

      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO community_creation_intents (
           intent_id, actor_id, create_idempotency_key, create_request_hash,
           revision, status, draft, canonical_policy_revision, canonical_policy_hash,
           verification_requirement_hash, verification_provider_id,
           provider_configuration_kind, provider_configuration_ref,
           provider_configuration_version, expires_at
         ) VALUES (
           'creation-b', 'creator-a', 'create-key-a', repeat('d', 64),
           1, 'draft', '{}'::jsonb, 1, repeat('b', 64), repeat('c', 64),
           'very.oauth', 'dynamic', 'very-oauth', '1',
           clock_timestamp() + interval '1 hour'
         )`,
        [],
      );

      await admin.query(
        `UPDATE community_creation_intents
            SET revision = 2, status = 'verification_required', updated_at = clock_timestamp()
          WHERE intent_id = 'creation-a'`,
      );
      await admin.query(
        `INSERT INTO community_creation_intent_revisions (
           intent_id, revision, actor_id, operation_kind, idempotency_key,
           request_hash, status, state_snapshot
         ) VALUES (
           'creation-a', 2, 'creator-a', 'preflight', NULL,
           repeat('e', 64), 'verification_required',
           '{"status":"verification_required"}'::jsonb
         )`,
      );

      await expectPostgresFailure(
        admin,
        "P0001",
        `UPDATE community_creation_intents
            SET revision = 4, status = 'commit_ready', updated_at = clock_timestamp()
          WHERE intent_id = 'creation-a'`,
        [],
      );
      await admin.query(
        `UPDATE community_creation_intents
            SET revision = 3, status = 'commit_ready', updated_at = clock_timestamp()
          WHERE intent_id = 'creation-a'`,
      );
      await admin.query(
        `INSERT INTO community_creation_intent_revisions (
           intent_id, revision, actor_id, operation_kind, idempotency_key,
           request_hash, status, state_snapshot
         ) VALUES (
           'creation-a', 3, 'creator-a', 'verification', NULL,
           repeat('f', 64), 'commit_ready', '{"status":"commit_ready"}'::jsonb
         )`,
      );
      await admin.query(
        `UPDATE community_creation_intents
            SET revision = 4, status = 'quota_exceeded', updated_at = clock_timestamp()
          WHERE intent_id = 'creation-a'`,
      );
      await admin.query(
        `INSERT INTO community_creation_intent_revisions (
           intent_id, revision, actor_id, operation_kind, idempotency_key,
           request_hash, status, state_snapshot
         ) VALUES (
           'creation-a', 4, 'creator-a', 'commit', 'commit-key-a',
           repeat('1', 64), 'quota_exceeded', '{"status":"quota_exceeded"}'::jsonb
         )`,
      );

      await expectPostgresFailure(
        admin,
        "P0001",
        `UPDATE community_creation_intents
            SET revision = 5, status = 'cancelled', updated_at = clock_timestamp()
          WHERE intent_id = 'creation-a'`,
        [],
      );
      await expectPostgresFailure(
        admin,
        "P0001",
        "DELETE FROM community_creation_intent_revisions WHERE intent_id = 'creation-a'",
        [],
      );

      const current = await admin.query<{ readonly revision: number; readonly status: string }>(
        "SELECT revision, status FROM community_creation_intents WHERE intent_id = 'creation-a'",
      );
      expect(current.rows).toEqual([{ revision: 4, status: "quota_exceeded" }]);
    });
    completedTestCount += 1;
  });

  test("enforces durable text moderation policy, submission, review, and projection invariants", async () => {
    await withSchema(async (admin, scopedConnectionString) => {
      await applyMigrations(scopedConnectionString, migrations);

      const policy = await admin.query<{
        readonly policy_hash: string;
        readonly policy_preimage: string;
        readonly model_identifier: string;
        readonly timeout_ms: number;
        readonly sexual_minors_block_threshold: string;
      }>(
        `SELECT policy_hash, policy_preimage, model_identifier, timeout_ms,
                sexual_minors_block_threshold::text
           FROM text_moderation_policy_revisions
          WHERE policy_revision_id = 'text-moderation-policy-v1'`,
      );
      expect(policy.rows).toHaveLength(1);
      const persistedPolicy = policy.rows[0];
      if (persistedPolicy === undefined) throw new Error("missing text moderation policy");
      expect(persistedPolicy).toMatchObject({
        model_identifier: "omni-moderation-latest",
        timeout_ms: 10000,
        sexual_minors_block_threshold: "0.95",
      });
      expect(checksum(persistedPolicy.policy_preimage)).toBe(persistedPolicy.policy_hash);

      await admin.query("INSERT INTO users (user_id) VALUES ('text-author'), ('other-author')");
      await admin.query(
        `INSERT INTO communities (
           community_id, display_name, created_by_user_id, created_at, updated_at
         ) VALUES ('text-community', 'Text', 'text-author', now(), now())`,
      );
      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO posts (
           community_id, post_id, author_user_id, author_persona_id,
           post_type, status, visibility,
           title, body, created_at, updated_at
         ) VALUES (
           'text-community', 'text-post-1', 'text-author',
           (SELECT persona_id FROM personas WHERE account_id='text-author' AND is_first_persona),
           'text', 'published', 'public',
           'Title', 'Body', now(), now()
         )`,
      );
      await admin.query(
        `INSERT INTO text_moderation_evidence (
           evidence_ref, provider_id, requested_model_identifier,
           response_model_identifier, outcome, normalized_categories, normalized_scores,
           response_sha256
         ) VALUES (
           'text-evidence-1', 'openai', 'omni-moderation-latest',
           'omni-moderation-latest', 'evaluated', '{}'::jsonb, '{}'::jsonb, repeat('e', 64)
         )`,
      );
      await admin.query(
        `INSERT INTO text_content_submissions (
           community_id, submission_id, operation_id, actor_user_id, author_persona_id,
           surface, idempotency_key,
           request_hash, status, moderation_decision, public_reason_code,
           policy_revision_id, policy_hash,
           input_sha256, internal_reason_codes, evidence_ref, published_post_id,
           response_snapshot_bytes, response_snapshot_sha256
         ) VALUES (
           'text-community', 'text-submission-1', 'text-operation-1', 'text-author',
           (SELECT persona_id FROM personas WHERE account_id='text-author' AND is_first_persona),
           'text_post', 'text-key-1',
           repeat('a', 64), 'published', 'allow', NULL, 'text-moderation-policy-v1',
           'b0a8fd06312d7f9a99d7100633bc03fafc44b16aae5340899d290f54cb64df9d',
           repeat('b', 64), '[]'::jsonb, 'text-evidence-1', 'text-post-1',
           decode('7b7d', 'hex'), encode(sha256(decode('7b7d', 'hex')), 'hex')
         )`,
      );
      await admin.query(
        `INSERT INTO home_feed_projection (
           community_id, feed_item_id, post_id, rank_score, projected_at
         ) VALUES ('text-community', 'feed-text-post-1', 'text-post-1', 0, now())`,
      );
      await admin.query("COMMIT");
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO home_feed_projection (
           community_id, feed_item_id, post_id, rank_score, projected_at
         ) VALUES ('text-community', 'duplicate-feed-item', 'text-post-1', 0, now())`,
        [],
      );
      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO text_content_submissions (
           community_id, submission_id, operation_id, actor_user_id, author_persona_id,
           surface, idempotency_key,
           request_hash, status, moderation_decision, public_reason_code,
           policy_revision_id, policy_hash,
           input_sha256, internal_reason_codes, review_ref,
           response_snapshot_bytes, response_snapshot_sha256
         ) VALUES (
           'text-community', 'text-submission-2', 'text-operation-2', 'text-author',
           (SELECT persona_id FROM personas WHERE account_id='text-author' AND is_first_persona),
           'text_post', 'text-key-2',
           repeat('c', 64), 'manual_review', 'manual_review', 'moderation_unavailable',
           'text-moderation-policy-v1',
           'b0a8fd06312d7f9a99d7100633bc03fafc44b16aae5340899d290f54cb64df9d',
           repeat('d', 64), '["provider_timeout"]'::jsonb, 'text-case-2',
           decode('7b7d', 'hex'), encode(sha256(decode('7b7d', 'hex')), 'hex')
         )`,
      );
      await admin.query(
        `INSERT INTO text_content_held_revisions (
           community_id, held_revision_id, submission_id, title, body, content_sha256
         ) VALUES (
           'text-community', 'text-held-2', 'text-submission-2', 'Held', 'Body', repeat('f', 64)
         )`,
      );
      await admin.query(
        `INSERT INTO text_moderation_cases (community_id, case_id, submission_id)
         VALUES ('text-community', 'text-case-2', 'text-submission-2')`,
      );
      await admin.query("COMMIT");

      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO posts (
           community_id, post_id, author_user_id, author_persona_id,
           post_type, status, visibility,
           title, body, created_at, updated_at
         ) VALUES (
           'text-community', 'text-post-2', 'text-author',
           (SELECT persona_id FROM personas WHERE account_id='text-author' AND is_first_persona),
           'text', 'published', 'public',
           'Held', 'Body', now(), now()
         )`,
      );
      await admin.query(
        `UPDATE text_moderation_cases
            SET status = 'approved', resolved_by_user_id = 'moderator-1',
                updated_at = clock_timestamp() + interval '1 millisecond'
          WHERE case_id = 'text-case-2'`,
      );
      await admin.query(
        `UPDATE text_content_submissions
            SET status = 'published', public_reason_code = NULL,
                published_post_id = 'text-post-2', review_ref = NULL,
                updated_at = clock_timestamp() + interval '1 millisecond'
          WHERE submission_id = 'text-submission-2'`,
      );
      await admin.query(
        `INSERT INTO home_feed_projection (
           community_id, feed_item_id, post_id, rank_score, projected_at
         ) VALUES ('text-community', 'feed-text-post-2', 'text-post-2', 0, now())`,
      );
      await admin.query("COMMIT");

      const approved = await admin.query<{
        readonly status: string;
        readonly moderation_decision: string;
      }>(
        `SELECT status, moderation_decision
           FROM text_content_submissions
          WHERE submission_id = 'text-submission-2'`,
      );
      expect(approved.rows).toEqual([
        { status: "published", moderation_decision: "manual_review" },
      ]);
      await expectPostgresFailure(
        admin,
        "P0001",
        `UPDATE text_moderation_cases
            SET status = 'dismissed', updated_at = clock_timestamp() + interval '2 milliseconds'
          WHERE case_id = 'text-case-2'`,
        [],
      );

      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO text_content_submissions (
           community_id, submission_id, operation_id, actor_user_id, author_persona_id,
           surface, idempotency_key,
           request_hash, status, moderation_decision, public_reason_code,
           policy_revision_id, policy_hash, input_sha256, internal_reason_codes, review_ref
           , response_snapshot_bytes, response_snapshot_sha256
         ) VALUES (
           'text-community', 'text-submission-missing-review', 'text-operation-3', 'text-author',
           (SELECT persona_id FROM personas WHERE account_id='text-author' AND is_first_persona),
           'text_post',
           'text-key-missing-review', repeat('3', 64), 'manual_review', 'manual_review',
           'review_required', 'text-moderation-policy-v1',
           'b0a8fd06312d7f9a99d7100633bc03fafc44b16aae5340899d290f54cb64df9d',
           repeat('4', 64), '["hate"]'::jsonb, 'text-case-missing',
           decode('7b7d', 'hex'), encode(sha256(decode('7b7d', 'hex')), 'hex')
         )`,
      );
      try {
        await admin.query("COMMIT");
        throw new Error("expected incomplete review transaction to fail");
      } catch (error) {
        expect(error).toMatchObject({ code: "P0001" });
      } finally {
        await admin.query("ROLLBACK");
      }

      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO text_content_submissions (
           community_id, submission_id, operation_id, actor_user_id, author_persona_id,
           surface, idempotency_key,
           request_hash, status, moderation_decision, public_reason_code,
           policy_revision_id, policy_hash, input_sha256, internal_reason_codes
           , response_snapshot_bytes, response_snapshot_sha256
         ) VALUES (
           'text-community', 'text-submission-unknown-reason', 'text-operation-4', 'text-author',
           (SELECT persona_id FROM personas WHERE account_id='text-author' AND is_first_persona),
           'text_post',
           'text-key-unknown-reason', repeat('5', 64), 'blocked', 'blocked',
           'policy_violation', 'text-moderation-policy-v1',
           'b0a8fd06312d7f9a99d7100633bc03fafc44b16aae5340899d290f54cb64df9d',
           repeat('6', 64), '["free_form"]'::jsonb,
           decode('7b7d', 'hex'), encode(sha256(decode('7b7d', 'hex')), 'hex')
         )`,
        [],
      );

      await admin.query(
        `INSERT INTO text_content_submissions (
           community_id, submission_id, operation_id, actor_user_id, author_persona_id,
           surface, idempotency_key,
           request_hash, status, moderation_decision, public_reason_code,
           policy_revision_id, policy_hash, input_sha256, internal_reason_codes
           , response_snapshot_bytes, response_snapshot_sha256
         ) VALUES (
           'text-community', 'text-submission-blocked', 'text-operation-5', 'text-author',
           (SELECT persona_id FROM personas WHERE account_id='text-author' AND is_first_persona),
           'text_post',
           'text-key-blocked', repeat('7', 64), 'blocked', 'blocked',
           'policy_violation', 'text-moderation-policy-v1',
           'b0a8fd06312d7f9a99d7100633bc03fafc44b16aae5340899d290f54cb64df9d',
           repeat('8', 64), '["sexual_minors"]'::jsonb,
           decode('7b7d', 'hex'), encode(sha256(decode('7b7d', 'hex')), 'hex')
         )`,
      );
      await expectPostgresFailure(
        admin,
        "P0001",
        `INSERT INTO text_content_held_revisions (
           community_id, held_revision_id, submission_id, title, content_sha256
         ) VALUES (
           'text-community', 'text-held-blocked', 'text-submission-blocked',
           'must not persist', repeat('9', 64)
         )`,
        [],
      );

      await admin.query(
        `INSERT INTO posts (
           community_id, post_id, author_user_id, author_persona_id,
           post_type, status, visibility,
           body, created_at, updated_at
         ) VALUES (
           'text-community', 'image-processing', 'other-author',
           (SELECT persona_id FROM personas WHERE account_id='other-author' AND is_first_persona),
           'image', 'processing',
           'public', 'not a published text post', now(), now()
         )`,
      );
      await expectPostgresFailure(
        admin,
        "P0001",
        `INSERT INTO text_content_submissions (
           community_id, submission_id, operation_id, actor_user_id, author_persona_id,
           surface, idempotency_key,
           request_hash, status, moderation_decision, public_reason_code,
           policy_revision_id, policy_hash, input_sha256, internal_reason_codes,
           published_post_id, response_snapshot_bytes, response_snapshot_sha256
         ) VALUES (
           'text-community', 'text-submission-bad-post', 'text-operation-6', 'text-author',
           (SELECT persona_id FROM personas WHERE account_id='text-author' AND is_first_persona),
           'text_post',
           'text-key-bad-post', repeat('a', 64), 'published', 'allow', NULL,
           'text-moderation-policy-v1',
           'b0a8fd06312d7f9a99d7100633bc03fafc44b16aae5340899d290f54cb64df9d',
           repeat('b', 64), '[]'::jsonb, 'image-processing',
           decode('7b7d', 'hex'), encode(sha256(decode('7b7d', 'hex')), 'hex')
         )`,
        [],
      );

      await admin.query(
        `INSERT INTO posts (
           community_id, post_id, author_user_id, author_persona_id,
           post_type, status, visibility,
           title, body, created_at, updated_at
         ) VALUES (
           'text-community', 'text-post-without-feed', 'text-author',
           (SELECT persona_id FROM personas WHERE account_id='text-author' AND is_first_persona),
           'text', 'published',
           'public', 'Missing projection', 'Body', now(), now()
         )`,
      );
      await expectPostgresFailure(
        admin,
        "P0001",
        `INSERT INTO text_content_submissions (
           community_id, submission_id, operation_id, actor_user_id, author_persona_id,
           surface, idempotency_key,
           request_hash, status, moderation_decision, public_reason_code,
           policy_revision_id, policy_hash, input_sha256, internal_reason_codes,
           published_post_id, response_snapshot_bytes, response_snapshot_sha256
         ) VALUES (
           'text-community', 'text-submission-no-feed', 'text-operation-7', 'text-author',
           (SELECT persona_id FROM personas WHERE account_id='text-author' AND is_first_persona),
           'text_post',
           'text-key-no-feed', repeat('0', 64), 'published', 'allow', NULL,
           'text-moderation-policy-v1',
           'b0a8fd06312d7f9a99d7100633bc03fafc44b16aae5340899d290f54cb64df9d',
           repeat('1', 64), '[]'::jsonb, 'text-post-without-feed',
           decode('7b7d', 'hex'), encode(sha256(decode('7b7d', 'hex')), 'hex')
         )`,
        [],
      );

      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO text_content_submissions (
           community_id, submission_id, operation_id, actor_user_id, author_persona_id,
           surface, idempotency_key,
           request_hash, status, moderation_decision, public_reason_code,
           policy_revision_id, policy_hash, input_sha256, internal_reason_codes,
           response_snapshot_bytes, response_snapshot_sha256
         ) VALUES (
           'text-community', 'text-submission-invalid', 'text-operation-8', 'text-author',
           (SELECT persona_id FROM personas WHERE account_id='text-author' AND is_first_persona),
           'text_post',
           'text-key-invalid', repeat('1', 64), 'blocked', 'blocked', NULL,
           'text-moderation-policy-v1',
           'b0a8fd06312d7f9a99d7100633bc03fafc44b16aae5340899d290f54cb64df9d',
           repeat('2', 64), '["sexual_minors"]'::jsonb,
           decode('7b7d', 'hex'), encode(sha256(decode('7b7d', 'hex')), 'hex')
         )`,
        [],
      );
      await expectPostgresFailure(
        admin,
        "P0001",
        "DELETE FROM text_moderation_evidence WHERE evidence_ref = 'text-evidence-1'",
        [],
      );

      const submissionColumns = await admin.query<{ readonly column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'text_content_submissions'`,
      );
      expect(submissionColumns.rows.map((row) => row.column_name)).not.toContain("title");
      expect(submissionColumns.rows.map((row) => row.column_name)).not.toContain("body");
    });
    completedTestCount += 1;
  });

  test("requires the 0037 text tables to be empty before adding response snapshots", async () => {
    await withSchema(async (admin, scopedConnectionString) => {
      const preSnapshotMigrations = migrations.slice(
        0,
        migrations.indexOf(textSubmissionResponseSnapshotMigration),
      );
      await applyMigrations(scopedConnectionString, preSnapshotMigrations);
      await admin.query("INSERT INTO users (user_id) VALUES ('text-order5-guard-actor')");
      await admin.query(
        `INSERT INTO communities (
           community_id, display_name, created_by_user_id, created_at, updated_at
         ) VALUES ('text-order5-guard-community', 'Text guard', 'text-order5-guard-actor', now(), now())`,
      );
      await admin.query(
        `INSERT INTO text_content_submissions (
           community_id, submission_id, actor_user_id, surface, idempotency_key,
           request_hash, status, moderation_decision, public_reason_code,
           policy_revision_id, policy_hash, input_sha256, internal_reason_codes
         ) VALUES (
           'text-order5-guard-community', 'text-order5-guard-submission',
           'text-order5-guard-actor', 'text_post', 'text-order5-guard-key',
           repeat('a', 64), 'blocked', 'blocked', 'policy_violation',
           'text-moderation-policy-v1',
           'b0a8fd06312d7f9a99d7100633bc03fafc44b16aae5340899d290f54cb64df9d',
           repeat('b', 64), '["hate"]'::jsonb
         )`,
      );

      const guarded = await applyMigrations(scopedConnectionString, migrations).catch(
        (error: unknown) => error,
      );
      expect(guarded).toMatchObject({
        _tag: "ControlPlaneStatementFailed",
        label: "postgres.migrations.0037_text_submission_response_snapshot.sql.apply",
        sqlState: "P0001",
      });
      const applied = await admin.query<{ readonly version: string }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      expect(applied.rows.at(-1)?.version).toBe(routeRevalidationCompletionMigration.version);
    });

    await withSchema(async (_admin, scopedConnectionString) => {
      await applyMigrations(scopedConnectionString, migrations);
    });
    completedTestCount += 1;
  });

  test("requires post votes to be empty before installing stored aggregates and actions", async () => {
    await withSchema(async (admin, scopedConnectionString) => {
      const preVoteActionMigrations = migrations.slice(
        0,
        migrations.indexOf(postVoteActionsMigration),
      );
      await applyMigrations(scopedConnectionString, preVoteActionMigrations);
      const now = new Date();
      await admin.query({
        text: "INSERT INTO communities (community_id, display_name, created_by_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
        values: ["vote-guard-community", "Vote guard", "vote-guard-user", now],
      });
      await admin.query({
        text: "INSERT INTO posts (community_id, post_id, author_user_id, body, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)",
        values: ["vote-guard-community", "vote-guard-post", "vote-guard-user", "post", now],
      });
      await admin.query({
        text: "INSERT INTO post_votes (community_id, post_vote_id, post_id, user_id, vote_value, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)",
        values: [
          "vote-guard-community",
          "vote-guard-vote",
          "vote-guard-post",
          "vote-guard-user",
          1,
          now,
        ],
      });

      const guarded = await applyMigrations(scopedConnectionString, migrations).catch(
        (error: unknown) => error,
      );
      expect(guarded).toMatchObject({
        _tag: "ControlPlaneStatementFailed",
        label: "postgres.migrations.0040_post_vote_actions.sql.apply",
        sqlState: "P0001",
      });
      const applied = await admin.query<{ readonly version: string }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      expect(applied.rows.at(-1)?.version).toBe(commentsRepliesRuntimeMigration.version);
      const installed = await admin.query<{ readonly exists: boolean }>(
        `SELECT to_regclass('post_vote_actions') IS NOT NULL AS exists`,
      );
      expect(installed.rows[0]?.exists).toBe(false);
    });
    completedTestCount += 1;
  });

  test("requires terminal creation requirements to have a matching ceremony result", async () => {
    await withSchema(async (admin, scopedConnectionString) => {
      await applyMigrations(scopedConnectionString, migrations);
      await admin.query(
        `INSERT INTO users (user_id, status, account)
         VALUES ('requirement-order-actor', 'active', '{}'::jsonb)`,
      );
      await admin.query(
        `INSERT INTO community_creation_intents (
           intent_id, actor_id, create_idempotency_key, create_request_hash,
           revision, status, draft, canonical_policy_revision,
           canonical_policy_hash, verification_requirement_hash,
           verification_provider_id, provider_configuration_kind,
           provider_configuration_ref, provider_configuration_version, expires_at
         ) VALUES (
           'requirement-order-intent', 'requirement-order-actor',
           'requirement-order-create-key', repeat('0', 64), 1,
           'verification_required',
           '{"name":"Requirement order","slug":"requirement-order","description":null,"policy":{}}'::jsonb,
           1, repeat('1', 64), repeat('2', 64), 'very.oauth', 'dynamic',
           'very-oauth', '1', clock_timestamp() + interval '1 day'
         )`,
      );
      await admin.query(
        `INSERT INTO community_creation_requirement_states (
           intent_id, actor_id, requirement_kind, status, requirement_hash,
           provider_id, provider_binding_hash, provider_configuration_kind,
           provider_configuration_ref, provider_configuration_version
         ) VALUES (
           'requirement-order-intent', 'requirement-order-actor',
           'human_identity', 'unmet', repeat('2', 64), 'very.oauth',
           repeat('3', 64), 'dynamic', 'very-oauth', '1'
         )`,
      );

      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO community_creation_ceremony_attempts (
           ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
           requirement_hash, provider_id, provider_binding_hash,
           provider_configuration_kind, provider_configuration_ref,
           provider_configuration_version, reservation_request_hash,
           reservation_request, expires_at
         ) VALUES (
           'terminal-gap-no-result', 'requirement-order-actor',
           'requirement-order-intent', 'human_identity', 1, repeat('2', 64),
           'very.oauth', repeat('3', 64), 'dynamic', 'very-oauth', '1',
           repeat('4', 64), '{}'::jsonb, clock_timestamp() + interval '10 minutes'
         )`,
      );
      await admin.query(
        `UPDATE community_creation_requirement_states
            SET status = 'pending', generation = 1,
                current_ceremony_intent_id = 'terminal-gap-no-result',
                updated_at = clock_timestamp()
          WHERE intent_id = 'requirement-order-intent'
            AND requirement_kind = 'human_identity'`,
      );
      await admin.query(
        `UPDATE community_creation_requirement_states
            SET status = 'failed', updated_at = clock_timestamp()
          WHERE intent_id = 'requirement-order-intent'
            AND requirement_kind = 'human_identity'`,
      );
      const absentResult = await admin.query<{ readonly count: string }>(
        `SELECT count(*)::text AS count
           FROM community_creation_ceremony_results
          WHERE ceremony_intent_id = 'terminal-gap-no-result'`,
      );
      expect(absentResult.rows[0]?.count).toBe("0");
      await expectPostgresFailure(admin, "P0001", "COMMIT", []);

      const rolledBackState = await admin.query<{
        readonly current_ceremony_intent_id: string | null;
        readonly generation: string;
        readonly status: string;
      }>(
        `SELECT status, generation::text, current_ceremony_intent_id
           FROM community_creation_requirement_states
          WHERE intent_id = 'requirement-order-intent'
            AND requirement_kind = 'human_identity'`,
      );
      expect(rolledBackState.rows[0]).toEqual({
        status: "unmet",
        generation: "0",
        current_ceremony_intent_id: null,
      });

      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO community_creation_ceremony_attempts (
           ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
           requirement_hash, provider_id, provider_binding_hash,
           provider_configuration_kind, provider_configuration_ref,
           provider_configuration_version, reservation_request_hash,
           reservation_request, expires_at
         ) VALUES (
           'result-before-state', 'requirement-order-actor',
           'requirement-order-intent', 'human_identity', 1, repeat('2', 64),
           'very.oauth', repeat('3', 64), 'dynamic', 'very-oauth', '1',
           repeat('5', 64), '{}'::jsonb, clock_timestamp() + interval '10 minutes'
         )`,
      );
      await admin.query(
        `UPDATE community_creation_requirement_states
            SET status = 'pending', generation = 1,
                current_ceremony_intent_id = 'result-before-state',
                updated_at = clock_timestamp()
          WHERE intent_id = 'requirement-order-intent'
            AND requirement_kind = 'human_identity'`,
      );
      await admin.query(
        `INSERT INTO community_creation_ceremony_results (
           ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
           requirement_hash, provider_id, provider_binding_hash,
           provider_configuration_version, callback_idempotency_key,
           callback_request_hash, outcome_status, result_hash, terminal_at
         ) VALUES (
           'result-before-state', 'requirement-order-actor',
           'requirement-order-intent', 'human_identity', 1, repeat('2', 64),
           'very.oauth', repeat('3', 64), '1', 'result-before-state-callback',
           repeat('6', 64), 'failed', repeat('7', 64), clock_timestamp()
         )`,
      );
      await admin.query(
        `UPDATE community_creation_requirement_states
            SET status = 'failed', updated_at = clock_timestamp()
          WHERE intent_id = 'requirement-order-intent'
            AND requirement_kind = 'human_identity'`,
      );
      await admin.query("COMMIT");

      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO community_creation_ceremony_attempts (
           ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
           requirement_hash, provider_id, provider_binding_hash,
           provider_configuration_kind, provider_configuration_ref,
           provider_configuration_version, reservation_request_hash,
           reservation_request, expires_at
         ) VALUES (
           'state-before-result', 'requirement-order-actor',
           'requirement-order-intent', 'human_identity', 2, repeat('2', 64),
           'very.oauth', repeat('3', 64), 'dynamic', 'very-oauth', '1',
           repeat('8', 64), '{}'::jsonb, clock_timestamp() + interval '10 minutes'
         )`,
      );
      await admin.query(
        `UPDATE community_creation_requirement_states
            SET status = 'pending', generation = 2,
                current_ceremony_intent_id = 'state-before-result',
                updated_at = clock_timestamp()
          WHERE intent_id = 'requirement-order-intent'
            AND requirement_kind = 'human_identity'`,
      );
      await admin.query(
        `UPDATE community_creation_requirement_states
            SET status = 'failed', updated_at = clock_timestamp()
          WHERE intent_id = 'requirement-order-intent'
            AND requirement_kind = 'human_identity'`,
      );
      await admin.query(
        `INSERT INTO community_creation_ceremony_results (
           ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
           requirement_hash, provider_id, provider_binding_hash,
           provider_configuration_version, callback_idempotency_key,
           callback_request_hash, outcome_status, result_hash, terminal_at
         ) VALUES (
           'state-before-result', 'requirement-order-actor',
           'requirement-order-intent', 'human_identity', 2, repeat('2', 64),
           'very.oauth', repeat('3', 64), '1', 'state-before-result-callback',
           repeat('9', 64), 'failed', repeat('a', 64), clock_timestamp()
         )`,
      );
      await admin.query("COMMIT");

      const persisted = await admin.query<{
        readonly ceremony_intent_id: string;
        readonly generation: string;
      }>(
        `SELECT ceremony_intent_id, generation::text
           FROM community_creation_ceremony_results
          WHERE intent_id = 'requirement-order-intent'
          ORDER BY generation`,
      );
      expect(persisted.rows).toEqual([
        { ceremony_intent_id: "result-before-state", generation: "1" },
        { ceremony_intent_id: "state-before-result", generation: "2" },
      ]);
      const finalState = await admin.query<{
        readonly current_ceremony_intent_id: string | null;
        readonly generation: string;
        readonly status: string;
      }>(
        `SELECT status, generation::text, current_ceremony_intent_id
           FROM community_creation_requirement_states
          WHERE intent_id = 'requirement-order-intent'
            AND requirement_kind = 'human_identity'`,
      );
      expect(finalState.rows[0]).toEqual({
        status: "failed",
        generation: "2",
        current_ceremony_intent_id: "state-before-result",
      });
    });
    completedTestCount += 1;
  });

  test("enforces canonical routes and independently fenced creation requirements", async () => {
    await withSchema(async (admin, scopedConnectionString) => {
      await applyMigrations(scopedConnectionString, migrations);
      const routeGrammar = await admin.query<{
        readonly hns_blacklisted: boolean;
        readonly hns_consecutive_hyphen: boolean;
        readonly hns_too_long: boolean;
        readonly hns_underscore: boolean;
        readonly spaces_ace: boolean;
        readonly spaces_consecutive_hyphen: boolean;
        readonly spaces_too_long: boolean;
        readonly spaces_underscore: boolean;
        readonly unicode_display: boolean;
        readonly whitespace_display: boolean;
      }>(
        `SELECT
           is_community_route_root_label('hns', 'test') AS hns_blacklisted,
           is_community_route_root_label('hns', 'one--two') AS hns_consecutive_hyphen,
           is_community_route_root_label('hns', repeat('a', 64)) AS hns_too_long,
           is_community_route_root_label('hns', 'tame_impala') AS hns_underscore,
           is_community_route_root_label('spaces', 'xn--t77hga') AS spaces_ace,
           is_community_route_root_label('spaces', 'one--two') AS spaces_consecutive_hyphen,
           is_community_route_root_label('spaces', repeat('a', 63)) AS spaces_too_long,
           is_community_route_root_label('spaces', 'tame_impala') AS spaces_underscore,
           is_community_route_root_label_display('🔥') AS unicode_display,
           is_community_route_root_label_display(' music ') AS whitespace_display`,
      );
      expect(routeGrammar.rows[0]).toEqual({
        hns_blacklisted: false,
        hns_consecutive_hyphen: true,
        hns_too_long: false,
        hns_underscore: true,
        spaces_ace: true,
        spaces_consecutive_hyphen: false,
        spaces_too_long: false,
        spaces_underscore: false,
        unicode_display: true,
        whitespace_display: false,
      });
      await admin.query(
        `INSERT INTO users (user_id, status, account)
         VALUES ('route-creator', 'active', '{}'::jsonb),
                ('other-route-creator', 'active', '{}'::jsonb)`,
      );
      await admin.query(
        `INSERT INTO community_creation_intents (
           intent_id, actor_id, create_idempotency_key, create_request_hash,
           revision, status, draft, canonical_policy_revision,
           canonical_policy_hash, verification_requirement_hash,
           verification_provider_id, provider_configuration_kind,
           provider_configuration_ref, provider_configuration_version, expires_at
         ) VALUES (
           'route-intent', 'route-creator', 'route-create-key', repeat('0', 64),
           1, 'verification_required',
           '{"name":"Jazleeuw","slug":"legacy-only","description":null,"policy":{}}'::jsonb,
           1, repeat('1', 64), repeat('2', 64), 'very.oauth', 'dynamic',
           'very-oauth', '1', clock_timestamp() + interval '1 day'
         ), (
           'null-route-intent', 'route-creator', 'null-route-create-key', repeat('d', 64),
           1, 'verification_required',
           '{"name":"Null route","slug":"legacy-null","description":null,"policy":{}}'::jsonb,
           1, repeat('1', 64), repeat('2', 64), 'very.oauth', 'dynamic',
           'very-oauth', '1', clock_timestamp() + interval '1 day'
         )`,
      );
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO community_creation_requirement_states (
           intent_id, actor_id, requirement_kind, status, requirement_hash,
           provider_id, provider_binding_hash, provider_configuration_kind,
           provider_configuration_ref, provider_configuration_version,
           route_family, route_root_label, route_root_label_display,
           route_path_segment
         ) VALUES (
           'null-route-intent', 'route-creator', 'namespace_ownership', 'unmet',
           repeat('4', 64), 'hns.owner.v1', repeat('5', 64), 'dynamic',
           'hns-owner', '1', 'hns', NULL, NULL, NULL
         )`,
        [],
      );
      await admin.query(
        `INSERT INTO community_creation_requirement_states (
           intent_id, actor_id, requirement_kind, status, requirement_hash,
           provider_id, provider_binding_hash, provider_configuration_kind,
           provider_configuration_ref, provider_configuration_version,
           route_family, route_root_label, route_root_label_display,
           route_path_segment
         ) VALUES (
           'route-intent', 'route-creator', 'human_identity', 'unmet', repeat('2', 64),
           'very.oauth', repeat('3', 64), 'dynamic', 'very-oauth', '1',
           NULL, NULL, NULL, NULL
         ), (
           'route-intent', 'route-creator', 'namespace_ownership', 'unmet', repeat('4', 64),
           'hns.owner.v1', repeat('5', 64), 'dynamic', 'hns-owner', '1',
           'hns', 'xn--mnchen-3ya', 'münchen', 'app.xn--mnchen-3ya'
         )`,
      );

      await expectPostgresFailure(
        admin,
        "P0001",
        `INSERT INTO community_creation_ceremony_attempts (
           ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
           requirement_hash, provider_id, provider_binding_hash,
           provider_configuration_kind, provider_configuration_ref,
           provider_configuration_version, route_family, route_root_label,
           route_root_label_display, route_path_segment,
           reservation_request_hash, reservation_request, expires_at
         ) VALUES (
           'ceremony-mismatch', 'route-creator', 'route-intent',
           'namespace_ownership', 1, repeat('4', 64), 'hns.owner.v1', repeat('5', 64),
           'dynamic', 'hns-owner', '1', 'hns', 'other', 'other', 'app.other',
           repeat('6', 64), '{}'::jsonb, clock_timestamp() + interval '10 minutes'
         )`,
        [],
      );

      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO community_creation_ceremony_attempts (
           ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
           requirement_hash, provider_id, provider_binding_hash,
           provider_configuration_kind, provider_configuration_ref,
           provider_configuration_version, route_family, route_root_label,
           route_root_label_display, route_path_segment,
           reservation_request_hash, reservation_request, expires_at
         ) VALUES (
           'ceremony-route-1', 'route-creator', 'route-intent',
           'namespace_ownership', 1, repeat('4', 64), 'hns.owner.v1', repeat('5', 64),
           'dynamic', 'hns-owner', '1', 'hns', 'xn--mnchen-3ya', 'münchen',
           'app.xn--mnchen-3ya', repeat('6', 64),
           '{"requirement":"namespace_ownership"}'::jsonb,
           clock_timestamp() + interval '10 minutes'
         )`,
      );
      await admin.query(
        `UPDATE community_creation_requirement_states
            SET status = 'pending', generation = 1,
                current_ceremony_intent_id = 'ceremony-route-1',
                updated_at = clock_timestamp()
          WHERE intent_id = 'route-intent'
            AND requirement_kind = 'namespace_ownership'`,
      );
      await admin.query("COMMIT");

      await expectPostgresFailure(
        admin,
        "23503",
        `INSERT INTO proof_sessions (
           proof_session_id, actor_id, intent_id, request_hash, provider_id,
           method, issuer, scope_kind, request_mode, protocol_version,
           environment, status, requested_requirements, requested_claim_ids,
           subject_binding_intent, started_at, expires_at,
           provider_configuration_kind, provider_configuration_ref,
           provider_configuration_version, creation_ceremony_intent_id
         ) VALUES (
           'cross-actor-route-proof', 'other-route-creator', 'ceremony-route-1',
           repeat('e', 64), 'hns.owner.v1', 'document', 'hns.owner.v1', 'none',
           'dynamic', '1', 'test', 'pending',
           '[{"claim_id":"namespace.ownership"}]'::jsonb,
           '["namespace.ownership"]'::jsonb, 'establish',
           clock_timestamp(), clock_timestamp() + interval '10 minutes',
           'dynamic', 'hns-owner', '1', 'ceremony-route-1'
         )`,
        [],
      );

      await expectPostgresFailure(
        admin,
        "P0001",
        `UPDATE community_creation_ceremony_attempts
            SET expires_at = expires_at + interval '1 minute'
          WHERE ceremony_intent_id = 'ceremony-route-1'`,
        [],
      );

      const routeTerminalAt = (
        await admin.query<{ readonly value: string }>(
          "SELECT (clock_timestamp() - interval '10 seconds')::text AS value",
        )
      ).rows[0]?.value;
      if (routeTerminalAt === undefined) throw new Error("route terminal time was unavailable");
      const routeExpiresAt = (
        await admin.query<{ readonly value: string }>(
          "SELECT (clock_timestamp() + interval '2 seconds')::text AS value",
        )
      ).rows[0]?.value;
      if (routeExpiresAt === undefined) throw new Error("route expiry time was unavailable");

      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO namespace_ownership_start_reservations (
           reservation_id, namespace_session_id, actor_id, creation_intent_id,
           ceremony_intent_id, generation, requirement_hash, expected_revision,
           client_idempotency_key, request_hash, provider_id, provider_binding_hash,
           provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
           protocol_version, environment, route_family, route_root_label, route_root_label_display,
           route_path_segment, route_href, state, fence_token, lease_expires_at
         ) VALUES (
           'route-start-reservation', 'route-namespace-session', 'route-creator', 'route-intent',
           'ceremony-route-1', 1, repeat('4', 64), 1, 'route-start-key', repeat('e', 64),
           'hns.owner.v1', repeat('5', 64), 'dynamic', 'hns-owner', '1', 'hns-txt-v1', 'test',
           'hns', 'xn--mnchen-3ya', 'münchen', 'app.xn--mnchen-3ya',
           '/c/app.xn--mnchen-3ya', 'acquired', 1, clock_timestamp() + interval '30 minutes')`,
      );
      await admin.query(
        `INSERT INTO namespace_ownership_sessions (
           namespace_session_id, actor_id, creation_intent_id, ceremony_intent_id,
           start_reservation_id, start_fence_token, expected_revision, generation,
           requirement_hash, request_hash, provider_id, provider_binding_hash,
           provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
           protocol_version, environment, route_family, route_root_label, route_root_label_display,
           route_path_segment, route_href, upstream_session_ref, presentation_kind,
           presentation_payload, status, started_at, expires_at
         ) VALUES (
           'route-namespace-session', 'route-creator', 'route-intent', 'ceremony-route-1',
           'route-start-reservation', 1, 1, 1, repeat('4', 64), repeat('e', 64),
           'hns.owner.v1', repeat('5', 64), 'dynamic', 'hns-owner', '1', 'hns-txt-v1', 'test',
           'hns', 'xn--mnchen-3ya', 'münchen', 'app.xn--mnchen-3ya',
           '/c/app.xn--mnchen-3ya', 'upstream-route', 'poll', '{"session_id":"route"}'::jsonb,
           'pending', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour')`,
      );
      await admin.query(
        `UPDATE namespace_ownership_start_reservations
            SET state = 'finalized', updated_at = clock_timestamp()
          WHERE reservation_id = 'route-start-reservation'`,
      );
      await admin.query(
        `INSERT INTO namespace_ownership_completion_attempts (
           completion_attempt_id, namespace_session_id, actor_id, idempotency_key,
           completion_request_hash, evidence_ref, submission_channel, state, fence_token,
           lease_expires_at
         ) VALUES (
           'route-completion-attempt', 'route-namespace-session', 'route-creator',
           'callback-route-1', repeat('7', 64), 'route-evidence-1', 'poll_result',
           'leased', 1, clock_timestamp() + interval '30 minutes')`,
      );
      await admin.query(
        `UPDATE namespace_ownership_completion_attempts
            SET state = 'consumed', consumption_kind = 'verified',
                updated_at = clock_timestamp()
          WHERE completion_attempt_id = 'route-completion-attempt'`,
      );
      await admin.query(
        `INSERT INTO namespace_ownership_evidence_snapshots (
           evidence_ref, completion_attempt_id, namespace_session_id, actor_id,
           creation_intent_id, ceremony_intent_id, generation, requirement_hash, request_hash,
           provider_id, provider_binding_hash, provider_configuration_kind,
           provider_configuration_ref, provider_configuration_version, protocol_version,
           environment, family, root_label, root_label_display, path_segment, href, upstream_session_ref,
           fence_token, ownership_source, challenge_name, challenge_value_sha256, root_exists,
           root_control_verified, expiry_horizon_sufficient, chain_network, chain_anchor_height,
           chain_anchor_block_hash, chain_anchor_median_time, expiry_height, observed_at, expires_at,
           provider_evidence_ref, observation_sha256, provider_identity_digest, evidence_digest,
           observation, raw_response_bytes
         ) VALUES (
           'route-evidence-1', 'route-completion-attempt', 'route-namespace-session',
           'route-creator', 'route-intent', 'ceremony-route-1', 1, repeat('4', 64), repeat('e', 64),
           'hns.owner.v1', repeat('5', 64), 'dynamic', 'hns-owner', '1', 'hns-txt-v1', 'test',
           'hns', 'xn--mnchen-3ya', 'münchen', 'app.xn--mnchen-3ya', '/c/app.xn--mnchen-3ya',
           'upstream-route', 1, 'owner_authoritative_dns_txt', '_pirate.xn--mnchen-3ya', repeat('6', 64),
           TRUE, TRUE, TRUE, 'hns-testnet', 10, repeat('b', 64), 100, 20,
           clock_timestamp() - interval '1 minute', $1::timestamptz,
           'provider-evidence-route', repeat('7', 64), repeat('a', 64), repeat('9', 64),
           '{"status":"verified"}'::jsonb, decode('01', 'hex'))`,
        [routeExpiresAt],
      );
      await admin.query(
        `INSERT INTO community_creation_ceremony_results (
           ceremony_intent_id, actor_id, intent_id, requirement_kind, generation,
           requirement_hash, provider_id, provider_binding_hash,
           provider_configuration_version, callback_idempotency_key,
           callback_request_hash, outcome_status, result_hash, evidence_ref,
           evidence_digest, provider_identity_digest, terminal_at, satisfied_at,
           namespace_session_id, completion_attempt_id, submission_channel
         ) VALUES (
           'ceremony-route-1', 'route-creator', 'route-intent',
           'namespace_ownership', 1, repeat('4', 64), 'hns.owner.v1', repeat('5', 64),
           '1', 'callback-route-1', repeat('7', 64), 'satisfied', repeat('8', 64),
           'route-evidence-1', repeat('9', 64), repeat('a', 64),
           $1, $1, 'route-namespace-session', 'route-completion-attempt', 'poll_result'
         )`,
        [routeTerminalAt],
      );
      await admin.query(
        `UPDATE community_creation_requirement_states
            SET status = 'satisfied', satisfied_at = $1,
                updated_at = clock_timestamp()
          WHERE intent_id = 'route-intent'
            AND requirement_kind = 'namespace_ownership'`,
        [routeTerminalAt],
      );
      await admin.query(
        `UPDATE namespace_ownership_sessions
            SET status = 'completed', terminal_at = $1, completed_at = $1,
                updated_at = clock_timestamp()
          WHERE namespace_session_id = 'route-namespace-session'`,
        [routeTerminalAt],
      );
      await admin.query("SAVEPOINT route_terminal_ready");

      const independentRequirements = await admin.query<{
        readonly requirement_kind: string;
        readonly status: string;
      }>(
        `SELECT requirement_kind, status
           FROM community_creation_requirement_states
          WHERE intent_id = 'route-intent'
          ORDER BY requirement_kind`,
      );
      expect(independentRequirements.rows).toEqual([
        { requirement_kind: "human_identity", status: "unmet" },
        { requirement_kind: "namespace_ownership", status: "satisfied" },
      ]);

      await admin.query(
        `INSERT INTO community_route_ownership_evidence (
           evidence_ref, creation_ceremony_intent_id, verified_by_actor_id,
           family, root_label, root_label_display, path_segment,
           requirement_hash, provider_id, provider_binding_hash,
           provider_configuration_version,
           provider_identity_digest, evidence_digest, binding_generation,
           verified_at, expires_at
         ) VALUES (
           'route-evidence-1', 'ceremony-route-1', 'route-creator', 'hns',
           'xn--mnchen-3ya', 'münchen', 'app.xn--mnchen-3ya', repeat('4', 64),
           'hns.owner.v1',
           repeat('5', 64), '1', repeat('a', 64), repeat('9', 64), 1,
           $1, $2::timestamptz
         )`,
        [routeTerminalAt, routeExpiresAt],
      );

      await admin.query(
        `INSERT INTO communities (
           community_id, display_name, status, created_by_user_id,
           created_at, updated_at, route_slug
         ) VALUES (
           'route-community', 'Jazleeuw', 'active', 'route-creator',
           clock_timestamp(), clock_timestamp(), 'legacy-only'
         ), (
           'unbound-community', 'Unbound', 'hidden', 'route-creator',
           clock_timestamp(), clock_timestamp(), 'still-not-authority'
         ), (
           'archived-community', 'Archived', 'archived', 'route-creator',
           clock_timestamp(), clock_timestamp(), NULL
         )`,
      );
      const unbound = await admin.query<{ readonly count: string }>(
        `SELECT count(*)::text AS count
           FROM community_canonical_route_bindings
          WHERE community_id = 'unbound-community'`,
      );
      expect(unbound.rows[0]?.count).toBe("0");
      await admin.query("SAVEPOINT route_v1_unbound");
      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO communities (
           community_id, display_name, status, created_by_user_id,
           created_at, updated_at, route_slug, route_authority_version
         ) VALUES (
           'route-v1-unbound', 'Route v1 unbound', 'active', 'route-creator',
           clock_timestamp(), clock_timestamp(), NULL, 'route_v1'
         )`,
        [],
      );
      await admin.query("ROLLBACK TO SAVEPOINT route_v1_unbound");

      await admin.query("RELEASE SAVEPOINT route_terminal_ready");
      await admin.query(
        `INSERT INTO community_canonical_route_bindings (
           route_binding_id, community_id, family, root_label,
           root_label_display, ownership_status, route_lifecycle_status,
           binding_generation, verified_evidence_ref
         ) VALUES (
           'route-binding-1', 'route-community', 'hns', 'xn--mnchen-3ya', 'münchen',
           'verified', 'active', 1, 'route-evidence-1'
         )`,
      );
      await admin.query(
        `UPDATE communities
            SET canonical_route_binding_id = 'route-binding-1'
          WHERE community_id = 'route-community'`,
      );
      await admin.query("COMMIT");

      const canonical = await admin.query<{
        readonly path_segment: string;
        readonly href: string;
        readonly route_lifecycle_status: string;
      }>(
        `SELECT path_segment, href, route_lifecycle_status
           FROM community_canonical_route_bindings
          WHERE route_binding_id = 'route-binding-1'`,
      );
      expect(canonical.rows[0]).toEqual({
        path_segment: "app.xn--mnchen-3ya",
        href: "/c/app.xn--mnchen-3ya",
        route_lifecycle_status: "active",
      });

      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO community_creation_intents (
           intent_id, actor_id, create_idempotency_key, create_request_hash,
           revision, status, draft, canonical_policy_revision,
           canonical_policy_hash, verification_requirement_hash,
           verification_provider_id, provider_configuration_kind,
           provider_configuration_ref, provider_configuration_version,
           expires_at, committed_community_id, committed_resource_href,
           creation_contract_version
         ) VALUES (
           'route-v1-live-evidence', 'route-creator', 'route-v1-live-key', repeat('c', 64),
           1, 'commit_ready',
           '{"name":"Jazleeuw","description":null,"route_request":{"family":"hns","root_label":"xn--mnchen-3ya"},"policy":{}}'::jsonb,
           1, repeat('1', 64), repeat('2', 64), 'very.oauth', 'dynamic',
           'very-oauth', '1', clock_timestamp() + interval '1 day',
           NULL, NULL, 'route_v1'
         )`,
      );
      await admin.query(
        `INSERT INTO community_creation_requirement_states (
           intent_id, actor_id, requirement_kind, status, requirement_hash,
           provider_id, provider_binding_hash, provider_configuration_kind,
           provider_configuration_ref, provider_configuration_version,
           route_family, route_root_label, route_root_label_display, route_path_segment
         ) VALUES (
           'route-v1-live-evidence', 'route-creator', 'human_identity', 'unmet',
           repeat('2', 64), 'very.oauth', repeat('3', 64), 'dynamic',
           'very-oauth', '1', NULL, NULL, NULL, NULL
         ), (
           'route-v1-live-evidence', 'route-creator', 'namespace_ownership', 'unmet',
           repeat('4', 64), 'hns.owner.v1', repeat('5', 64), 'dynamic',
           'hns-owner', '1', 'hns', 'xn--mnchen-3ya', 'münchen',
           'app.xn--mnchen-3ya'
         )`,
      );
      await admin.query("COMMIT");

      await new Promise((resolve) => setTimeout(resolve, 2_100));
      await expectPostgresFailure(
        admin,
        "P0001",
        `UPDATE community_creation_intents
            SET revision = 2, status = 'committed',
                committed_community_id = 'route-community',
                committed_resource_href = '/c/app.xn--mnchen-3ya',
                updated_at = clock_timestamp()
          WHERE intent_id = 'route-v1-live-evidence'`,
        [],
      );

      // Expansion deliberately leaves the legacy active row shape available;
      // the cutover migration makes active canonical references mandatory.
      await admin.query(
        `INSERT INTO communities (
           community_id, display_name, status, created_by_user_id,
           created_at, updated_at, route_slug
         ) VALUES (
           'same-root-hns', 'Same root HNS', 'hidden', 'route-creator',
           clock_timestamp(), clock_timestamp(), 'same-root-hns'
         ), (
           'same-root-spaces', 'Same root Spaces', 'hidden', 'route-creator',
           clock_timestamp(), clock_timestamp(), 'same-root-spaces'
         ), (
           'same-root-hns-collision', 'Same root HNS collision', 'hidden',
           'route-creator', clock_timestamp(), clock_timestamp(),
           'same-root-hns-collision'
         )`,
      );
      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO community_canonical_route_bindings (
           route_binding_id, community_id, family, root_label,
           root_label_display, ownership_status, route_lifecycle_status
         ) VALUES (
           'same-root-hns-binding', 'same-root-hns', 'hns', 'xn--4v8h', '🔥',
           'pending', 'suspended'
         ), (
           'same-root-spaces-binding', 'same-root-spaces', 'spaces', 'xn--4v8h', '🔥',
           'pending', 'suspended'
         )`,
      );
      await admin.query(
        `UPDATE communities
            SET canonical_route_binding_id = CASE community_id
              WHEN 'same-root-hns' THEN 'same-root-hns-binding'
              WHEN 'same-root-spaces' THEN 'same-root-spaces-binding'
            END
          WHERE community_id IN ('same-root-hns', 'same-root-spaces')`,
      );
      await admin.query("COMMIT");
      const sameRoot = await admin.query<{ readonly path_segment: string }>(
        `SELECT path_segment
           FROM community_canonical_route_bindings
          WHERE root_label = 'xn--4v8h'
          ORDER BY family`,
      );
      expect(sameRoot.rows).toEqual([
        { path_segment: "app.xn--4v8h" },
        { path_segment: "@xn--4v8h" },
      ]);
      await expectPostgresFailure(
        admin,
        "23505",
        `INSERT INTO community_canonical_route_bindings (
           route_binding_id, community_id, family, root_label,
           root_label_display, ownership_status, route_lifecycle_status
         ) VALUES (
           'same-root-hns-collision-binding', 'same-root-hns-collision', 'hns',
           'xn--4v8h', '🔥', 'pending', 'suspended'
         )`,
        [],
      );

      await expectPostgresFailure(
        admin,
        "P0001",
        `UPDATE community_canonical_route_bindings
            SET root_label = 'replacement'
          WHERE route_binding_id = 'route-binding-1'`,
        [],
      );
      await expectPostgresFailure(
        admin,
        "P0001",
        `UPDATE communities
            SET canonical_route_binding_id = NULL
          WHERE community_id = 'route-community'`,
        [],
      );

      await admin.query(
        `INSERT INTO community_route_app_host_health (
           route_binding_id, health_status, health_generation
         ) VALUES ('route-binding-1', 'unhealthy', 1)`,
      );
      const stillActive = await admin.query<{ readonly route_lifecycle_status: string }>(
        `SELECT route_lifecycle_status
           FROM community_canonical_route_bindings
          WHERE route_binding_id = 'route-binding-1'`,
      );
      expect(stillActive.rows[0]?.route_lifecycle_status).toBe("active");

      await admin.query(
        `UPDATE community_canonical_route_bindings
            SET ownership_status = 'expired', route_lifecycle_status = 'suspended',
                binding_generation = 2, updated_at = clock_timestamp()
          WHERE route_binding_id = 'route-binding-1'`,
      );
      // The BEFORE trigger fails closed before PostgreSQL reaches NOT NULL.
      await expectPostgresFailure(
        admin,
        "P0001",
        `INSERT INTO community_route_ownership_evidence (
           evidence_ref, creation_ceremony_intent_id, verified_by_actor_id,
           family, root_label, root_label_display, path_segment,
           requirement_hash, provider_id, provider_binding_hash,
           provider_configuration_version, provider_identity_digest,
           evidence_digest, binding_generation, verified_at
         ) VALUES (
           'unfenced-route-evidence', NULL, 'route-creator', 'hns',
           'xn--mnchen-3ya', 'münchen', 'app.xn--mnchen-3ya', repeat('4', 64),
           'hns.owner.v1', repeat('5', 64), '1', repeat('a', 64),
           repeat('b', 64), 3, '2026-08-20T01:00:00.000Z'
         )`,
        [],
      );

      await admin.query(
        `UPDATE community_creation_requirement_states
            SET status = 'unmet', provider_binding_hash = repeat('c', 64),
                provider_configuration_version = '2',
                current_ceremony_intent_id = NULL, satisfied_at = NULL,
                updated_at = clock_timestamp()
          WHERE intent_id = 'route-intent'
            AND requirement_kind = 'namespace_ownership'`,
      );
      const invalidated = await admin.query<{
        readonly status: string;
        readonly generation: string;
        readonly current_ceremony_intent_id: string | null;
      }>(
        `SELECT status, generation::text, current_ceremony_intent_id
           FROM community_creation_requirement_states
          WHERE intent_id = 'route-intent'
            AND requirement_kind = 'namespace_ownership'`,
      );
      expect(invalidated.rows[0]).toEqual({
        status: "unmet",
        generation: "1",
        current_ceremony_intent_id: null,
      });
      // Reuse the immutable result's exact evidence_ref so every result field
      // matches; the BEFORE trigger must reject only because generation one is
      // no longer the requirement state's current satisfied ceremony. It runs
      // before the duplicate primary-key check.
      await expectPostgresFailure(
        admin,
        "P0001",
        `INSERT INTO community_route_ownership_evidence (
           evidence_ref, creation_ceremony_intent_id, verified_by_actor_id,
           family, root_label, root_label_display, path_segment,
           requirement_hash, provider_id, provider_binding_hash,
           provider_configuration_version, provider_identity_digest,
           evidence_digest, binding_generation, verified_at
         ) VALUES (
           'route-evidence-1', 'ceremony-route-1', 'route-creator', 'hns',
           'xn--mnchen-3ya', 'münchen', 'app.xn--mnchen-3ya', repeat('4', 64),
           'hns.owner.v1', repeat('5', 64), '1', repeat('a', 64),
           repeat('9', 64), 1, '2026-08-20T00:00:00.000Z'
         )`,
        [],
      );
    });
    completedTestCount += 1;
  });

  test("fences route-v1 drafts and requires both creation requirements", async () => {
    await withSchema(async (admin, scopedConnectionString) => {
      await applyMigrations(scopedConnectionString, migrations);
      await admin.query("INSERT INTO users (user_id) VALUES ('route-v1-creator')");

      await expectPostgresFailure(
        admin,
        "23514",
        `INSERT INTO community_creation_intents (
           intent_id, actor_id, create_idempotency_key, create_request_hash,
           revision, status, draft, canonical_policy_revision,
           canonical_policy_hash, verification_requirement_hash,
           verification_provider_id, provider_configuration_kind,
           provider_configuration_ref, provider_configuration_version,
           expires_at, creation_contract_version
         ) VALUES (
           'route-v1-invalid', 'route-v1-creator', 'invalid-draft', repeat('1', 64),
           1, 'verification_required',
           '{"name":"Legacy","slug":"legacy","description":null,"policy":{}}'::jsonb,
           1, repeat('2', 64), repeat('3', 64), 'very.oauth', 'dynamic',
           'very-oauth', '1', clock_timestamp() + interval '1 day', 'route_v1'
         )`,
        [],
      );

      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO community_creation_intents (
           intent_id, actor_id, create_idempotency_key, create_request_hash,
           revision, status, draft, canonical_policy_revision,
           canonical_policy_hash, verification_requirement_hash,
           verification_provider_id, provider_configuration_kind,
           provider_configuration_ref, provider_configuration_version,
           expires_at, creation_contract_version
         ) VALUES (
           'route-v1-incomplete', 'route-v1-creator', 'incomplete', repeat('1', 64),
           1, 'verification_required',
           '{"name":"Route","description":null,"route_request":{"family":"hns","root_label":"jazleeuw"},"policy":{}}'::jsonb,
           1, repeat('2', 64), repeat('3', 64), 'very.oauth', 'dynamic',
           'very-oauth', '1', clock_timestamp() + interval '1 day', 'route_v1'
         )`,
      );
      await admin.query(
        `INSERT INTO community_creation_requirement_states (
           intent_id, actor_id, requirement_kind, status, requirement_hash,
           provider_id, provider_binding_hash, provider_configuration_kind,
           provider_configuration_ref, provider_configuration_version, generation
         ) VALUES (
           'route-v1-incomplete', 'route-v1-creator', 'human_identity', 'unmet',
           repeat('3', 64), 'very.oauth', repeat('4', 64), 'dynamic', 'very-oauth', '1', 0
         )`,
      );
      await expectPostgresFailure(admin, "P0001", "COMMIT", []);
      await admin.query("ROLLBACK");

      await admin.query("BEGIN");
      await admin.query(
        `INSERT INTO community_creation_intents (
           intent_id, actor_id, create_idempotency_key, create_request_hash,
           revision, status, draft, canonical_policy_revision,
           canonical_policy_hash, verification_requirement_hash,
           verification_provider_id, provider_configuration_kind,
           provider_configuration_ref, provider_configuration_version,
           expires_at, creation_contract_version
         ) VALUES (
           'route-v1-complete', 'route-v1-creator', 'complete', repeat('1', 64),
           1, 'verification_required',
           '{"name":"Route","description":null,"route_request":{"family":"hns","root_label":"jazleeuw"},"policy":{}}'::jsonb,
           1, repeat('2', 64), repeat('3', 64), 'very.oauth', 'dynamic',
           'very-oauth', '1', clock_timestamp() + interval '1 day', 'route_v1'
         )`,
      );
      await admin.query(
        `INSERT INTO community_creation_requirement_states (
           intent_id, actor_id, requirement_kind, status, requirement_hash,
           provider_id, provider_binding_hash, provider_configuration_kind,
           provider_configuration_ref, provider_configuration_version,
           route_family, route_root_label, route_root_label_display,
           route_path_segment, generation
         ) VALUES
         (
           'route-v1-complete', 'route-v1-creator', 'human_identity', 'unmet',
           repeat('3', 64), 'very.oauth', repeat('4', 64), 'dynamic', 'very-oauth', '1',
           NULL, NULL, NULL, NULL, 0
         ),
         (
           'route-v1-complete', 'route-v1-creator', 'namespace_ownership', 'unmet',
           repeat('5', 64), 'hns.owner.v1', repeat('6', 64), 'managed',
           'hns-owner-staging', '1', 'hns', 'jazleeuw', 'jazleeuw',
           'app.jazleeuw', 0
         )`,
      );
      await admin.query("COMMIT");

      const rows = await admin.query<{ readonly count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM community_creation_requirement_states
          WHERE intent_id = 'route-v1-complete'`,
      );
      expect(rows.rows[0]?.count).toBe("2");

      await admin.query(
        `INSERT INTO communities (
           community_id, display_name, status, created_by_user_id,
           created_at, updated_at, membership_mode, human_verification_lane
         ) VALUES (
           'route-v1-unbound', 'Unbound', 'active', 'route-v1-creator',
           clock_timestamp(), clock_timestamp(), 'gated', 'very'
         )`,
      );
      await admin.query("BEGIN");
      await admin.query(
        `UPDATE community_creation_intents
            SET revision = revision + 1, status = 'commit_ready'
          WHERE intent_id = 'route-v1-complete'`,
      );
      await admin.query(
        `UPDATE community_creation_intents
            SET revision = revision + 1, status = 'committed',
                committed_community_id = 'route-v1-unbound',
                committed_resource_href = '/c/app.jazleeuw'
          WHERE intent_id = 'route-v1-complete'`,
      );
      await expectPostgresFailure(admin, "P0001", "COMMIT", []);
      await admin.query("ROLLBACK");
    });
    completedTestCount += 1;
  });

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === foundationTestCount) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
