/** TEST ONLY explicit historical source construction; current factory stays separate. */
import { confirmPersonaEvmWallet, prepareActivityPersona } from "@pirate/application";
import { Effect } from "effect";
import { COMMUNITY_ID, addressFor } from "../activity-participation-composed.pg-fixture.ts";
import type { Runtime } from "../activity-participation-composed-drivers.pg-fixture.ts";
import { makeControlPlanePersonaStore, makeControlPlanePersonaWalletStore } from "./persona-repository.ts";
export const prepareHistoricalIdentity3ef = (runtime: Runtime) => {
  const services = {
    store: makeControlPlanePersonaStore(runtime),
    nextPersonaId: () => Effect.sync(() => `persona_${crypto.randomUUID().replaceAll("-", "")}`),
    nowIso: () => Effect.sync(() => new Date().toISOString()),
  };
  return (accountId: string, idempotencyKey: string) =>
    Effect.runPromise(
      prepareActivityPersona(
        {
          accountId,
          communityId: COMMUNITY_ID,
          body: { idempotency_key: idempotencyKey, choice: { kind: "create_new" } },
        },
        services,
      ),
    );
};

export const confirmHistoricalWallet3ef = (runtime: Runtime) => {
  const store = makeControlPlanePersonaWalletStore(runtime);
  return async (accountId: string, personaId: string) =>
    Effect.runPromise(
      confirmPersonaEvmWallet(
        {
          accountId,
          personaId,
          body: {
            proof: { type: "privy_access_token", privy_access_token: "composed-fixture-token" },
          },
        },
        {
          store,
          verifier: {
            verifyPrivyEmbeddedEvmWallet: ({ hdWalletIndex }) =>
              Effect.promise(async () => ({
                address: await addressFor(`${accountId}:${personaId}`),
                hdWalletIndex,
                privyWalletId: `composed-wallet-${personaId}`,
                sourceUserId: accountId,
              })),
          },
          accounts: { canonicalAccountId: (sourceUserId) => Effect.succeed(sourceUserId) },
        },
      ),
    );
};
