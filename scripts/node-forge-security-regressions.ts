import assert from "node:assert/strict";
import type { createRequire } from "node:module";
import type * as Forge from "node-forge";
import { assertForgeTlsRegressions } from "./node-forge-tls-regressions.ts";

type ForgeModule = typeof Forge;
type PackageLoader = ReturnType<typeof createRequire>;

function assertGcm(forge: ForgeModule): void {
  const key = "k".repeat(16);
  const iv = "i".repeat(12);
  for (const bad of [0, false, "", "0", -1, 31, 129, Number.NaN]) {
    for (const decrypt of [false, true]) {
      const cipher = decrypt
        ? forge.cipher.createDecipher("AES-GCM", key)
        : forge.cipher.createCipher("AES-GCM", key);
      assert.throws(
        () =>
          cipher.start({ iv, tag: forge.util.createBuffer(), tagLength: bad as unknown as number }),
        /Invalid tag length/,
      );
    }
  }
  // Upstream's intact/tampered vectors cover 96-128 bits. Its pre-existing
  // 32/64-bit export truncation defect is outside the zero-like-length fix.
  // Check documented length admission and invalid-tag rejection for those
  // modes without claiming their intact short-tag roundtrips work.
  for (const tagLength of [32, 64]) {
    const cipher = forge.cipher.createCipher("AES-GCM", key);
    assert.doesNotThrow(() => cipher.start({ iv, tagLength }));
    const decipher = forge.cipher.createDecipher("AES-GCM", key);
    assert.doesNotThrow(() =>
      decipher.start({ iv, tagLength, tag: forge.util.createBuffer("\0".repeat(tagLength / 8)) }),
    );
    decipher.update(forge.util.createBuffer("invalid ciphertext"));
    assert.equal(decipher.finish(), false);
  }
  for (const tagLength of [undefined, null, 96, 104, 112, 120, 128, "128"]) {
    const cipher = forge.cipher.createCipher("AES-GCM", key);
    cipher.start({ iv, tagLength: tagLength as unknown as number });
    cipher.update(forge.util.createBuffer("authenticated"));
    assert.equal(cipher.finish(), true);
    const ciphertext = cipher.output.getBytes();
    const tag = cipher.mode.tag.getBytes();
    for (const tamper of [false, true]) {
      const decipher = forge.cipher.createDecipher("AES-GCM", key);
      const actualTag = tamper ? String.fromCharCode(tag.charCodeAt(0) ^ 1) + tag.slice(1) : tag;
      decipher.start({
        iv,
        tagLength: tagLength as unknown as number,
        tag: forge.util.createBuffer(actualTag),
      });
      decipher.update(forge.util.createBuffer(ciphertext));
      assert.equal(decipher.finish(), !tamper);
      if (!tamper) assert.equal(decipher.output.getBytes(), "authenticated");
    }
  }
  for (const tagLength of [undefined, null]) {
    const decipher = forge.cipher.createDecipher("AES-GCM", key);
    assert.throws(
      () =>
        decipher.start({
          iv,
          tagLength: tagLength as unknown as number,
          tag: forge.util.createBuffer(),
        }),
      /tag length/,
    );
  }
}

function assertPem(forge: ForgeModule): void {
  const messages = forge.pem.decode("-----BEGIN A-----\nQUJD\n-----END A-----\n");
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.body, "ABC");
  assert.throws(() => forge.pem.decode(" -----BEGIN I-----G-----END B".repeat(2000) + "\0"));
  assert.throws(() => forge.pem.decode("-----BEGIN A-----\n" + "\n".repeat(256 * 1024)));
  const header = forge.pem.decode(
    "-----BEGIN A-----\nProc-Type: 4,ENCRYPTED\n" +
      "DEK-Info: DES-CBC,F8143EDE5960C597\nX-Header: " +
      " ".repeat(32000) +
      "x\n\nQUJD\n-----END A-----",
  );
  assert.equal(header.length, 1);
  assert.equal(header[0]?.body, "ABC");
  assert.deepEqual(header[0]?.headers, [{ name: "X-Header", values: ["x"] }]);
}

function regressionCertificate(forge: ForgeModule): {
  certificate: Forge.pki.Certificate;
  keys: Forge.pki.rsa.KeyPair;
} {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 65537 });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 86_400_000);
  certificate.setSubject([{ name: "commonName", value: "synthetic-root" }]);
  certificate.setIssuer(certificate.subject.attributes);
  certificate.setExtensions([{ name: "basicConstraints", cA: true }]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  return { certificate, keys };
}

function children(node: Forge.asn1.Asn1): Forge.asn1.Asn1[] {
  assert.ok(Array.isArray(node.value), "expected a constructed ASN.1 fixture");
  return node.value;
}

function assertPkcs12(forge: ForgeModule): void {
  const { certificate } = regressionCertificate(forge);
  const make = () =>
    forge.pkcs12.toPkcs12Asn1(null, certificate, "synthetic-password", {
      count: 1,
      generateLocalKeyId: false,
    });
  forge.pkcs12.pkcs12FromAsn1(make(), true, "synthetic-password");
  for (const zero of ["\x00", ""]) {
    const pfx = make();
    const macData = children(pfx)[2];
    assert.ok(macData);
    const iterations = children(macData)[2];
    const digestInfo = children(macData)[0];
    assert.ok(iterations && digestInfo);
    iterations.value = zero;
    const digest = children(digestInfo)[1];
    assert.ok(digest);
    const authSafe = children(pfx)[1];
    assert.ok(authSafe);
    const wrapper = children(authSafe)[1];
    assert.ok(wrapper);
    const safeOctets = children(wrapper)[0];
    assert.ok(safeOctets && typeof safeOctets.value === "string");
    const mac = forge.hmac.create();
    mac.start("sha1", "\x03".repeat(20));
    mac.update(safeOctets.value);
    digest.value = mac.digest().getBytes();
    assert.throws(
      () => forge.pkcs12.pkcs12FromAsn1(pfx, true, "another-password"),
      /MAC iteration count must be >= 1/,
    );
  }
  for (const count of [0, -1, Number.NaN]) {
    assert.throws(
      () => forge.pkcs12.generateKey("a", forge.util.createBuffer("salt"), 3, count, 20),
      /iteration count must be >= 1/,
    );
  }
  const first = forge.pkcs12.generateKey("a", forge.util.createBuffer("salt"), 3, 1, 20).getBytes();
  const second = forge.pkcs12
    .generateKey("b", forge.util.createBuffer("salt"), 3, 1, 20)
    .getBytes();
  assert.notEqual(first, second);
}

function assertBasicConstraints(forge: ForgeModule): void {
  const { certificate: root, keys } = regressionCertificate(forge);
  const issue = (subject: string, issuer: string, extensions: object[]) => {
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = subject === "intermediate" ? "02" : "03";
    cert.validity.notBefore = root.validity.notBefore;
    cert.validity.notAfter = root.validity.notAfter;
    cert.setSubject([{ name: "commonName", value: subject }]);
    cert.setIssuer([{ name: "commonName", value: issuer }]);
    cert.setExtensions(extensions);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return forge.pki.certificateFromPem(forge.pki.certificateToPem(cert));
  };
  const leaf = issue("leaf", "intermediate", []);
  const verify = (extensions: object[]) =>
    forge.pki.verifyCertificateChain(forge.pki.createCaStore([forge.pki.certificateToPem(root)]), [
      leaf,
      issue("intermediate", "synthetic-root", extensions),
    ]);
  assert.equal(verify([{ name: "basicConstraints", cA: true }]), true);
  const errorMatches = (pattern: RegExp) => (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    pattern.test(error.message);
  for (const id of ["2.5.29.10", "2.5.29.13"]) {
    assert.throws(
      () =>
        verify([
          { id, cA: true },
          { id: "2.5.29.19", cA: false },
        ]),
      errorMatches(/not a CA/),
    );
    assert.throws(() => verify([{ id, cA: true }]), errorMatches(/missing basicConstraints/));
  }
}

interface CookieClient {
  setCookie(cookie: { name: string; value: string; path: string; secure: boolean }): boolean;
  getCookie(name: string, path?: string): unknown;
  removeCookie(name: string, path?: string): boolean;
}

function assertCookies(loader: PackageLoader): void {
  const http = loader("node-forge/lib/http.js") as {
    createClient(options: object): CookieClient;
  };
  // This inert pool opens no network socket. Cookie methods are the real library.
  const client = http.createClient({
    url: "http://synthetic.invalid",
    persistCookies: false,
    socketPool: { createSocket: () => ({}) },
  });
  const before = Object.getOwnPropertyDescriptors(Object.prototype);
  try {
    assert.equal(client.getCookie("toString", "/"), null);
    assert.equal(client.removeCookie("toString", "/"), false);
    for (const [name, path] of [
      ["__proto__", "/"],
      ["ordinary", "__proto__"],
    ]) {
      assert.ok(name && path);
      assert.equal(client.setCookie({ name, path, value: "synthetic", secure: false }), false);
    }
    assert.equal(
      client.setCookie({ name: "constructor", path: "/", value: "synthetic", secure: false }),
      true,
    );
    assert.ok(client.getCookie("constructor", "/"));
    assert.equal(client.removeCookie("constructor", "/"), true);
    assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
  } finally {
    // Restore only unexpected new properties from this isolated synthetic test.
    for (const key of Object.getOwnPropertyNames(Object.prototype)) {
      if (!(key in before)) Reflect.deleteProperty(Object.prototype, key);
    }
  }
}

/** Real public-library regressions, called only after every installed hash agrees. */
export function assertForgeSecurityRegressions(forge: ForgeModule, loader: PackageLoader): void {
  assertGcm(forge);
  assertPem(forge);
  assertPkcs12(forge);
  assertBasicConstraints(forge);
  assertCookies(loader);
  assertForgeTlsRegressions(forge);
}
