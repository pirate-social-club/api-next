# HNS admission runtime grant

Migration 0136 introduces
`hns_community_root_import_consumes_actor_budget_v1(text)` and revokes its
PUBLIC execution. The calling admission function is SECURITY INVOKER, so
the HTTP Worker's actual runtime database role needs an explicit EXECUTE
grant on the helper. Applying migrations successfully does not establish
that the runtime role can use their functions.

This omission caused a production preparation 500 on 2026-09-09. The boundary
diagnostic identified `hns.community-root-import.admit` with SQLSTATE 42501;
a runtime-role helper call established the missing privilege. Owner-role
tests and a structural baseline that strips ACLs cannot detect this omission.

## Migration and credential-rotation preflight

Resolve `current_user`, `current_database()` and `current_schema()` through
the exact runtime credential used by the HTTP Worker. Do not infer its role
from a credential label. Verify the admin connection targets the same database
and schema, and that the helper is SECURITY INVOKER with its search path pinned
to the application schema and pg_temp.

Through the runtime connection, check:

```sql
SELECT has_function_privilege(
  current_user,
  'api_next.hns_community_root_import_consumes_actor_budget_v1(text)',
  'EXECUTE'
);
```

Through the admin connection, inspect the function's ACL and confirm PUBLIC
has no EXECUTE grant. Review the exact schema-qualified statement and target
role before applying this template; `verified_runtime_role` is a placeholder,
not an environment role name:

```sql
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5s';
GRANT EXECUTE ON FUNCTION
  api_next.hns_community_root_import_consumes_actor_budget_v1(text)
  TO "verified_runtime_role";
COMMIT;
```

Do not grant execution to PUBLIC, a monitoring reader, or every role in the
schema. Do not turn the helper into SECURITY DEFINER or replace the Worker's
credential with an administrator credential. No function body, product row or
migration ledger entry changes in this operational grant ceremony.

## Verification and rollback

Open a runtime-role READ ONLY transaction. Confirm effective EXECUTE and call
the helper with NULL; it must return false without a permission error. This
probe writes nothing and does not take the admission advisory lock. Confirm
PUBLIC remains denied, then roll back. Retain a credential-free receipt of the
before/after permissions and a fingerprint of the resolved role.

Finally perform the real owner preparation and verify its HTTP result and
resulting state. A successful NULL helper probe proves access, not the whole
preparation workflow. Repeat the preflight whenever the runtime role rotates.

Rollback removes only a newly added EXECUTE grant from the verified role;
never revoke a grant that existed before the ceremony. Revoking it restores
the preparation outage, so rollback requires an explicit operational decision.

`hns-admission-privileges.pg.test.ts` applies the full forward migrations,
reproduces the real repository preparation failure under a restricted runtime
role with an existing actor preparation, then proves the one-function grant
repairs preparation and replay while leaving a reader denied.
