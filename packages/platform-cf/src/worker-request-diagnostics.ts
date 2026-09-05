import { AsyncLocalStorage } from "node:async_hooks";

export type WorkerDiagnosticFields = Readonly<{
  phase:
    | "request_entry"
    | "authority"
    | "client_initialization"
    | "connection_acquisition"
    | "query";
  outcome?: "started" | "success" | "failed" | "canceled";
  correlation_id?: string;
  elapsed_ms?: number;
}>;
export type WorkerRequestDiagnostic = Readonly<{
  instance_id: string;
  request_sequence: number;
  first_request_on_instance: boolean;
  worker_version: string | null;
  worker_role: "http";
  emit: (fields: WorkerDiagnosticFields) => void;
}>;

export function makeWorkerRequestDiagnostics(
  options: {
    readonly randomUUID?: () => string;
    readonly now?: () => number;
    readonly log?: (record: Readonly<Record<string, string | number | boolean | null>>) => void;
  } = {},
) {
  const storage = new AsyncLocalStorage<WorkerRequestDiagnostic>();
  const now = options.now ?? (() => performance.now());
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const log = options.log ?? ((record) => console.info("worker.diagnostic", record));
  let instanceId: string | undefined;
  let sequence = 0;
  return {
    current: () => storage.getStore(),
    run<A>(version: string | null, use: () => A): A {
      const requestStartedAt = now();
      instanceId ??= randomUUID();
      const requestSequence = ++sequence;
      const identity = Object.freeze({
        instance_id: instanceId,
        request_sequence: requestSequence,
        first_request_on_instance: requestSequence === 1,
        worker_version: version,
        worker_role: "http" as const,
      });
      const emit = (fields: WorkerDiagnosticFields): void => {
        try {
          log({ ...identity, ...fields, request_offset_ms: Math.max(0, now() - requestStartedAt) });
        } catch {
          /* Diagnostics cannot change admission. */
        }
      };
      const context = Object.freeze({ ...identity, emit });
      return storage.run(context, () => {
        emit({ phase: "request_entry" });
        return use();
      });
    },
  };
}

export const httpRequestDiagnostics = makeWorkerRequestDiagnostics();
