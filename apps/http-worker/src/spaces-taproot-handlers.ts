import { AuthError, Conflict, InternalError, NotFound } from "@pirate/contracts";
import type { makeControlPlaneSpacesTaprootIntentStore } from "@pirate/platform-cf/spaces-taproot-intent-repository";
import type { EmbeddedTaprootWallet } from "@pirate/platform-cf/spaces-taproot-inventory";
import type { makeControlPlaneSpacesTaprootPreparationStore } from "@pirate/platform-cf/spaces-taproot-preparation-repository";
import { Effect } from "effect";
import type { DecodedRequest, EndpointHandler, Principal } from "./transport.ts";

type Proof = Readonly<{
  type: "privy_access_token";
  privy_access_token: string;
  privy_identity_token?: string | null;
}>;
type Store = ReturnType<typeof makeControlPlaneSpacesTaprootPreparationStore>;
type IntentStore = ReturnType<typeof makeControlPlaneSpacesTaprootIntentStore>;
type Inventory = Readonly<{ sourceUserId: string; wallets: readonly EmbeddedTaprootWallet[] }>;

export type SpacesTaprootHandlerServices = Readonly<{
  enabled: boolean;
  preparations: Store;
  intents: IntentStore;
  readInventory: (proof: Proof) => Effect.Effect<Inventory, unknown>;
  canonicalAccountId: (sourceUserId: string) => Effect.Effect<string, unknown>;
}>;

const account = (principal: Principal | null): string => {
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin"))
    throw new AuthError({ message: "Authentication required" });
  return principal.subject;
};
const persona = (request: DecodedRequest) =>
  (request.params as { readonly personaId: string }).personaId;
const input = (request: DecodedRequest) => request.body as { readonly proof: Proof };
const requireEnabled = (enabled: boolean) => {
  if (!enabled) throw new Conflict({ message: "Spaces recipient setup is unavailable" });
};
const identityFor = async (request: DecodedRequest, services: SpacesTaprootHandlerServices) => {
  const accountId = account(request.principal);
  let inventory: Inventory;
  let resolved: string;
  try {
    inventory = await Effect.runPromise(services.readInventory(input(request).proof));
    resolved = await Effect.runPromise(services.canonicalAccountId(inventory.sourceUserId));
  } catch {
    throw new AuthError({ message: "Wallet proof is unavailable" });
  }
  if (resolved !== accountId)
    throw new AuthError({ message: "Wallet proof does not match account" });
  return { accountId, personaId: persona(request), inventory: inventory.wallets };
};
const mapStore = async <T>(effect: Effect.Effect<T, unknown>): Promise<T> => {
  try {
    return await Effect.runPromise(effect);
  } catch (error) {
    if (error instanceof Error && /authority|not-found/u.test(error.message))
      throw new NotFound({ message: "Persona wallet is unavailable" });
    if (
      error instanceof Error &&
      /conflict|account-busy|request-mismatch|invalid/u.test(error.message)
    )
      throw new Conflict({ message: "Spaces recipient setup conflicts" });
    throw new InternalError({ message: "Spaces recipient setup failed" });
  }
};

/** Production composition keeps these routes disabled until staging acceptance. */
export function makeSpacesTaprootHandlers(services: SpacesTaprootHandlerServices): Readonly<{
  PreparePersonaSpacesTaproot: EndpointHandler;
  GetPersonaSpacesTaprootStatus: EndpointHandler;
  ConfirmPersonaSpacesTaproot: EndpointHandler;
}> {
  return {
    PreparePersonaSpacesTaproot: async (request) => {
      requireEnabled(services.enabled);
      const { accountId, personaId, inventory } = await identityFor(request, services);
      const body = request.body as { idempotency_key: string; proof: Proof };
      const prepared = await mapStore(
        services.preparations.prepare({
          accountId,
          personaId,
          idempotencyKey: body.idempotency_key,
          network: "mainnet",
        }),
      );
      const identity = {
        accountId,
        personaId,
        assignmentId: prepared.assignmentId,
        network: "mainnet" as const,
      };
      await mapStore(services.intents.prepare(identity, inventory));
      const start = await mapStore(services.intents.beginCreate(identity));
      return {
        assignment_id: prepared.assignmentId,
        network: "mainnet",
        may_create: start.mayCreate,
      };
    },
    GetPersonaSpacesTaprootStatus: async (request) => {
      requireEnabled(services.enabled);
      const { accountId, personaId, inventory } = await identityFor(request, services);
      const prepared = await mapStore(services.preparations.read({ accountId, personaId }));
      if (prepared === null) throw new NotFound({ message: "Persona wallet is unavailable" });
      const identity = {
        accountId,
        personaId,
        assignmentId: prepared.assignmentId,
        network: "mainnet" as const,
      };
      const status = await mapStore(services.intents.status(identity, inventory));
      const common = { assignment_id: prepared.assignmentId, network: "mainnet" as const };
      if (status.kind === "candidate")
        return {
          ...common,
          kind: "candidate",
          provider_wallet_id: status.wallet.providerId,
          address: status.wallet.address,
          output_script_hex: status.wallet.outputScriptHex,
          challenge_digest_hex: status.challengeDigestHex,
        };
      if (status.kind === "active") {
        if (prepared.address === null || prepared.outputScriptHex === null)
          throw new InternalError({ message: "Invalid active recipient" });
        return {
          ...common,
          kind: "active",
          provider_wallet_id: status.providerId,
          address: prepared.address,
          output_script_hex: prepared.outputScriptHex,
        };
      }
      return { ...common, kind: status.kind };
    },
    ConfirmPersonaSpacesTaproot: async (request) => {
      requireEnabled(services.enabled);
      const { accountId, personaId, inventory } = await identityFor(request, services);
      const body = request.body as {
        assignment_id: string;
        provider_wallet_id: string;
        signature_hex: string;
        proof: Proof;
      };
      const prepared = await mapStore(services.preparations.read({ accountId, personaId }));
      if (prepared === null || prepared.assignmentId !== body.assignment_id)
        throw new NotFound({ message: "Persona wallet is unavailable" });
      const identity = {
        accountId,
        personaId,
        assignmentId: prepared.assignmentId,
        network: "mainnet" as const,
      };
      const result = await mapStore(
        services.intents.confirm(identity, inventory, body.provider_wallet_id, body.signature_hex),
      );
      return {
        assignment_id: prepared.assignmentId,
        network: "mainnet",
        address: result.address,
        output_script_hex: result.outputScriptHex,
        replay: result.replay,
      };
    },
  };
}
