import { describe, expect, test } from "bun:test";
import type { CommunityHandleOfferingDiscoveryV1 } from "@pirate/contracts";
import { bech32m } from "@scure/base";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { terms } from "./handle-sales.pg-fixture.ts";
import { makeControlPlaneHandleSalesStore } from "./handle-sales-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import type {
  SpacesDiscoveryAuthority,
  SpacesDiscoveryObservation,
} from "./spaces-discovery-authority.ts";
import { spacesDelegationScriptV1 } from "./spaces-operator-assignment-repository.ts";
import {
  configureSpacesNetwork,
  enableSpacesDriverForRoot,
  recordSpacesAuthorityEvidence,
  seedSpacesOperatorAssignment,
  seedSpacesSeller,
  spacesKeyA,
  spacesKeyB,
  spacesOutpoint,
} from "./spaces-sale-namespace.pg-fixture.ts";
import { makeControlPlaneSpacesSaleNamespaceStore } from "./spaces-sale-namespace-repository.ts";

const connection = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connection)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = connection ? describe : describe.skip;
const communityId = "community-spaces-discovery";
const seller = "spaces-discovery-owner";
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

async function withDiscovery(
  use: (fixture: {
    admin: Client;
    url: string;
    spaces: ReturnType<typeof makeControlPlaneSpacesSaleNamespaceStore>;
    sales: (
      authority: SpacesDiscoveryAuthority,
    ) => ReturnType<typeof makeControlPlaneHandleSalesStore>;
    seed: (root?: string) => Promise<{
      command: Parameters<
        ReturnType<typeof makeControlPlaneSpacesSaleNamespaceStore>["createSaleNamespace"]
      >[0];
      activationHash: string;
      offeringId: string;
      observation: SpacesDiscoveryObservation;
    }>;
  }) => Promise<void>,
) {
  if (!connection) throw new Error("Missing PostgreSQL fixture");
  const schema = `spaces_discovery_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: connection });
  let created = false;
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await admin.query(`SET search_path TO "${schema}"`);
    const scoped = new URL(connection);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    const url = scoped.toString();
    await applyPostgresTestBaselineConnection({ connectionString: url });
    await configureSpacesNetwork(admin);
    await seedSpacesSeller(admin, { communityId, sellerId: seller });
    const runtime = makeDirectPostgresControlPlaneLayer(url);
    const spaces = makeControlPlaneSpacesSaleNamespaceStore(runtime);
    // Test-only regtest capabilities exercise SQL. They do not wire a live
    // observer or admit regtest through the production authority constructor.
    const sales = (authority: SpacesDiscoveryAuthority) =>
      makeControlPlaneHandleSalesStore(
        runtime,
        (binding) => Effect.succeed(binding.network === "regtest"),
        authority,
      );
    let rootCount = 0;
    const seed = async (root = "charizard") => {
      rootCount++;
      const delegation = bech32m.encode("bcrt", [
        1,
        ...bech32m.toWords(new Uint8Array(32).fill(rootCount)),
      ]);
      const reference = `authority-${root}`;
      const assignment = `assignment-${root}`;
      await recordSpacesAuthorityEvidence(admin, {
        reference,
        generation: 1,
        communityId,
        controllingAccountId: seller,
        root,
      });
      await seedSpacesOperatorAssignment(admin, {
        assignmentId: assignment,
        generation: 1,
        delegationAddress: delegation,
        root,
      });
      await run(
        spaces.recordRootObservation({
          canonicalRoot: root,
          observerReference: "discovery-pg-observer",
          observedAt: new Date(Date.now() - 1000).toISOString(),
          root: {
            kind: "resolved",
            outpoint: spacesOutpoint,
            key: spacesKeyA,
            anchoredAt: new Date(Date.now() - 60000).toISOString(),
            anchorCoversRootOutpoint: true,
            publication: "verified",
            delegationAddress: delegation,
          },
          commitmentHistory: {
            kind: "verified",
            commitmentCount: 0,
            latestCommitmentRootHex: null,
          },
          freshness: { observation_max_age_ms: 3600000, anchor_max_age_ms: 86400000 },
        }),
      );
      await run(
        spaces.recordOperatorCapabilityObservation({
          operatorAssignmentId: assignment,
          operatorAssignmentGeneration: 1,
          observedAt: new Date(Date.now() - 1000).toISOString(),
          capability: "observed",
          observationMaxAgeMs: 3600000,
        }),
      );
      await enableSpacesDriverForRoot(admin, { enablementId: `enable-${root}`, root });
      const command = {
        accountId: seller,
        communityId,
        idempotencyKey: `activate-${root}`,
        namespaceAuthorityReference: reference,
        expectedNamespaceAuthorityGeneration: 1,
        operatorAssignmentId: assignment,
        expectedOperatorAssignmentGeneration: 1,
        operatorFundingTermsConfirmed: true as const,
        activationId: `activation-${root}`,
        actionId: `activate-${root}`,
      };
      const activated = await run(spaces.createSaleNamespace(command));
      const offeringId = `offering-${root}`;
      await run(
        sales(null).createOffering({
          accountId: seller,
          communityId,
          idempotencyKey: offeringId,
          offeringId,
          actionId: offeringId,
          terms: {
            ...terms(command.activationId),
            label_scope: {
              kind: "label_rule_v2",
              label_grammar_id: "spaces_subspace_label_v1",
              reserved_labels_id: "reserved_labels_spaces_01",
              expected_reserved_labels_revision: 1,
              availability: { kind: "length_band_v1", min_label_length: 8, max_label_length: 32 },
            },
            fulfillment_kind: "spaces_native_v1",
            qualification_policy_id: "qualification_policy_spaces_members_01",
            issuance_driver_id: "spaces_native-local",
          },
        }),
      );
      return {
        command,
        activationHash: activated.activation.sale_namespace_activation_hash,
        offeringId,
        observation: {
          kind: "verified" as const,
          network: "regtest",
          canonicalRoot: root,
          rootKey: spacesKeyA,
          outpoint: spacesOutpoint,
          operatorNumLive: true,
          reverseDelegationMatches: true,
          delegationScript: spacesDelegationScriptV1(delegation),
          commitmentCount: 0,
          latestRoot: null,
        },
      };
    };
    await use({ admin, url, spaces, sales, seed });
  } finally {
    try {
      if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  }
}

const availability = (item: CommunityHandleOfferingDiscoveryV1 | undefined) =>
  item?.family === "spaces" ? item.current_availability.kind : undefined;

suite("Spaces public discovery against real PostgreSQL", () => {
  test("pending and unwired discovery stay visible and recover with real matching facts", async () => {
    await withDiscovery(async (f) => {
      const sale = await f.seed();
      for (const authority of [
        null,
        () => Effect.succeed({ kind: "temporarily_unavailable" as const }),
      ])
        expect(
          availability((await run(f.sales(authority).listOfferings({ communityId }))).items[0]),
        ).toBe("temporarily_unavailable");
      expect(
        availability(
          (
            await run(
              f.sales(() => Effect.succeed(sale.observation)).listOfferings({ communityId }),
            )
          ).items[0],
        ),
      ).toBe("available");
    });
  }, 60000);

  test("a later same-binding evidence generation stays temporary", async () => {
    await withDiscovery(async (f) => {
      const sale = await f.seed();
      await recordSpacesAuthorityEvidence(f.admin, {
        reference: sale.command.namespaceAuthorityReference,
        generation: 2,
        communityId,
        controllingAccountId: seller,
      });
      expect(
        availability(
          (
            await run(
              f.sales(() => Effect.succeed(sale.observation)).listOfferings({ communityId }),
            )
          ).items[0],
        ),
      ).toBe("temporarily_unavailable");
    });
  }, 60000);

  test("validated changed ownership evidence supersedes before or during observation", async () => {
    for (const during of [false, true])
      await withDiscovery(async (f) => {
        const sale = await f.seed();
        const change = () =>
          recordSpacesAuthorityEvidence(f.admin, {
            reference: sale.command.namespaceAuthorityReference,
            generation: 2,
            communityId,
            controllingAccountId: seller,
            rootKeyHex: spacesKeyB,
          });
        if (!during) await change();
        let calls = 0;
        const authority: NonNullable<SpacesDiscoveryAuthority> = () =>
          Effect.tryPromise(async () => {
            calls++;
            if (during) await change();
            return { kind: "temporarily_unavailable" as const };
          });
        expect((await run(f.sales(authority).listOfferings({ communityId }))).items).toEqual([]);
        expect(calls).toBe(during ? 1 : 0);
      });
  }, 120000);

  test("post-wait suspension and changed publication are rechecked", async () => {
    for (const suspend of [false, true])
      await withDiscovery(async (f) => {
        const sale = await f.seed();
        const authority: NonNullable<SpacesDiscoveryAuthority> = () =>
          Effect.tryPromise(async () => {
            if (suspend)
              await run(
                f.spaces.reviseSaleNamespace({
                  ...sale.command,
                  idempotencyKey: "suspend-during-read",
                  actionId: "suspend-during-read",
                  expectedActivationHash: sale.activationHash,
                  requestedStatus: "suspended",
                }),
              );
            else
              await recordSpacesAuthorityEvidence(f.admin, {
                reference: sale.command.namespaceAuthorityReference,
                generation: 2,
                communityId,
                controllingAccountId: seller,
              });
            return sale.observation;
          });
        const page = await run(f.sales(authority).listOfferings({ communityId }));
        if (suspend) expect(page.items).toEqual([]);
        else expect(availability(page.items[0])).toBe("temporarily_unavailable");
      });
  }, 120000);

  test("a missing current offering record fails initial SQL rather than disappearing", async () => {
    await withDiscovery(async (f) => {
      const sale = await f.seed();
      // An individually valid immutable revision can exist without its current
      // pointer. Exercise that unknown state without disabling any DB guard.
      await f.admin.query(
        `INSERT INTO community_handle_offering_revisions
        SELECT (jsonb_populate_record(NULL::community_handle_offering_revisions,
          to_jsonb(revision)||jsonb_build_object('offering_id','orphan-discovery'))).*
          FROM community_handle_offering_revisions revision WHERE offering_id=$1`,
        [sale.offeringId],
      );
      await expect(run(f.sales(null).listOfferings({ communityId }))).rejects.toMatchObject({
        _tag: "HandleSalesStorageFailed",
      });
    });
  }, 60000);

  test("omitted pages retain their original cursor and do not refill", async () => {
    await withDiscovery(async (f) => {
      const first = await f.seed("charizard");
      const second = await f.seed("otherroot");
      await f.admin.query("UPDATE communities SET status='hidden' WHERE community_id=$1", [
        communityId,
      ]);
      const page = await run(f.sales(null).listOfferings({ communityId, limit: 1 }));
      expect(page.items).toEqual([]);
      expect(page.next_cursor).not.toBeNull();
      if (page.next_cursor === null) throw new Error("Original candidate cursor required");
      const next = await run(
        f.sales(null).listOfferings({ communityId, limit: 1, cursor: page.next_cursor }),
      );
      expect(next.items).toEqual([]);
      expect(next.next_cursor).toBeNull();
      expect(first.offeringId).not.toBe(second.offeringId);
    });
  }, 60000);
});
