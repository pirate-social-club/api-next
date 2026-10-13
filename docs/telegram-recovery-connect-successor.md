# Telegram practice recovery and Connect: contract successor draft

Status: draft for review, 2026-10-13. It amends Specs 014 and 026 for phase-two
recovery and existing-account connection of Telegram practice learners. It is
not accepted and admits no implementation. The provider section stays open
until the staging probe has real phone evidence. Decisions marked **Owner
decision** need the workspace_owner. Production, rewards and funds, credential
operations and irreversible actions remain excluded.

Inputs: Spec 026 (Telegram linking), Spec 014 (restricted practice identity),
Spec 027 (ownership invariants only), and the reviewed account-connection
research at Solid `docs/evidence/telegram-takeover-2026-10-13/reviewed-research.md`.
The frozen texts are in the contract-context package at Solid `666d0bb3`.

## What this successor decides

There are two actions. Both start on Pirate's website from a server-owned
community-bot navigation reference, never from chat authority:

1. **Recover**: a learner with no Pirate account gains website access to their
   own restricted practice account.
2. **Connect**: a learner who already has a Pirate account links their Telegram
   practice to it.

In both, independent proof of the same numeric Telegram ID is required.
Recovery keeps the learner's own account, Connect keeps their existing one, and
no history moves.

## Invariants (from Specs 014 and 026, unchanged)

- One restricted learner account per numeric Telegram ID across Pirate, keyed
  by the reservation with `local_bot_id IS NULL`. Only that reservation can be
  recovered. A bot-local isolated owner, one with `local_bot_id` set, is never
  promoted. At most it gets scoped Connect access (see Connect).
- Recovery happens in place. `users.user_id`, persona IDs, Study session IDs,
  attempts and practice-only mode are preserved. Nothing is copied, merged or
  re-attributed.
- Historic practice sessions stay permanently practice-only. They never gain
  reward, share, credit or qualification eligibility, now or later.
- Bot ingress, Mini App data, bot-token signatures, guest cookies and browser
  observations are never login or linking proof.
- An association maps one Telegram ID to one account. Conflicts refuse; they
  never reassign or merge.
- No age assertion is collected, as Spec 006 directs since 2026-10-08.

## Proof of identity

Both actions need a server-verified numeric Telegram ID equal to the bot
sender bound to the navigation reference: community, stable bot ID, ingress
generation and sender.

The proof must come from a verified provider result: a fresh app- and
subject-bound signed identity, or a managed server-side provider lookup. It
must also meet each of these:

- It never comes from a browser-supplied ID, an unverified SDK user object, a
  username or a decoded but unverified JWT.
- It is single-use, bounded in time and bound to the initiating browser
  transaction (the Spec 026 transaction, or its provider-path replacement).
- Mismatch, replay, expiry, cancellation, a browser switch or a conflicting
  association refuses with no credential, association, grant, account, persona
  or history mutation.
- A provider path that replaces native OIDC must say how it replaces OIDC's
  nonce, state and PKCE protections. It must not drop them silently.

**Provider: open pending evidence.** Native Telegram OIDC (Spec 026) is the
accepted contract, but its staging login has not completed: the October 6
attempt stopped at the phone form. The staging-only Privy probe (Solid #64)
will produce the deciding evidence:

- a real login from a link opened inside Telegram, with a same-tab return and
  a cancelled attempt;
- a managed read-only Privy lookup whose numeric Telegram ID, subject hash and
  verification time match the original practice sender.

If Privy passes, this section selects Privy Telegram OAuth with that
server-side verification. If it fails, the concrete failure is recorded and
native OIDC is investigated under the same standard.

## Recover (no existing Pirate account)

1. The learner opens the website from the bot's ending (see Entry and Connect
   visibility). The navigation reference is unprivileged and binds the
   server-side sender.
2. The provider proof completes. The server verifies that the numeric ID
   equals the sender. It then locks the reservation, rechecks that it is the
   promotable one (`local_bot_id IS NULL`) and checks that no other association
   holds this Telegram ID or provider subject.
3. The server attaches the provider credential to the existing restricted
   account and records the association. A provider subject already mapped to
   another account takes the Connect path, never reassignment.
4. The browser receives a session for that same account. **Owner decision R1**
   chooses the scope:
   - **(a) recommended**: a limited practice-history session. It covers
     reading practice history, continuing practice and account settings, and
     grants no posting, membership, handle, wallet or rewards. This needs no
     wallet provisioning and keeps the ordinary full-session readiness gate
     unchanged.
   - **(b)**: full in-place promotion. Profile, handle and first-persona
     preparation, including EVM wallet assignment, run in place. Then the
     ordinary full session applies.

   Generic registration must never run. Solid must intercept before its
   session-exchange 401 path triggers automatic registration; otherwise a
   second account is created.
5. The migration 0246 `require_restricted_learner_practice_only` trigger
   stays. **Owner decision R2** (recommended: yes): the recovered account stays
   practice-only for Study until a separately reviewed transition admits
   ordinary Study. The reservation row is never deleted to get around the
   trigger.

## Connect (existing Pirate account)

1. The learner signs into their existing Pirate account independently, then
   completes the same provider proof as in Recover.
2. The server verifies the numeric ID equals the bot sender. It then locks and
   rechecks uniqueness: the Telegram ID must not be associated with another
   account. That check comes before attaching the credential to the existing
   account's provider user (for Privy, link to that user; never authenticate
   Telegram into a different provider user).
3. The server records a **private connection relation** between the existing
   account and the restricted practice owner, or the bot-local owner. The
   practice account, its personas and its sessions stay where they are;
   original attribution is unchanged.
4. **Owner decision C1** (recommended): the relation authorizes a unified,
   read-only practice-history projection on the existing account's website.
   New bot lessons keep continuing the same practice profile until a
   separately reviewed routing transition. Nothing swaps personas because a
   login exists. The relation grants no ownership of the practice account's
   personas, wallet or website routes, and the existing account gains no new
   authority from it.
5. For a bot-local isolated owner, the relation is scoped to that bot's local
   practice only, with no sibling-bot access.

## Entry and Connect visibility

- The completion message gains a third action, alongside Choose a song and
  Practice again, only while Telegram login acceptance passes on that
  environment. It goes to every unconnected learner alike, per Spec 026.
  - **Owner decision E1**: the label, either one action ("Save my progress")
    that routes to Recover or Connect on the website, or two actions.
    Recommended: one action.
- The action carries only a fresh, expiring navigation reference (at most
  fifteen minutes). It is hidden once a current connection or recovery exists
  for that sender. A stale button never recreates it.
- Returning to the bot resumes the current prompt or ending unchanged.

## Acceptance

| Case | Required evidence |
| --- | --- |
| Recover | Same `user_id`, persona and session IDs; no second account; session scope per R1; practice-only per R2. |
| Connect | Verified target account plus a matching Telegram ID; explicit confirmation; historic attribution unchanged; projection and routing per C1. |
| Wrong identity or copied entry | Refused; no credential, association, grant, account or history mutation. |
| Cancel, replay, expiry or browser switch | Safe refusal or a fresh restart in the destination browser; no state transfer; no automatic registration. |
| Return to bot | Prompt or ending resumes; the third action is gone once connected; stale buttons inert. |

The final acceptance is a real phone run plus server readback of account,
history, association, relation and button behavior.

## Delivery order

1. The probe phone run and its managed lookup decide the provider section.
2. Review and accept this successor and decisions R1, R2, C1 and E1.
   Integrate into Specs 014 and 026 in the control plane.
3. API: recovery and connection transactions, association and relation,
   session scope, plus adversarial PostgreSQL tests (concurrency, conflicts,
   replay, wrong identity, bot-local owner).
4. Solid: entry, confirmation and return, with the intercept before generic
   registration. Bot: the completion action.
5. Guarded staging deploy, then a real phone run.
