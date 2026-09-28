import { formatRequestForAuthorizationSignature } from "@privy-io/node";

const PRIVY_API = "https://api.privy.io";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/u;
const OPAQUE_ID = /^[A-Za-z0-9_-]{16,64}$/u;
const SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/u;

export type PrivySponsoredEvmCall = Readonly<{
  appId: string;
  walletId: string;
  chainId: number;
  to: string;
  data: string;
  referenceId: string;
  idempotencyKey: string;
  expiresAtMs: number;
}>;

export type PreparedPrivySponsoredEvmCall = Readonly<{
  url: string;
  body: Readonly<{
    method: "eth_sendTransaction";
    caip2: string;
    chain_type: "ethereum";
    reference_id: string;
    sponsor: true;
    params: Readonly<{
      transaction: Readonly<{ to: string; value: "0x0"; data: string }>;
    }>;
  }>;
  headers: Readonly<{
    "privy-app-id": string;
    "privy-idempotency-key": string;
    "privy-request-expiry": string;
  }>;
  authorizationPayloadBase64: string;
}>;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Builds the exact server request the wallet owner must authorize. The caller
 * derives every field from its durable reservation and private policy; a
 * browser must never supply arbitrary calldata to this function.
 */
export function preparePrivySponsoredEvmCall(
  input: PrivySponsoredEvmCall,
  nowMs: number,
): PreparedPrivySponsoredEvmCall {
  if (!/^[A-Za-z0-9_-]{4,128}$/u.test(input.appId)) throw new Error("invalid Privy app ID");
  if (!/^[A-Za-z0-9_-]{4,128}$/u.test(input.walletId)) throw new Error("invalid Privy wallet ID");
  if (!Number.isSafeInteger(input.chainId) || input.chainId < 1) {
    throw new Error("invalid sponsored chain");
  }
  if (!ADDRESS.test(input.to) || !HEX_DATA.test(input.data) || input.data.length < 10) {
    throw new Error("invalid sponsored call");
  }
  if (!OPAQUE_ID.test(input.referenceId) || !OPAQUE_ID.test(input.idempotencyKey)) {
    throw new Error("invalid sponsorship identity");
  }
  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(input.expiresAtMs) ||
    input.expiresAtMs <= nowMs ||
    input.expiresAtMs > nowMs + 5 * 60_000
  ) {
    throw new Error("invalid sponsorship expiry");
  }

  const url = `${PRIVY_API}/v1/wallets/${input.walletId}/rpc`;
  const body = {
    method: "eth_sendTransaction",
    caip2: `eip155:${input.chainId}`,
    chain_type: "ethereum",
    reference_id: input.referenceId,
    sponsor: true,
    params: { transaction: { to: input.to, value: "0x0", data: input.data } },
  } as const;
  const headers = {
    "privy-app-id": input.appId,
    "privy-idempotency-key": input.idempotencyKey,
    "privy-request-expiry": String(input.expiresAtMs),
  } as const;
  const authorizationPayloadBase64 = bytesToBase64(
    formatRequestForAuthorizationSignature({ version: 1, method: "POST", url, body, headers }),
  );
  return { url, body, headers, authorizationPayloadBase64 };
}

export type PrivySponsoredSubmission = Readonly<{
  transactionId: string | null;
  transactionHash: string | null;
  userOperationHash: string | null;
}>;

/** A lost or malformed response never proves that Privy did not submit. */
export class PrivySponsoredOutcomeUnknown extends Error {
  constructor() {
    super("Privy sponsored transaction outcome unknown");
    this.name = "PrivySponsoredOutcomeUnknown";
  }
}

export type PrivySponsoredFetcher = (url: string, init: RequestInit) => Promise<Response>;

function basicAuthorization(appId: string, appSecret: string): string {
  if (
    !/^[A-Za-z0-9_-]{4,128}$/u.test(appId) ||
    !/^[\x21-\x7e]{8,512}$/u.test(appSecret) ||
    appSecret.includes(":")
  ) {
    throw new Error("invalid Privy application credentials");
  }
  return `Basic ${btoa(`${appId}:${appSecret}`)}`;
}

/** Sends precisely the bytes the wallet owner authorized, with no body edits. */
export async function submitPrivySponsoredEvmCall(
  prepared: PreparedPrivySponsoredEvmCall,
  signature: string,
  appSecret: string,
  fetcher: PrivySponsoredFetcher = fetch,
): Promise<PrivySponsoredSubmission> {
  if (!SIGNATURE.test(signature) || signature.length > 4096) {
    throw new Error("invalid Privy authorization signature");
  }
  const authorization = basicAuthorization(prepared.headers["privy-app-id"], appSecret);
  const url = new URL(prepared.url);
  if (
    url.origin !== PRIVY_API ||
    !/^\/v1\/wallets\/[A-Za-z0-9_-]{4,128}\/rpc$/u.test(url.pathname) ||
    url.search !== "" ||
    !OPAQUE_ID.test(prepared.body.reference_id)
  ) {
    throw new Error("invalid prepared Privy request");
  }
  const actualPayload = bytesToBase64(
    formatRequestForAuthorizationSignature({
      version: 1,
      method: "POST",
      url: prepared.url,
      body: prepared.body,
      headers: prepared.headers,
    }),
  );
  if (actualPayload !== prepared.authorizationPayloadBase64) {
    throw new Error("prepared Privy request changed after authorization");
  }
  let response: Response;
  try {
    response = await fetcher(prepared.url, {
      method: "POST",
      headers: {
        ...prepared.headers,
        "Content-Type": "application/json",
        Authorization: authorization,
        "privy-authorization-signature": signature,
      },
      body: JSON.stringify(prepared.body),
    });
  } catch {
    throw new PrivySponsoredOutcomeUnknown();
  }
  // Even a provider refusal can arrive after an uncertain submission. The
  // durable reservation remains blocked until reference and chain reads settle.
  if (!response.ok) throw new PrivySponsoredOutcomeUnknown();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new PrivySponsoredOutcomeUnknown();
  }
  if (payload === null || typeof payload !== "object" || !("data" in payload)) {
    throw new PrivySponsoredOutcomeUnknown();
  }
  const data = payload.data;
  if (data === null || typeof data !== "object" || !("caip2" in data)) {
    throw new PrivySponsoredOutcomeUnknown();
  }
  if (
    data.caip2 !== prepared.body.caip2 ||
    ("reference_id" in data && data.reference_id !== prepared.body.reference_id)
  ) {
    throw new PrivySponsoredOutcomeUnknown();
  }
  const transactionId = "transaction_id" in data ? data.transaction_id : null;
  const transactionHash = "hash" in data ? data.hash : null;
  const userOperationHash = "user_operation_hash" in data ? data.user_operation_hash : null;
  if (
    (transactionId !== null && typeof transactionId !== "string") ||
    (transactionHash !== null && typeof transactionHash !== "string") ||
    (userOperationHash !== null && typeof userOperationHash !== "string")
  ) {
    throw new PrivySponsoredOutcomeUnknown();
  }
  const submission = {
    transactionId:
      typeof transactionId === "string" && transactionId.length > 0 ? transactionId : null,
    transactionHash:
      typeof transactionHash === "string" && transactionHash.length > 0 ? transactionHash : null,
    userOperationHash:
      typeof userOperationHash === "string" && userOperationHash.length > 0
        ? userOperationHash
        : null,
  };
  if (Object.values(submission).every((value) => value === null)) {
    throw new PrivySponsoredOutcomeUnknown();
  }
  return submission;
}

export type PrivySponsoredTransactionObservation = Readonly<{
  id: string;
  walletId: string;
  referenceId: string;
  caip2: string;
  status: string;
  transactionHash: string | null;
}>;

/**
 * A null observation is never permission to resubmit. The caller holds its
 * durable reservation until the provider and chain outcome can be proven.
 */
export async function findPrivySponsoredTransactionByReference(
  input: Readonly<{
    appId: string;
    appSecret: string;
    walletId: string;
    chainId: number;
    referenceId: string;
  }>,
  fetcher: PrivySponsoredFetcher = fetch,
): Promise<PrivySponsoredTransactionObservation | null> {
  if (
    !OPAQUE_ID.test(input.referenceId) ||
    !/^[A-Za-z0-9_-]{4,128}$/u.test(input.walletId) ||
    !Number.isSafeInteger(input.chainId) ||
    input.chainId < 1
  ) {
    throw new Error("invalid Privy transaction lookup");
  }
  const authorization = basicAuthorization(input.appId, input.appSecret);
  let response: Response;
  try {
    response = await fetcher(
      `${PRIVY_API}/v1/transactions?reference_id=${encodeURIComponent(input.referenceId)}`,
      { method: "GET", headers: { "privy-app-id": input.appId, Authorization: authorization } },
    );
  } catch {
    throw new PrivySponsoredOutcomeUnknown();
  }
  if (!response.ok) throw new PrivySponsoredOutcomeUnknown();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new PrivySponsoredOutcomeUnknown();
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("transactions" in payload) ||
    !Array.isArray(payload.transactions) ||
    payload.transactions.length > 1
  ) {
    throw new PrivySponsoredOutcomeUnknown();
  }
  const candidate: unknown = payload.transactions[0];
  if (candidate === undefined) return null;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    !("wallet_id" in candidate) ||
    candidate.wallet_id !== input.walletId ||
    !("caip2" in candidate) ||
    candidate.caip2 !== `eip155:${input.chainId}` ||
    !("reference_id" in candidate) ||
    candidate.reference_id !== input.referenceId ||
    !("id" in candidate) ||
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    !("status" in candidate) ||
    typeof candidate.status !== "string" ||
    !("transaction_hash" in candidate) ||
    (candidate.transaction_hash !== null && typeof candidate.transaction_hash !== "string")
  ) {
    throw new PrivySponsoredOutcomeUnknown();
  }
  return {
    id: candidate.id,
    walletId: input.walletId,
    referenceId: input.referenceId,
    caip2: `eip155:${input.chainId}`,
    status: candidate.status,
    transactionHash: candidate.transaction_hash,
  };
}
