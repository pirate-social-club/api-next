import { isAbsolute } from "node:path";
import type { Client } from "pg";
import {
  adoptHnsRootZone,
  HnsZoneAdoptionCommitUnknown,
  type HnsZoneAdoptionMode,
  HnsZoneAdoptionRefusal,
  hnsRootZoneAdoptionObservationRequestBytes,
  readHnsRootZoneAdoptionState,
  withHnsRootZoneAdoptionFence,
} from "../../../packages/platform-cf/src/hns-zone-adoption.ts";
import {
  HNS_ZONE_ADOPTION_DELTA_KINDS,
  type HnsZoneAdoptionDeltaKind,
  HnsZoneAdoptionDeltaRefusal,
  hnsZoneHoldsWildcardAddressFamilyV1,
  requireHnsZoneAdoptionDeltaV1,
} from "../../../packages/platform-cf/src/hns-zone-adoption-delta.ts";
import {
  decodeHnsAuthorityProvisionResultV1,
  decodeHnsRootReadinessObservationRequestV1,
  type HnsRootReadinessObservationConfig,
  HnsRootReadinessObservationError,
  type HnsRootReadinessObservationPorts,
  observeHnsRootReadinessV1,
} from "./observe-root.ts";
import {
  makePowerDnsWildcardFamilyWriter,
  type PowerDnsFetch,
  type PowerDnsRootProvisionConfig,
} from "./powerdns.ts";

/**
 * The operator command that brings an activated root's zone to a changed
 * shape and has the control plane adopt it.
 *
 * A root's retained zone is frozen between authority successors, and a
 * renewal promotes a successor only when the served zone still equals it. So
 * a root provisioned before the wildcard address-family records existed can
 * get them only through a successor that adopts the changed zone. This
 * command is that path, in four steps an operator runs in order and reads
 * between:
 *
 * - `status` reads the root's generation, retained zone, open renewal jobs
 *   and remaining validity. It writes nothing.
 * - `write-records` adds or removes the two wildcard record sets at the
 *   primary authority, inside the adoption fence, after confirming the zone
 *   is the retained one.
 * - `observe` takes the same observation a renewal takes, with the same
 *   observer, and writes its result to a new file. It reports how the served
 *   zone differs from the retained one. It changes nothing in the database.
 * - `adopt` promotes the successor from that file as a dry run, a rehearsal
 *   that is rolled back, or a commit, and refuses any difference other than
 *   the one named.
 *
 * Every step prints one JSON line. It reuses the serving path's
 * configuration, observer and successor promotion, and adds no second
 * configuration surface.
 */

/** Three days is when the scheduler queues a renewal; a day more leaves room to finish. */
export const HNS_ZONE_ADOPTION_DEFAULT_MINIMUM_VALIDITY_SECONDS = 345_600;

export type HnsZoneAdoptionCommandV1 =
  | Readonly<{ step: "status"; root_label: string }>
  | Readonly<{
      step: "write-records";
      root_label: string;
      change: "add" | "remove";
      minimum_serving_validity_seconds: number;
    }>
  | Readonly<{ step: "observe"; root_label: string; out: string }>
  | Readonly<{
      step: "adopt";
      observation: string;
      expected_result_sha256: string;
      expected_delta: HnsZoneAdoptionDeltaKind;
      mode: HnsZoneAdoptionMode;
    }>;

const USAGE =
  "HNS zone adoption arguments are invalid: use `status --root <label>`, " +
  "`write-records --root <label> --change add-wildcard-family|remove-wildcard-family " +
  "[--minimum-validity-seconds <n>]`, `observe --root <label> --out <absolute path>`, or " +
  "`adopt --observation <absolute path> --expect-result-sha256 <hex> " +
  "--expect-delta <kind> --mode dry-run|rehearse|commit`";

function options(
  args: readonly string[],
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, string>> {
  const found: Record<string, string> = {};
  if (args.length % 2 !== 0) throw new Error(USAGE);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !name.startsWith("--") ||
      value.startsWith("--") ||
      value.length === 0 ||
      value.trim() !== value ||
      name in found ||
      !(required.includes(name) || optional.includes(name))
    )
      throw new Error(USAGE);
    found[name] = value;
  }
  if (required.some((name) => !(name in found))) throw new Error(USAGE);
  return found;
}

const rootLabel = (value: string | undefined): string => {
  if (value === undefined || !/^[a-z0-9-]{1,63}$/u.test(value)) throw new Error(USAGE);
  return value;
};
const absolutePath = (value: string | undefined): string => {
  if (value === undefined || !isAbsolute(value) || value.length > 1_024) throw new Error(USAGE);
  return value;
};

export function parseHnsZoneAdoptionArgumentsV1(args: readonly string[]): HnsZoneAdoptionCommandV1 {
  const [step, ...rest] = args;
  if (step === "status") {
    return { step, root_label: rootLabel(options(rest, ["--root"])["--root"]) };
  }
  if (step === "write-records") {
    const found = options(rest, ["--root", "--change"], ["--minimum-validity-seconds"]);
    const change =
      found["--change"] === "add-wildcard-family"
        ? "add"
        : found["--change"] === "remove-wildcard-family"
          ? "remove"
          : undefined;
    const minimum =
      found["--minimum-validity-seconds"] === undefined
        ? HNS_ZONE_ADOPTION_DEFAULT_MINIMUM_VALIDITY_SECONDS
        : /^[1-9][0-9]{3,5}$/u.test(found["--minimum-validity-seconds"])
          ? Number(found["--minimum-validity-seconds"])
          : Number.NaN;
    if (change === undefined || !(minimum >= 3_600 && minimum <= 604_800)) throw new Error(USAGE);
    return {
      step,
      root_label: rootLabel(found["--root"]),
      change,
      minimum_serving_validity_seconds: minimum,
    };
  }
  if (step === "observe") {
    const found = options(rest, ["--root", "--out"]);
    return { step, root_label: rootLabel(found["--root"]), out: absolutePath(found["--out"]) };
  }
  if (step === "adopt") {
    const found = options(rest, [
      "--observation",
      "--expect-result-sha256",
      "--expect-delta",
      "--mode",
    ]);
    const delta = HNS_ZONE_ADOPTION_DELTA_KINDS.find((kind) => kind === found["--expect-delta"]);
    const mode = (["dry-run", "rehearse", "commit"] as const).find(
      (candidate) => candidate === found["--mode"],
    );
    const digest = found["--expect-result-sha256"];
    if (
      delta === undefined ||
      mode === undefined ||
      digest === undefined ||
      !/^[0-9a-f]{64}$/u.test(digest)
    )
      throw new Error(USAGE);
    return {
      step,
      observation: absolutePath(found["--observation"]),
      expected_result_sha256: digest,
      expected_delta: delta,
      mode,
    };
  }
  throw new Error(USAGE);
}

export type HnsZoneAdoptionCommandDependenciesV1 = Readonly<{
  readonly connect: () => Promise<Client>;
  readonly powerdns: PowerDnsRootProvisionConfig;
  readonly fetch: PowerDnsFetch;
  /** The serving path's observer. Reconciliation is no part of an adoption. */
  readonly observe: Omit<HnsRootReadinessObservationPorts, "reconcile_zone">;
  readonly observation_config: HnsRootReadinessObservationConfig;
  readonly executor_id: string;
  readonly read_file: (path: string) => Promise<Uint8Array>;
  /** Creates the file and fails if it exists. */
  readonly write_new_file: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly write: (line: string) => void;
}>;

/** Exit codes: 0 done, 1 failed or misused, 2 refused, 3 commit outcome unknown. */
export type HnsZoneAdoptionExitCode = 0 | 1 | 2 | 3;

/**
 * Error text that is safe to print: the fixed sentences this code and the
 * provider adapters raise. Anything carrying a URL, a credential or provider
 * output fails the pattern and is reported as unclassified.
 */
function printable(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Za-z0-9 .,:;_'()/-]{1,200}$/u.test(message) ? message : "unclassified";
}

async function withClient<A>(
  deps: HnsZoneAdoptionCommandDependenciesV1,
  use: (client: Client) => Promise<A>,
): Promise<A> {
  const client = await deps.connect();
  try {
    return await use(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

type Step = Readonly<Record<string, unknown>>;

/** Records whether each observer port returned or threw; the observer itself discards that. */
function traced<A extends unknown[], R>(
  steps: Step[],
  name: string,
  port: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args) => {
    const started = Date.now();
    try {
      const value = await port(...args);
      steps.push({ port: name, outcome: "returned", ms: Date.now() - started });
      return value;
    } catch (error) {
      steps.push({
        port: name,
        outcome: "threw",
        ms: Date.now() - started,
        reason: printable(error),
      });
      throw error;
    }
  };
}

async function status(
  command: Extract<HnsZoneAdoptionCommandV1, { step: "status" }>,
  deps: HnsZoneAdoptionCommandDependenciesV1,
): Promise<Step> {
  const state = await withClient(deps, (client) =>
    readHnsRootZoneAdoptionState(client, command.root_label),
  );
  return {
    outcome: "read",
    root_label: state.root_label,
    root_import_session_id: state.root_import_session_id,
    current_generation: state.current_generation,
    retained_zone_bytes_sha256: state.retained_zone_bytes_sha256,
    retained_zone_holds_wildcard_family: hnsZoneHoldsWildcardAddressFamilyV1({
      root_label: state.root_label,
      zone_bytes: state.retained_zone_bytes,
    }),
    open_renewal_jobs: state.open_renewal_jobs,
    serving_valid_until: state.serving_valid_until,
    serving_valid_for_seconds: state.serving_valid_for_seconds,
    gateway_deployment_reference: state.gateway_deployment_reference,
    dnssec_keyset_version: state.dnssec_keyset_version,
    stable_chain_delegation_snapshot_reference: state.stable_chain_delegation_snapshot_reference,
    database_time: state.database_time,
  };
}

async function writeRecords(
  command: Extract<HnsZoneAdoptionCommandV1, { step: "write-records" }>,
  deps: HnsZoneAdoptionCommandDependenciesV1,
): Promise<Step> {
  return withClient(deps, (client) =>
    withHnsRootZoneAdoptionFence(client, command, async (state, signal) => {
      if (state.challenge_txt_value === null || state.provision_result_bytes === null)
        throw new HnsZoneAdoptionRefusal("the root's session holds no provision result");
      const provision = decodeHnsAuthorityProvisionResultV1(
        state.provision_result_bytes,
        deps.observation_config.nameservers,
      );
      // Losing the fence stops the provider exchange that is under way.
      const fenced: PowerDnsFetch = (url, init) =>
        deps.fetch(url, {
          ...init,
          signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
        });
      const written = await makePowerDnsWildcardFamilyWriter(
        deps.powerdns,
        fenced,
      )({
        root_label: state.root_label,
        challenge_txt_value: state.challenge_txt_value,
        expected_ds_records: provision.ds_records,
        expected_managed_rrset_sha256: provision.managed_rrset_sha256,
        change: command.change,
      });
      return {
        outcome: written.changed ? "written" : "already_as_asked",
        change: command.change,
        root_label: state.root_label,
        current_generation: state.current_generation,
        retained_zone_bytes_sha256: state.retained_zone_bytes_sha256,
        serving_valid_for_seconds: state.serving_valid_for_seconds,
        ...written,
      };
    }),
  );
}

async function observe(
  command: Extract<HnsZoneAdoptionCommandV1, { step: "observe" }>,
  deps: HnsZoneAdoptionCommandDependenciesV1,
): Promise<Readonly<{ code: HnsZoneAdoptionExitCode; report: Step }>> {
  const state = await withClient(deps, (client) =>
    readHnsRootZoneAdoptionState(client, command.root_label),
  );
  if (state.publish_plan_bytes === null || state.provision_result_bytes === null)
    throw new HnsZoneAdoptionRefusal("the root's session holds no plan or provision result");
  const steps: Step[] = [];
  let artifact: Awaited<ReturnType<typeof observeHnsRootReadinessV1>>;
  try {
    artifact = await observeHnsRootReadinessV1({
      observation_attempt: {
        job_id: `hns-zone-adoption:${state.root_import_session_id}`,
        executor_id: deps.executor_id,
        lease_fence: 1,
      },
      operation_kind: "renew_health_v1",
      request: decodeHnsRootReadinessObservationRequestV1(
        hnsRootZoneAdoptionObservationRequestBytes(state),
      ),
      publish_plan_bytes: state.publish_plan_bytes,
      provision_result_bytes: state.provision_result_bytes,
      ports: {
        observe_current_resource: traced(steps, "chain", deps.observe.observe_current_resource),
        inspect_zone: traced(steps, "inspect", deps.observe.inspect_zone),
        observe_live: traced(steps, "live", deps.observe.observe_live),
        reconcile_zone: async () => {
          throw new Error("reconciliation is not part of an adoption");
        },
      },
      config: deps.observation_config,
    });
  } catch (error) {
    if (!(error instanceof HnsRootReadinessObservationError)) throw error;
    return {
      code: 2,
      report: { outcome: "observation_failed", reason: error.code, ports: steps },
    };
  }
  let delta: HnsZoneAdoptionDeltaKind | null = null;
  let deltaRefusal: string | null = null;
  try {
    delta = requireHnsZoneAdoptionDeltaV1({
      root_label: state.root_label,
      retained_zone_bytes: state.retained_zone_bytes,
      observed_zone_bytes: artifact.managed_zone_bytes,
    });
  } catch (error) {
    if (!(error instanceof HnsZoneAdoptionDeltaRefusal)) throw error;
    deltaRefusal = error.message;
  }
  const result = artifact.result;
  // The bindings adoption will require of this observation, compared here so
  // a mismatch is seen before the file is handed to `adopt`.
  const mismatched = [
    result.dnssec_keyset_reference !== state.dnssec_keyset_reference ||
    result.dnssec_keyset_version !== state.dnssec_keyset_version
      ? "dnssec_keyset"
      : null,
    result.gateway_deployment_reference !== state.gateway_deployment_reference
      ? "gateway_deployment_reference"
      : null,
    result.gateway_certificate_spki_sha256 !== state.gateway_certificate_spki_sha256
      ? "gateway_certificate_spki_sha256"
      : null,
    `hns-root-chain:${result.chain_resource_sha256}` !==
    state.stable_chain_delegation_snapshot_reference
      ? "stable_chain_delegation_snapshot_reference"
      : null,
  ].filter((name) => name !== null);
  await deps.write_new_file(command.out, artifact.result_bytes);
  return {
    code: 0,
    report: {
      outcome: "observed",
      root_label: state.root_label,
      observation: command.out,
      result_sha256: artifact.result_sha256,
      current_generation: state.current_generation,
      retained_zone_bytes_sha256: state.retained_zone_bytes_sha256,
      observed_zone_bytes_sha256: result.observed_zone_bytes_sha256,
      zone_equals_retained: result.observed_zone_bytes_sha256 === state.retained_zone_bytes_sha256,
      delta,
      delta_refusal: deltaRefusal,
      bindings_not_current: mismatched,
      powerdns_zone_serial: result.powerdns_zone_serial,
      observed_at: result.observed_at,
      valid_until: result.valid_until,
      open_renewal_jobs: state.open_renewal_jobs,
      ports: steps,
    },
  };
}

async function adopt(
  command: Extract<HnsZoneAdoptionCommandV1, { step: "adopt" }>,
  deps: HnsZoneAdoptionCommandDependenciesV1,
): Promise<Step> {
  const resultBytes = await deps.read_file(command.observation);
  const receipt = await withClient(deps, (client) =>
    adoptHnsRootZone(client, {
      result_bytes: resultBytes,
      expected_result_sha256: command.expected_result_sha256,
      expected_delta: command.expected_delta,
      mode: command.mode,
    }),
  );
  return {
    outcome: receipt.committed
      ? "committed"
      : command.mode === "rehearse"
        ? "rehearsed_and_rolled_back"
        : "would_adopt",
    ...receipt,
  };
}

export async function runHnsZoneAdoptionCommandV1(
  args: readonly string[],
  deps: HnsZoneAdoptionCommandDependenciesV1,
): Promise<HnsZoneAdoptionExitCode> {
  let command: HnsZoneAdoptionCommandV1;
  try {
    command = parseHnsZoneAdoptionArgumentsV1(args);
  } catch (error) {
    deps.write(
      JSON.stringify({
        command: "adopt-zone",
        outcome: "invalid_arguments",
        detail: error instanceof Error ? error.message : "invalid arguments",
      }),
    );
    return 1;
  }
  const print = (report: Step) =>
    deps.write(JSON.stringify({ command: "adopt-zone", step: command.step, ...report }));
  try {
    if (command.step === "status") print(await status(command, deps));
    else if (command.step === "write-records") print(await writeRecords(command, deps));
    else if (command.step === "adopt") print(await adopt(command, deps));
    else {
      const observed = await observe(command, deps);
      print(observed.report);
      return observed.code;
    }
    return 0;
  } catch (error) {
    if (error instanceof HnsZoneAdoptionRefusal || error instanceof HnsZoneAdoptionDeltaRefusal) {
      print({ outcome: "refused", reason: error.message });
      return 2;
    }
    if (error instanceof HnsZoneAdoptionCommitUnknown) {
      print({
        outcome: "commit_unknown",
        detail: "read the root's generation with the status step before any retry",
      });
      return 3;
    }
    print({
      outcome: "failed",
      reason: printable(error),
      // A record write that failed part way may have changed the zone. The
      // same step run again finishes it, and the observe step reads it.
      ...(command.step === "write-records" ? { zone_state: "unknown" } : {}),
    });
    return 1;
  }
}
