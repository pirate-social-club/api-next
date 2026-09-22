import { describe, expect, test } from "bun:test";
import {
  decodeHnsRootImportNameProofResultV1,
  hnsRootImportNameProofMessage,
} from "@pirate/application/namespace-ownership";
import type { HnsControlObserverHsdPrivateCapability } from "@pirate/platform-cf/namespace-ownership-hns-control-observer-hsd-private-transport";
import { HnsNameProofRuntimeError, makeHnsNameProofRuntime } from "./name-proof.ts";

const signature = btoa("\u0001".repeat(64));
const proofInput = {
  actor_id: "actor-1",
  creation_intent_id: "intent-1",
  ceremony_intent_id: "ceremony-1",
  root_import_session_id: "root-import-1",
  namespace_session_id: "namespace-1",
  root_label: "dankmemes",
  challenge_txt_value: "pirate-verification=namespace-1",
  environment: "staging",
  expires_at: "2026-09-23T00:00:00.000Z",
};
const message = hnsRootImportNameProofMessage(proofInput);

function capability(
  responseBody: string,
  captured: string[],
): HnsControlObserverHsdPrivateCapability {
  return {
    exchange: async (request) => {
      captured.push(new TextDecoder().decode(request.body));
      return new Response(responseBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

describe("HNS name-proof verifier runtime", () => {
  test("refuses cross-chain, wrong-session and unconfigured proofs before any HSD call", async () => {
    const chain = { network: "regtest", genesis_block_hash: "a".repeat(64) } as const;
    const requests: string[] = [];
    const transport = capability('{"result":true,"error":null,"id":null}', requests);
    const runtime = makeHnsNameProofRuntime({
      capability: transport,
      chain,
      environment: "staging",
    });
    const valid = hnsRootImportNameProofMessage({ ...proofInput, chain });
    for (const rejected of [
      message,
      hnsRootImportNameProofMessage({ ...proofInput, chain: { ...chain, network: "main" } }),
      hnsRootImportNameProofMessage({
        ...proofInput,
        chain: { ...chain, genesis_block_hash: "b".repeat(64) },
      }),
      hnsRootImportNameProofMessage({ ...proofInput, chain, environment: "test" }),
      hnsRootImportNameProofMessage({ ...proofInput, chain, root_import_session_id: "other" }),
    ]) {
      await expect(
        runtime.verify(
          { ...proofInput, message: rejected, signature },
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(HnsNameProofRuntimeError);
    }
    await expect(
      makeHnsNameProofRuntime({ capability: transport }).verify(
        { ...proofInput, message: valid, signature },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(HnsNameProofRuntimeError);
    expect(requests).toHaveLength(0);
    await runtime.verify(
      { ...proofInput, message: valid, signature },
      new AbortController().signal,
    );
    expect(requests).toHaveLength(1);
  });
  test("calls HSD with the exact safe name-verification vector", async () => {
    const requests: string[] = [];
    const runtime = makeHnsNameProofRuntime({
      capability: capability('{"result":true,"error":null,"id":null}\n', requests),
    });
    const bytes = await runtime.verify(
      {
        root_import_session_id: "root-import-1",
        root_label: "dankmemes",
        message,
        signature,
      },
      new AbortController().signal,
    );

    expect(requests).toEqual([
      JSON.stringify({
        method: "verifymessagewithname",
        params: ["dankmemes", signature, message, true],
      }),
    ]);
    expect(decodeHnsRootImportNameProofResultV1(bytes)).toMatchObject({
      root_label: "dankmemes",
      safe: true,
      verified: true,
    });
    expect(new TextDecoder().decode(bytes)).not.toContain(signature);
  });

  test("retains a valid false result without upgrading it to proof", async () => {
    const runtime = makeHnsNameProofRuntime({
      capability: capability('{"result":false,"error":null,"id":null}', []),
    });
    const bytes = await runtime.verify(
      {
        root_import_session_id: "root-import-1",
        root_label: "dankmemes",
        message,
        signature,
      },
      new AbortController().signal,
    );
    expect(decodeHnsRootImportNameProofResultV1(bytes).verified).toBe(false);
  });

  test("rejects reordered or non-boolean HSD envelopes", async () => {
    for (const body of [
      '{"id":null,"error":null,"result":true}',
      '{"result":"true","error":null,"id":null}',
      '{"result":true,"error":null,"id":null}\n\n',
    ]) {
      const runtime = makeHnsNameProofRuntime({ capability: capability(body, []) });
      await expect(
        runtime.verify(
          {
            root_import_session_id: "root-import-1",
            root_label: "dankmemes",
            message,
            signature,
          },
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(HnsNameProofRuntimeError);
    }
  });
});
