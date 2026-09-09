import {
  type HnsChainObservationAnchorV1,
  type HnsChainObservationClassV1,
  type HnsChainObservationResultV1,
  type HnsChainObservationViewV1,
  type HnsRootResourceRecordV1,
  type HnsSafeCommitmentSelectionV1,
  hnsChainResourceDigestV1,
  hsdSafeCommitmentHeightV1,
} from "@pirate/application/namespace-ownership";
import { validCommunityRouteRoot } from "@pirate/domain";

export type HsdFetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

export type HsdRootResourceObserverConfig = Readonly<{
  readonly rpc_url: string;
  readonly authorization: string;
  readonly chain_network: string;
  readonly genesis_block_hash: string;
  readonly tree_interval_blocks: number;
  readonly safe_minimum_confirmations: number;
  readonly maximum_tip_age_seconds: number;
  readonly maximum_future_tip_seconds: number;
}>;

const responseMaxBytes = 1_048_576;
const requestTimeoutMs = 5_000;

function validEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

async function readBounded(response: Response): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > responseMaxBytes) throw new Error("HSD response exceeded byte limit");
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("HSD returned an invalid response");
  }
  return value as Record<string, unknown>;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function hexHash(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : null;
}

class HsdObservationUnavailable extends Error {
  constructor(
    readonly classification: Exclude<
      HnsChainObservationClassV1,
      "resource_absent" | "resource_mismatch"
    >,
  ) {
    super(classification);
  }
}

/** A finding about the name itself, distinct from unavailable evidence. */
class HsdObservationFinding extends Error {
  constructor(readonly classification: "resource_absent" | "resource_mismatch") {
    super(classification);
  }
}

/**
 * Anchor-bracketed typed HSD root observer — spec 012 "Observation evidence
 * model". Every observation is bracketed by two equal chain anchors; a moved
 * anchor is `chain_moving` unavailable evidence and never a name finding.
 * The current view reads the best block (`safe=false`); the safe view
 * resolves through the HSD safe commitment (`safe=true`) and additionally
 * retains the selected commitment. This replaces the previous conflated
 * `getnameinfo(name, true)` / `getnameresource(name, true)` reads that used
 * the safe view as though it were current.
 */
export function makeHsdRootResourceObserver(
  config: HsdRootResourceObserverConfig,
  fetcher: HsdFetch = fetch,
  now: () => number = Date.now,
): (rootLabel: string, view: HnsChainObservationViewV1) => Promise<HnsChainObservationResultV1> {
  if (
    !validEndpoint(config.rpc_url) ||
    config.authorization.trim().length === 0 ||
    typeof config.chain_network !== "string" ||
    config.chain_network.length === 0 ||
    !/^[0-9a-f]{64}$/u.test(config.genesis_block_hash) ||
    !Number.isSafeInteger(config.tree_interval_blocks) ||
    config.tree_interval_blocks < 1 ||
    !Number.isSafeInteger(config.safe_minimum_confirmations) ||
    config.safe_minimum_confirmations < 0 ||
    !Number.isSafeInteger(config.maximum_tip_age_seconds) ||
    config.maximum_tip_age_seconds < 1 ||
    !Number.isSafeInteger(config.maximum_future_tip_seconds) ||
    config.maximum_future_tip_seconds < 0
  ) {
    throw new Error("HSD root observer configuration is invalid");
  }
  const rpc = async (
    method:
      | "getblockchaininfo"
      | "getblockheader"
      | "getblockbyheight"
      | "getnameinfo"
      | "getnameresource",
    params: readonly unknown[],
  ): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetcher(config.rpc_url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: {
          accept: "application/json",
          authorization: config.authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({ method, params }),
      });
    } catch {
      throw new HsdObservationUnavailable("transport_failure");
    }
    if (
      !response.ok ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      throw new HsdObservationUnavailable("transport_failure");
    }
    let decoded: unknown;
    try {
      const bytes = await readBounded(response);
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new HsdObservationUnavailable("malformed_response");
    }
    let envelope: Record<string, unknown>;
    try {
      envelope = object(decoded);
    } catch {
      throw new HsdObservationUnavailable("malformed_response");
    }
    if (
      Object.keys(envelope).sort().join(",") !== "error,id,result" ||
      envelope.id !== null ||
      envelope.error !== null
    ) {
      throw new HsdObservationUnavailable("malformed_response");
    }
    return envelope.result;
  };

  const chainAnchor = async (): Promise<HnsChainObservationAnchorV1> => {
    let infoResult: unknown;
    try {
      infoResult = await rpc("getblockchaininfo", []);
    } catch (error) {
      if (
        error instanceof HsdObservationUnavailable &&
        error.classification === "malformed_response"
      )
        throw new HsdObservationUnavailable("node_unavailable");
      throw error;
    }
    const chain = object(infoResult);
    const height = safeInteger(chain.blocks);
    const headers = safeInteger(chain.headers);
    const medianTime = safeInteger(chain.mediantime);
    const bestBlockHash = hexHash(chain.bestblockhash);
    if (
      height === null ||
      headers === null ||
      medianTime === null ||
      bestBlockHash === null ||
      typeof chain.chain !== "string"
    ) {
      throw new HsdObservationUnavailable("malformed_response");
    }
    if (chain.chain !== config.chain_network) throw new HsdObservationUnavailable("wrong_network");
    if (height !== headers) throw new HsdObservationUnavailable("node_stale");
    let headerResult: unknown;
    try {
      headerResult = await rpc("getblockheader", [bestBlockHash, true]);
    } catch (error) {
      if (
        error instanceof HsdObservationUnavailable &&
        error.classification === "malformed_response"
      )
        throw new HsdObservationUnavailable("node_unavailable");
      throw error;
    }
    const header = object(headerResult);
    const headerTime = safeInteger(header.time);
    const confirmations = safeInteger(header.confirmations);
    if (
      hexHash(header.hash) !== bestBlockHash ||
      safeInteger(header.height) !== height ||
      safeInteger(header.mediantime) !== medianTime ||
      headerTime === null ||
      confirmations === null
    ) {
      throw new HsdObservationUnavailable("malformed_response");
    }
    const anchor: HnsChainObservationAnchorV1 = {
      network: config.chain_network,
      genesis_block_hash: config.genesis_block_hash,
      height,
      best_block_hash: bestBlockHash,
      median_time_past_epoch_seconds: medianTime,
      header_time_epoch_seconds: headerTime,
      confirmations,
    };
    const ageSeconds = Math.floor(now() / 1_000) - medianTime;
    if (ageSeconds > config.maximum_tip_age_seconds) {
      throw new HsdObservationUnavailable("node_stale");
    }
    if (ageSeconds < -config.maximum_future_tip_seconds) {
      throw new HsdObservationUnavailable("malformed_response");
    }
    return anchor;
  };

  return async (rootLabel, view) => {
    if (!validCommunityRouteRoot("hns", rootLabel)) {
      throw new Error("HSD root label is invalid");
    }
    let bracketAnchor: HnsChainObservationAnchorV1 | null = null;
    try {
      const anchorA = await chainAnchor();
      bracketAnchor = anchorA;
      const nameResult = object(await rpc("getnameinfo", [rootLabel, view === "safe"]));
      const info = object(nameResult.info === null ? {} : nameResult.info);
      // HSD getnameinfo omits currently expired names (info=null). Its
      // serialized expired flag records a previous expiry and survives
      // re-registration; it is not the current NameState.isExpired decision.
      if (info.state !== "CLOSED" || info.registered !== true) {
        throw new HsdObservationFinding("resource_absent");
      }
      const inclusionHeight = safeInteger(info.height);
      if (inclusionHeight === null || inclusionHeight < 0) {
        throw new HsdObservationUnavailable("malformed_response");
      }
      let commitment: HnsSafeCommitmentSelectionV1 | null = null;
      let commitmentBlockHash: string | null = null;
      let commitmentTreeRoot: string | null = null;
      if (view === "safe") {
        const commitmentHeight = hsdSafeCommitmentHeightV1(
          anchorA.height,
          config.tree_interval_blocks,
          config.safe_minimum_confirmations,
        );
        const blockResult = object(await rpc("getblockbyheight", [commitmentHeight, false, false]));
        commitmentBlockHash = hexHash(blockResult.hash);
        if (commitmentBlockHash === null) {
          throw new HsdObservationUnavailable("malformed_response");
        }
        const headerResult = object(await rpc("getblockheader", [commitmentBlockHash, true]));
        commitmentTreeRoot = hexHash(headerResult.treeRoot);
        if (
          hexHash(headerResult.hash) !== commitmentBlockHash ||
          safeInteger(headerResult.height) !== commitmentHeight ||
          commitmentTreeRoot === null
        ) {
          throw new HsdObservationUnavailable("malformed_response");
        }
        commitment = {
          selection_basis: "hsd_getsaferoot_compatible",
          commitment_height: commitmentHeight,
          commitment_block_hash: commitmentBlockHash,
          commitment_tree_root: commitmentTreeRoot,
          tip_height: anchorA.height,
          tree_interval_blocks: config.tree_interval_blocks,
          minimum_confirmations: config.safe_minimum_confirmations,
        };
      }
      const resourceValue = await rpc("getnameresource", [rootLabel, view === "safe"]);
      const records: HnsRootResourceRecordV1[] = [];
      if (resourceValue !== null) {
        const resource = object(resourceValue);
        if (Object.keys(resource).join(",") !== "records" || !Array.isArray(resource.records)) {
          throw new HsdObservationUnavailable("malformed_response");
        }
        records.push(...structuredClone(resource.records));
      }
      const anchorB = await chainAnchor();
      if (
        anchorA.best_block_hash !== anchorB.best_block_hash ||
        anchorA.height !== anchorB.height ||
        anchorA.median_time_past_epoch_seconds !== anchorB.median_time_past_epoch_seconds
      ) {
        throw new HsdObservationUnavailable("chain_moving");
      }
      return {
        kind: "observed",
        observation: {
          view,
          network: config.chain_network,
          genesis_block_hash: config.genesis_block_hash,
          anchor: anchorB,
          tip_height: anchorB.height,
          update_inclusion_height: inclusionHeight,
          commitment,
          observed_at_epoch_ms: now(),
          records,
          resource_sha256: await hnsChainResourceDigestV1(records),
        },
      };
    } catch (error) {
      if (error instanceof HsdObservationFinding) {
        // A finding is only raised after the opening anchor was read; if that
        // ordering is ever violated the evidence is not trustworthy.
        if (bracketAnchor === null) {
          return { kind: "unavailable", classification: "malformed_response" };
        }
        return {
          kind: "finding",
          classification: error.classification,
          anchor: bracketAnchor,
          observed_at_epoch_ms: now(),
        };
      }
      if (error instanceof HsdObservationUnavailable) {
        return { kind: "unavailable", classification: error.classification };
      }
      if (error instanceof SyntaxError || error instanceof TypeError) {
        return { kind: "unavailable", classification: "malformed_response" };
      }
      return { kind: "unavailable", classification: "transport_failure" };
    }
  };
}
