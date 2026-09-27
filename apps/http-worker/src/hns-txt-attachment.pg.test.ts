import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  completeRouteAttachmentOwnership,
  startRouteAttachmentOwnership,
} from "@pirate/application/namespace-ownership";
import { Effect } from "effect";
import { Client } from "pg";
import { makeControlPlaneHnsTxtAttachmentStore } from "../../../packages/platform-cf/src/hns-txt-attachment-repository.ts";
import { makeHnsOwnerServiceBindingTransport } from "../../../packages/platform-cf/src/namespace-ownership/hns-owner-service-binding.ts";
import { makePlatformNamespaceOwnershipProviderRegistry } from "../../../packages/platform-cf/src/namespace-ownership/provider-registry.ts";
import { makeDirectPostgresControlPlaneLayer } from "../../../packages/platform-cf/src/postgres.ts";
import { makeControlPlaneRouteAttachmentCompletionStore } from "../../../packages/platform-cf/src/route-attachment-completion-repository.ts";
import {
  makeControlPlaneRouteAttachmentOwnershipStartAuthorityResolver,
  makeControlPlaneRouteAttachmentOwnershipStartStore,
} from "../../../packages/platform-cf/src/route-attachment-start-repository.ts";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { attachmentObserverFixture } from "../../hns-owner-verifier/src/attachment-observer.fixture.ts";
import { handleRequest } from "../../hns-owner-verifier/src/index.ts";
import { makeHnsTxtAttachmentHandlers } from "./hns-community-root-import-handlers.ts";
import { createHttpWorker } from "./transport.ts";

/**
 * TXT-only attachment end to end: the real HTTP handlers, the real PostgreSQL
 * repository and the real owner verifier handler, with the verifier's chain
 * observation as the only fixture. The verifier runs as production does, with
 * plain hns-txt-v1 and no import capability.
 */

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("Postgres required");
const pgTest = url ? test : test.skip;

type Attachment = Readonly<{
  readonly attachment_intent_id: string;
  readonly root_label: string;
  readonly status: string;
  readonly challenge: Readonly<{ name: string; value: string }> | null;
  readonly route_href: string | null;
}>;

async function setup(connectionString: string, evidenceTtlSeconds = 2_592_000) {
  const schema = `hns_txt_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const connection = `${connectionString}${connectionString.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  await applyPostgresTestBaselineConnection({ connectionString: connection });
  await admin.query(`SET search_path TO "${schema}"`);
  const actor = "hns-owner";
  await admin.query("INSERT INTO users(user_id,status,account) VALUES($1,'active','{}')", [actor]);
  const createCommunity = async () => {
    const community = `community_${randomUUID()}`;
    await admin.query(
      "INSERT INTO communities(community_id,display_name,status,created_by_user_id,route_authority_version,created_at,updated_at) VALUES($1,'HNS TXT test','active',$2,'optional_route_v2',clock_timestamp(),clock_timestamp())",
      [community, actor],
    );
    await admin.query(
      "INSERT INTO community_route_authority_grants(grant_id,community_id,principal_user_id,authority,source_kind,status,granted_at,granted_by_user_id) VALUES($1,$2,$3,'manage_routes','creator_owner','active',clock_timestamp(),$3)",
      [`grant_${community}`, community, actor],
    );
    return community;
  };
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const configuration = {
    kind: "managed" as const,
    reference: "hns-owner-staging",
    version: "hns-owner-config-v1",
  };
  const chain: { status: "pending" | "verified" } = { status: "pending" };
  const transport = makeHnsOwnerServiceBindingTransport({
    fetch: async (fetchInput, init) => {
      const observer = attachmentObserverFixture(
        chain.status,
        () => {},
        Math.floor(Date.now() / 1_000) + (evidenceTtlSeconds === 2_592_000 ? 0 : 600),
      );
      return handleRequest(
        new Request(String(fetchInput), init),
        {
          HNS_OWNERSHIP_SOURCE: "hns_parent_chain_txt",
          HNS_CHALLENGE_TTL_SECONDS: "3600",
          HNS_EVIDENCE_TTL_SECONDS: String(evidenceTtlSeconds),
          HNS_PROVIDER_ENVIRONMENT: "staging",
          HNS_PROVIDER_CONFIGURATION_REFERENCE: configuration.reference,
          HNS_PROVIDER_CONFIGURATION_VERSION: configuration.version,
        },
        {
          targetObserver: {
            ...observer,
            configuration: {
              ...observer.configuration,
              lease_policy: {
                ...observer.configuration.lease_policy,
                evidence_lease_seconds: evidenceTtlSeconds,
              },
            },
          },
        },
      );
    },
  });
  const registry = await Effect.runPromise(
    makePlatformNamespaceOwnershipProviderRegistry({
      hns: {
        enabled: true,
        transport,
        provider_configuration: configuration,
        environments: ["staging"],
        target_observation_contract: "v2",
        import_protocol_enabled: false,
      },
    }),
  );
  const handlers = makeHnsTxtAttachmentHandlers({
    ownership: {
      start: (input) =>
        startRouteAttachmentOwnership(input, {
          intents: makeControlPlaneRouteAttachmentOwnershipStartAuthorityResolver(layer),
          registry,
          store: makeControlPlaneRouteAttachmentOwnershipStartStore(layer),
          environment: "staging",
        }),
    },
    completion: {
      complete: (input) =>
        completeRouteAttachmentOwnership(input, {
          registry,
          store: makeControlPlaneRouteAttachmentCompletionStore(layer),
        }),
    },
    store: makeControlPlaneHnsTxtAttachmentStore(layer, {
      environment: "staging",
      provider_binding: {
        requirement: "namespace_ownership",
        family: "hns",
        provider_id: "hns.owner.v1",
        provider_configuration: configuration,
        protocol_version: "hns-txt-v1",
      },
    }),
  });
  const app = createHttpWorker({
    handlers,
    authenticate: () => ({ kind: "user", subject: actor }),
    authorize: () => {},
  });
  const call = async (path: string, body?: unknown) => {
    const response = await app.request(`https://worker.test${path}`, {
      headers: { authorization: "test-account", "content-type": "application/json" },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const start = (community: string, root: string, key = `start-${randomUUID()}`) =>
    call(`/communities/${community}/hns-txt-attachments`, {
      root_label: root,
      idempotency_key: key,
    });
  const check = (community: string, intent: string) =>
    call(`/communities/${community}/hns-txt-attachments/${intent}/check`, {
      idempotency_key: `check-${randomUUID()}`,
    });
  const count = async (table: string) =>
    Number((await admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  const cleanup = async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  };
  return { admin, chain, createCommunity, start, check, call, count, cleanup };
}

pgTest(
  "a TXT challenge seen on chain attaches the community at /c/<root>",
  async () => {
    const fixture = await setup(url as string, 15);
    try {
      const community = await fixture.createCommunity();
      const started = await fixture.start(community, "harbor", "start");
      expect(started.status).toBe(202);
      const attachment = started.body as unknown as Attachment;
      expect(attachment.status).toBe("awaiting_txt");
      expect(attachment.root_label).toBe("harbor");
      expect(attachment.challenge?.name).toBe("harbor");
      expect(attachment.challenge?.value).toMatch(/^pirate-verification=nvs_[0-9a-f]{48}$/u);
      expect(attachment.route_href).toBeNull();

      // A replayed start returns the same challenge.
      const replayed = await fixture.start(community, "harbor", "start");
      expect((replayed.body as unknown as Attachment).challenge).toEqual(attachment.challenge);

      // Nothing on chain yet: the check stays pending and spends no attempt.
      const pending = await fixture.check(community, attachment.attachment_intent_id);
      expect(pending.status).toBe(202);
      expect((pending.body as unknown as Attachment).status).toBe("awaiting_txt");
      expect(pending.body.retry_after_seconds).toBeGreaterThan(0);

      fixture.chain.status = "verified";
      const attached = await fixture.check(community, attachment.attachment_intent_id);
      expect(attached.status).toBe(200);
      expect(attached.body).toMatchObject({
        status: "attached",
        root_label: "harbor",
        challenge: null,
        route_href: "/c/harbor",
      });

      // A repeated check is a no-op read of the committed attachment.
      const again = await fixture.check(community, attachment.attachment_intent_id);
      expect(again.body).toMatchObject({ status: "attached", route_href: "/c/harbor" });

      const current = await fixture.call(`/communities/${community}/hns-txt-attachments`);
      expect(current.status).toBe(200);
      expect(current.body).toMatchObject({
        community_id: community,
        attachment: { status: "attached", route_href: "/c/harbor" },
      });

      // The public route resolves exactly as GET /c/harbor reads it.
      const route = await fixture.admin.query(
        `SELECT community_id, public_href FROM effective_public_community_route_v2(NULL, clock_timestamp())
        WHERE public_path_segment = 'harbor'`,
      );
      expect(route.rows).toEqual([{ community_id: community, public_href: "/c/harbor" }]);

      // No provisioning, readiness or activation state was created.
      expect(await fixture.count("hns_root_import_sessions")).toBe(0);
      expect(await fixture.count("hns_root_import_lifecycle")).toBe(0);
      expect(await fixture.count("hns_authority_provision_jobs")).toBe(0);
      expect(await fixture.count("hns_dns_zone_activation_current")).toBe(0);

      // The committed preparation no longer holds its reservation.
      const held = await fixture.admin.query(
        `SELECT hns_community_root_import_reservation_held_v1(root_import_session_id) AS held
         FROM hns_community_root_import_preparations`,
      );
      expect(held.rows).toEqual([{ held: false }]);

      // Let the short, append-only evidence lease end naturally.
      const evidence = await fixture.admin.query(
        `SELECT evidence.expires_at FROM community_route_ownership_evidence AS evidence
          JOIN community_canonical_route_bindings AS binding
            ON binding.verified_evidence_ref=evidence.evidence_ref
          WHERE binding.community_id=$1`,
        [community],
      );
      const waitMs = new Date(evidence.rows[0].expires_at).getTime() - Date.now() + 250;
      if (waitMs > 0) await Bun.sleep(waitMs);
      const expiredRoute = await fixture.admin.query(
        `SELECT community_id FROM effective_public_community_route_v2(NULL, clock_timestamp())
          WHERE public_path_segment='harbor'`,
      );
      expect(expiredRoute.rows).toEqual([]);
      const expiredCurrent = await fixture.call(`/communities/${community}/hns-txt-attachments`);
      expect(expiredCurrent.body).toMatchObject({
        attachment: { status: "expired", route_href: null },
      });
    } finally {
      await fixture.cleanup();
    }
  },
  120_000,
);

pgTest(
  "a root attached to one community is refused for another",
  async () => {
    const fixture = await setup(url as string);
    try {
      fixture.chain.status = "verified";
      const first = await fixture.createCommunity();
      const started = await fixture.start(first, "harbor");
      const intent = (started.body as unknown as Attachment).attachment_intent_id;
      expect((await fixture.check(first, intent)).body).toMatchObject({ status: "attached" });

      const second = await fixture.createCommunity();
      const refused = await fixture.start(second, "harbor");
      expect(refused.status).toBe(409);
    } finally {
      await fixture.cleanup();
    }
  },
  120_000,
);

pgTest(
  "issued challenges count against the daily limit even when abandoned",
  async () => {
    const fixture = await setup(url as string);
    try {
      for (const root of ["alpha", "bravo", "charlie"]) {
        const community = await fixture.createCommunity();
        const started = await fixture.start(community, root);
        expect(started.status).toBe(202);
      }
      const community = await fixture.createCommunity();
      const limited = await fixture.start(community, "delta");
      expect(limited.status).toBe(429);
    } finally {
      await fixture.cleanup();
    }
  },
  120_000,
);

pgTest(
  "an actor without route authority cannot read or check an attachment",
  async () => {
    const fixture = await setup(url as string);
    try {
      const community = await fixture.createCommunity();
      const started = await fixture.start(community, "harbor");
      const intent = (started.body as unknown as Attachment).attachment_intent_id;
      await fixture.admin.query(
        "UPDATE community_route_authority_grants SET status='revoked', revoked_at=clock_timestamp(), revoked_by_user_id=principal_user_id WHERE community_id=$1",
        [community],
      );
      expect((await fixture.call(`/communities/${community}/hns-txt-attachments`)).status).toBe(
        404,
      );
      expect((await fixture.check(community, intent)).status).toBe(404);
    } finally {
      await fixture.cleanup();
    }
  },
  120_000,
);
