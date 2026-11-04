import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as Forge from "node-forge";

const root = fileURLToPath(new URL("../", import.meta.url));
const copies = [
  {
    name: "registry",
    patch: "patches/node-forge@1.4.0.patch",
    patchHash: "b6876574a5de19521a766856b293aeae2689848c5d8dab03f93040be0a64b8b4",
    rsaHash: "c9b1e3799e230528b6d6815c1f6cd3c6058b9d45975264b55d995abb976589af",
  },
  {
    name: "sdk-fork",
    patch: "patches/node-forge-sdk-rsa-validation.patch",
    patchHash: "8724044fdc6243ad2845901df00485388d7db10baede983870f46500b5a11313",
    rsaHash: "dd383dc51d9ac90d85e4b3dbf78a106d4a2ba5a12ec2149ca45bb52533f2a3f2",
  },
] as const;

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

/** Recognize remediation only after both exact installed copies and patch files
 * pass their reviewed hashes and real signature checks. No advisory is waived. */
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
    assertStrictForgeRsa(loader("node-forge") as typeof Forge);
  }
}
