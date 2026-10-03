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
permissions. All five TRUNCATE results must remain false. Read back DELETE
and TRUNCATE on telegram_bot_grants and telegram_study_conversations as false as well; effective inherited
privileges matter, not just direct grants. Record role, schema, serving
provenance and results without secrets.

```sql
SELECT
  current_user::text AS runtime_role, required.table_name, required.expected_delete,
  COALESCE(has_schema_privilege(current_user, n.oid, 'USAGE'), FALSE) AS schema_usage,
  COALESCE(c.relkind IN ('r','p'), FALSE) AS table_exists,
  COALESCE(pg_has_role(current_user, c.relowner, 'USAGE'), FALSE) AS owner_equivalent,
  COALESCE(has_table_privilege(current_user, c.oid, 'SELECT'), FALSE) AS can_select,
  COALESCE(has_table_privilege(current_user, c.oid, 'INSERT'), FALSE) AS can_insert,
  COALESCE(has_table_privilege(current_user, c.oid, 'UPDATE'), FALSE) AS can_update,
  COALESCE(has_table_privilege(current_user, c.oid, 'DELETE'), FALSE) AS can_delete,
  FALSE AS expected_truncate,
  COALESCE(has_table_privilege(current_user, c.oid, 'TRUNCATE'), FALSE) AS can_truncate
FROM (VALUES ('telegram_account_associations', TRUE),
             ('telegram_link_transactions', TRUE),
             ('telegram_link_navigation', TRUE),
             ('telegram_bot_grants', FALSE),
             ('telegram_study_conversations', FALSE)) AS required(table_name, expected_delete)
LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='api_next'
LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=required.table_name;
```

The new PostgreSQL privilege test provisions the documented pre-0237 runtime
role before replaying 0237. It proves all affected operations fail without the
bounded grant, then runs real unlink, account-deletion fencing, both cleanup
paths and original conversation retention under that role after the exact
operator-template grant. Read-only access stays read-only, TRUNCATE is not
introduced, and consent revisions and an unrelated money-table deletion denial
survive. Tests use a disposable PostgreSQL fixture, not a serving database.
No production role readback or privilege change was performed for this repair.

The deployment wrapper checks the actual executor before upload whenever the
selected HTTP or jobs configuration enables Telegram, linking or practice.
Both runtime constructors independently query the actual connected executor;
direct deployments and dashboard flag changes cannot bypass admission. Missing
schema, owner-equivalent access, missing ordinary access, missing required
DELETE or excessive DELETE/TRUNCATE are refused. The standalone read-only
command is bun run db:preflight:telegram-activation. Its connection must be the
actual serving role, separately evidenced in each environment. Shared staging
may need DELETE revoked; that mutation still requires owner approval.
Migration 0238 must precede code using the shared Study practice marker, even
when Telegram flags remain false.

## Website contracts

The integrated practice API adds POST /telegram/link/callback/verify. Its
state-hash lookup uses the private browser binding and exact signed-in account
and session. The existing verification path then rechecks expiry, current bot
and single use before consuming the provider code. The UI does not need a
transaction ID in per-tab storage. A session refresh is rejected; restart safely
rather than weakening this binding.

An independently proven Telegram identity already associated with another
account returns a 409 conflict with details.reason equal to
telegram_identity_already_linked_to_another_account. The client exports
TELEGRAM_IDENTITY_LINK_CONFLICT_REASON. Other conflicts do not imply that an
association exists. Reveal no other account identity; offer recovery by
unlinking there before starting a fresh ceremony.

Verified name and username may appear in confirmation_display only in the
no-store verification response. The repository persists only numeric Telegram
identity, and later transaction reads cannot recover those display fields.
The UI keeps them only while the confirmation is displayed. No picture, name,
username, login code or state belongs in storage, logs or analytics. Display
fields are not identity proof. Numeric identity remains authoritative.

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
