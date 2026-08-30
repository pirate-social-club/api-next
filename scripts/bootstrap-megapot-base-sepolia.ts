import { readFile } from "node:fs/promises";
import { ControlPlaneDb } from "@pirate/application";
import { Effect, Schema } from "effect";
import { makeMegapotV2RpcClient } from "../packages/platform-cf/src/megapot-v2-rpc.ts";
import { deriveBaseSepoliaMegapotAddress } from "../packages/platform-cf/src/megapot-v2-signer.ts";
import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import { normalizePostgresConnectionString } from "./postgres-migrations.ts";

const Address = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{40}$/u));
const Hash = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/u));

const BootstrapManifest = Schema.Struct({
  domain: Schema.Literal("pirate.megapot-deployment-bootstrap.v1"),
  attestation_id: Schema.Literal("megapot-base-sepolia-v2"),
  environment: Schema.Literal("staging"),
  chain_id: Schema.Literal(84_532),
  jackpot_address: Address,
  usdc_address: Address,
  ticket_nft_address: Address,
  source_tag: Hash,
  jackpot_code_hash: Hash,
  usdc_code_hash: Hash,
  ticket_nft_code_hash: Hash,
  abi_version: Schema.Literal("megapot_v2"),
});

export type MegapotBaseSepoliaBootstrapManifest = Schema.Schema.Type<typeof BootstrapManifest>;

type AuthorityRow = Readonly<{
  readonly attestation_id: string;
  readonly custody_address: string;
  readonly referrer_address: string;
  readonly attestation_block_number: string;
  readonly attestation_block_hash: string;
  readonly verified_at: string;
}>;

export type MegapotBaseSepoliaBootstrapPlan = Readonly<{
  manifest: MegapotBaseSepoliaBootstrapManifest;
  custodyAddress: string;
  referrerAddress: string;
  anchorBlockNumber: bigint;
  anchorBlockHash: string;
  verifiedAt: string;
}>;

const defaultManifestUrl = new URL("../infra/megapot/base-sepolia-v2.json", import.meta.url);

export async function loadMegapotBaseSepoliaBootstrapManifest(
  url: URL = defaultManifestUrl,
): Promise<MegapotBaseSepoliaBootstrapManifest> {
  const value: unknown = JSON.parse(await readFile(url, "utf8"));
  return Schema.decodeUnknownSync(BootstrapManifest, { onExcessProperty: "error" })(value);
}

function httpsRpcUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("MEGAPOT_V2_RPC_URL must be a credential-safe HTTPS URL");
  }
  return url.toString();
}

export async function inspectMegapotBaseSepoliaAuthority(input: {
  readonly rpcUrl: string;
  readonly custodyPrivateKey: string;
  readonly referrerPrivateKey: string;
  readonly manifest: MegapotBaseSepoliaBootstrapManifest;
  readonly requiredConfirmations: number;
}): Promise<MegapotBaseSepoliaBootstrapPlan> {
  if (!Number.isSafeInteger(input.requiredConfirmations) || input.requiredConfirmations < 1) {
    throw new Error("MEGAPOT_REQUIRED_CONFIRMATIONS must be a positive integer");
  }
  const custodyAddress = deriveBaseSepoliaMegapotAddress(input.custodyPrivateKey);
  const referrerAddress = deriveBaseSepoliaMegapotAddress(input.referrerPrivateKey);
  if (custodyAddress === referrerAddress) {
    throw new Error("Megapot custody and referral identities must be distinct");
  }
  const manifest = input.manifest;
  const rpc = makeMegapotV2RpcClient({
    rpcUrl: httpsRpcUrl(input.rpcUrl),
    attestation: {
      environment: manifest.environment,
      chainId: manifest.chain_id,
      jackpotAddress: manifest.jackpot_address,
      usdcAddress: manifest.usdc_address,
      ticketNftAddress: manifest.ticket_nft_address,
      custodyAddress,
      referrerAddress,
      jackpotCodeHash: manifest.jackpot_code_hash,
      usdcCodeHash: manifest.usdc_code_hash,
      ticketNftCodeHash: manifest.ticket_nft_code_hash,
      attestationId: manifest.attestation_id,
    },
  });
  await rpc.attestDeployment();
  const head = await rpc.readHead();
  const confirmations = BigInt(input.requiredConfirmations);
  if (head.blockNumber < confirmations) throw new Error("Base Sepolia head is too young");
  const anchor = await rpc.readBlock(head.blockNumber - confirmations);
  if (anchor.blockTimestamp === undefined) throw new Error("Base Sepolia anchor has no timestamp");
  const timestampMs = anchor.blockTimestamp * 1_000n;
  if (timestampMs > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Base Sepolia anchor timestamp is outside the supported range");
  }
  const verifiedAt = new Date(Number(timestampMs));
  if (!Number.isFinite(verifiedAt.getTime())) throw new Error("Base Sepolia anchor is invalid");
  return {
    manifest,
    custodyAddress,
    referrerAddress,
    anchorBlockNumber: anchor.blockNumber,
    anchorBlockHash: anchor.blockHash,
    verifiedAt: verifiedAt.toISOString(),
  };
}

function exactlyOne<A>(rows: readonly A[], message: string): A {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error(message);
  return rows[0];
}

export async function persistMegapotBaseSepoliaAuthority(
  connectionString: string,
  plan: MegapotBaseSepoliaBootstrapPlan,
): Promise<AuthorityRow> {
  const manifest = plan.manifest;
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            yield* transaction.execute({
              label: "megapot.base-sepolia.bootstrap.asset",
              text: `INSERT INTO reward_asset_whitelist (
                       chain_id, token_address, decimals, symbol, asset_kind,
                       environment, status, policy_version, activated_at,
                       plain_erc20_verified_at
                     ) VALUES ($1,$2,6,'USDC','settlement_usdc','staging','active',
                               'megapot-settlement-usdc-v1',$3::timestamptz,$3::timestamptz)
                     ON CONFLICT (chain_id, token_address) DO NOTHING`,
              values: [manifest.chain_id, manifest.usdc_address, plan.verifiedAt],
              readonly: false,
            });
            const asset = yield* transaction.execute({
              label: "megapot.base-sepolia.bootstrap.asset.verify",
              text: `SELECT chain_id
                       FROM reward_asset_whitelist
                      WHERE chain_id=$1 AND token_address=$2 AND decimals=6
                        AND symbol='USDC' AND asset_kind='settlement_usdc'
                        AND environment='staging' AND status='active'
                        AND policy_version='megapot-settlement-usdc-v1'`,
              values: [manifest.chain_id, manifest.usdc_address],
              readonly: true,
            });
            exactlyOne(asset.rows, "Active staging USDC authority does not match the manifest");

            yield* transaction.execute({
              label: "megapot.base-sepolia.bootstrap.attestation",
              text: `INSERT INTO megapot_deployment_attestations (
                       attestation_id, environment, chain_id, jackpot_address,
                       usdc_address, ticket_nft_address, custody_address,
                       referrer_address, source_tag, jackpot_code_hash,
                       usdc_code_hash, ticket_nft_code_hash,
                       attestation_block_number, attestation_block_hash,
                       abi_version, status, verified_at
                     ) VALUES ($1,'staging',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                               'megapot_v2','active',$14::timestamptz)
                     ON CONFLICT (attestation_id) DO NOTHING`,
              values: [
                manifest.attestation_id,
                manifest.chain_id,
                manifest.jackpot_address,
                manifest.usdc_address,
                manifest.ticket_nft_address,
                plan.custodyAddress,
                plan.referrerAddress,
                manifest.source_tag,
                manifest.jackpot_code_hash,
                manifest.usdc_code_hash,
                manifest.ticket_nft_code_hash,
                plan.anchorBlockNumber.toString(),
                plan.anchorBlockHash,
                plan.verifiedAt,
              ],
              readonly: false,
            });
            const result = yield* transaction.execute<AuthorityRow>({
              label: "megapot.base-sepolia.bootstrap.attestation.verify",
              text: `SELECT attestation_id, custody_address, referrer_address,
                            attestation_block_number::text AS attestation_block_number,
                            attestation_block_hash, verified_at::text AS verified_at
                       FROM megapot_deployment_attestations
                      WHERE attestation_id=$1 AND environment='staging' AND chain_id=$2
                        AND jackpot_address=$3 AND usdc_address=$4 AND ticket_nft_address=$5
                        AND custody_address=$6 AND referrer_address=$7 AND source_tag=$8
                        AND jackpot_code_hash=$9 AND usdc_code_hash=$10
                        AND ticket_nft_code_hash=$11 AND abi_version='megapot_v2'
                        AND status='active'`,
              values: [
                manifest.attestation_id,
                manifest.chain_id,
                manifest.jackpot_address,
                manifest.usdc_address,
                manifest.ticket_nft_address,
                plan.custodyAddress,
                plan.referrerAddress,
                manifest.source_tag,
                manifest.jackpot_code_hash,
                manifest.usdc_code_hash,
                manifest.ticket_nft_code_hash,
              ],
              readonly: true,
            });
            return exactlyOne(
              result.rows,
              "Active staging Megapot attestation does not match the verified deployment",
            );
          }),
        );
      }).pipe(
        Effect.provide(
          makeDirectPostgresControlPlaneLayer(normalizePostgresConnectionString(connectionString)),
        ),
      ),
    ),
  );
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const unknown = args.filter((argument) => argument !== "--apply");
  if (unknown.length > 0) throw new Error(`Unknown bootstrap option: ${unknown[0]}`);
  if (process.env.API_NEXT_ENV !== "staging") {
    throw new Error("The Base Sepolia bootstrap is refused unless API_NEXT_ENV=staging");
  }
  const confirmations = Number(
    required(process.env.MEGAPOT_REQUIRED_CONFIRMATIONS, "MEGAPOT_REQUIRED_CONFIRMATIONS"),
  );
  const plan = await inspectMegapotBaseSepoliaAuthority({
    rpcUrl: required(process.env.MEGAPOT_V2_RPC_URL, "MEGAPOT_V2_RPC_URL"),
    custodyPrivateKey: required(
      process.env.MEGAPOT_CUSTODY_PRIVATE_KEY,
      "MEGAPOT_CUSTODY_PRIVATE_KEY",
    ),
    referrerPrivateKey: required(
      process.env.MEGAPOT_REFERRER_PRIVATE_KEY,
      "MEGAPOT_REFERRER_PRIVATE_KEY",
    ),
    manifest: await loadMegapotBaseSepoliaBootstrapManifest(),
    requiredConfirmations: confirmations,
  });
  if (!args.includes("--apply")) {
    console.log(
      JSON.stringify(
        {
          action: "dry-run",
          attestationId: plan.manifest.attestation_id,
          custodyAddress: plan.custodyAddress,
          referrerAddress: plan.referrerAddress,
          anchorBlockNumber: plan.anchorBlockNumber.toString(),
          anchorBlockHash: plan.anchorBlockHash,
        },
        null,
        2,
      ),
    );
    console.log("Dry run: no database write performed. Pass --apply to persist authority.");
    return;
  }
  const row = await persistMegapotBaseSepoliaAuthority(
    required(process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL, "CONTROL_PLANE_POSTGRES_ADMIN_URL"),
    plan,
  );
  console.log(JSON.stringify({ action: "applied", ...row }, null, 2));
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Base Sepolia bootstrap failed");
    process.exitCode = 1;
  });
}
