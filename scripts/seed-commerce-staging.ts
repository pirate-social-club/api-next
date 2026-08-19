import { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";

import { makeDirectPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import { normalizePostgresConnectionString } from "./postgres-migrations.ts";

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

export type CommerceStagingSeedInput = Readonly<{
  readonly connectionString: string;
  readonly communityId: string;
  readonly actorId: string;
  readonly listingId: string;
  readonly membershipId: string;
  readonly policyVersion: number;
  readonly sourceRevision: string;
  readonly tokenContract: string;
  readonly treasuryAddress: string;
  readonly chainId: number;
  readonly tokenDecimals: number;
  readonly requiredConfirmations: number;
  readonly amountAtomic: string;
  readonly availableQuantity: number;
}>;

export type CommerceStagingSeedResult = Readonly<{
  readonly communityId: string;
  readonly actorId: string;
  readonly listingId: string;
  readonly membershipId: string;
  readonly policyVersion: number;
  readonly amountAtomic: string;
  readonly currentAvailableQuantity: number;
  readonly verificationRequired: false;
}>;

type UserRow = Readonly<{ readonly status: string }>;
type CommunityRow = Readonly<{
  readonly status: string;
  readonly created_by_user_id: string;
  readonly membership_mode: string;
}>;
type MembershipRow = Readonly<{
  readonly membership_id: string;
  readonly status: string;
}>;
type PolicyRow = Readonly<{
  readonly source_revision: string;
  readonly issued_by: string;
}>;
type ListingRow = Readonly<{
  readonly active: boolean;
  readonly policy_version: number;
  readonly availability_mode: string;
  readonly available_quantity: number | null;
}>;
type EligibilityRow = Readonly<{ readonly verification_required: boolean }>;
type PricingRow = Readonly<{ readonly amount_atomic: string }>;
type RouteRow = Readonly<{
  readonly chain_id: number;
  readonly token_contract: string;
  readonly token_decimals: number;
  readonly treasury_address: string;
  readonly required_confirmations: number;
}>;
type AllocationRow = Readonly<{ readonly allocation_mode: string }>;
type SettlementRow = Readonly<{ readonly settlement_mode: string }>;
type DonationRow = Readonly<{
  readonly policy_mode: string;
  readonly partner_id: string | null;
  readonly share_bps: number;
}>;

const requireOne = <A>(rows: readonly A[], message: string): A => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error(message);
  return rows[0];
};

const requireEqual = (actual: unknown, expected: unknown, message: string): void => {
  if (actual !== expected) throw new Error(message);
};

const validateInput = (input: CommerceStagingSeedInput): void => {
  if (!input.communityId.startsWith("staging-") || input.communityId.trim() === "staging-") {
    throw new Error("communityId must use a non-empty staging- prefix");
  }
  if (
    input.actorId.trim() === "" ||
    input.listingId.trim() === "" ||
    input.membershipId.trim() === ""
  ) {
    throw new Error("actorId, listingId, and membershipId are required");
  }
  if (!Number.isInteger(input.policyVersion) || input.policyVersion <= 0) {
    throw new Error("policyVersion must be a positive integer");
  }
  if (input.sourceRevision.trim() === "") throw new Error("sourceRevision is required");
  if (!ADDRESS_PATTERN.test(input.tokenContract) || !ADDRESS_PATTERN.test(input.treasuryAddress)) {
    throw new Error("tokenContract and treasuryAddress must be lowercase 20-byte hex addresses");
  }
  if (!Number.isInteger(input.chainId) || input.chainId <= 0)
    throw new Error("chainId must be positive");
  if (input.tokenDecimals !== 6) throw new Error("tokenDecimals must be 6 for the commerce route");
  if (!Number.isInteger(input.requiredConfirmations) || input.requiredConfirmations <= 0) {
    throw new Error("requiredConfirmations must be a positive integer");
  }
  if (!/^\d+$/.test(input.amountAtomic) || BigInt(input.amountAtomic) <= 0n) {
    throw new Error("amountAtomic must be a positive integer string");
  }
  if (!Number.isInteger(input.availableQuantity) || input.availableQuantity < 0) {
    throw new Error("availableQuantity must be a non-negative integer");
  }
};

export async function seedCommerceStaging(
  input: CommerceStagingSeedInput,
): Promise<CommerceStagingSeedResult> {
  validateInput(input);
  return await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            yield* transaction.execute({
              label: "commerce.seed.staging.user",
              text: `INSERT INTO users (user_id, status)
                      VALUES ($1, 'active')
                      ON CONFLICT (user_id) DO NOTHING`,
              values: [input.actorId],
              readonly: false,
            });
            const user = requireOne(
              (yield* transaction.execute<UserRow>({
                label: "commerce.seed.staging.user.verify",
                text: `SELECT status FROM users WHERE user_id = $1`,
                values: [input.actorId],
                readonly: true,
              })).rows,
              "Staging commerce actor was not created",
            );
            requireEqual(user.status, "active", "Staging commerce actor is not active");

            yield* transaction.execute({
              label: "commerce.seed.staging.community",
              text: `INSERT INTO communities (
                       community_id, display_name, status, created_by_user_id,
                       created_at, updated_at, membership_mode
                     ) VALUES ($1, 'Staging Community Purchase', 'active', $2,
                               clock_timestamp(), clock_timestamp(), 'gated')
                     ON CONFLICT (community_id) DO NOTHING`,
              values: [input.communityId, input.actorId],
              readonly: false,
            });
            const community = requireOne(
              (yield* transaction.execute<CommunityRow>({
                label: "commerce.seed.staging.community.verify",
                text: `SELECT status, created_by_user_id, membership_mode
                            FROM communities
                           WHERE community_id = $1`,
                values: [input.communityId],
                readonly: true,
              })).rows,
              "Staging commerce community was not created",
            );
            requireEqual(community.status, "active", "Staging commerce community is not active");
            requireEqual(
              community.created_by_user_id,
              input.actorId,
              "Staging commerce community has a different creator",
            );
            requireEqual(
              community.membership_mode,
              "gated",
              "Staging commerce community is not gated",
            );

            yield* transaction.execute({
              label: "commerce.seed.staging.membership",
              text: `INSERT INTO community_memberships (
                       community_id, membership_id, user_id, status,
                       joined_at, created_at, updated_at
                     ) VALUES ($1, $2, $3, 'member', clock_timestamp(),
                               clock_timestamp(), clock_timestamp())
                     ON CONFLICT DO NOTHING`,
              values: [input.communityId, input.membershipId, input.actorId],
              readonly: false,
            });
            const membership = requireOne(
              (yield* transaction.execute<MembershipRow>({
                label: "commerce.seed.staging.membership.verify",
                text: `SELECT membership_id, status
                            FROM community_memberships
                           WHERE community_id = $1 AND user_id = $2`,
                values: [input.communityId, input.actorId],
                readonly: true,
              })).rows,
              "Staging commerce membership was not created",
            );
            requireEqual(
              membership.membership_id,
              input.membershipId,
              "Staging membership identity differs",
            );
            requireEqual(membership.status, "member", "Staging commerce actor is not a member");

            yield* transaction.execute({
              label: "commerce.seed.staging.policy",
              text: `INSERT INTO community_commerce_policy_revisions (
                       community_id, policy_version, source_revision, issued_by
                     ) VALUES ($1, $2, $3, $4)
                     ON CONFLICT (community_id, policy_version) DO NOTHING`,
              values: [input.communityId, input.policyVersion, input.sourceRevision, input.actorId],
              readonly: false,
            });
            const policy = requireOne(
              (yield* transaction.execute<PolicyRow>({
                label: "commerce.seed.staging.policy.verify",
                text: `SELECT source_revision, issued_by
                            FROM community_commerce_policy_revisions
                           WHERE community_id = $1 AND policy_version = $2`,
                values: [input.communityId, input.policyVersion],
                readonly: true,
              })).rows,
              "Staging commerce policy was not created",
            );
            requireEqual(
              policy.source_revision,
              input.sourceRevision,
              "Staging commerce policy revision differs",
            );
            requireEqual(policy.issued_by, input.actorId, "Staging commerce policy issuer differs");

            yield* transaction.execute({
              label: "commerce.seed.staging.listing",
              text: `INSERT INTO community_commerce_listings (
                       listing_id, community_id, policy_version, active,
                       availability_mode, available_quantity
                     ) VALUES ($1, $2, $3, TRUE, 'finite', $4)
                     ON CONFLICT (listing_id) DO NOTHING`,
              values: [
                input.listingId,
                input.communityId,
                input.policyVersion,
                input.availableQuantity,
              ],
              readonly: false,
            });
            const listing = requireOne(
              (yield* transaction.execute<ListingRow>({
                label: "commerce.seed.staging.listing.verify",
                text: `SELECT active, policy_version::int AS policy_version,
                               availability_mode, available_quantity
                            FROM community_commerce_listings
                           WHERE listing_id = $1 AND community_id = $2`,
                values: [input.listingId, input.communityId],
                readonly: true,
              })).rows,
              "Staging commerce listing was not created",
            );
            requireEqual(listing.active, true, "Staging commerce listing is inactive");
            requireEqual(
              listing.policy_version,
              input.policyVersion,
              "Staging commerce listing policy differs",
            );
            requireEqual(
              listing.availability_mode,
              "finite",
              "Staging commerce listing is not finite",
            );
            const currentAvailableQuantity = listing.available_quantity;
            if (currentAvailableQuantity === null || currentAvailableQuantity < 0) {
              throw new Error("Staging commerce listing quantity is invalid");
            }

            yield* transaction.execute({
              label: "commerce.seed.staging.eligibility",
              text: `INSERT INTO community_commerce_eligibility_policy_versions (
                       community_id, policy_version, verification_required
                     ) VALUES ($1, $2, FALSE)
                     ON CONFLICT (community_id, policy_version) DO NOTHING`,
              values: [input.communityId, input.policyVersion],
              readonly: false,
            });
            const eligibility = requireOne(
              (yield* transaction.execute<EligibilityRow>({
                label: "commerce.seed.staging.eligibility.verify",
                text: `SELECT verification_required
                            FROM community_commerce_eligibility_policy_versions
                           WHERE community_id = $1 AND policy_version = $2`,
                values: [input.communityId, input.policyVersion],
                readonly: true,
              })).rows,
              "Staging commerce eligibility policy was not created",
            );
            requireEqual(
              eligibility.verification_required,
              false,
              "Staging fixture requires verification",
            );

            yield* transaction.execute({
              label: "commerce.seed.staging.pricing",
              text: `INSERT INTO community_commerce_pricing_policy_versions (
                       community_id, policy_version, amount_atomic
                     ) VALUES ($1, $2, $3)
                     ON CONFLICT (community_id, policy_version) DO NOTHING`,
              values: [input.communityId, input.policyVersion, input.amountAtomic],
              readonly: false,
            });
            const pricing = requireOne(
              (yield* transaction.execute<PricingRow>({
                label: "commerce.seed.staging.pricing.verify",
                text: `SELECT amount_atomic::text AS amount_atomic
                            FROM community_commerce_pricing_policy_versions
                           WHERE community_id = $1 AND policy_version = $2`,
                values: [input.communityId, input.policyVersion],
                readonly: true,
              })).rows,
              "Staging commerce pricing policy was not created",
            );
            requireEqual(
              pricing.amount_atomic,
              input.amountAtomic,
              "Staging commerce amount differs",
            );

            yield* transaction.execute({
              label: "commerce.seed.staging.route",
              text: `INSERT INTO community_commerce_money_route_policy_versions (
                       community_id, policy_version, chain_id, token_contract,
                       token_decimals, treasury_address, required_confirmations
                     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                     ON CONFLICT (community_id, policy_version) DO NOTHING`,
              values: [
                input.communityId,
                input.policyVersion,
                input.chainId,
                input.tokenContract,
                input.tokenDecimals,
                input.treasuryAddress,
                input.requiredConfirmations,
              ],
              readonly: false,
            });
            const route = requireOne(
              (yield* transaction.execute<RouteRow>({
                label: "commerce.seed.staging.route.verify",
                text: `SELECT chain_id::int AS chain_id, token_contract, token_decimals,
                                 treasury_address, required_confirmations
                            FROM community_commerce_money_route_policy_versions
                           WHERE community_id = $1 AND policy_version = $2`,
                values: [input.communityId, input.policyVersion],
                readonly: true,
              })).rows,
              "Staging commerce route policy was not created",
            );
            requireEqual(route.chain_id, input.chainId, "Staging commerce chain differs");
            requireEqual(
              route.token_contract,
              input.tokenContract,
              "Staging commerce token differs",
            );
            requireEqual(
              route.token_decimals,
              input.tokenDecimals,
              "Staging commerce token decimals differ",
            );
            requireEqual(
              route.treasury_address,
              input.treasuryAddress,
              "Staging commerce treasury differs",
            );
            requireEqual(
              route.required_confirmations,
              input.requiredConfirmations,
              "Staging commerce confirmation policy differs",
            );

            yield* transaction.execute({
              label: "commerce.seed.staging.allocation",
              text: `INSERT INTO community_commerce_allocation_policy_versions (
                       community_id, policy_version, allocation_mode
                     ) VALUES ($1, $2, 'single_unit')
                     ON CONFLICT (community_id, policy_version) DO NOTHING`,
              values: [input.communityId, input.policyVersion],
              readonly: false,
            });
            const allocation = requireOne(
              (yield* transaction.execute<AllocationRow>({
                label: "commerce.seed.staging.allocation.verify",
                text: `SELECT allocation_mode
                            FROM community_commerce_allocation_policy_versions
                           WHERE community_id = $1 AND policy_version = $2`,
                values: [input.communityId, input.policyVersion],
                readonly: true,
              })).rows,
              "Staging commerce allocation policy was not created",
            );
            requireEqual(
              allocation.allocation_mode,
              "single_unit",
              "Staging allocation mode differs",
            );

            yield* transaction.execute({
              label: "commerce.seed.staging.settlement",
              text: `INSERT INTO community_commerce_settlement_policy_versions (
                       community_id, policy_version, settlement_mode
                     ) VALUES ($1, $2, 'delivery_only_story_settlement')
                     ON CONFLICT (community_id, policy_version) DO NOTHING`,
              values: [input.communityId, input.policyVersion],
              readonly: false,
            });
            const settlement = requireOne(
              (yield* transaction.execute<SettlementRow>({
                label: "commerce.seed.staging.settlement.verify",
                text: `SELECT settlement_mode
                            FROM community_commerce_settlement_policy_versions
                           WHERE community_id = $1 AND policy_version = $2`,
                values: [input.communityId, input.policyVersion],
                readonly: true,
              })).rows,
              "Staging commerce settlement policy was not created",
            );
            requireEqual(
              settlement.settlement_mode,
              "delivery_only_story_settlement",
              "Staging settlement mode differs",
            );

            yield* transaction.execute({
              label: "commerce.seed.staging.donation",
              text: `INSERT INTO community_commerce_donation_policy_versions (
                       community_id, policy_version, policy_mode, partner_id, share_bps
                     ) VALUES ($1, $2, 'none', NULL, 0)
                     ON CONFLICT (community_id, policy_version) DO NOTHING`,
              values: [input.communityId, input.policyVersion],
              readonly: false,
            });
            const donation = requireOne(
              (yield* transaction.execute<DonationRow>({
                label: "commerce.seed.staging.donation.verify",
                text: `SELECT policy_mode, partner_id, share_bps
                            FROM community_commerce_donation_policy_versions
                           WHERE community_id = $1 AND policy_version = $2`,
                values: [input.communityId, input.policyVersion],
                readonly: true,
              })).rows,
              "Staging commerce donation policy was not created",
            );
            requireEqual(donation.policy_mode, "none", "Staging donation mode differs");
            requireEqual(donation.partner_id, null, "Staging donation partner differs");
            requireEqual(donation.share_bps, 0, "Staging donation share differs");

            return {
              communityId: input.communityId,
              actorId: input.actorId,
              listingId: input.listingId,
              membershipId: membership.membership_id,
              policyVersion: input.policyVersion,
              amountAtomic: pricing.amount_atomic,
              currentAvailableQuantity,
              verificationRequired: false,
            };
          }),
        );
      }).pipe(
        Effect.provide(
          makeDirectPostgresControlPlaneLayer(
            normalizePostgresConnectionString(input.connectionString),
          ),
        ),
      ),
    ),
  );
}

const parsePositiveInteger = (
  value: string | undefined,
  name: string,
  fallback?: number,
): number => {
  const resolved = value ?? (fallback === undefined ? undefined : String(fallback));
  if (resolved === undefined || !/^\d+$/.test(resolved))
    throw new Error(`${name} must be a positive integer`);
  const parsed = Number(resolved);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
};

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  if (!args.includes("--apply") || args.some((argument) => argument !== "--apply")) {
    throw new Error("Refusing to seed without --apply; no other arguments are accepted");
  }
  const connectionString = process.env.CONTROL_PLANE_POSTGRES_MIGRATOR_URL?.trim();
  if (!connectionString) throw new Error("CONTROL_PLANE_POSTGRES_MIGRATOR_URL is required");
  const tokenContract = process.env.STAGING_COMMERCE_TOKEN_CONTRACT?.trim();
  const treasuryAddress = process.env.STAGING_COMMERCE_TREASURY_ADDRESS?.trim();
  if (tokenContract === undefined || treasuryAddress === undefined) {
    throw new Error(
      "STAGING_COMMERCE_TOKEN_CONTRACT and STAGING_COMMERCE_TREASURY_ADDRESS are required",
    );
  }
  const result = await seedCommerceStaging({
    connectionString,
    communityId: process.env.STAGING_COMMERCE_COMMUNITY_ID?.trim() ?? "staging-community-purchase",
    // The actor is the raw session subject (for example `did:privy:…`), never
    // the `usr_`-prefixed public id returned by `/users/me`.
    actorId: process.env.STAGING_COMMERCE_ACTOR_ID?.trim() ?? "staging-commerce-actor",
    listingId: process.env.STAGING_COMMERCE_LISTING_ID?.trim() ?? "staging-listing-1",
    membershipId:
      process.env.STAGING_COMMERCE_MEMBERSHIP_ID?.trim() ?? "staging-commerce-membership",
    policyVersion: parsePositiveInteger(
      process.env.STAGING_COMMERCE_POLICY_VERSION,
      "policyVersion",
      1,
    ),
    sourceRevision: process.env.STAGING_COMMERCE_SOURCE_REVISION?.trim() ?? "staging-commerce-v1",
    tokenContract,
    treasuryAddress,
    chainId: parsePositiveInteger(process.env.STAGING_COMMERCE_CHAIN_ID, "chainId", 8453),
    tokenDecimals: 6,
    requiredConfirmations: parsePositiveInteger(
      process.env.STAGING_COMMERCE_REQUIRED_CONFIRMATIONS,
      "requiredConfirmations",
      3,
    ),
    amountAtomic: process.env.STAGING_COMMERCE_AMOUNT_ATOMIC?.trim() ?? "12500000",
    availableQuantity: parsePositiveInteger(
      process.env.STAGING_COMMERCE_AVAILABLE_QUANTITY,
      "availableQuantity",
      100,
    ),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Commerce staging seed failed");
    process.exitCode = 1;
  });
}
