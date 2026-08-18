# Registration staging schema evidence

Date: 2026-08-19

Scope: apply the published registration migrations to the dedicated staging
`api_next` schema and satisfy the runtime privilege gate. No production database,
Worker deployment, secret value, user record, or verification evidence was changed.

## Migration read-back

The checksum-verified runner connected with the staging migrator credential. The
existing ledger ended at `0012`; it applied `0013` through `0017` in order. A separate
read-back returned 17 ledger rows and the following tail:

- `0013_m3_community_purchase_funding_journal.sql`
  `a3bb7deed76d76c1642220cf54b5dd277cbbaf0239946cd6a9967328e2e277a3`
- `0014_m3_community_purchase_funding_plans.sql`
  `a60a534038ef9e56e5e8fb50ae10c92a74b7333f97c289cf8cc298676673ec98`
- `0015_identity_credentials.sql`
  `c903d74fdc282b1ab3b0c0be3d46758ba1c50f30282c0d02976b52c43b92966f`
- `0016_identity_credential_invariants.sql`
  `b9d94049c5e796b567f9d11e8b210d147561fd3b0e38abaea60a5c73fe436220`
- `0017_identity_credential_delete_guard.sql`
  `c66ac7d2076b9db3f25f31a5a96fddf7569e1aaf4bfc6ba931e5d2400d5a8aaa`

## Runtime privilege read–remediate–re-read

The runtime connection resolved its physical PlanetScale principal as
`pscale_api_gy9lze83nr29`; the logical deployment role name `api_next_runtime` is not a
PostgreSQL role visible through this connection and must not be used as read-back
evidence.

Initial read-back on `api_next.identity_credentials`:

- `DELETE = true`
- `TRUNCATE = false`

The migrator session applied only:

```sql
REVOKE DELETE ON TABLE api_next.identity_credentials
FROM pscale_api_gy9lze83nr29;
```

The runtime credential then reconnected and returned:

- `SELECT = true`
- `INSERT = true`
- `UPDATE = true`
- `DELETE = false`
- `TRUNCATE = false`
- `current_schema() = api_next`

This satisfies the decision record's live-role gate. The row lifecycle trigger remains
the primary schema guarantee; the grant is defense in depth.

## Default privileges disposition

The initial `DELETE = true` result proves that the current operational grant workflow
gives new tables broader DML than this table needs. This tranche does not globally
remove `DELETE` from default privileges: existing repositories have not yet been audited
table-by-table, and changing defaults would affect future migrations without repairing
existing grants. The follow-up is an explicit privilege-matrix audit that classifies
each table as append-only, tombstone-only, or physically deletable, then changes default
privileges and per-table grants together.

The registration repository itself never deletes credential rows. It requires
`SELECT`, `INSERT`, and later deletion flows require tombstoning through `UPDATE`.
