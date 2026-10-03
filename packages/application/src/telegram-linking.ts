import type {
  TelegramLinkAccount,
  TelegramLinkGrant,
  TelegramLinkTransaction,
} from "@pirate/contracts";
import { Effect, Result } from "effect";
import { type CredentialVault, TelegramFailure } from "./telegram/index.ts";
import type { TelegramOidcClient, TelegramOidcRejected } from "./telegram-oidc.ts";

/** Constructed only after browser-session authentication, never from a body. */
export interface TelegramLinkBrowser {
  readonly accountId: string;
  readonly sessionHash: string;
  readonly browserHash: string;
}
export interface TelegramLinkStart {
  readonly id: string;
  readonly browser: TelegramLinkBrowser;
  readonly navigationHash: string;
  readonly stateHash: string;
  readonly secretCiphertext: string;
}
export interface TelegramLinkStore {
  list(accountId: string): Promise<TelegramLinkAccount>;
  /** Internal ingress operation; the reference is navigation, not authority. */
  createNavigation(input: {
    referenceHash: string;
    communityId: string;
    botId: string;
    epoch: string;
    telegramUserId: string;
    postId: string;
  }): Promise<void>;
  start(input: TelegramLinkStart): Promise<TelegramLinkTransaction>;
  get(id: string, browser: TelegramLinkBrowser): Promise<TelegramLinkTransaction>;
  claim(id: string, browser: TelegramLinkBrowser, stateHash: string): Promise<string>;
  verified(
    id: string,
    browser: TelegramLinkBrowser,
    telegramUserId: string,
  ): Promise<TelegramLinkTransaction>;
  fail(id: string, browser: TelegramLinkBrowser): Promise<void>;
  confirm(id: string, browser: TelegramLinkBrowser, personaId: string): Promise<TelegramLinkGrant>;
  revoke(browser: TelegramLinkBrowser, communityId: string, botId: string): Promise<void>;
  unlink(browser: TelegramLinkBrowser, telegramUserId: string): Promise<void>;
  /** No Study dispatch yet; future acceptance must recheck this revision atomically. */
  resolveGrant(
    communityId: string,
    botId: string,
    epoch: string,
    telegramUserId: string,
  ): Promise<{
    accountId: string;
    personaId: string;
    revision: number;
  } | null>;
  cleanup(): Promise<void>;
}
export interface TelegramLinkServices {
  readonly store: TelegramLinkStore;
  readonly oidc: TelegramOidcClient;
  readonly vault: CredentialVault;
}

async function oidc<A>(
  effect: Effect.Effect<A, TelegramOidcRejected>,
  signal?: AbortSignal,
): Promise<A> {
  const result = await Effect.runPromise(Effect.result(effect), { signal });
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}
export async function startTelegramLink(
  services: TelegramLinkServices,
  browser: TelegramLinkBrowser,
  navigationReference: string,
  signal?: AbortSignal,
) {
  const authorization = await oidc(services.oidc.authorize(), signal);
  const id = services.vault.token();
  const transaction = await services.store.start({
    id,
    browser,
    navigationHash: await services.vault.hash(navigationReference),
    stateHash: await services.vault.hash(authorization.state),
    secretCiphertext: await services.vault.seal(
      JSON.stringify({
        nonce: authorization.nonce,
        verifier: authorization.verifier,
      }),
      `telegram-link:${id}`,
    ),
  });
  return { transaction, authorization_url: authorization.authorizationUrl };
}

export async function verifyTelegramLink(
  services: TelegramLinkServices,
  browser: TelegramLinkBrowser,
  id: string,
  state: string,
  code: string,
  signal?: AbortSignal,
) {
  // Check browser before provider traffic; check keys before claiming/exchanging.
  // Start and callback may run in different isolates; warming at start is insufficient.
  const current = await services.store.get(id, browser);
  if (current.state !== "pending") throw new TelegramFailure({ reason: "conflict" });
  await oidc(services.oidc.prepare(), signal);
  const secret = await services.store.claim(id, browser, await services.vault.hash(state));
  try {
    const stored = JSON.parse(await services.vault.open(secret, `telegram-link:${id}`)) as {
      nonce: string;
      verifier: string;
    };
    const identity = await oidc(services.oidc.exchange({ ...stored, code }), signal);
    return await services.store.verified(id, browser, identity.telegramUserId);
  } catch (error) {
    await services.store.fail(id, browser);
    throw error;
  }
}
