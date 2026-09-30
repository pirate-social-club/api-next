# Rewards bindings and obligation visibility

The tracked deployment lifecycle is docs/rewards-deployment-lifecycle.json.
Production is prelaunch. Staging is intentionally dormant. Both environments
currently track false bindings; this is not a production launch configuration.
At the approved production launch, one reviewed source release must set the
production lifecycle to launched and both HTTP/jobs bindings to true, together
with the reviewed signing, contract identity and caps. Launched deployments
refuse either tracked binding off. Persisted database control, seeded paused,
provides default-off and survives ordinary releases.

Stop launched rewards through the database brake. Keep bindings on to show held
credits, balances and claims. Do not hide obligations through a flag override.
Retiring a launched environment requires a separately reviewed lifecycle change
and complete obligation disposition; changing its lifecycle does not bypass the
zero-owed shutdown guard.

The provenance deployment command gates false-binding HTTP and jobs uploads
through a direct operator database connection. The operator supplies the URL
for the exact target environment. It performs SELECT-only queries in a regular
transaction: PostgreSQL READ ONLY transactions cannot take the required FOR SHARE
row lock. The paused control lock remains held through inventory and upload,
blocking operator resume. Runtime permissions are not expanded. Unknown or
missing control, tables, columns, credentials, states or unreadable inventory
refuse deployment. The gate does not use Hyperdrive or its read cache.

Inventory includes unpaid/reserved credits, per-leg residual funds and reserved
budgets, shared sponsorship funds and reservations, open offers and legs,
unresolved drawings, funding intents, chain effects and gas top-ups. Unresolved
and signed failed effects stay visible; terminal historical rows are not a
blanket reason to keep an otherwise zero-owed dormant environment enabled.
User-owned Wallet sends are governed by their separate Wallet feature and are
outside this rewards binding. Count rows per owner rather than netting balances.
New money states or repositories require inventory review alongside migration
and privilege review.

On loss of the guard connection the upload subprocess is cancelled and success
is refused. Cancellation cannot retract a Cloudflare upload already accepted;
inspect the version and bindings before retrying after any ambiguous upload.
The guard holds no database data writes and does not pause or resume on its own.
The ordinary source-provenance and HNS checks still apply.

This source change does not authorize a Worker deployment, lifecycle activation,
control write, grant migration or money rehearsal. Review the exact accepted-main
release and target credentials before a live release. At launch keep both tracked
bindings true; an ad-hoc variable override is not the deployment policy.
