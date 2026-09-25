import {
  type SpacesBitcoinNetwork,
  spacesTaprootOutputScriptFromAddress,
} from "./spaces-taproot-recipient.ts";

export type EmbeddedTaprootWallet = Readonly<{
  providerId: string;
  index: number;
  address: string;
  outputScriptHex: string;
  publicKeyHex: string;
}>;

const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid provider inventory");
  }
  return value as Record<string, unknown>;
};

/** Accept only provider-owned embedded Taproot wallets from the authenticated user document. */
export function collectEmbeddedTaprootWallets(
  document: unknown,
  network: SpacesBitcoinNetwork,
): readonly EmbeddedTaprootWallet[] {
  const accounts = record(document).linked_accounts;
  if (!Array.isArray(accounts) || accounts.length > 256) {
    throw new TypeError("invalid provider inventory");
  }
  const wallets: EmbeddedTaprootWallet[] = [];
  const ids = new Set<string>();
  const indices = new Set<number>();
  const scripts = new Set<string>();
  for (const value of accounts) {
    const account = record(value);
    if (account.type !== "wallet" || account.chain_type !== "bitcoin-taproot") continue;
    if (
      account.wallet_client !== "privy" ||
      account.wallet_client_type !== "privy" ||
      account.connector_type !== "embedded" ||
      account.imported !== false
    ) {
      throw new TypeError("unsupported Taproot wallet in provider inventory");
    }
    const id = account.id;
    const index = account.wallet_index;
    const address = account.address;
    const publicKey = account.public_key;
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(id) ||
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      typeof address !== "string" ||
      typeof publicKey !== "string" ||
      !/^(?:02|03)[0-9a-f]{64}$/u.test(publicKey)
    ) {
      throw new TypeError("invalid embedded Taproot wallet");
    }
    const outputScriptHex = spacesTaprootOutputScriptFromAddress(address, network);
    if (ids.has(id) || indices.has(index) || scripts.has(outputScriptHex)) {
      throw new TypeError("duplicate embedded Taproot wallet");
    }
    ids.add(id);
    indices.add(index);
    scripts.add(outputScriptHex);
    wallets.push({ providerId: id, index, address, outputScriptHex, publicKeyHex: publicKey });
  }
  return wallets.sort((left, right) => left.providerId.localeCompare(right.providerId, "en"));
}

export type TaprootInventoryResult =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "ambiguous" }>
  | Readonly<{ kind: "candidate"; wallet: EmbeddedTaprootWallet }>;

/** A create attempt may be reconciled, but never retried after its outcome is uncertain. */
export function reconcileEmbeddedTaprootWallets(
  before: readonly EmbeddedTaprootWallet[],
  after: readonly EmbeddedTaprootWallet[],
): TaprootInventoryResult {
  const previous = new Map(before.map((wallet) => [wallet.providerId, wallet]));
  const current = new Map(after.map((wallet) => [wallet.providerId, wallet]));
  if (previous.size !== before.length || current.size !== after.length)
    return { kind: "ambiguous" };
  for (const [id, old] of previous) {
    const fresh = current.get(id);
    if (
      fresh === undefined ||
      fresh.index !== old.index ||
      fresh.address !== old.address ||
      fresh.outputScriptHex !== old.outputScriptHex ||
      fresh.publicKeyHex !== old.publicKeyHex
    ) {
      return { kind: "ambiguous" };
    }
  }
  const added = after.filter((wallet) => !previous.has(wallet.providerId));
  if (added.length === 0) return { kind: "pending" };
  if (added.length !== 1) return { kind: "ambiguous" };
  return { kind: "candidate", wallet: added[0] as EmbeddedTaprootWallet };
}
