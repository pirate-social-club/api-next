/** Root generates each actual candidate from accepted complete native source.
 * These are structural types, never evidence or a browser/config callback. */
export type GuestStudyReadinessRoleProfile = "practice" | "owner_financial";
export interface GuestStudyReadinessCandidate {
  readonly source_head: string;
  readonly native_phase: string;
  readonly ledger: readonly Readonly<{ version: string; checksum: string }>[];
  readonly required_frames: readonly Readonly<{
    signature: string;
    body_sha256: string;
    definer: boolean;
  }>[];
  readonly native_function_bodies: readonly Readonly<{
    name: string;
    body_sha256: string;
    definer: boolean;
    configuration: "none" | "pinned" | "unreviewed";
  }>[];
  readonly restricted_catalogue_probes: readonly string[];
  readonly profiles: Readonly<
    Record<
      "learning" | "publicRead" | "cron" | "observer",
      Readonly<{
        columns: Readonly<Record<string, readonly string[]>>;
        functions: readonly string[];
      }>
    >
  >;
}
export interface OrdinaryAccountReadinessProfile {
  readonly columns: Readonly<Record<string, readonly string[]>>;
  readonly functions: readonly string[];
  /** Exact finite effective privileges, including columns inherited from table
   * grants. Root derives and reviews these from actual ordinary producer source. */
  readonly column_grants: readonly Readonly<{
    table_name: string;
    column_name: string;
    privilege: string;
  }>[];
  readonly table_grants: readonly Readonly<{ table_name: string; privilege: string }>[];
  readonly sequence_grants: readonly Readonly<{ sequence_name: string; privilege: string }>[];
}
export interface OwnerFinancialGuestStudyReadinessSource {
  /** Compiled exact SHA256 of reviewed native manifest JSONB::TEXT, never caller/config/observed data. */
  readonly accountingManifestSha256: string;
  readonly candidate: GuestStudyReadinessCandidate & {
    readonly profiles: GuestStudyReadinessCandidate["profiles"] & {
      readonly ordinaryAccount: OrdinaryAccountReadinessProfile;
    };
  };
  /** Complete readonly positive catalogue/phase predicate, generated and reviewed
   * from the actual financial schema. No privileged helper EXECUTE grant. */
  readonly phaseSql: (quotedSchema: string) => string;
}
