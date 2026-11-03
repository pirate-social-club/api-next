import {
  BrowserSessionFailure,
  type BrowserSessionService,
} from "@pirate/application/use-cases/browser-sessions";
import { Effect } from "effect";

/** Transport-only seam. Real cookie signing, persistence and revocation are
 * exercised together by browser-session-authentication.pg.test.ts. */
export function browserSessionTransportFixture(): BrowserSessionService {
  return {
    issue: ({ accessToken }) =>
      Effect.succeed({
        accessToken,
        accessSeconds: 3600,
        renewal: `bs_${"1".repeat(32)}.${"a".repeat(64)}`,
        csrf: "b".repeat(64),
        durableSeconds: 30 * 86400,
        accountId: "transport-fixture-account",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
    renew: () => Effect.fail(new BrowserSessionFailure({ reason: "invalid" })),
    verify: () => Effect.fail(new BrowserSessionFailure({ reason: "invalid" })),
    revoke: () => Effect.succeed(undefined),
  };
}
