# Rewards activation database gate

Before turning on Megapot rewards or Wallet sponsorship, run
`bun run db:preflight:reward-activation` from the exact api-next source being
released. Supply `CONTROL_PLANE_POSTGRES_RUNTIME_URL` for the same database role
the HTTP and jobs Workers use, and `CONTROL_PLANE_POSTGRES_ADMIN_URL` for a
read-only migration-ledger check. An operator may instead supply
`RUNTIME_POSTGRES_URL` and `ADMIN_POSTGRES_URL` for an isolated stack. The
command opens read-only transactions, issues no grants, and refuses any missing
or excessive privilege in its reviewed claim and Wallet send contract. It
also requires the database migration filenames and checksums to match the
release source exactly, with no pending migration. Run it after migrations and
before the first flag change. Save its JSON result with the deployment record.

The Megapot Base Sepolia preflight's `--require-ready` mode invokes this same
gate before its chain checks. Wallet sponsorship activation must invoke
`db:preflight:reward-activation` directly before changing its flag. A passing
check is evidence for the database role and ledger at that instant; a rollout
guard must repeat it if either changes before activation. If HTTP and jobs use
different database roles, run the privilege check once for each role and
require both to pass.

When a claim or Wallet send repository starts using another table or routine,
extend `RUNTIME_RELEASE_PRIVILEGES` in
`scripts/runtime-role-release-preflight.ts`. Its test inventories the direct
table operations in the claim and sponsored-send repositories. Review any
new routine calls as well. Do not grant broad table writes merely to make the
gate pass: keep claim writes inside the claim routine and keep DELETE denied
on `wallet_sponsored_sends`.

The isolated E2E database has the sponsorship migrations under old filenames
0225 and 0226. Current main has them under 0226 and 0227. The ledger mismatch
is intentional and this gate must refuse a current-main release there. Rebuild
the disposable isolated database from a clean branch using the current-main
migration set, restore only the test fixture and required nonsecret state, and
run this gate against the rebuilt runtime role before deploying main source.
Do not rename applied ledger rows or reinterpret their checksums.
