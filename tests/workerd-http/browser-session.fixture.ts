import type { IdentityStore } from "@pirate/application";
import {
  BrowserSessionFailure,
  type BrowserSessionRecord,
  type BrowserSessionStore,
  makeBrowserSessionService,
} from "@pirate/application/use-cases/browser-sessions";
import { Effect } from "effect";
import { makeBrowserSessionCrypto } from "../../packages/platform-cf/src/browser-session-crypto.ts";
import type { SessionCrypto } from "../../packages/platform-cf/src/session-crypto.ts";

/** The HTTP harness uses genuine crypto/service behavior with an in-memory
 * authority port. SQL renewal, replacement and locking have separate PG tests. */
export function workerdBrowserSessions(
  crypto: SessionCrypto,
  identities: Pick<IdentityStore["Service"], "resolveCanonical">,
) {
  type Stored = BrowserSessionRecord & {
    secretHash: string | null;
    csrfHash: string;
    revoked: boolean;
  };
  const rows = new Map<string, Stored>();
  const now = () => Math.floor(Date.now() / 1000);
  const store: BrowserSessionStore = {
    create: (input) =>
      input.replacement !== null
        ? Effect.fail(new BrowserSessionFailure({ reason: "unavailable" }))
        : Effect.sync(() => {
            const time = now();
            const row: Stored = {
              sessionId: input.sessionId,
              accountId: input.accountId,
              credentialUserId: input.accountId,
              scope: input.scope,
              origin: input.origin,
              renewable: input.renewable,
              now: time,
              idleExpiresAt: input.renewable
                ? time + 30 * 86400
                : Math.min(time + input.accessSeconds, input.proofExpiresAt),
              absoluteExpiresAt: input.renewable
                ? time + 90 * 86400
                : Math.min(time + input.accessSeconds, input.proofExpiresAt),
              secretHash: input.secretHash,
              csrfHash: input.csrfHash,
              revoked: false,
            };
            rows.set(input.sessionId, row);
            return row;
          }),
    access: (input) =>
      Effect.sync(() => {
        const row = rows.get(input.sessionId);
        return row &&
          !row.revoked &&
          row.accountId === input.accountId &&
          row.scope === input.scope &&
          row.idleExpiresAt > now() &&
          row.absoluteExpiresAt > now()
          ? row
          : null;
      }),
    loadRenewal: () => Effect.fail(new BrowserSessionFailure({ reason: "unavailable" })),
    renew: () => Effect.fail(new BrowserSessionFailure({ reason: "unavailable" })),
    revoke: (input) =>
      Effect.sync(() => {
        const row = rows.get(input.sessionId);
        if (
          !row ||
          row.origin !== input.origin ||
          row.csrfHash !== input.csrfHash ||
          (input.secretHash !== null
            ? row.secretHash !== input.secretHash
            : row.accountId !== input.accountId)
        )
          return false;
        row.revoked = true;
        return true;
      }),
  };
  return makeBrowserSessionService({
    store,
    crypto: makeBrowserSessionCrypto(crypto),
    identities,
    providerAppId: "workerd-test",
    userScope: crypto.defaultScope,
  });
}
