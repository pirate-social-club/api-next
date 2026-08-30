import type {
  HnsAuthoritySuccessorGenerationReaderV1,
  HnsAuthoritySuccessorInventoryReaderV1,
} from "@pirate/application/hns-host-persistence";
import { decodeHnsAuthorityInventoryBytes } from "@pirate/application/namespace-ownership";
import { Effect } from "effect";
import {
  type HnsFirstPartyHostPersistenceRepositoryV1,
  makeControlPlaneHnsFirstPartyHostPersistenceRepository,
} from "./hns-host-persistence-repository.ts";
import { makeControlPlaneHnsAuthorityInventoryResolver } from "./namespace-ownership/hns-control-observer-postgres.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

type GenerationObservationRepositoryV1 = Pick<
  HnsFirstPartyHostPersistenceRepositoryV1,
  "readSuccessorGenerationObservation"
>;

type AuthorityInventoryResolverV1 = Readonly<{
  resolve: (options: Readonly<{ deadline_ms: number; signal: AbortSignal }>) => Promise<Readonly<{
    authority_inventory_reference: string;
    authority_inventory_version: string;
    authority_inventory_digest: string;
    inventory_bytes: Uint8Array;
  }> | null>;
}>;

export class HnsAuthoritySuccessorPostgresReaderError extends Error {
  readonly name = "HnsAuthoritySuccessorPostgresReaderError";

  constructor(readonly reason: "invalid_configuration" | "source_unavailable" | "invalid_row") {
    super(`HNS authority successor PostgreSQL reader refused: ${reason}`);
  }
}

function invalidPostgresSource(): HnsAuthoritySuccessorPostgresReaderError {
  return new HnsAuthoritySuccessorPostgresReaderError("invalid_configuration");
}

function unavailablePostgresSource(): HnsAuthoritySuccessorPostgresReaderError {
  return new HnsAuthoritySuccessorPostgresReaderError("source_unavailable");
}

export function makeHnsAuthoritySuccessorGenerationReaderFromRepositoryV1(
  repository: GenerationObservationRepositoryV1,
): HnsAuthoritySuccessorGenerationReaderV1 {
  return {
    read: async (identity, { signal }) => {
      if (signal.aborted) {
        throw unavailablePostgresSource();
      }
      let observed: Awaited<ReturnType<HnsAuthoritySuccessorGenerationReaderV1["read"]>>;
      try {
        observed = await Effect.runPromise(
          repository.readSuccessorGenerationObservation(identity),
          {
            signal,
          },
        );
      } catch {
        throw unavailablePostgresSource();
      }
      return {
        database_time: observed.database_time,
        snapshot: {
          dns_zone_activation_id: observed.snapshot.dns_zone_activation_id,
          dns_current_generation: observed.snapshot.dns_current_generation,
          app_host_activation_id: observed.snapshot.app_host_activation_id,
          app_host_current_generation: observed.snapshot.app_host_current_generation,
          successor_dns_latest_health_generation:
            observed.snapshot.successor_dns_latest_health_generation,
        },
      };
    },
  };
}

export function makeHnsAuthoritySuccessorInventoryReaderFromResolverV1(
  resolver: AuthorityInventoryResolverV1,
  deadlineMs: number,
): HnsAuthoritySuccessorInventoryReaderV1 {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) {
    throw invalidPostgresSource();
  }
  return {
    read: async ({ signal }) => {
      if (signal.aborted) {
        throw unavailablePostgresSource();
      }
      let resolved: Awaited<ReturnType<AuthorityInventoryResolverV1["resolve"]>>;
      try {
        resolved = await resolver.resolve({ deadline_ms: deadlineMs, signal });
      } catch {
        throw unavailablePostgresSource();
      }
      if (resolved === null) {
        throw unavailablePostgresSource();
      }
      let decoded: Awaited<ReturnType<typeof decodeHnsAuthorityInventoryBytes>>;
      try {
        decoded = await decodeHnsAuthorityInventoryBytes(resolved.inventory_bytes);
      } catch {
        throw new HnsAuthoritySuccessorPostgresReaderError("invalid_row");
      }
      if (
        decoded.inventory.authority_inventory_reference !==
          resolved.authority_inventory_reference ||
        decoded.inventory.authority_inventory_version !== resolved.authority_inventory_version ||
        decoded.inventory_digest !== resolved.authority_inventory_digest
      ) {
        throw new HnsAuthoritySuccessorPostgresReaderError("invalid_row");
      }
      return Uint8Array.from(resolved.inventory_bytes);
    },
  };
}

export function makeHnsAuthoritySuccessorPostgresReadersV1(
  input: Readonly<{
    connection_string: string;
    authority_inventory_registry_reference: string;
    authority_inventory_response_max_bytes: number;
    authority_inventory_deadline_ms: number;
  }>,
): Readonly<{
  generation_reader: HnsAuthoritySuccessorGenerationReaderV1;
  inventory_reader: HnsAuthoritySuccessorInventoryReaderV1;
}> {
  if (
    input.connection_string.trim() !== input.connection_string ||
    input.connection_string.length === 0 ||
    input.authority_inventory_registry_reference.trim() !==
      input.authority_inventory_registry_reference ||
    input.authority_inventory_registry_reference.length === 0
  ) {
    throw invalidPostgresSource();
  }
  let runtime: ReturnType<typeof makeDirectPostgresControlPlaneLayer>;
  let repository: HnsFirstPartyHostPersistenceRepositoryV1;
  let inventoryResolver: ReturnType<typeof makeControlPlaneHnsAuthorityInventoryResolver>;
  try {
    runtime = makeDirectPostgresControlPlaneLayer(input.connection_string);
    repository = makeControlPlaneHnsFirstPartyHostPersistenceRepository(runtime, {
      authority_schema: "api_next",
    });
    inventoryResolver = makeControlPlaneHnsAuthorityInventoryResolver(runtime, {
      registryReference: input.authority_inventory_registry_reference,
      responseMaxBytes: input.authority_inventory_response_max_bytes,
    });
  } catch {
    throw invalidPostgresSource();
  }
  return {
    generation_reader: makeHnsAuthoritySuccessorGenerationReaderFromRepositoryV1(repository),
    inventory_reader: makeHnsAuthoritySuccessorInventoryReaderFromResolverV1(
      inventoryResolver,
      input.authority_inventory_deadline_ms,
    ),
  };
}
