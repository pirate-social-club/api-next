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
- Existing staging bootstrap records are migration fixtures, not a reason to preserve
  the external subject as the internal user identifier.

The registration transaction inserts the user, generated handle index row, complete
account document, and credential binding together. Losing any uniqueness race causes a
read-back of the winning binding; it never creates a second account.

## Registration contract

Input contains the Privy access token and optional identity token in the same bounded
shape used by session exchange. Client-supplied user IDs, handles, timestamps, provider
subjects, verification state, and account documents are forbidden.

Successful registration returns the same projected account and host-only browser
session as session exchange. Repeating registration for the same credential is
idempotent and returns the existing account. A credential that resolves to a deleted,
invalid, or conflicting identity fails closed without revealing whether another
account exists.

Generated identifiers and handle stems use cryptographically secure randomness. The
handle grammar is lowercase ASCII, reserved-word safe, and independent of row counts,
timestamps, email addresses, phone numbers, or provider subject fragments.

## Abuse controls

Registration uses two independent Worker-side limits before database provisioning:

1. a conservative per-client-IP bucket to bound anonymous resource creation; and
2. a higher-capacity per-application bucket to cap a runaway or abused client.

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
recovery is required and preserve the existing binding.

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
- different subjects cannot claim the same credential binding or generated handle;
- session exchange remains mutation-free and still rejects an unregistered subject;
- rate-limit failures perform no database mutation;
- deleted/conflicting bindings fail closed without enumeration;
- registration cannot set verification evidence or capabilities;
- a cross-account document binding produces `recovery_required`, never an automatic
  rebind;
- Postgres 17 tests and the required sentinel exercise the concurrency/rollback path;
- workerd tests exercise client-IP extraction, both limit buckets, cookies, CORS, and
  redacted errors.

## Deferred decisions

- the exact prior-owner factor and cooling-off/operator policy for recovery completion;
- the separate user-chosen handle claim and rename contract;
- production thresholds for the two rate-limit buckets, calibrated from staging
  telemetry without weakening the correctness constraints above.
