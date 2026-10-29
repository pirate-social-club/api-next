# Durable browser sessions

Ordinary sign-in uses short access cookies backed by a durable server session. A reload, independent tab or browser restart can renew without a tab-local provider snapshot. The server permits 30 days idle and 90 days absolute, using database time. Logout and credential/account revocation invalidate the family immediately. This is source preparation; deployment and device acceptance remain separate.

The access and opaque renewal cookies are Secure, host-only, HttpOnly, SameSite=Lax and Path=/. The matching CSRF cookie is readable by the application. Renewal and logout require exact trusted Origin and bound CSRF. Renewal returns account identity and expiry only; tokens and renewal secrets never appear in JSON or localStorage. Stored credentials are hashed. The stable renewal secret is reusable until revocation or expiry; this design does not claim one-use rotation or theft detection.

Browser access carries a session ID and browser purpose. It must match a live, immutable family and current identity binding. Machine bearer credentials remain separate. Old browser cookies without that family binding refuse. Initial wallet proof remains bounded to its original access expiry; silent renewal never restores or extends wallet authorization. Setup-only sessions cannot renew. Ordinary guest-only controls retain their independent guest authority, while mixed and attachment account verification refuses malformed ordinary ambient cookies.

## Paired release requirements

Apply migration0330 through the normal contiguous migration runner. It grants no runtime authority by itself. The ordinary serving role needs exactly these added EXECUTE capabilities:

| Function | Purpose |
| --- | --- |
| create_browser_session_v1(jsonb) | Fresh verified sign-in or registration |
| read_browser_session_access_v1(text,text,text) | Current browser access |
| read_browser_session_renewal_v1(text,text,text,text) | Read renewal authority |
| renew_browser_session_v1(text,text,text,text) | Bounded rolling renewal |
| revoke_browser_session_v1(text,text,text,text,text) | Logout/replacement revocation |

Raw browser_sessions table access and all three internal helpers remain denied. The existing serving-function preflight checks the added facades and denials, including owner identity and the maintained pg_catalog-first pinned search path. The roles example carries the matching incremental block; the coordinator must prepare an exact reviewed production operation rather than applying the entire example as a release candidate.

The paired Solid session/bootstrap and same-origin cookie proxy must ship with the accepted API/client. Client0.138 adds POST /auth/session/renew. Its candidate artifact is byte-identical to the frozen Solid intake; producer acceptance still needs the final source review and required checks. A cached artifact or frontend-only acceptance cannot substitute for that producer proof.

The old cookie format is deliberately refused; this is a coordinated cookie cutover with fresh sign-in where needed. Runtime recovery must account for family rows and the paired frontend. Source acceptance does not authorize changing staging sessions, shared phone custody, secrets, production or Rewards.

## Qualification boundaries

The focused native PostgreSQL tests exercise actual restricted-role facades, replacement rollback, canonical aliases and status changes, expiry after row/credential lock waits, both renewal/logout orders, idempotent logout and hostile search paths. The real RS256 HTTP/PG test covers expired access with durable renewal, token/purpose separation, cookie tuples, Origin/CSRF refusal, unavailable-service behavior and immediate access revocation.

The Workerd fixture uses the real service and signing/verifying code over an explicitly in-memory authority port; it is transport evidence. PostgreSQL tests establish persistence and locking. Local fixtures do not establish provider, phone or production acceptance. The coordinator retains final paired rollout and independent review custody.
