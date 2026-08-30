import type { DanceReferenceProcessorService } from "@pirate/application/dance/reference-processing";
import {
  type CloudflareDanceReferenceWorkflowBinding,
  makeCloudflareDanceReferenceWorkflowLauncher,
} from "@pirate/platform-cf/dance-reference-processing-cloudflare";
import { makeDanceReferenceProcessingStore } from "@pirate/platform-cf/dance-reference-processing-repository";
import { makeHyperdriveControlPlaneLayer } from "@pirate/platform-cf/postgres";
import type {
  DanceReferenceProcessorComposition,
  DanceReferenceProcessorWorkerEnv,
} from "./dance-reference.ts";

export type DanceReferenceProcessorRuntimeEnv = DanceReferenceProcessorWorkerEnv &
  Readonly<{
    readonly CONTROL_PLANE?: Readonly<{ readonly connectionString: string }>;
    readonly DANCE_REFERENCE_PROCESSING_WORKFLOW?: CloudflareDanceReferenceWorkflowBinding;
  }>;

export type DanceReferenceTestProcessorInjection = Readonly<{
  readonly processor: DanceReferenceProcessorService;
  readonly adapterId: string;
  readonly adapterRevision: string;
}>;

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} binding is required`);
  return value;
}

/** Production calls this without an injection and therefore cannot process a reference. */
export function makeDanceReferenceProcessorComposition(
  env: DanceReferenceProcessorRuntimeEnv,
  injection: DanceReferenceTestProcessorInjection | null = null,
): DanceReferenceProcessorComposition {
  const runtime = makeHyperdriveControlPlaneLayer(required(env.CONTROL_PLANE, "CONTROL_PLANE"));
  const store = makeDanceReferenceProcessingStore(runtime);
  const workflow = makeCloudflareDanceReferenceWorkflowLauncher(
    required(env.DANCE_REFERENCE_PROCESSING_WORKFLOW, "DANCE_REFERENCE_PROCESSING_WORKFLOW"),
  );
  return {
    queue: { store, workflow },
    workflow: {
      store,
      processor: injection?.processor ?? null,
      leaseSeconds: 60,
      adapterId: injection?.adapterId ?? "disabled",
      adapterRevision: injection?.adapterRevision ?? "disabled",
    },
  };
}
