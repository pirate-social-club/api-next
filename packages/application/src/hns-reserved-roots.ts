import { IANA_TLD_SNAPSHOT } from "./hns-iana-tld-snapshot.ts";

/**
 * A listed root sends every name under it to the Handshake resolver, so discovery
 * never lists one that ordinary DNS, another name system or a local network
 * already owns. Refusing a root only leaves its names on today's ordinary path.
 */
const RESERVED_NON_ICANN_ROOTS = [
  // Suffixes the Freedom browser resolves through another name system.
  "eth",
  "box",
  "wei",
  "gwei",
  "tez",
  "onion",
  // Special-use and non-DNS names, including RFC 9476's `alt`.
  "local",
  "localhost",
  "test",
  "invalid",
  "example",
  "arpa",
  "alt",
  // Private-network names ICANN does not delegate or local networks commonly use.
  "internal",
  "corp",
  "home",
  "mail",
  "lan",
  "intranet",
  "private",
  "localdomain",
] as const;

const reservedRoots: ReadonlySet<string> = new Set([
  ...IANA_TLD_SNAPSHOT.split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.toLowerCase()),
  ...RESERVED_NON_ICANN_ROOTS,
]);

/** Expects a lowercase LDH label; every ICANN TLD in the bundled snapshot is reserved. */
export function isReservedHnsRoot(root: string): boolean {
  return reservedRoots.has(root);
}
