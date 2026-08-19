# Self physical-ceremony callback replay runbook

This runbook prepares the remaining staging evidence for the `self.pass`
physical-document ceremony. It is staging-only. It does not enable Self,
change the callback origin, expose `begin`, or authorize a deployment.

## Why capture needs an explicit mechanism

The Self launch payload binds the callback origin into the proof. The live
staging endpoint is therefore fixed as:

```text
https://api-next-staging.pirate.sc/verification/callbacks/self.pass
```

Do not insert a proxy, tunnel, alternate hostname, or rewritten callback URL
after a verification session is created: the proof will no longer be bound to
the session's configuration.

The HTTP transport preserves the callback body as raw text, but the deployed
application deliberately does not log or persist that body. Cloudflare tail
output, request logging, browser console output, and shell transcripts must
not be used to capture it; a Self proof can contain sensitive document-derived
data and any displayed value is treated as compromised.

Before the physical ceremony, the coordinator must choose one of these
explicitly authorized mechanisms:

1. **Provider-controlled retry:** the Self client/provider must expose a
   documented retry that resends the identical callback bytes to the same
   endpoint. Confirm that the retry is byte-identical before the ceremony.
2. **Reviewed staging capture instrumentation:** add a short-lived,
   staging-only capture seam that holds one raw body in a bounded, access-
   controlled location, emits only digest/length metadata, and is removed or
   disabled before the next deployment. This requires its own code review,
   secret/access-control decision, and deployment authorization.

## Authorized capture implementation

The selected mechanism is the reviewed staging capture seam. It is a single
Durable Object instance named `physical-ceremony-callback`, enabled only by the
staging Worker configuration. The body is bounded to 1 MiB, callback headers
are bounded to 32 KiB, and the first capture is immutable until an operator
clears it. The DO stores the raw UTF-8 bytes internally so replay can preserve
the exact callback payload; it never returns those bytes from the operator
status endpoint.

The control routes are absent in production and return the same redacted 404
for missing or incorrect credentials in staging:

```text
GET  /internal/self-callback-capture/status
POST /internal/self-callback-capture/replay
POST /internal/self-callback-capture/clear
```

Each request requires `Authorization: Bearer <staging capture token>`. The
token is stored only as the Infisical staging secret
`SELF_CALLBACK_CAPTURE_ACCESS_TOKEN`; never paste it into a shell transcript,
chat, browser console, or evidence file. `status` returns only state, provider
id, digest, byte length, capture time, and replayed state. `replay` runs the
captured callback server-side and returns only the normal callback
acknowledgment. It does not return the raw body. `clear` is used after the
ceremony and after evidence review.

Before the physical session, verify the protected status endpoint reports
`state=empty`; do not send a synthetic callback to the deployed endpoint,
because that would consume the one-shot capture. The DO unit test is the dry
run for bounded capture, metadata-only status, one-shot replay, and clearing.

If neither mechanism is available, run the physical ceremony for the other
evidence (accepted result, session binding, receipt, assertion, provenance,
scope, and `credential.subject_unique`) but record byte-identical callback
replay as **unproven**. Do not claim replay based on a terminal application
replay with the same idempotency key; that is a different test.

## Evidence to retain

Keep temporary evidence outside the repository and remove it after review.
Record only:

- redacted session/receipt/assertion identifiers;
- subject binding and provider configuration provenance;
- `pirate-social` scope and `credential.subject_unique` result;
- callback body byte length and SHA-256 digest (never the body);
- first and replay response status plus redacted result metadata;
- database counts for the completion/attempt/receipt invariants.

Never record passport data, QR payloads, proofs, user-defined callback data,
JWTs, cookies, bearer values, private keys, DSNs, or raw request/response
bodies. A displayed secret or proof is compromised and must be rotated or the
ceremony must be rerun with a fresh session.

## Required sequence

1. Verify staging-only configuration (`SELF_PASS_ENABLED=true`,
   `SELF_PASS_MOCK_PASSPORT=false`) and a clean, pinned deployment.
2. Deploy the selected capture mechanism and verify the protected status
   endpoint reports empty. The dry run is the repository workerd test; do not
   consume the staging slot with a synthetic callback.
3. Start one fresh physical-document session. Do not reuse a session from a
   different deployment or configuration.
4. Complete the ceremony and record the redacted accepted evidence.
5. Read the captured digest/length metadata, then invoke the protected replay
   control. Confirm the same digest/length and the idempotent response; record
   no raw body.
6. Run the rejected-bound-proof and unbound-garbage cases with fresh sessions
   as separate tests. Verify the durable attempt/lease invariants.
7. Disable/remove any capture instrumentation, remove temporary evidence, and
   update `self-staging-evidence.md` and `TASKS.md` with the result and the
   mechanism used.

The real ZKPassport proof remains a separate authorization and gate; it is not
part of this Self callback replay procedure.
