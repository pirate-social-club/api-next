import type { prepareHnsAuthoritySuccessorCandidateV1 } from "@pirate/application/hns-host-persistence";
import {
  HNS_AUTHORITY_SUCCESSOR_OBSERVATION_MAX_BYTES,
  prepareCandidateFromHnsAuthoritySuccessorObservationV1,
} from "./authority-successor-observation-harness.ts";

export class HnsAuthoritySuccessorEmitterError extends Error {
  readonly name = "HnsAuthoritySuccessorEmitterError";

  constructor(
    readonly reason: "invalid_arguments" | "observation_read_failed" | "observation_too_large",
  ) {
    super(`HNS authority successor emitter refused: ${reason}`);
  }
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.includes("\0");
}

export type HnsAuthoritySuccessorEmitterIoV1 = Readonly<{
  read: (absolutePath: string, maximumBytes: number) => Promise<Uint8Array>;
  emit: (candidateBytes: Uint8Array) => Promise<void>;
}>;

type CandidatePreparer = typeof prepareHnsAuthoritySuccessorCandidateV1;

export async function runHnsAuthoritySuccessorEmitterV1(
  args: readonly string[],
  io: HnsAuthoritySuccessorEmitterIoV1,
  prepare?: CandidatePreparer,
) {
  if (args.length !== 2 || args[0] !== "--input" || !isAbsolutePath(args[1])) {
    throw new HnsAuthoritySuccessorEmitterError("invalid_arguments");
  }
  let observationBytes: Uint8Array;
  try {
    observationBytes = new Uint8Array(
      await io.read(args[1], HNS_AUTHORITY_SUCCESSOR_OBSERVATION_MAX_BYTES),
    );
  } catch {
    throw new HnsAuthoritySuccessorEmitterError("observation_read_failed");
  }
  if (observationBytes.byteLength > HNS_AUTHORITY_SUCCESSOR_OBSERVATION_MAX_BYTES) {
    throw new HnsAuthoritySuccessorEmitterError("observation_too_large");
  }
  const candidate = await prepareCandidateFromHnsAuthoritySuccessorObservationV1(
    observationBytes,
    prepare,
  );
  await io.emit(candidate.candidate_bytes);
  return candidate;
}
