import type { MegapotCommitmentPublisher } from "./megapot-commitment-coordinator.ts";

const COMMITMENT_ID = /^megapot_commitment_[0-9a-f]{64}$/u;
const PAYLOAD_HASH = /^[0-9a-f]{64}$/u;

type StoredObject = Readonly<{
  uploaded: Date;
}>;

type StoredObjectBody = StoredObject &
  Readonly<{
    text: () => Promise<string>;
  }>;

export interface MegapotCommitmentBucket {
  readonly get: (key: string) => Promise<StoredObjectBody | null>;
  readonly put: (
    key: string,
    value: string,
    options: Readonly<{
      onlyIf: Readonly<{ etagDoesNotMatch: "*" }>;
      httpMetadata: Readonly<{ contentType: "application/json" }>;
      customMetadata: Readonly<{ payloadHash: string }>;
    }>,
  ) => Promise<StoredObject | null>;
}

export class MegapotCommitmentR2Failed extends Error {
  readonly _tag = "MegapotCommitmentR2Failed";

  constructor(readonly reason: "conflict" | "invalid-config" | "invalid-request") {
    super(reason);
  }
}

function publicOrigin(value: string): URL {
  const origin = new URL(value);
  if (
    origin.protocol !== "https:" ||
    origin.username.length > 0 ||
    origin.password.length > 0 ||
    origin.search.length > 0 ||
    origin.hash.length > 0 ||
    origin.pathname !== "/"
  ) {
    throw new MegapotCommitmentR2Failed("invalid-config");
  }
  return origin;
}

function keyFor(idempotencyKey: string): string {
  if (!COMMITMENT_ID.test(idempotencyKey)) {
    throw new MegapotCommitmentR2Failed("invalid-request");
  }
  return `megapot/commitments/${idempotencyKey}.json`;
}

function canonicalDocument(input: {
  readonly idempotencyKey: string;
  readonly payload: string;
  readonly payloadHash: string;
  readonly signingKeyId: string;
  readonly signature: string;
}): string {
  if (
    input.payload.length === 0 ||
    !PAYLOAD_HASH.test(input.payloadHash) ||
    input.signingKeyId.length === 0 ||
    input.signature.length === 0
  ) {
    throw new MegapotCommitmentR2Failed("invalid-request");
  }
  return JSON.stringify({
    domain: "pirate.megapot-commitment-publication.v1",
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    payloadHash: input.payloadHash,
    signingKeyId: input.signingKeyId,
    signature: input.signature,
  });
}

export function makeR2MegapotCommitmentPublisher(input: {
  readonly bucket: MegapotCommitmentBucket;
  readonly publicOrigin: string;
}): MegapotCommitmentPublisher {
  const origin = publicOrigin(input.publicOrigin);
  return {
    publish: async (request) => {
      const key = keyFor(request.idempotencyKey);
      const document = canonicalDocument(request);
      const created = await input.bucket.put(key, document, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
        customMetadata: { payloadHash: request.payloadHash },
      });
      let object: StoredObject;
      if (created === null) {
        const existing = await input.bucket.get(key);
        if (existing === null || (await existing.text()) !== document) {
          throw new MegapotCommitmentR2Failed("conflict");
        }
        object = existing;
      } else {
        object = created;
      }
      if (!Number.isFinite(object.uploaded.getTime())) {
        throw new MegapotCommitmentR2Failed("conflict");
      }
      return {
        publicReference: new URL(`/${key}`, origin).toString(),
        publishedAt: object.uploaded.toISOString(),
      };
    },
  };
}
