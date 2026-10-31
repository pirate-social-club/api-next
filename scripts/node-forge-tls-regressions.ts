import assert from "node:assert/strict";
import type * as Forge from "node-forge";

/** No sockets or provider calls: ordinary TLS connections exchange synthetic
 * plaintext records directly, including a real certificate-stripping path. */
export function assertForgeTlsRegressions(forge: typeof Forge): void {
  const record = (type: number, fragment: string) =>
    String.fromCharCode(type, 3, 1) + forge.util.int32ToBytes(fragment.length).slice(2) + fragment;
  const alert = record(21, "\x02\x28");
  const heartbeat = record(24, "\x02\x00\x00");
  const connection = (server: boolean, errors: string[], sent: { bytes: string }) => {
    const c = forge.tls.createConnection({
      server,
      verify: () => true,
      connected: () => {},
      tlsDataReady: (current) => {
        sent.bytes += current.tlsData.getBytes();
      },
      dataReady: (current) => {
        current.data.getBytes();
      },
      closed: () => {},
      error: (_current, error) => {
        errors.push(error.message);
      },
    });
    if (!server) {
      c.handshake();
      sent.bytes = "";
    }
    return c;
  };
  for (const server of [false, true]) {
    const errors: string[] = [];
    const c = connection(server, errors, { bytes: "" });
    assert.equal(c.process(heartbeat.repeat(50_000) + alert), 0);
    assert.deepEqual(errors, ["Handshake failure."]);
    for (const interleaved of [record(20, "\x01"), alert, record(23, "data"), heartbeat]) {
      const fragmentErrors: string[] = [];
      const sent = { bytes: "" };
      const fragmented = connection(server, fragmentErrors, sent);
      const first = record(22, forge.util.hexToBytes((server ? "01" : "02") + "0000100301"));
      assert.doesNotThrow(() => fragmented.process(first + interleaved));
      assert.deepEqual(fragmentErrors, ["Invalid fragmented record."]);
      assert.equal(fragmented.fail, true);
      assert.equal(sent.bytes, record(21, "\x02\x0a"));
      assert.equal(fragmented.process(interleaved), 0);
      assert.deepEqual(fragmentErrors, ["Invalid fragmented record."]);
      const continuedErrors: string[] = [];
      const continued = connection(server, continuedErrors, { bytes: "" });
      assert.equal(continued.process(first + record(22, "\x00")), 0);
      assert.equal(continued.fail, false);
      assert.deepEqual(continuedErrors, []);
    }
  }
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 65537 });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 86_400_000);
  certificate.setSubject([{ name: "commonName", value: "synthetic-server" }]);
  certificate.setIssuer(certificate.subject.attributes);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  const pem = forge.pki.certificateToPem(certificate);
  const privateKey = forge.pki.privateKeyToPem(keys.privateKey);
  const dropCertificate = (bytes: string) => {
    const input = forge.util.createBuffer(bytes);
    let output = "";
    while (input.length() > 0) {
      const type = input.getByte();
      const version = input.getBytes(2);
      let fragment = input.getBytes(input.getInt16());
      if (type === 22) {
        const messages = forge.util.createBuffer(fragment);
        fragment = "";
        while (messages.length() > 0) {
          const messageType = messages.getByte();
          const length = messages.getInt24();
          const body = messages.getBytes(length);
          if (messageType !== 11)
            fragment +=
              String.fromCharCode(messageType) + forge.util.int32ToBytes(length).slice(1) + body;
        }
      }
      output +=
        String.fromCharCode(type) +
        version +
        forge.util.int32ToBytes(fragment.length).slice(2) +
        fragment;
    }
    return output;
  };
  for (const accept of [false, true]) {
    const errors: string[] = [];
    const verified: unknown[] = [];
    let client: Forge.tls.Connection;
    let server: Forge.tls.Connection;
    client = forge.tls.createConnection({
      server: false,
      caStore: [certificate],
      connected: () => {},
      verify: (_c, status, depth, certificates) => {
        verified.push([status, depth, certificates.length]);
        return accept ? true : status;
      },
      tlsDataReady: (c) => {
        server.process(c.tlsData.getBytes());
      },
      dataReady: () => {},
      closed: () => {},
      error: (_c, error) => {
        errors.push(error.message);
      },
    });
    server = forge.tls.createConnection({
      server: true,
      getCertificate: () => pem,
      getPrivateKey: () => privateKey,
      connected: () => {},
      tlsDataReady: (c) => {
        client.process(dropCertificate(c.tlsData.getBytes()));
      },
      dataReady: () => {},
      closed: () => {},
      error: () => {},
    });
    assert.doesNotThrow(() => client.handshake());
    assert.deepEqual(verified, [[forge.tls.Alert.Description.insufficient_security, 0, 0]]);
    assert.deepEqual(errors, ["No server certificate provided. Not enough security."]);
    assert.equal(client.fail, true);
    assert.equal(client.isConnected, false);
  }
}
