import type { HnsForwarderClockV1, HnsForwarderReplayStoreV1 } from "./hns-forwarder-v3.ts";

export const HNS_COMMUNITY_APP_API_REPLAY_SCOPE =
  "pirate:hns-forwarder-v3:api-next-community-app-api:v1" as const;

type HnsForwarderReplayStoreStub = Readonly<{
  readonly consume: (
    nonce: string,
    expiresAtUnixSeconds: number,
    nowUnixSeconds: number,
  ) => Promise<boolean>;
}>;

export type HnsForwarderReplayStoreNamespace = Readonly<{
  readonly getByName: (name: string) => HnsForwarderReplayStoreStub;
}>;

const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const noncePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const scopePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

/**
 * Routes each key id to an independent Durable Object and retains a consumed
 * nonce until every envelope accepted at first sight must be stale.
 */
export function makeDurableObjectHnsForwarderReplayStore(input: {
  readonly namespace: HnsForwarderReplayStoreNamespace;
  readonly consumerScope: string;
  readonly clock: HnsForwarderClockV1;
  readonly retentionSeconds: number;
}): HnsForwarderReplayStoreV1 {
  if (
    !scopePattern.test(input.consumerScope) ||
    !Number.isSafeInteger(input.retentionSeconds) ||
    input.retentionSeconds <= 0
  ) {
    throw new Error("Invalid HNS forwarder replay-store configuration");
  }
  return Object.freeze({
    consume: async (keyId, nonce) => {
      if (!keyIdPattern.test(keyId) || !noncePattern.test(nonce)) return false;
      const now = input.clock.nowUnixSeconds();
      const expiresAt = now + input.retentionSeconds;
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(expiresAt)) {
        throw new Error("Invalid HNS forwarder replay-store clock");
      }
      return input.namespace
        .getByName(`${input.consumerScope}:${keyId}`)
        .consume(nonce, expiresAt, now);
    },
  });
}
