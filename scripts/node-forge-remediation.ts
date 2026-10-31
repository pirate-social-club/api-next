import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as Forge from "node-forge";
import { assertForgeSecurityRegressions } from "./node-forge-security-regressions.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const copies = [
  {
    name: "registry",
    patch: "patches/node-forge@1.4.0.patch",
    patchHash: "a38f3deb24d99d1d9db5105beef65e58f1b695907eb040d9645202f532dccf09",
    rsaHash: "c9b1e3799e230528b6d6815c1f6cd3c6058b9d45975264b55d995abb976589af",
    files: {
      "cipherModes.js": "bcc6aec4127be32ede61899410f9f4813e8bb24ec03f0f0e8d88744bde889fd0",
      "http.js": "257276e15b49964f8e5c4037e1bd6b4368aacdc1de4f6f46a45b67ca72728265",
      "pbe.js": "674750301f7c7d44b7b52c80bde90399aef8ff6021e6d6ccd1553ce3f5768c81",
      "pem.js": "38f22a503dc8285e31edfb67f0614a30c8af4abd0032e7738d45a08c31361401",
      "pkcs12.js": "4e471bf3e717d940a07b34d5716d988cfa01b143c38c3fc1f8b597cb83d29742",
      "tls.js": "3d7def7a2e1c568de50c18109d7186c0c83d0384c7f9badab4831722b6233cbe",
      "x509.js": "cf3a94b7966de3445364ff20c08ec7810ea22a5222a54873f34df39e9c3db77f",
    },
  },
  {
    name: "sdk-fork",
    patch: "patches/node-forge-sdk-rsa-validation.patch",
    patchHash: "28e9271870038d59526fa9a674e0fde116ff2c972655dc78ac76f9ef482d2bd9",
    rsaHash: "dd383dc51d9ac90d85e4b3dbf78a106d4a2ba5a12ec2149ca45bb52533f2a3f2",
    files: {
      "cipherModes.js": "bcc6aec4127be32ede61899410f9f4813e8bb24ec03f0f0e8d88744bde889fd0",
      "http.js": "257276e15b49964f8e5c4037e1bd6b4368aacdc1de4f6f46a45b67ca72728265",
      "pbe.js": "042d7b66dd70b1bc41996162541f29c39b5168b66a66ec621f30a74582ec1df2",
      "pem.js": "38f22a503dc8285e31edfb67f0614a30c8af4abd0032e7738d45a08c31361401",
      "pkcs12.js": "2493bbf72bdeed9fe83f9482687f7eac0bc8dc44d115d84aab79a306460e79ea",
      "tls.js": "e72887b28965e5ac5374e8cd5f9cfc68f1942aa484a238b27adff9a4b7ac6a2a",
      "x509.js": "01c3058b2e1ebe8743412c3a681edc9aa6e78928ce42630b767692b28bcfc3a6",
    },
  },
] as const;

/** Exact source fixes, never a severity or reachability exception. Unknown IDs
 * continue through the unchanged policy. Verification below is unconditional. */
const remediatedForgeAdvisories: ReadonlySet<string> = new Set([
  "GHSA-86w9-cpqp-85rv",
  "GHSA-8hrf-8g6f-7xwp",
  "GHSA-hqq3-7jhf-c5jx",
  "GHSA-5x38-2vff-x55p",
  "GHSA-6wvx-3r32-xmcg",
  "GHSA-525v-9gp9-w22h",
  "GHSA-7wch-p9px-956x",
  "GHSA-5cwg-6vw7-rj6p",
  "GHSA-jc66-7q78-782g",
]);

export function isRemediatedForgeAdvisory(packageName: string, advisory: string): boolean {
  return packageName === "node-forge" && remediatedForgeAdvisories.has(advisory);
}

/** Exercise RSA decoding with signed, malformed DigestInfo structures. A valid
 * RSA operation must not make an invalid ASN.1 algorithm structure acceptable. */
export function assertStrictForgeRsa(forge: typeof Forge): void {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 65537 });
  const digest = forge.md.sha256.create().update("RSA dependency remediation").digest().getBytes();
  const asn1 = forge.asn1;
  const element = (type: number, value: string | Forge.asn1.Asn1[], constructed = false) =>
    asn1.create(asn1.Class.UNIVERSAL, type, constructed, value);
  for (const includeNull of [true, false]) {
    for (const malformed of ["none", "nested", "outer"] as const) {
      const algorithm = [
        element(asn1.Type.OID, asn1.oidToDer("2.16.840.1.101.3.4.2.1").getBytes()),
      ];
      if (includeNull) algorithm.push(element(asn1.Type.NULL, ""));
      if (malformed === "nested") algorithm.push(element(asn1.Type.OCTETSTRING, "extra"));
      const values = [
        element(asn1.Type.SEQUENCE, algorithm, true),
        element(asn1.Type.OCTETSTRING, digest),
      ];
      if (malformed === "outer") values.push(element(asn1.Type.OCTETSTRING, "extra"));
      const encoded = asn1.toDer(element(asn1.Type.SEQUENCE, values, true)).getBytes();
      // NONE signs our exact ASN.1 bytes so the test reaches DigestInfo decoding.
      const signature = keys.privateKey.sign(encoded, "NONE");
      let accepted = false;
      try {
        accepted = keys.publicKey.verify(digest, signature);
      } catch {
        accepted = false;
      }
      if (accepted !== (malformed === "none")) {
        throw new Error(`node-forge RSA remediation failed: ${malformed}, NULL=${includeNull}`);
      }
    }
  }
}

/** First check all bytes of both copies, then exercise actual library behavior.
 * Static expected hashes are not an installation or qualification attestation. */
export async function verifyNodeForgeRemediation(
  readText: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<void> {
  const require = createRequire(resolve(root, "package.json"));
  const core = createRequire(require.resolve("@selfxyz/core"));
  const common = createRequire(core.resolve("@selfxyz/common"));
  const loaders = [core, common];
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  for (const [index, copy] of copies.entries()) {
    const loader = loaders[index];
    if (loader === undefined) throw new Error("node-forge remediation loader missing");
    if (hash(await readText(resolve(root, copy.patch))) !== copy.patchHash) {
      throw new Error(`node-forge remediation patch mismatch: ${copy.name}`);
    }
    if (hash(await readText(loader.resolve("node-forge/lib/rsa.js"))) !== copy.rsaHash) {
      throw new Error(`node-forge installed RSA remediation mismatch: ${copy.name}`);
    }
    for (const [file, expected] of Object.entries(copy.files)) {
      if (hash(await readText(loader.resolve(`node-forge/lib/${file}`))) !== expected) {
        throw new Error(`node-forge installed security remediation mismatch: ${copy.name}/${file}`);
      }
    }
  }
  for (const loader of loaders) {
    assertStrictForgeRsa(loader("node-forge") as typeof Forge);
    assertForgeSecurityRegressions(loader("node-forge") as typeof Forge, loader);
  }
}
