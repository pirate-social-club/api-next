/** Child-process LOCAL restart probe. It has no signing key or operational issuer. */
import { RewardSafeSettlementFailedV1 } from "@pirate/application/rewards/safe-settlement-v1";
import { Effect } from "effect";
import { makeMegapotLocalForkRpcClient } from "./megapot-local-fork.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneRewardRunAuthority } from "./reward-operations-control.ts";
import { makeLocalRewardSafeCoordinatorV1 } from "./reward-safe-coordinator-v1.ts";
import { makeControlPlaneRewardSafeStoreV1 } from "./reward-safe-repository-v1.ts";

if (import.meta.main) {
  try {
    const request = await Bun.stdin.json();
    const url = new URL(request.database);
    if (
      url.hostname !== "127.0.0.1" ||
      url.port !== "54387" ||
      url.pathname !== "/rewards_source_test" ||
      !/^rewards_lifecycle_[a-f0-9]+$/.test(
        url.searchParams.get("options")?.split("search_path=")[1] ?? "",
      )
    )
      throw new Error("local_database_required");
    const layer = makeDirectPostgresControlPlaneLayer(url.href);
    const refusal = () =>
      Effect.fail(new RewardSafeSettlementFailedV1({ reason: "production-disabled" }));
    let loseAck = request.loseAck === true;
    const coordinator = makeLocalRewardSafeCoordinatorV1({
      rpc: await makeMegapotLocalForkRpcClient({
        rpcUrl: "http://127.0.0.1:8549/",
        attestation: request.deployment,
        fetcher: async (target, init) => {
          const response = await fetch(target, init);
          if (loseAck && JSON.parse(String(init?.body)).method === "eth_sendRawTransaction") {
            loseAck = false;
            await response.arrayBuffer();
            throw new Error("injected_local_ack_loss");
          }
          return response;
        },
      }),
      store: makeControlPlaneRewardSafeStoreV1(layer),
      authority: makeControlPlaneRewardRunAuthority(layer),
      issuer: { authorize: refusal },
      signer: { sign: refusal, lookup: () => Effect.succeed(request.lookup ?? null) },
      localGasLimit: 500000n,
    });
    const result = await Effect.runPromise(coordinator.reconcile(request.creditId));
    process.stdout.write(
      JSON.stringify({
        state: result.state,
        transactionHash: result.signed?.transactionHash ?? null,
      }),
    );
  } catch (error) {
    const reason = error instanceof RewardSafeSettlementFailedV1 ? error.reason : "unclassified";
    process.stderr.write(
      `local_restart_reconciliation_failed:${reason}:${error instanceof RewardSafeSettlementFailedV1 ? (error.stage ?? "unspecified") : "unclassified"}\n`,
    );
    process.exitCode = 1;
  }
}
