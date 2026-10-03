# Telegram linking review follow-up

The runtime-role review on 2026-10-03 found that default table privileges omit
DELETE. The previous linking tests used the migration owner, so they did not
exercise this boundary. Private association removal, expired login cleanup and
the account-deletion trigger need DELETE on three tables. Consent grant rows
remain retained to preserve revision fences.

## Schema and runtime-role admission

The bounded grant in db/postgres/roles.sql.example is operator provisioning,
not an application migration. The example role is api_next_app; it is not proof
of the role actually used by HTTP or maintenance. During an authorized schema
release, identify each actual database login and its inherited roles from the
serving connection. Grant DELETE only on telegram_account_associations,
telegram_link_transactions and telegram_link_navigation to the observed
executor role. Retain the existing restrictions on consent revisions and money
ledgers. Do not add DELETE to schema-wide default privileges or grant to PUBLIC.

This is a schema-release prerequisite even while TELEGRAM_LINKING_ENABLED is
false. Existing Telegram inbox maintenance already calls the new cleanup, and
the account-deletion trigger is installed by migration 0237. Applying that
migration without the effective grants can break unrelated maintenance or
account deletion before a learner starts linking. Apply the bounded grant and
read it back in the same approved ceremony before serving code uses that schema.
If 0237 is already installed, check these privileges before its affected paths run.

Run the following read-only query through each actual serving connection after
provisioning. The three DELETE results must be true; merely reading grants from
an administrator connection or a staging role does not establish production
permissions. The three TRUNCATE results must remain false. Read back DELETE
and TRUNCATE on telegram_bot_grants as false as well; effective inherited
privileges matter, not just direct grants. Record role, schema, serving
provenance and results without secrets.

```sql
SELECT current_user AS runtime_role, current_schema() AS runtime_schema,
       table_name, has_table_privilege(current_user, table_name, 'DELETE') AS can_delete,
       has_table_privilege(current_user, table_name, 'TRUNCATE') AS can_truncate
FROM (VALUES ('telegram_account_associations'),
             ('telegram_link_transactions'),
             ('telegram_link_navigation')) AS required(table_name);
```

The new PostgreSQL privilege test provisions the documented pre-0237 runtime
role before replaying 0237. It proves all affected operations fail without the
bounded grant, then runs real unlink, account-deletion fencing, both cleanup
paths and original conversation retention under that role after the exact
operator-template grant. Read-only access stays read-only, TRUNCATE is not
introduced, and consent revisions and an unrelated money-table deletion denial
survive. Tests use a disposable PostgreSQL fixture, not a serving database.
No production role readback or privilege change was performed for this repair.

## Website slice requirements

The merged API still returns a generic conflict for an already-associated
Telegram identity. Before admitting the linking UI, add a specific recovery
reason for an independently proven identity already linked to another account,
with a path to unlink from that account. Do not reveal the other account's
identity. Distinguish it from other refused or stale ceremonies. This needs an
explicit reviewed contract/client change rather than client interpretation of
all generic 409 responses as an association conflict.

The adapter currently discards names and usernames, so confirmation shows only
the numeric Telegram ID. The website slice should offer recognizable name or
username from the independently verified login for the confirmation step only.
Do not persist profile data, include it in logs or telemetry, or treat display
fields as identity proof. The numeric ID remains the association authority.
Design the ephemeral delivery deliberately; the existing projection cannot
supply profile fields that have already been discarded.

Telegram redirects with code and state, not the transaction ID required by the
current verify path. Do not depend on per-tab storage alone. Resolve the attempt
using state hash and the private browser binding, still enforcing account,
session, expiry and single-use checks. Prove new-tab redirects and invalid or
ambiguous state cannot select another transaction. This is future API and UI
work; the privileges repair does not claim to provide the lookup endpoint.

Include a sign-in session refresh between start and callback in phone-browser
acceptance. The current exact session hash rejects it. Show a safe restart when
it happens; do not relax session binding incidentally to make the test pass.
Test Telegram's in-app and system browsers with each offered sign-in method,
including Google and browser wallets, and preserve the browser/account binding
through the whole flow.

A learner may still be socially engineered into approving an unprompted login
and returning its callback address. This accepted phishing risk does not justify
showing raw authorization code or state. The callback page must never display,
log or send those values to analytics or third-party resources. Consume them
through the protected flow and remove them from the visible address when safe.
