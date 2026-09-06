/** Portable catalog privilege fact, not SQL and not authorization to issue GRANT. */
export type ResetGrant = Readonly<{
  schema: "api_next";
  objectKind: "table" | "sequence" | "routine" | "type" | "schema";
  objectIdentity: string;
  grantee: string;
  privilege: string;
  grantOption: boolean;
}>;

/** Independently approved additions and denials, never inferred from old ACLs. */
export type ResetGrantPolicy = Readonly<{
  explicitNew: readonly ResetGrant[];
  forbidden: readonly ResetGrant[];
}>;

const allowedPrivileges = {
  table: new Set([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
    "MAINTAIN",
  ]),
  sequence: new Set(["USAGE", "SELECT", "UPDATE"]),
  routine: new Set(["EXECUTE"]),
  type: new Set(["USAGE"]),
  schema: new Set(["USAGE", "CREATE"]),
};

function grantKey(grant: ResetGrant): string {
  if (
    grant.schema !== "api_next" ||
    !Object.hasOwn(allowedPrivileges, grant.objectKind) ||
    !allowedPrivileges[grant.objectKind].has(grant.privilege) ||
    !grant.objectIdentity ||
    !grant.grantee ||
    /\p{Cc}/u.test(grant.objectIdentity + grant.grantee) ||
    typeof grant.grantOption !== "boolean"
  )
    throw new Error("reset_grant_fact_invalid");
  return JSON.stringify([
    grant.schema,
    grant.objectKind,
    grant.objectIdentity,
    grant.grantee,
    grant.privilege,
    grant.grantOption,
  ]);
}

function grantSet(grants: readonly ResetGrant[]) {
  const entries = grants.map((grant) => [grantKey(grant), Object.freeze({ ...grant })] as const);
  return new Map(entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

/**
 * Exact conservative set reconciliation. The coordinator must supply a reviewed
 * runtime manifest independently of the old ACL inventory. No inferred grants,
 * default-ACL replay, grantor impersonation or executable SQL is produced here.
 * A future executor must reject unfulfilledReviewed and validate object/role
 * identity plus grant authority on the reconstructed catalog before applying.
 */
export function reconcileResetGrants(input: {
  before: readonly ResetGrant[];
  replay: readonly ResetGrant[];
  reviewed: readonly ResetGrant[];
  policy?: ResetGrantPolicy;
}) {
  const before = grantSet(input.before);
  const replay = grantSet(input.replay);
  const reviewed = grantSet(input.reviewed);
  const additions = grantSet(input.policy?.explicitNew ?? []);
  const forbidden = grantSet(input.policy?.forbidden ?? []);
  const withoutOption = (grant: ResetGrant) => grantKey({ ...grant, grantOption: false });
  if ([...forbidden.values()].some((grant) => grant.grantOption))
    throw new Error("reset_denial_grant_option_invalid");
  if ([...additions.keys()].some((key) => !reviewed.has(key)))
    throw new Error("reset_new_grant_not_reviewed");
  if ([...reviewed.values()].some((grant) => forbidden.has(withoutOption(grant))))
    throw new Error("reset_grant_policy_conflict");
  const previousOnly = new Map([...before].filter(([key]) => !replay.has(key)));
  const reapply = new Map([...previousOnly].filter(([key]) => reviewed.has(key)));
  const newGrants = [...additions].filter(([key]) => !replay.has(key) && !reapply.has(key));
  return Object.freeze({
    replayCreated: Object.freeze([...replay.values()]),
    previousOnly: Object.freeze([...previousOnly.values()]),
    reapply: Object.freeze([...reapply.values()]),
    newGrants: Object.freeze(newGrants.map(([, grant]) => grant)),
    revoke: Object.freeze(
      [...replay.values()].filter((grant) => forbidden.has(withoutOption(grant))),
    ),
    unfulfilledReviewed: Object.freeze(
      [...reviewed]
        .filter(([key]) => !replay.has(key) && !reapply.has(key) && !additions.has(key))
        .map(([, grant]) => grant),
    ),
    execution_authorized: false,
  });
}
