/**
 * Registers the owner's Safe as the production Megapot custody for the Safe pool
 * pilot. It verifies the Megapot deployment and the Safe on Base and prints what it
 * found; only with --apply does it record, in one transaction, the settlement asset,
 * the deployment attestation and the Safe's owner-executed nonce authority. It never
 * signs or sends. Production writes still need the reward run lease.
 *
 *   API_NEXT_ENV=production SAFE_POOL_RPC_URL=... SAFE_POOL_SAFE_ADDRESS=0x...
 *   SAFE_POOL_REFERRER_ADDRESS=0x... SAFE_POOL_SOURCE_TAG=0x...
 *   MEGAPOT_REQUIRED_CONFIRMATIONS=... \
 *     bun scripts/register-safe-pool-custody.ts [--apply]   (--apply also needs
 *     CONTROL_PLANE_POSTGRES_ADMIN_URL)
 */
import { readFile } from "node:fs/promises";
import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Effect, type Layer, Schema } from "effect";
import { createPublicClient, getAddress, http, parseAbi } from "viem";
import { base } from "viem/chains";
import { makeMegapotV2RpcClient } from "../packages/platform-cf/src/megapot-v2-rpc.ts";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import { normalizePostgresConnectionString } from "./postgres-migrations.ts";

const Address = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{40}$/u));
const Hash = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/u));

const SafeCustodyManifest = Schema.Struct({
  domain: Schema.Literal("pirate.megapot-safe-custody-bootstrap.v1"),
  attestation_id: Schema.Literal("megapot-base-v2-safe-pilot"),
  environment: Schema.Literal("production"),
  chain_id: Schema.Literal(8_453),
  jackpot_address: Address,
  usdc_address: Address,
  ticket_nft_address: Address,
  jackpot_code_hash: Hash,
  usdc_code_hash: Hash,
  ticket_nft_code_hash: Hash,
  safe_singleton_address: Address,
  safe_version: Schema.Literal("1.4.1"),
  abi_version: Schema.Literal("megapot_v2"),
});

type SafeCustodyManifest = Schema.Schema.Type<typeof SafeCustodyManifest>;

/** The Safe reads registration needs, at one anchored block. */
export type SafeCustodyReader = Readonly<{
  readSingleton: (safe: string, blockNumber: bigint) => Promise<string>;
  readVersion: (safe: string, blockNumber: bigint) => Promise<string>;
  readOwners: (safe: string, blockNumber: bigint) => Promise<readonly string[]>;
  readThreshold: (safe: string, blockNumber: bigint) => Promise<bigint>;
  readNonce: (safe: string, blockNumber: bigint) => Promise<bigint>;
}>;

export type SafeCustodyPlan = Readonly<{
  manifest: SafeCustodyManifest;
  safeAddress: string;
  referrerAddress: string;
  sourceTag: string;
  owners: readonly string[];
  threshold: string;
  safeNonce: bigint;
  anchorBlockNumber: bigint;
  anchorBlockHash: string;
  verifiedAt: string;
}>;

const manifestUrl = new URL("../infra/megapot/base-v2-safe-pilot.json", import.meta.url);

async function loadManifest(): Promise<SafeCustodyManifest> {
  const value: unknown = JSON.parse(await readFile(manifestUrl, "utf8"));
  return Schema.decodeUnknownSync(SafeCustodyManifest, { onExcessProperty: "error" })(value);
}

function lowerAddress(value: string, name: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(value)) throw new Error(`${name} must be an address`);
  return value.toLowerCase();
}

const safeAbi = parseAbi([
  "function VERSION() view returns (string)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
]);

function makeBaseSafeReader(rpcUrl: string): SafeCustodyReader {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const read = <A>(safe: string, blockNumber: bigint, functionName: string) =>
    client.readContract({
      address: getAddress(safe),
      abi: safeAbi,
      functionName: functionName as "VERSION",
      blockNumber,
    }) as Promise<A>;
  return {
    // A Safe proxy keeps its singleton in storage slot 0.
    readSingleton: async (safe, blockNumber) => {
      const slot = await client.getStorageAt({
        address: getAddress(safe),
        slot: "0x0",
        blockNumber,
      });
      if (slot === undefined) throw new Error("Safe singleton slot is unreadable");
      return `0x${slot.slice(-40)}`.toLowerCase();
    },
    readVersion: (safe, blockNumber) => read<string>(safe, blockNumber, "VERSION"),
    readOwners: async (safe, blockNumber) =>
      (await read<readonly string[]>(safe, blockNumber, "getOwners")).map((owner) =>
        owner.toLowerCase(),
      ),
    readThreshold: (safe, blockNumber) => read<bigint>(safe, blockNumber, "getThreshold"),
    readNonce: (safe, blockNumber) => read<bigint>(safe, blockNumber, "nonce"),
  };
}

/** Verify the deployment and the Safe at one confirmed block; nothing is written. */
export async function inspectSafePoolCustody(input: {
  readonly manifest: SafeCustodyManifest;
  readonly rpc: Pick<
    ReturnType<typeof makeMegapotV2RpcClient>,
    "attestDeployment" | "readHead" | "readBlock"
  >;
  readonly safe: SafeCustodyReader;
  readonly safeAddress: string;
  readonly referrerAddress: string;
  readonly sourceTag: string;
  readonly requiredConfirmations: number;
}): Promise<SafeCustodyPlan> {
  const { manifest } = input;
  const safeAddress = lowerAddress(input.safeAddress, "SAFE_POOL_SAFE_ADDRESS");
  const referrerAddress = lowerAddress(input.referrerAddress, "SAFE_POOL_REFERRER_ADDRESS");
  if (safeAddress === referrerAddress) {
    throw new Error("The Safe custody and the referrer must be distinct");
  }
  if (!/^0x[0-9a-f]{64}$/u.test(input.sourceTag)) {
    throw new Error("SAFE_POOL_SOURCE_TAG must be a lowercase 32-byte hex value");
  }
  if (!Number.isSafeInteger(input.requiredConfirmations) || input.requiredConfirmations < 1) {
    throw new Error("MEGAPOT_REQUIRED_CONFIRMATIONS must be a positive integer");
  }
  await input.rpc.attestDeployment();
  const head = await input.rpc.readHead();
  const confirmations = BigInt(input.requiredConfirmations);
  if (head.blockNumber < confirmations) throw new Error("Base head is too young");
  const anchor = await input.rpc.readBlock(head.blockNumber - confirmations);
  if (anchor.blockTimestamp === undefined) throw new Error("Base anchor has no timestamp");
  const [singleton, version, owners, threshold, safeNonce] = await Promise.all([
    input.safe.readSingleton(safeAddress, anchor.blockNumber),
    input.safe.readVersion(safeAddress, anchor.blockNumber),
    input.safe.readOwners(safeAddress, anchor.blockNumber),
    input.safe.readThreshold(safeAddress, anchor.blockNumber),
    input.safe.readNonce(safeAddress, anchor.blockNumber),
  ]);
  if (singleton !== manifest.safe_singleton_address || version !== manifest.safe_version) {
    throw new Error("The custody address is not a Safe 1.4.1 proxy on the pinned singleton");
  }
  if (owners.length === 0 || threshold < 1n || threshold > BigInt(owners.length)) {
    throw new Error("The Safe has no valid owner threshold");
  }
  return {
    manifest,
    safeAddress,
    referrerAddress,
    sourceTag: input.sourceTag,
    owners,
    threshold: threshold.toString(),
    safeNonce,
    anchorBlockNumber: anchor.blockNumber,
    anchorBlockHash: anchor.blockHash,
    verifiedAt: new Date(Number(anchor.blockTimestamp * 1_000n)).toISOString(),
  };
}

/**
 * Record the asset, attestation and Safe nonce authority. A replay of the same plan
 * changes nothing; any row that already exists with different values is refused.
 */
export async function persistSafePoolCustody(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  plan: SafeCustodyPlan,
): Promise<void> {
  const { manifest } = plan;
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const check = (
            label: string,
            text: string,
            values: readonly unknown[],
            refusal: string,
          ) =>
            transaction
              .execute({ label, text, values: [...values], readonly: true })
              .pipe(
                Effect.flatMap((result) =>
                  result.rows.length === 1 ? Effect.void : Effect.fail(new Error(refusal)),
                ),
              );
          yield* transaction.execute({
            label: "safe-pool-custody.asset",
            text: `INSERT INTO reward_asset_whitelist (
                     chain_id, token_address, decimals, symbol, asset_kind, environment,
                     status, policy_version, activated_at, plain_erc20_verified_at
                   ) VALUES ($1,$2,6,'USDC','settlement_usdc','production','active',
                             'megapot-settlement-usdc-v1',$3::timestamptz,$3::timestamptz)
                   ON CONFLICT (chain_id, token_address) DO NOTHING`,
            values: [manifest.chain_id, manifest.usdc_address, plan.verifiedAt],
            readonly: false,
          });
          yield* check(
            "safe-pool-custody.asset.verify",
            `SELECT 1 FROM reward_asset_whitelist
              WHERE chain_id=$1 AND token_address=$2 AND decimals=6 AND symbol='USDC'
                AND asset_kind='settlement_usdc' AND environment='production'
                AND status='active'`,
            [manifest.chain_id, manifest.usdc_address],
            "The production USDC asset row does not match",
          );
          yield* transaction.execute({
            label: "safe-pool-custody.attestation",
            text: `INSERT INTO megapot_deployment_attestations (
                     attestation_id, environment, chain_id, jackpot_address, usdc_address,
                     ticket_nft_address, custody_address, referrer_address, source_tag,
                     jackpot_code_hash, usdc_code_hash, ticket_nft_code_hash,
                     attestation_block_number, attestation_block_hash, abi_version, status,
                     verified_at
                   ) VALUES ($1,'production',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                             'megapot_v2','active',$14::timestamptz)
                   ON CONFLICT (attestation_id) DO NOTHING`,
            values: [
              manifest.attestation_id,
              manifest.chain_id,
              manifest.jackpot_address,
              manifest.usdc_address,
              manifest.ticket_nft_address,
              plan.safeAddress,
              plan.referrerAddress,
              plan.sourceTag,
              manifest.jackpot_code_hash,
              manifest.usdc_code_hash,
              manifest.ticket_nft_code_hash,
              plan.anchorBlockNumber.toString(),
              plan.anchorBlockHash,
              plan.verifiedAt,
            ],
            readonly: false,
          });
          yield* check(
            "safe-pool-custody.attestation.verify",
            `SELECT 1 FROM megapot_deployment_attestations
              WHERE attestation_id=$1 AND environment='production' AND chain_id=$2
                AND jackpot_address=$3 AND usdc_address=$4 AND ticket_nft_address=$5
                AND custody_address=$6 AND referrer_address=$7 AND source_tag=$8
                AND jackpot_code_hash=$9 AND usdc_code_hash=$10
                AND ticket_nft_code_hash=$11 AND status='active'`,
            [
              manifest.attestation_id,
              manifest.chain_id,
              manifest.jackpot_address,
              manifest.usdc_address,
              manifest.ticket_nft_address,
              plan.safeAddress,
              plan.referrerAddress,
              plan.sourceTag,
              manifest.jackpot_code_hash,
              manifest.usdc_code_hash,
              manifest.ticket_nft_code_hash,
            ],
            "The production attestation does not match this Safe and deployment",
          );
          yield* transaction.execute({
            label: "safe-pool-custody.nonce-authority",
            text: `INSERT INTO reward_signer_nonces (
                     chain_id, signer_address, next_nonce, observed_pending_nonce,
                     observed_block_number, observed_block_hash, observed_at, nonce_authority
                   ) VALUES ($1,$2,$3,$3,$4,$5,$6::timestamptz,'safe_owner_v1')
                   ON CONFLICT (chain_id, signer_address) DO NOTHING`,
            values: [
              manifest.chain_id,
              plan.safeAddress,
              plan.safeNonce.toString(),
              plan.anchorBlockNumber.toString(),
              plan.anchorBlockHash,
              plan.verifiedAt,
            ],
            readonly: false,
          });
          yield* check(
            "safe-pool-custody.nonce-authority.verify",
            `SELECT 1 FROM reward_signer_nonces
              WHERE chain_id=$1 AND signer_address=$2 AND nonce_authority='safe_owner_v1'`,
            [manifest.chain_id, plan.safeAddress],
            "The Safe is already registered with another nonce authority",
          );
        }),
      );
    }).pipe(Effect.provide(layer)),
  );
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.some((argument) => argument !== "--apply")) throw new Error("usage: [--apply]");
    if (process.env.API_NEXT_ENV !== "production") {
      throw new Error("Safe pool custody is registered only with API_NEXT_ENV=production");
    }
    const rpcUrl = new URL(required("SAFE_POOL_RPC_URL"));
    if (rpcUrl.protocol !== "https:" || rpcUrl.username || rpcUrl.password) {
      throw new Error("SAFE_POOL_RPC_URL must be a credential-free HTTPS URL");
    }
    const manifest = await loadManifest();
    const safeAddress = lowerAddress(required("SAFE_POOL_SAFE_ADDRESS"), "SAFE_POOL_SAFE_ADDRESS");
    const referrerAddress = lowerAddress(
      required("SAFE_POOL_REFERRER_ADDRESS"),
      "SAFE_POOL_REFERRER_ADDRESS",
    );
    const plan = await inspectSafePoolCustody({
      manifest,
      rpc: makeMegapotV2RpcClient({
        rpcUrl: rpcUrl.toString(),
        attestation: {
          attestationId: manifest.attestation_id,
          environment: manifest.environment,
          chainId: manifest.chain_id,
          jackpotAddress: manifest.jackpot_address,
          usdcAddress: manifest.usdc_address,
          ticketNftAddress: manifest.ticket_nft_address,
          custodyAddress: safeAddress,
          referrerAddress,
          jackpotCodeHash: manifest.jackpot_code_hash,
          usdcCodeHash: manifest.usdc_code_hash,
          ticketNftCodeHash: manifest.ticket_nft_code_hash,
        },
      }),
      safe: makeBaseSafeReader(rpcUrl.toString()),
      safeAddress,
      referrerAddress,
      sourceTag: required("SAFE_POOL_SOURCE_TAG"),
      requiredConfirmations: Number(required("MEGAPOT_REQUIRED_CONFIRMATIONS")),
    });
    const summary = {
      attestationId: manifest.attestation_id,
      safeAddress: plan.safeAddress,
      owners: plan.owners,
      threshold: plan.threshold,
      safeNonce: plan.safeNonce.toString(),
      referrerAddress: plan.referrerAddress,
      anchorBlockNumber: plan.anchorBlockNumber.toString(),
      anchorBlockHash: plan.anchorBlockHash,
    };
    if (!args.includes("--apply")) {
      console.log(JSON.stringify({ action: "dry-run", ...summary }, null, 2));
    } else {
      await persistSafePoolCustody(
        makeDirectPostgresControlPlaneLayer(
          normalizePostgresConnectionString(required("CONTROL_PLANE_POSTGRES_ADMIN_URL")),
        ),
        plan,
      );
      console.log(JSON.stringify({ action: "applied", ...summary }, null, 2));
    }
  } catch (error) {
    // Driver causes can include connection details; only our own messages are printed.
    console.error(
      error instanceof Error && !error.message.includes("://")
        ? error.message
        : "safe_pool_custody_registration_failed",
    );
    process.exitCode = 1;
  }
}
