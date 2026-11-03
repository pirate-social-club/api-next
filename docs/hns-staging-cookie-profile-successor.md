# Staging cookie profile successor

This is the exact `c8cd/614a` to `34f5/ca8947` staging package. The cookie mode selects only `8s28`. It does not recover another root or switch a gateway, Worker, Solid deployment, verifier or provisioner. Production and the existing fingerprint-only, two-root mode retain their boundaries.

The coordinator first completes genuine creator recovery and unchanged-gateway owner-TXT adoption. Current namespace, DNS health and inventory must cover the complete execution window. The selected namespace must still resolve through the completed same-root creator recovery, consumed provider attempt, immutable snapshot and actual expiry predecessor. Source qualification is separate from those live facts.

## Prepare and review

Use clean committed source. The input has exactly `previousManifest`, `nextManifest`, `readiness`, `executeBy` and `outputPath`. Manifest values are canonical JSON strings, not file paths. The preceding manifest must hash to the actual serving `c8cd` authority; the stale checked-in historical manifest is not a substitute. The next manifest must hash to accepted `34f5`. Only source, bundle, interactive profile version/hash/byte count and ingress fingerprint differ. Every other field, certificate, credential reference, handle profile and limit is byte-bound.

Run `bun scripts/hns-staging-gateway-successor.mjs prepare-cookie-profile /absolute/input.json` through the existing managed database workflow. Preparation is read-only and creates an exclusive mode-0600 plan. It freezes one deadline no more than fifteen minutes after the complete database observation and records the original DNS health observation time. The earlier inventory/health expiry caps successor health with a further five-second margin. A promotion records a new database row time; it does not establish a new external DNS observation or extend the original evidence.

The complete census includes roots referenced by current DNS, app or sale authorities at either gateway, all associated app and claimed-handle authorities, predecessor rows and retained history. Missing, duplicate, changed, unreadable or live unselected authority refuses. The maintained app and handle repositories and effective serving predicates determine availability. One expired column is insufficient. An unavailable co-tenant is retained unchanged and remains unable to serve through the new gateway reference.

Review the exact plan digest and the whole native/Solid/API/verifier/provisioner package. The native manifest, Solid ingress, verifier targets and provisioner's expected gateway reference must advance consistently. Preparation does not grant any external operation. The coordinator owns finite exclusive runtime custody, native shadow readiness, source/artifact binding and recovery.

## Rehearse, commit and reconcile

The maintained command accepts `preflight`, `rehearse` or `commit`, followed by the absolute plan path and its SHA-256. It dispatches only the exact plan schema. The transaction revalidates the entire census and every selected predecessor. Ordered table locks freeze authority writers and absent-row membership while the fixed, short serializable operation runs. Lock and statement bounds remain ten and twenty seconds. These locks include shared staging authority tables; use only the coordinator's exclusive operational slot.

Rehearsal executes the actual DNS, app, health and sale writers and rolls back. Commit promotes those selectors atomically, preserves namespace/zone/key/chain/certificate authority, preserves every unselected row and count, and rechecks actual app and claimed-handle availability. Changed selectors, root membership, elapsed deadlines and partial writer failures refuse or roll back.

A lost commit acknowledgement is never retried automatically. Run `readback /absolute/plan.json SHA256` on the same reviewed source. It reports `committed` only for exact successor generations/documents/operation identities and unchanged co-tenants; `not_committed` describes only the current unchanged read snapshot. Other authority is `unknown`. Every result explicitly disables automatic retry. Reconcile database operations, current selectors and the external package before any new reviewed operation.

Restoration after promotion uses a reviewed advancing successor. Do not rewind authority history. Once new browser families could exist, retain compatible cookie-capable native, backend and Solid transports. The old transport is not an assumed rollback.

Every staging Jobs release carrying enabled active-lease renewal remains held until manual `8s28` recovery/adoption and fresh whole-package acceptance. Actual route, cookie issue/renewal, acknowledged logout, scheduled renewal and co-tenant fail-closed checks remain live release gates.
