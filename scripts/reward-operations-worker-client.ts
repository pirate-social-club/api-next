import { join } from "node:path";
import { Predicate, Schema } from "effect";
import type { RewardOperationsPlan } from "./reward-operations-plan.ts";
import {
  RewardOperationsRefusal,
  sanitizeRewardOperationsFailure,
} from "./reward-operations-report.ts";
import {
  decodeRewardWorkerDescriptor,
  RewardVersionId,
  type RewardWorkerDescriptor,
} from "./reward-operations-worker-policy.ts";

export type RewardWorker = RewardOperationsPlan["workers"]["http"];
export type RewardWorkerClient = {
  authenticate(worker: RewardWorker, signal: AbortSignal): Promise<void>;
  serving(worker: RewardWorker, signal: AbortSignal): Promise<RewardWorkerDescriptor>;
  versions(
    worker: RewardWorker,
    signal: AbortSignal,
  ): Promise<{ id: string; message: string; createdAt: number }[]>;
  view(worker: RewardWorker, id: string, signal: AbortSignal): Promise<RewardWorkerDescriptor>;
  patch(worker: RewardWorker, settings: unknown, signal: AbortSignal): Promise<void>;
  deploy(worker: RewardWorker, id: string, message: string, signal: AbortSignal): Promise<void>;
  hyperdrive?(id: string, signal: AbortSignal): Promise<unknown>;
};

export async function boundedRewardOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    throw signal.reason instanceof RewardOperationsRefusal
      ? signal.reason
      : new RewardOperationsRefusal("deadline");
  }
  let cancel: () => void = () => {};
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        cancel = () =>
          reject(
            signal.reason instanceof RewardOperationsRefusal
              ? signal.reason
              : new RewardOperationsRefusal("deadline"),
          );
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function readWithBoundedRetry<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = rewardReadDelay,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await boundedRewardOperation(operation(), signal);
    } catch (error) {
      const failure = sanitizeRewardOperationsFailure(error);
      if (
        signal.aborted ||
        attempt === 3 ||
        !(
          failure.reason === "transport" ||
          failure.status === 429 ||
          (failure.status !== undefined && failure.status >= 500)
        )
      )
        throw error;
      await boundedRewardOperation(sleep(attempt * 1000, signal), signal);
    }
  }
}

export async function rewardReadDelay(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(resolve, ms);
      cancel = () =>
        reject(
          signal.reason instanceof RewardOperationsRefusal
            ? signal.reason
            : new RewardOperationsRefusal("deadline"),
        );
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
  }
}

const Versions = Schema.Array(
  Schema.Struct({
    id: RewardVersionId,
    annotations: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    metadata: Schema.Struct({ created_on: Schema.String }),
  }),
);
const Deployment = Schema.Struct({
  versions: Schema.Array(Schema.Struct({ version_id: RewardVersionId, percentage: Schema.Number })),
});
const Version = Schema.Struct({
  annotations: Schema.Record(Schema.String, Schema.Unknown),
  resources: Schema.Struct({
    script: Schema.Struct({ etag: Schema.String }),
    script_runtime: Schema.Record(Schema.String, Schema.Unknown),
    bindings: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  }),
});
const Token = Schema.Struct({
  status: Schema.Literals(["active", "disabled", "expired"]),
  expires_on: Schema.optional(Schema.String),
  not_before: Schema.optional(Schema.String),
});

type CommandRunner = (
  args: readonly string[],
  env: Record<string, string>,
  signal: AbortSignal,
) => Promise<{ stdout: string; exitCode: number }>;

/** Credentials stay in memory and are injected identically into API and CLI calls. */
export function createRewardWorkerClient(input: {
  root: string;
  plan: RewardOperationsPlan;
  token: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  command?: CommandRunner;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): RewardWorkerClient {
  if (!input.token.trim()) throw new RewardOperationsRefusal("authentication");
  const now = input.now ?? Date.now;
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    CLOUDFLARE_API_TOKEN: input.token,
    CLOUDFLARE_ACCOUNT_ID: input.plan.accountId,
    WRANGLER_SEND_METRICS: "false",
  };
  async function command(args: readonly string[], signal: AbortSignal) {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    try {
      return await rawCommand(args, requestSignal);
    } catch (error) {
      if (requestSignal.aborted && !signal.aborted) throw new RewardOperationsRefusal("transport");
      throw error;
    }
  }
  async function rawCommand(args: readonly string[], signal: AbortSignal) {
    signal.throwIfAborted();
    let result: { stdout: string; exitCode: number };
    if (input.command)
      result = await boundedRewardOperation(input.command(args, env, signal), signal);
    else {
      const proc = Bun.spawn([join(input.root, "node_modules/.bin/wrangler"), ...args], {
        cwd: input.root,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const cancel = () => proc.kill("SIGKILL");
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        const [stdout, exitCode] = await boundedRewardOperation(
          Promise.all([new Response(proc.stdout).text(), proc.exited]),
          signal,
        );
        result = { stdout, exitCode };
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    }
    if (result.exitCode !== 0 || result.stdout.length > 2_000_000)
      throw new RewardOperationsRefusal("provider");
    if (args[0] === "versions" && args[1] === "deploy") return undefined;
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new RewardOperationsRefusal("provider");
    }
  }
  function args(worker: RewardWorker, action: readonly string[]) {
    const label =
      worker.name === input.plan.workers.http.name
        ? "http"
        : worker.name === input.plan.workers.jobs.name
          ? "jobs"
          : undefined;
    if (!label) throw new RewardOperationsRefusal("identity-drift");
    return [
      ...action,
      "--config",
      `apps/${label}-worker/wrangler.jsonc`,
      "--env",
      input.plan.environment,
      "--name",
      worker.name,
    ];
  }
  async function api(path: string, signal: AbortSignal, settings?: unknown) {
    const parentSignal = signal;
    signal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
    const form = settings === undefined ? undefined : new FormData();
    if (form) form.set("settings", JSON.stringify(settings));
    let response: Response;
    try {
      response = await boundedRewardOperation(
        (input.fetch ?? fetch)(`https://api.cloudflare.com/client/v4/${path}`, {
          method: form ? "PATCH" : "GET",
          ...(form ? { body: form } : {}),
          signal,
          headers: { authorization: `Bearer ${input.token}` },
        }),
        signal,
      );
    } catch (error) {
      if (parentSignal.aborted)
        throw parentSignal.reason instanceof RewardOperationsRefusal
          ? parentSignal.reason
          : new RewardOperationsRefusal("deadline");
      if (error instanceof RewardOperationsRefusal) throw error;
      throw new RewardOperationsRefusal("transport");
    }
    let text: string;
    try {
      text = await boundedRewardOperation(response.text(), signal);
    } catch {
      throw parentSignal.aborted
        ? parentSignal.reason instanceof RewardOperationsRefusal
          ? parentSignal.reason
          : new RewardOperationsRefusal("deadline")
        : new RewardOperationsRefusal("transport");
    }
    if (text.length > 2_000_000) throw new RewardOperationsRefusal("provider", response.status);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new RewardOperationsRefusal("provider", response.status);
    }
    if (!response.ok || !Predicate.isObject(value) || Reflect.get(value, "success") !== true)
      throw new RewardOperationsRefusal(
        response.status === 401 || response.status === 403 ? "authentication" : "provider",
        response.status,
      );
    return Reflect.get(value, "result") as unknown;
  }
  const view: RewardWorkerClient["view"] = async (worker, id, signal) => {
    const value = await readWithBoundedRetry(
      () => command(args(worker, ["versions", "view", id, "--json"]), signal),
      signal,
      input.sleep,
    );
    try {
      const version = Schema.decodeUnknownSync(Version)(value);
      return decodeRewardWorkerDescriptor({
        id,
        etag: version.resources.script.etag,
        runtime: version.resources.script_runtime,
        bindings: version.resources.bindings,
        message: version.annotations["workers/message"],
      });
    } catch {
      throw new RewardOperationsRefusal("identity-drift");
    }
  };
  return {
    view,
    hyperdrive: (id, signal) =>
      readWithBoundedRetry(
        () => api(`accounts/${input.plan.accountId}/hyperdrive/configs/${id}`, signal),
        signal,
        input.sleep,
      ),
    async authenticate(worker, signal) {
      const raw = await readWithBoundedRetry(
        () => api("user/tokens/verify", signal),
        signal,
        input.sleep,
      );
      try {
        const token = Schema.decodeUnknownSync(Token)(raw);
        if (
          token.status !== "active" ||
          (token.not_before !== undefined && !(Date.parse(token.not_before) <= now()))
        )
          throw new RewardOperationsRefusal("authentication");
        if (token.expires_on !== undefined && !(Date.parse(token.expires_on) - now() >= 1_200_000))
          throw new RewardOperationsRefusal("expiry");
      } catch (error) {
        throw error instanceof RewardOperationsRefusal
          ? error
          : new RewardOperationsRefusal("authentication");
      }
      await readWithBoundedRetry(
        () =>
          api(
            `accounts/${input.plan.accountId}/workers/scripts/${worker.name}/versions/${worker.baseline.id}`,
            signal,
          ),
        signal,
        input.sleep,
      );
    },
    async serving(worker, signal) {
      const value = await readWithBoundedRetry(
        () => command(args(worker, ["deployments", "status", "--json"]), signal),
        signal,
        input.sleep,
      );
      const deployment = Schema.decodeUnknownSync(Deployment)(value);
      if (deployment.versions.length !== 1 || deployment.versions[0]?.percentage !== 100)
        throw new RewardOperationsRefusal("split-deployment");
      return view(worker, deployment.versions[0].version_id, signal);
    },
    async versions(worker, signal) {
      const raw = await readWithBoundedRetry(
        () => command(args(worker, ["versions", "list", "--json"]), signal),
        signal,
        input.sleep,
      );
      const versions = Schema.decodeUnknownSync(Versions)(raw);
      const result = versions.map((version) => ({
        id: version.id,
        message: Predicate.isString(version.annotations?.["workers/message"])
          ? version.annotations["workers/message"]
          : "",
        createdAt: Date.parse(version.metadata.created_on),
      }));
      if (
        !result.length ||
        result.some((version) => !Number.isFinite(version.createdAt)) ||
        new Set(result.map((v) => v.id)).size !== result.length
      )
        throw new RewardOperationsRefusal("identity-drift");
      result.sort((a, b) => a.createdAt - b.createdAt);
      if (result.length > 1 && result.at(-1)?.createdAt === result.at(-2)?.createdAt)
        throw new RewardOperationsRefusal("latest-mismatch");
      return result;
    },
    async patch(worker, settings, signal) {
      await api(
        `accounts/${input.plan.accountId}/workers/scripts/${worker.name}/settings`,
        signal,
        settings,
      );
    },
    async deploy(worker, id, message, signal) {
      await command(
        args(worker, ["versions", "deploy", `${id}@100`, "--yes", "--message", message]),
        signal,
      );
    },
  };
}
