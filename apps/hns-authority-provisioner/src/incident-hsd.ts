import type { HnsRetainedAuthorityReferenceV1 } from "@pirate/application/namespace-ownership";
import type { HnsIncidentNameStateV1, HnsIncidentTransactionV1 } from "./incident-evidence.ts";

/**
 * The read-only hsd calls incident evidence needs beyond a routine
 * observation: the owning outpoint, the transaction that produced it, and the
 * block that confirmed it.
 *
 * These are separate from the observer on purpose. The observer answers "what
 * does the name carry now" and must work against any node; this answers "which
 * transaction put it there", which needs transaction indexing. A node without
 * it returns nothing here, and nothing is what the classifier is given.
 */

export type HnsIncidentHsdConfigV1 = Readonly<{
  readonly rpc_url: string;
  readonly authorization: string;
  readonly timeout_ms?: number;
}>;

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const objectOf = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("HSD returned a non-object result");
  }
  return value as Record<string, unknown>;
};

const hex64 = (value: unknown): string | null =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : null;

export function makeHnsIncidentHsdReadsV1(
  config: HnsIncidentHsdConfigV1,
  fetcher: Fetcher = fetch,
): Readonly<{
  readonly name_state: (rootLabel: string) => Promise<HnsIncidentNameStateV1 | null>;
  readonly transaction: (
    txid: string,
    outputIndex: number,
  ) => Promise<HnsIncidentTransactionV1 | null>;
  readonly block_height: (blockHash: string) => Promise<number | null>;
}> {
  const timeout = config.timeout_ms ?? 10_000;
  const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const response = await fetcher(config.rpc_url, {
      method: "POST",
      headers: { authorization: config.authorization, "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(timeout),
    });
    const body = objectOf(await response.json());
    if (body.error !== null && body.error !== undefined) {
      throw new Error(`hsd ${method} failed`);
    }
    return body.result;
  };
  return {
    name_state: async (rootLabel) => {
      const result = objectOf(await rpc("getnameinfo", [rootLabel, false]));
      if (result.info === null || result.info === undefined) return null;
      const info = objectOf(result.info);
      const owner = info.owner === null || info.owner === undefined ? null : objectOf(info.owner);
      const txid = hex64(owner?.hash);
      const index = typeof owner?.index === "number" ? owner.index : null;
      if (txid === null || index === null || !Number.isSafeInteger(index) || index < 0) return null;
      return {
        owner_txid: txid,
        owner_index: index,
        resource_hex:
          typeof info.data === "string" && /^(?:[0-9a-f]{2})*$/u.test(info.data) && info.data !== ""
            ? info.data
            : null,
      };
    },
    transaction: async (txid, outputIndex) => {
      const result = objectOf(await rpc("getrawtransaction", [txid, true]));
      const outputs = Array.isArray(result.vout) ? result.vout : [];
      const output = outputs[outputIndex];
      const covenant =
        output === null || output === undefined ? null : (objectOf(output).covenant ?? null);
      const covenantObject = covenant === null ? null : objectOf(covenant);
      const items = Array.isArray(covenantObject?.items) ? covenantObject.items : [];
      // An UPDATE covenant carries [nameHash, sequence, resource]; the resource
      // is the encoded bytes that transaction actually published.
      const resource = items.length >= 3 && typeof items[2] === "string" ? items[2] : null;
      return {
        block_hash: hex64(result.blockhash),
        confirmations: typeof result.confirmations === "number" ? result.confirmations : 0,
        covenant_action: typeof covenantObject?.action === "string" ? covenantObject.action : null,
        covenant_resource_hex: resource,
      };
    },
    block_height: async (blockHash) => {
      const header = objectOf(await rpc("getblockheader", [blockHash, true]));
      const height = header.height;
      return typeof height === "number" && Number.isSafeInteger(height) && height >= 0
        ? height
        : null;
    },
  };
}

/**
 * The retained plan, read from whichever tables the deployment actually has.
 *
 * A deployment that predates the lifecycle tables still holds the exposed plan
 * in the older session tables, and four of the five evidence questions are
 * answered by the chain and the provider anyway. Reading such an operation and
 * classifying it is useful; persisting a finding against it is not possible,
 * and the report says so rather than failing.
 */
export function makeHnsIncidentRetainedPlanReadV1(
  query: <Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ readonly rows: Row[] }>,
  planAuthority: (planBytes: Uint8Array) => HnsRetainedAuthorityReferenceV1,
  planEncodedDigest: (planBytes: Uint8Array) => string | null,
) {
  return async (rootImportSessionId: string) => {
    const lifecycle = await query<Record<string, unknown>>(
      `SELECT root_label, generation, revision, plan_encoded_resource_sha256
         FROM hns_root_import_lifecycle WHERE root_import_session_id = $1`,
      [rootImportSessionId],
    ).catch(() => ({ rows: [] as Record<string, unknown>[] }));
    const session = await query<Record<string, unknown>>(
      `SELECT root_label, ownership_generation, revision, publish_plan_bytes
         FROM hns_root_import_sessions WHERE root_import_session_id = $1`,
      [rootImportSessionId],
    );
    const sessionRow = session.rows[0];
    if (sessionRow === undefined && lifecycle.rows[0] === undefined) return null;
    const planBytes =
      sessionRow?.publish_plan_bytes instanceof Uint8Array ? sessionRow.publish_plan_bytes : null;
    let authority: HnsRetainedAuthorityReferenceV1 | null = null;
    let derivedDigest: string | null = null;
    if (planBytes !== null) {
      try {
        authority = planAuthority(planBytes);
        derivedDigest = planEncodedDigest(planBytes);
      } catch {
        authority = null;
        derivedDigest = null;
      }
    }
    const row = lifecycle.rows[0];
    if (row !== undefined) {
      return {
        root_label: String(row.root_label),
        generation: Number(row.generation),
        revision: Number(row.revision),
        // The lifecycle's own digest is authoritative when it has one; the
        // plan document is the fallback for operations recorded before it.
        plan_encoded_sha256:
          typeof row.plan_encoded_resource_sha256 === "string"
            ? row.plan_encoded_resource_sha256
            : derivedDigest,
        authority,
        lifecycle_present: true,
      };
    }
    return {
      root_label: String(sessionRow?.root_label ?? ""),
      generation: Number(sessionRow?.ownership_generation ?? 0),
      revision: Number(sessionRow?.revision ?? 0),
      plan_encoded_sha256: derivedDigest,
      authority,
      lifecycle_present: false,
    };
  };
}
