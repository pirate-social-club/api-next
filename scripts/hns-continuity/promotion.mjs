import { createHash } from "node:crypto";
import { Effect } from "effect";
import {
  decodeHnsAppHostTransitionDocumentV1,
  decodeHnsDnsZonePersistenceDocumentV1,
  requireReviewedHnsAuthorityCandidateV1,
} from "../../packages/application/src/hns-host-persistence.ts";
import { decodeHnsAuthorityInventoryBytes } from "../../packages/application/src/namespace-ownership/hns-authority-inventory.ts";
import {
  ControlPlaneDb,
  ControlPlaneStatementFailed,
} from "../../packages/application/src/ports.ts";
import { makeControlPlaneHandleSalesRepository } from "../../packages/platform-cf/src/handle-sales-repository.ts";
import {
  hnsAppHostTransitionStatementFromReviewedDocument,
  hnsDnsHealthStatementFromReviewedDocument,
  hnsDnsZoneFinalizationStatementFromReviewedDocument,
  hnsDnsZoneReservationStatementFromReviewedDocument,
} from "../../packages/platform-cf/src/hns-host-persistence-repository.ts";
import { ContinuityRefusal } from "./refusal.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function bytesFromHex(value) {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2})+$/u.test(value))
    throw new ContinuityRefusal("candidate artifact hex is invalid");
  return Uint8Array.from(Buffer.from(value, "hex"));
}
function positiveInteger(value, label) {
  const parsed = typeof value === "string" && /^[1-9][0-9]*$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed <= 0)
    throw new ContinuityRefusal(`${label} is invalid`);
  return parsed;
}
function nonnegativeInteger(value, label) {
  const parsed = typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0)
    throw new ContinuityRefusal(`${label} is invalid`);
  return parsed;
}
function exactRow(rows, label) {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new ContinuityRefusal(`${label} returned invalid rows`);
  return rows[0];
}
export async function promoteContinuity({
  client,
  prepared,
  state,
  reviewedCandidateBytes,
  expectedCandidateSha256,
  mode = "--preflight",
  authoritySchema = "api_next",
}) {
  if (!["--preflight", "--rehearse", "--commit"].includes(mode))
    throw new ContinuityRefusal("Invalid promotion mode");
  if (!/^[a-z][a-z0-9_]*$/.test(authoritySchema))
    throw new ContinuityRefusal("Invalid authority schema");
  const recomputedCandidateBytes = prepared.candidate_bytes;
  if (
    !/^[0-9a-f]{64}$/.test(expectedCandidateSha256) ||
    sha256(reviewedCandidateBytes) !== expectedCandidateSha256 ||
    sha256(recomputedCandidateBytes) !== expectedCandidateSha256
  )
    throw new ContinuityRefusal("Reviewed candidate bytes changed");
  const inventoryRegistryReference = state.inventory.registry_reference,
    candidate = JSON.parse(new TextDecoder().decode(reviewedCandidateBytes)),
    artifactNames = [
      "authority_inventory",
      "dns_zone_activation",
      "app_host_activation",
      "health_observation",
      "observer_evidence",
    ],
    artifacts = new Map();
  for (const name of artifactNames) {
    const matches = candidate.artifacts.filter((artifact) => artifact.name === name);
    if (matches.length !== 1 || matches[0] === undefined)
      throw new ContinuityRefusal(`candidate artifact ${name} is missing or duplicated`);
    const bytes = bytesFromHex(matches[0].bytes_hex);
    if (sha256(bytes) !== matches[0].sha256)
      throw new ContinuityRefusal(`candidate artifact ${name} changed`);
    artifacts.set(name, bytes);
  }
  if (candidate.artifacts.length !== artifactNames.length)
    throw new ContinuityRefusal("candidate contains an unexpected artifact");
  const artifact = (name) => {
      const value = artifacts.get(name);
      if (value === undefined)
        throw new ContinuityRefusal(`candidate artifact ${name} is unavailable`);
      return value;
    },
    inventory = await decodeHnsAuthorityInventoryBytes(artifact("authority_inventory")),
    dns = await decodeHnsDnsZonePersistenceDocumentV1(artifact("dns_zone_activation")),
    app = decodeHnsAppHostTransitionDocumentV1(artifact("app_host_activation")),
    emittedSnapshot = {
      dns_zone_activation_id: dns.dns_zone_activation_id,
      dns_current_generation: candidate.generations.dns_activation_generation - 1,
      app_host_activation_id: app.app_host_activation_id,
      app_host_current_generation: candidate.generations.app_host_activation_generation - 1,
      successor_dns_latest_health_generation: candidate.generations.health_generation - 1,
    };
  let transactionOpen = false;
  try {
    await client.query(
      mode !== "--preflight"
        ? "BEGIN ISOLATION LEVEL SERIALIZABLE"
        : "BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY",
    );
    transactionOpen = true;
    await client.query(`SET LOCAL search_path TO "${authoritySchema}", public`);
    await client.query("SET LOCAL lock_timeout TO '10s'");
    await client.query("SET LOCAL statement_timeout TO '20s'");
    const currentRows = await client.query({
        text: `SELECT dns.dns_zone_activation_id,
                    dns.current_generation AS dns_current_generation,
                    app.app_host_activation_id,
                    app.current_generation AS app_host_current_generation,
                    to_char(clock_timestamp() AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS database_time
               FROM hns_dns_zone_activation_current AS dns
               JOIN hns_community_app_host_activation_current AS app
                 ON app.normalized_host = $2
              WHERE dns.canonical_root = $1
              ${mode !== "--preflight" ? "FOR UPDATE OF dns, app" : ""}`,
        values: [candidate.root_label, `app.${candidate.root_label}`],
      }),
      current = exactRow(currentRows.rows, "generation fence"),
      healthRows = await client.query({
        text: `SELECT COALESCE(max(health_generation), 0) AS health_generation
             FROM hns_dns_zone_health_observations
            WHERE dns_zone_activation_id = $1
              AND activation_generation = $2::bigint`,
        values: [dns.dns_zone_activation_id, dns.dns_authority_generation],
      }),
      currentSnapshot = {
        dns_zone_activation_id: String(current.dns_zone_activation_id),
        dns_current_generation: positiveInteger(
          current.dns_current_generation,
          "current DNS generation",
        ),
        app_host_activation_id: String(current.app_host_activation_id),
        app_host_current_generation: positiveInteger(
          current.app_host_current_generation,
          "current app-host generation",
        ),
        successor_dns_latest_health_generation: nonnegativeInteger(
          exactRow(healthRows.rows, "health fence").health_generation,
          "current health generation",
        ),
      };
    requireReviewedHnsAuthorityCandidateV1({
      emitted_snapshot: emittedSnapshot,
      current_snapshot: currentSnapshot,
      reviewed_candidate_bytes: reviewedCandidateBytes,
      recomputed_candidate_bytes: recomputedCandidateBytes,
    });
    const saleFence = exactRow(
      (
        await client.query({
          text: `SELECT current_generation FROM community_handle_sale_namespace_activation_current
            WHERE sale_namespace_activation_id=$1 AND community_id=$2 AND canonical_root=$3 ${mode !== "--preflight" ? "FOR UPDATE" : ""}`,
          values: [
            state.sale.sale_namespace_activation_id,
            state.sale.community_id,
            candidate.root_label,
          ],
        })
      ).rows,
      "sale namespace fence",
    );
    if (
      Number(saleFence.current_generation) !==
      Number(state.sale.sale_namespace_activation_generation)
    )
      throw new ContinuityRefusal("Sale namespace changed after observation");
    const priorDependency = exactRow(
      (
        await client.query({
          text: "SELECT * FROM current_hns_sale_namespace_dependency_v1($1,$2,$3,$4,$5,clock_timestamp())",
          values: [
            state.sale.community_id,
            state.sale.namespace_authority_reference,
            Number(state.sale.namespace_authority_generation),
            state.dns.dns_zone_activation_id,
            Number(state.dns.dns_zone_activation_generation),
          ],
        })
      ).rows,
      "current namespace authority",
    );
    if (
      !priorDependency.namespace_authority_current ||
      !priorDependency.dns_zone_current ||
      !priorDependency.dns_delegation_current
    )
      throw new ContinuityRefusal("Existing namespace authority is not current");
    const databaseTime = String(current.database_time);
    if (
      !Number.isFinite(Date.parse(candidate.observed_at)) ||
      Date.parse(databaseTime) < Date.parse(candidate.observed_at) ||
      Date.parse(databaseTime) - Date.parse(candidate.observed_at) > 3600000
    )
      throw new ContinuityRefusal("Observations older than one hour; reacquire all evidence");
    if (
      Date.parse(inventory.inventory.published_at) > Date.parse(databaseTime) ||
      Date.parse(inventory.inventory.expires_at) <= Date.parse(databaseTime)
    )
      throw new ContinuityRefusal("reviewed authority inventory is no longer current");
    const reservationStatement = await hnsDnsZoneReservationStatementFromReviewedDocument(
        artifact("dns_zone_activation"),
        60,
      ),
      appStatement = hnsAppHostTransitionStatementFromReviewedDocument(
        artifact("app_host_activation"),
      ),
      healthStatement = hnsDnsHealthStatementFromReviewedDocument(artifact("health_observation")),
      outcome = {
        mode: mode.slice(2),
        candidate_sha256: expectedCandidateSha256,
        source_commit: candidate.source_commit,
        reviewed_bytes_match_fresh_recomputation: true,
        database_time: databaseTime,
        emitted_snapshot: emittedSnapshot,
        current_snapshot: currentSnapshot,
        target_generations: candidate.generations,
        inventory_registry_reference: inventoryRegistryReference,
        inventory_reference: inventory.inventory.authority_inventory_reference,
        inventory_version: inventory.inventory.authority_inventory_version,
        inventory_digest: inventory.inventory_digest,
        inventory_expires_at: inventory.inventory.expires_at,
        zone_bytes_digest: dns.zone_bytes_digest,
        dnskey_keyset_version: dns.dnssec_keyset_version,
        gateway_deployment_reference: dns.gateway_deployment_reference,
        gateway_certificate_spki_sha256: dns.gateway_certificate_spki_sha256,
        operation_labels: [
          "hns.authority-inventory.insert",
          reservationStatement.label,
          "hns.hosts.dns-zone.finalize",
          appStatement.label,
          healthStatement.label,
          "hns.sale-namespace.revise",
          "hns.authority-successor.verify",
        ],
      };
    if (mode === "--preflight") {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return { ...outcome, committed: false };
    } else {
      const inventoryValues = [
        inventoryRegistryReference,
        inventory.inventory.authority_inventory_reference,
        inventory.inventory.authority_inventory_version,
        inventory.inventory_digest,
        inventory.inventory.environment,
        inventory.inventory.runtime_capability_set_digest,
        Buffer.from(inventory.inventory_bytes),
        inventory.inventory.published_at,
        inventory.inventory.expires_at,
      ];
      const inserted = await client.query({
          text: `INSERT INTO hns_authority_inventories (
               registry_reference,
               authority_inventory_reference,
               authority_inventory_version,
               authority_inventory_digest,
               environment,
               runtime_capability_set_digest,
               inventory_bytes,
               published_at,
               expires_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7::bytea, $8::timestamptz, $9::timestamptz)
             ON CONFLICT DO NOTHING`,
          values: inventoryValues,
        }),
        retainedInventory = await client.query({
          text: `SELECT count(*)::integer AS matching_rows
               FROM hns_authority_inventories
              WHERE registry_reference = $1
                AND authority_inventory_reference = $2
                AND authority_inventory_version = $3
                AND authority_inventory_digest = $4
                AND environment = $5
                AND runtime_capability_set_digest = $6
                AND inventory_bytes = $7::bytea
                AND published_at = $8::timestamptz
                AND expires_at = $9::timestamptz`,
          values: inventoryValues,
        });
      if (exactRow(retainedInventory.rows, "retained inventory").matching_rows !== 1)
        throw new ContinuityRefusal("retained authority inventory differs from reviewed bytes");
      const reservationResult = exactRow(
          (
            await client.query({
              text: reservationStatement.text,
              values: reservationStatement.values,
            })
          ).rows,
          reservationStatement.label,
        ),
        reservation = {
          outcome: String(reservationResult.outcome),
          operation_id: String(reservationResult.operation_id),
          dns_zone_activation_id: String(reservationResult.dns_zone_activation_id),
          fence_token: positiveInteger(reservationResult.fence_token, "DNS fence token"),
          lease_expires_at: new Date(String(reservationResult.lease_expires_at)).toISOString(),
          activation_generation:
            reservationResult.activation_generation === null
              ? null
              : positiveInteger(reservationResult.activation_generation, "DNS replay generation"),
        };
      if (reservation.outcome !== "reserved" && reservation.outcome !== "replayed")
        throw new ContinuityRefusal("DNS reservation returned an invalid outcome");
      const finalizationStatement = await hnsDnsZoneFinalizationStatementFromReviewedDocument(
          reservation,
          artifact("dns_zone_activation"),
        ),
        dnsOutcome = exactRow(
          (
            await client.query({
              text: finalizationStatement.text,
              values: finalizationStatement.values,
            })
          ).rows,
          finalizationStatement.label,
        ),
        appOutcome = exactRow(
          (await client.query({ text: appStatement.text, values: appStatement.values })).rows,
          appStatement.label,
        ),
        healthOutcome = exactRow(
          (await client.query({ text: healthStatement.text, values: healthStatement.values })).rows,
          healthStatement.label,
        ),
        transaction = {
          execute: (statement) =>
            Effect.tryPromise({
              try: async () => {
                const result = await client.query({
                  text: statement.text,
                  values: statement.values,
                });
                return { rows: result.rows, rowCount: result.rowCount ?? 0 };
              },
              catch: (error) =>
                new ControlPlaneStatementFailed({
                  label: statement.label,
                  sqlState: error.code ?? null,
                  constraint: error.constraint ?? null,
                  outcomeCertainty: "not_committed",
                }),
            }),
        },
        saleOutcome = await Effect.runPromise(
          makeControlPlaneHandleSalesRepository()
            .reviseSaleNamespace({
              accountId: state.sale.actor_account_id,
              communityId: state.sale.community_id,
              activationId: state.sale.sale_namespace_activation_id,
              expectedActivationHash: state.sale.sale_namespace_activation_hash,
              requestedStatus: "active",
              namespaceAuthorityReference: state.sale.namespace_authority_reference,
              expectedNamespaceAuthorityGeneration: Number(
                state.sale.namespace_authority_generation,
              ),
              dnsZoneActivationId: dns.dns_zone_activation_id,
              expectedDnsZoneActivationGeneration: candidate.generations.dns_activation_generation,
              dedicatedRootReplacementConfirmed: true,
              idempotencyKey: `hns-continuity-sale:${expectedCandidateSha256}`,
              actionId: `hns-continuity-sale:${expectedCandidateSha256}`,
            })
            .pipe(
              Effect.provideService(ControlPlaneDb, {
                ...transaction,
                withTransaction: (use) => use(transaction),
              }),
            ),
        );
      if (
        saleOutcome.activation.serving.dns_zone_activation_generation !==
          candidate.generations.dns_activation_generation ||
        saleOutcome.activation.sale_namespace_activation_generation !==
          Number(state.sale.sale_namespace_activation_generation) + 1
      )
        throw new ContinuityRefusal("Sale namespace did not advance atomically");
      const verified = exactRow(
        (
          await client.query({
            text: `SELECT dns.current_generation AS dns_generation,
                        app.current_generation AS app_generation,
                        COALESCE((
                          SELECT max(health_generation)
                            FROM hns_dns_zone_health_observations
                           WHERE dns_zone_activation_id = dns.dns_zone_activation_id
                             AND activation_generation = dns.current_generation
                        ), 0) AS health_generation
                   FROM hns_dns_zone_activation_current AS dns
                   JOIN hns_community_app_host_activation_current AS app
                     ON app.normalized_host = $2
                  WHERE dns.canonical_root = $1`,
            values: [candidate.root_label, `app.${candidate.root_label}`],
          })
        ).rows,
        "successor verification",
      );
      if (
        positiveInteger(verified.dns_generation, "verified DNS generation") !==
          candidate.generations.dns_activation_generation ||
        positiveInteger(verified.app_generation, "verified app-host generation") !==
          candidate.generations.app_host_activation_generation ||
        positiveInteger(verified.health_generation, "verified health generation") !==
          candidate.generations.health_generation
      )
        throw new ContinuityRefusal("successor selectors do not match the reviewed generations");
      if (mode === "--commit") {
        transactionOpen = false;
        try {
          await client.query("COMMIT");
        } catch {
          throw new ContinuityRefusal(
            "Commit outcome unknown; reconcile retained generations before any retry",
          );
        }
      } else await client.query("ROLLBACK");
      transactionOpen = false;
      return {
        ...outcome,
        inventory_inserted: inserted.rowCount === 1,
        dns_outcome: dnsOutcome,
        app_host_outcome: appOutcome,
        health_outcome: healthOutcome,
        sale_generation: saleOutcome.activation.sale_namespace_activation_generation,
        committed: mode === "--commit",
      };
    }
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    throw error;
  }
}
