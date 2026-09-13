import type { CutoverIdentityRow, HnsReadinessCutoverBundle } from "./hns-readiness-cutover.ts";

/**
 * The staging contract for the delegated HNS post-migration entry point.
 *
 * These constants and types are what the staging reset orchestrator binds
 * against: the authorized target, the live provider-verified binding it must
 * match, the reviewed privilege matrix and the ports the entry point consumes.
 * Every target is staging-explicit; nothing here defaults to production.
 */

export const HNS_STAGING_SERVICE_UNIT = "pirate-hns-authority-provisioner-staging.service";
export const HNS_STAGING_DATABASE_ID = "mvydkmmwh5x4";
export const HNS_STAGING_BRANCH_ID = "syu03e00w3ux";
export const HNS_STAGING_PROVIDER_DATABASE_NAME = "pirate-staging";
export const HNS_STAGING_BRANCH_NAME = "main";
export const HNS_STAGING_SQL_DATABASE = "postgres";

export type HnsStagingAuthorizedTarget = Readonly<{
  readonly database_id: string;
  readonly database_name: string;
  readonly sql_database: string;
  readonly branch_id: string;
  readonly branch_name: string;
  readonly runtime_role: string;
  readonly operator_role: string;
  readonly migrator_role: string;
  readonly service_unit: string;
}>;

/** Live, provider-verified target facts. Supplied by the reset lane's
 * collector in process; never a deserialized authorization receipt. */
export type HnsStagingTargetBinding = Readonly<{
  readonly database_id: string;
  readonly database_name: string;
  readonly sql_database: string;
  readonly branch_id: string;
  readonly branch_name: string;
  readonly branch_ready: boolean;
  readonly migrator_role: string;
}>;

export type HnsStagingMigration = Readonly<{
  readonly version: string;
  readonly checksum: string;
}>;

export type HnsStagingPrivilegeRow = Readonly<{
  readonly probe_execute: boolean;
  readonly identity_insert: boolean;
  readonly identity_update: boolean;
  readonly identity_delete: boolean;
}>;

export type HnsStagingPrivilegeMatrix = Readonly<{
  readonly runtime: HnsStagingPrivilegeRow;
  readonly operator: HnsStagingPrivilegeRow;
}>;

export type HnsStagingPostMigrationPorts = Readonly<{
  readonly readTargetBinding: () => Promise<HnsStagingTargetBinding>;
  readonly readMigratorIdentity: () => Promise<string>;
  readonly readRuntimeIdentity: () => Promise<string>;
  readonly readOperatorIdentity: () => Promise<string>;
  readonly readMigrationLedger: () => Promise<readonly HnsStagingMigration[]>;
  readonly readPinnedMigrations: () => Promise<readonly HnsStagingMigration[]>;
  readonly applyReviewedGrants: (input: {
    readonly runtime_role: string;
    readonly operator_role: string;
  }) => Promise<void>;
  readonly readPrivilegeMatrix: (input: {
    readonly runtime_role: string;
    readonly operator_role: string;
  }) => Promise<HnsStagingPrivilegeMatrix>;
  readonly stageBundle: (input: {
    readonly bundle: HnsReadinessCutoverBundle;
    readonly stage_directory: string;
  }) => Promise<void>;
  readonly seedExecutionProbe: () => Promise<void>;
  readonly startService: (unit: string) => Promise<void>;
  readonly readSchemaCompatibility: (input: {
    readonly service_version: string;
    readonly job_envelope_version: string;
  }) => Promise<string>;
  readonly readCutoverIdentity: () => Promise<CutoverIdentityRow | undefined>;
}>;

export type HnsStagingPostMigrationStep =
  | "target_and_ledger"
  | "identities"
  | "grants"
  | "privilege_matrix"
  | "bundle"
  | "probe"
  | "service"
  | "schema_compatibility"
  | "service_identity"
  | "executor_progress";

export type HnsStagingPostMigrationResult = Readonly<{
  readonly outcome: "post_migration_applied";
  readonly attempt_id: string;
  readonly results: readonly Readonly<{
    readonly step: HnsStagingPostMigrationStep;
    readonly result: Readonly<Record<string, unknown>>;
  }>[];
}>;

export type HnsStagingServiceDisposition = Readonly<{
  readonly unit: string;
  readonly started: true;
  readonly disposition: "started_unverified";
  readonly attempt_id: string;
}>;

export type HnsStagingRecoveryReceipt = Readonly<{
  readonly resumable: true;
  readonly stop_service_before_rerun: true;
  readonly attempt_id: string;
}>;

export type HnsStagingPostMigrationRefusal = Readonly<{
  readonly outcome: "post_migration_refused";
  readonly step: HnsStagingPostMigrationStep;
  readonly reason: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  /** Present once the named staging unit was started, so a partial failure
   * carries an explicit disposition instead of an implicit one. */
  readonly service_disposition?: HnsStagingServiceDisposition;
  /** Present with the disposition: the refusal is resumable only after the
   * already-started service is stopped and a fresh attempt is established. */
  readonly recovery?: HnsStagingRecoveryReceipt;
}>;

export type HnsStagingPostMigrationInput = Readonly<{
  readonly authorized: HnsStagingAuthorizedTarget;
  readonly release: Readonly<{
    readonly service_version: string;
    readonly job_envelope_version: string;
  }>;
  readonly bundle: Omit<HnsReadinessCutoverBundle, "attempt_id">;
  readonly stage_directory: string;
  readonly ports: HnsStagingPostMigrationPorts;
  readonly new_attempt_id?: () => string;
  readonly identity_poll?: Readonly<{
    readonly timeout_ms?: number;
    readonly poll_interval_ms?: number;
    readonly now?: () => number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
  }>;
}>;
