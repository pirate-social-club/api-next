import { describe, expect, test } from "bun:test";
import { decodeHnsRootImportNameProofResultV1 } from "@pirate/application/namespace-ownership";
import type { HnsControlObserverHsdPrivateCapability } from "@pirate/platform-cf/namespace-ownership-hns-control-observer-hsd-private-transport";
import { HnsNameProofRuntimeError, makeHnsNameProofRuntime } from "./name-proof.ts";

const signature = btoa("\u0001".repeat(64));
const message = '["pirate-hns-root-import-name-proof-v1","fixture"]';

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
