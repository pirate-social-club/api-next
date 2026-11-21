import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashTypedData } from "viem";
import {
  bindingDigest,
  challengeDigest,
  consentHash,
  namespaceId,
} from "../src/protocol.ts";
import { accessData } from "../src/access.ts";
import { challengeRecord, delegationRecord } from "../src/records.ts";
test("committed service-only consent, publication and HTTP authorization vectors remain fixed", async () => {
  const v = JSON.parse(
    readFileSync(
      new URL("./vectors/ceremony-v1.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(bindingDigest(v.binding), v.expected.bindingDigest);
  assert.equal(namespaceId(v.binding.tld), v.expected.namespaceId);
  const challenge = await challengeDigest(
    v.fields.ceremonyId,
    v.fields.bindingDigest,
    v.fields.nonce,
    v.publicationDeadline,
    v.maturitySeconds,
  );
  assert.equal(challenge, v.expected.challengeDigest);
  assert.equal(challengeRecord(challenge), v.expected.challengeRecord);
  const { chainId, registry, controller, communityId } = v.binding;
  assert.equal(
    delegationRecord({ chainId, registry, controller, communityId }),
    v.expected.delegationRecord,
  );
  assert.equal(consentHash(v.binding, v.fields), v.expected.consentHash);
  const h = v.http;
  assert.equal(
    hashTypedData(
      await accessData(
        v.binding,
        h.method,
        h.path,
        h.body,
        h.nonce,
        h.issuedAt,
        h.deadline,
      ),
    ),
    v.expected.httpHash,
  );
});
