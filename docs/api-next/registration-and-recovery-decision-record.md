# Registration and identity recovery decision record

Status: accepted architecture; implementation pending (2026-08-18)

## Decision

Authentication and account provisioning are separate operations.

- `POST /auth/session/exchange` remains resolve-only. It verifies a Privy proof,
  resolves an existing account, and mints a browser session. It never creates or
  modifies identity state.
- Registration is an explicit public endpoint that verifies the same Privy proof,
  applies registration-specific rate limits, and atomically provisions an account.
- Verification is not a registration prerequisite. An unverified account receives no
  gated capabilities, so verification remains an action/policy concern.
- Generated handles are non-enumerable placeholders. Claiming or renaming a public
  handle is a later, independently abuse-gated flow.
- A document subject already bound to another account never triggers an automatic
  rebind. Verification returns an explicit `recovery_required` outcome and offers a
  separate recovery ceremony.

## Identity model

External authentication subjects are credentials, not account identifiers.

- New users receive an opaque, random internal `user_id`.
- A credential binding records `(provider, provider_app_id, provider_subject)` to one
  internal user. The tuple is unique in Postgres and is the concurrency fence for two
  simultaneous first registrations.
- A provider subject cannot be rebound by ordinary registration. Account recovery is
  the only operation allowed to change which user owns a credential or document
  subject, and it must leave an auditable binding event.
- Authentication providers are a closed database enum. Adding a provider requires a
  migration alongside its reviewed verifier and contract; this deliberately prevents
  rows from naming providers the runtime cannot authenticate. Provider-neutrality here
  means shared credential semantics, not accepting arbitrary provider strings.
- Existing staging bootstrap records are migration fixtures, not a reason to preserve
  the external subject as the internal user identifier.

The registration transaction inserts the user, generated handle index row, complete
account document, and credential binding together. Losing any uniqueness race causes a
read-back of the winning binding; it never creates a second account.

## Registration contract

Input contains only the Privy access token. Registration does not accept a Privy
identity token: identity-token validation has a distinct contract and must not be
silently routed through access-token validation. If identity tokens become necessary,
they require a separate verifier path and explicit issuer, audience, signature, and
claim tests before the registration contract can change. Client-supplied user IDs,
handles, timestamps, provider subjects, verification state, and account documents are
forbidden.

Successful registration returns the same projected account and host-only browser
session as session exchange. Repeating registration for the same credential is
idempotent and returns the existing account. A credential that resolves to a deleted,
invalid, or conflicting identity fails closed without revealing whether another
account exists.

A caller presenting a tombstoned credential receives a specific permanent-deletion
response explaining that the credential cannot register again. This is not account
enumeration because the caller has proved control of that credential. An inconsistent
active binding (missing, deleted, or malformed canonical account) remains an opaque
internal failure and never exposes persisted identity state.

Generated identifiers and handle stems use cryptographically secure randomness. The
handle grammar is lowercase ASCII, reserved-word safe, and independent of row counts,
timestamps, email addresses, phone numbers, or provider subject fragments.

## Abuse controls

Registration uses two independent, strongly consistent Durable Object limits before
database provisioning:

1. one deterministically sharded object per client IP, with a conservative bucket to
   bound anonymous resource creation; and
2. one object per configured application/environment, with a higher-capacity bucket to
   cap a runaway or abused client.

The application-wide object is an intentional coordination point. Registration is a
low-volume control-plane action, so the global guarantee is worth the extra round trip
and bounded serialization. Cloudflare's native rate-limit binding is not used for this
boundary because its counters are per-colocation and permissively consistent; it would
not provide the stated global application cap.

Limiter availability is part of authorization: timeout, RPC failure, malformed output,
or unavailable Durable Object state fails registration closed before proof verification
or database access. An outage may therefore stop new registration while existing users
continue to authenticate. The Worker emits a bounded limiter-unavailable reason and the
runbook treats sustained failure as an availability incident; there is no bypass flag.

The application-wide object is acceptable only while registration remains low-volume.
Operations must track RPC latency, limiter-unavailable failures, and sustained request
rate. Before a launch or campaign expected to create a signup spike, the owner must
review capacity and choose an explicitly sharded globally coordinated design rather
than weakening the limit or silently falling back to per-colocation counters.

### Ratified threshold amendment — 2026-08-19

The initial fixed-window policy is configuration, not a constant in the Durable
Object bodies:

- the per-IP bucket allows 5 registrations per 15-minute window, keyed by the
  exact trusted IP;
- the per-application bucket allows 100 registrations per 1-minute window,
  acting as a short global circuit breaker rather than an ordinary throttle;
- exhaustion is a hard stop and returns `RateLimited` with `Retry-After` equal
  to the remaining whole seconds in the current window (at least 1 second).

The values are repeated in each Worker environment's Wrangler vars so staging
can calibrate them without a code change. Fixed windows accept rollover bursts,
CGNAT false positives, and bounded retry self-lockout. IPv6 `/64` folding is
deliberately deferred: the application-wide 100-per-minute ceiling is the
required backstop against routed IPv6 address rotation, and it must not be
removed while exact-IP accounting remains the policy.

At the public Worker edge, the client IP comes exclusively from `CF-Connecting-IP`.
`X-Forwarded-For`, `X-Real-IP`, request bodies, query parameters, and arbitrary caller
headers are never accepted as substitutes. A registration request without trusted edge
metadata is refused before proof verification or database access. Tests inject a typed
request-context value directly rather than manufacturing a second production trust
path.

Privy proof verification still occurs before any account mutation. Limits return the
closed `RateLimited` contract and never reveal credential or account existence. The
limits are abuse controls rather than accounting guarantees; database uniqueness is
the correctness boundary. Metrics record only bounded reason codes and never tokens,
provider subjects, email addresses, phone numbers, or raw IP addresses.

## Recovery boundary

Possession of the same document alone is insufficient authorization to seize an
existing account. The first registration vertical therefore implements discovery, not
automatic recovery:

- a verification attempt whose subject key is actively bound elsewhere produces a
  non-enumerating `recovery_required` result;
- the result contains no old account identifier, handle, provider subject, or binding
  metadata;
- the recovery intent uses the existing `recover` subject-binding machinery and a new
  Privy-authenticated account, but completion remains disabled until the prior-owner
  authorization policy is accepted.

The follow-up recovery policy must choose one explicit prior-owner factor (for example,
an old-account challenge or operator-assisted review with a cooling-off period). Fresh
document proof plus control of the new Privy account is necessary but not, by itself,
sufficient. Until that policy lands, the safe product behavior is to explain that
recovery is required and preserve the existing binding. The UI must state honestly that
self-service recovery is unavailable; it must not promise an automatic or imminent
rebind. A documented operator-assisted support intake remains available for genuine
loss-of-access cases, but operators cannot mutate a binding until the same reviewed
prior-owner policy is satisfied and recorded.

## Account deletion

Deletion is not an identity reset and releases nothing automatically.

- The credential binding is retained in a disabled/tombstoned state, so deleting and
  re-registering cannot mint a fresh account from the same Privy credential.
- The generated or claimed handle is retired and is not returned to the available
  namespace by the deletion transaction.
- Subject-key bindings and binding-event history remain durable. They continue to fence
  cross-account verification and subject-key-based reward uniqueness.

The row lifecycle trigger is the portable schema-level guarantee against `DELETE` and
reactivation. PostgreSQL `TRUNCATE` does not execute row-level triggers, so environment
provisioning must also prove that the application runtime principal has neither
`DELETE` nor `TRUNCATE` on `identity_credentials`. The actual principal is
environment-specific (the staging runtime connection currently resolves to the
PlanetScale-managed role `pscale_api_gy9lze83nr29`); the logical name
`api_next_runtime` and the legacy
`roles.sql.example` file is not evidence of live grants and must never be cited as such.
The migrator necessarily retains schema-changing authority and remains an operational
credential unavailable to Workers.

User-facing account data is removed or minimized according to the deletion runbook,
while the smallest non-public identity tombstones needed for abuse prevention, recovery,
financial integrity, and auditability remain. Any future erasure or label-reclamation
policy is a separate privacy/security decision with an explicit quarantine period; it
cannot be inferred from ordinary deletion.

Deletion confirmation must state in plain language that the same login credential
cannot be used to register a new account afterward. Generic language such as “you can
always come back” is forbidden unless a reviewed restoration flow actually exists.

## Handle lifecycle

The generated handle is a placeholder with `tier = generated`,
`issuance_source = generated_signup`, and the existing one-active-handle invariants.
It is not sequential or derived from private identity data. Reserved stems are rejected
before insertion; uniqueness collisions regenerate within a bounded retry count.

A later handle-claim endpoint owns naming policy, scarce-namespace abuse controls, and
any challenge such as ALTCHA. Registration does not accept a desired handle and cannot
reserve a user-chosen label.

## Acceptance gates

- concurrent registration for one provider subject creates exactly one user;
- retries return the same canonical account and do not rotate its generated handle;
- registration rejects identity-token and caller-supplied identity metadata fields;
- different subjects cannot claim the same credential binding or generated handle;
- session exchange remains mutation-free and still rejects an unregistered subject;
- rate-limit failures perform no database mutation;
- limiter unavailability fails closed and performs no proof verification or database
  mutation;
- rate limits coordinate globally per application and per trusted edge IP; spoofable
  forwarding headers and missing edge metadata cannot reach proof verification;
- deleted/conflicting bindings fail closed without enumeration;
- deletion tombstones credential, handle, and subject-key bindings rather than making
  them reusable;
- the deployed runtime principal is read back as lacking both `DELETE` and `TRUNCATE`
  on `identity_credentials`; example SQL and intended grants are not sufficient evidence;
- registration cannot set verification evidence or capabilities;
- a cross-account document binding produces `recovery_required`, never an automatic
  rebind;
- Postgres 17 tests and the required sentinel exercise the concurrency/rollback path;
- workerd tests exercise client-IP extraction, both limit buckets, cookies, CORS, and
  redacted errors.

## Deferred decisions

- the exact prior-owner factor and cooling-off/operator policy for recovery completion;
- the separate user-chosen handle claim and rename contract;
- the retention/minimization period and any exceptional erasure process for identity
  tombstones, plus whether retired labels can ever return after quarantine;
- production thresholds for the two rate-limit buckets, calibrated from staging
  telemetry without weakening the correctness constraints above.
