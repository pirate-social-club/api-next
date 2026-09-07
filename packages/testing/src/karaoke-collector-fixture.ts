import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeKaraokeReconciliationFixture } from "./karaoke-reconciliation-fixture.ts";

/** Test-only signed producer and JWKS transport. Never live observation evidence. */
export function makeKaraokeCollectorFixture(
  ids: readonly string[],
  digest: (bytes: string) => string,
) {
  const directory = mkdtempSync(join(tmpdir(), "karaoke-collector-test-"));
  const evidence = makeKaraokeReconciliationFixture(ids, digest);
  const signing = generateKeyPairSync("ed25519");
  const access = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const operator = {
    API_NEXT_ENV: "staging",
    KARAOKE_RESET_ENABLED: "true",
    KARAOKE_RESET_ACCESS_ISSUER: "https://collector-test.cloudflareaccess.com",
    KARAOKE_RESET_ACCESS_AUDIENCE: "collector-test-audience",
    KARAOKE_RESET_ACCESS_SUBJECT: "collector-test-operator",
  };
  const trust = {
    directory,
    operator,
    collectorPublicKeyPem: signing.publicKey.export({ type: "spki", format: "pem" }).toString(),
    collectorSourceDigest: digest("fixture-source"),
    epoch: evidence.manifest.epoch,
    bucket: evidence.manifest.bucket,
    residualDispositionId: evidence.manifest.residualDispositionId,
    expectedHistory: Object.fromEntries(
      evidence.manifest.targets.map((target) => [target.objectId, [...target.receiptIds]]),
    ),
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  function assertion(subject = operator.KARAOKE_RESET_ACCESS_SUBJECT) {
    const now = Math.floor(Date.now() / 1000);
    const body = `${encode({ alg: "RS256", kid: "collector-test" })}.${encode({
      iss: operator.KARAOKE_RESET_ACCESS_ISSUER,
      aud: operator.KARAOKE_RESET_ACCESS_AUDIENCE,
      sub: subject,
      iat: now - 1,
      exp: now + 300,
    })}`;
    return `${body}.${Buffer.from(sign("RSA-SHA256", Buffer.from(body), access.privateKey)).toString("base64url")}`;
  }
  async function authenticationFetch(input: string | URL): Promise<Response> {
    if (String(input) !== `${operator.KARAOKE_RESET_ACCESS_ISSUER}/cdn-cgi/access/certs`)
      throw new Error("unexpected_fixture_network");
    return Response.json({
      keys: [
        {
          ...access.publicKey.export({ format: "jwk" }),
          kid: "collector-test",
          alg: "RS256",
          use: "sig",
        },
      ],
    });
  }
  function writeAttestation(value: unknown, key = signing.privateKey) {
    const payload = JSON.stringify(value);
    writeFileSync(
      join(directory, "manifest.signed.json"),
      JSON.stringify({
        payload,
        signature: Buffer.from(sign(null, Buffer.from(payload), key)).toString("hex"),
      }),
      { mode: 0o600 },
    );
  }
  function attestation(challenge: { challenge: string; operatorSubjectDigest: string }) {
    return {
      version: "staging-karaoke-collector-attestation-v1",
      challenge: challenge.challenge,
      operatorSubjectDigest: challenge.operatorSubjectDigest,
      collectorSourceDigest: trust.collectorSourceDigest,
      observedAt: evidence.now,
      manifest: structuredClone(evidence.manifest),
    };
  }
  for (const [id, bytes] of evidence.artifacts)
    writeFileSync(join(directory, `${id}.json`), bytes, { mode: 0o600 });
  // Self-contained stdin program for the real CLI spawn test, not a live collector.
  function bundle(assertionFile: string) {
    return `import { sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.slice(-3, -1).join(" ") !== "collect-karaoke-reconciliation --run-directory") process.exit(3);
if (process.env.KARAOKE_COLLECTOR_ACCESS_ASSERTION_FILE !== ${JSON.stringify(assertionFile)}) process.exit(4);
if (!readFileSync(process.env.KARAOKE_COLLECTOR_ACCESS_ASSERTION_FILE, "utf8")) process.exit(5);
const challenge = JSON.parse(process.env.KARAOKE_COLLECTOR_CHALLENGE);
const payload = JSON.stringify({version:"staging-karaoke-collector-attestation-v1",
challenge:challenge.challenge,operatorSubjectDigest:challenge.operatorSubjectDigest,
collectorSourceDigest:process.env.KARAOKE_COLLECTOR_SOURCE_DIGEST,
observedAt:${JSON.stringify(evidence.now)},manifest:${JSON.stringify(evidence.manifest)}});
const signature = sign(null, Buffer.from(payload), ${JSON.stringify(signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString())}).toString("hex");
writeFileSync(join(process.argv.at(-1), "manifest.signed.json"),JSON.stringify({payload,signature}),{mode:0o600});
`;
  }
  return {
    directory,
    evidence,
    trust,
    signing,
    assertion,
    authenticationFetch,
    attestation,
    writeAttestation,
    bundle,
    collector: {
      async collect(challenge: { challenge: string; operatorSubjectDigest: string }) {
        writeAttestation(attestation(challenge));
      },
    },
    now: () => evidence.now,
    dispose() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
