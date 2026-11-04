import { bech32m } from "@scure/base";

export type SpacesBitcoinNetwork = "mainnet" | "testnet4" | "regtest";

const NETWORK_HRP: Readonly<Record<SpacesBitcoinNetwork, string>> = {
  mainnet: "bc",
  testnet4: "tb",
  regtest: "bcrt",
};

/**
 * Decode a provider-attested address into the exact P2TR script used by
 * Spaces. The 32-byte witness program is the tweaked output key; a provider's
 * compressed public key is an internal key and must not be copied here.
 */
export function spacesTaprootOutputScriptFromAddress(
  address: string,
  network: SpacesBitcoinNetwork,
): string {
  const expectedHrp = NETWORK_HRP[network];
  const expectedLength = expectedHrp.length + 60;
  if (address !== address.toLowerCase() || address.length !== expectedLength) {
    throw new TypeError("invalid Taproot address");
  }

  const decoded = bech32m.decodeUnsafe(address, 90);
  if (decoded === undefined || decoded.prefix !== expectedHrp || decoded.words[0] !== 1) {
    throw new TypeError("invalid Taproot address");
  }

  let outputKey: Uint8Array;
  try {
    outputKey = bech32m.fromWords(decoded.words.slice(1));
  } catch {
    throw new TypeError("invalid Taproot address");
  }
  if (outputKey.length !== 32 || bech32m.encode(expectedHrp, decoded.words, 90) !== address) {
    throw new TypeError("invalid Taproot address");
  }

  return `5120${Array.from(outputKey, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
