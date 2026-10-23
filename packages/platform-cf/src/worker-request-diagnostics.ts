import { AsyncLocalStorage } from "node:async_hooks";

export type WorkerDiagnosticFields = Readonly<{
  phase:
    | "request_entry"
    | "authority"
    | "client_initialization"
    | "connection_acquisition"
    | "query"
    | "study_request"
    | "study_transcription"
    | "study_archive";
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
  database_correlation_id?: string;
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
    /** Bind internal operation timings to this same request, without exposing
     * its route, account, audio, SQL or provider response. Existing diagnostic
     * ownership wins; nested work never invents another request/instance. */
    correlateDatabase<A>(use: () => A): A {
      const current = storage.getStore();
      if (current === undefined || current.database_correlation_id !== undefined) return use();
      let correlationId: string;
      try {
        correlationId = randomUUID();
      } catch {
        return use();
      }
      return storage.run(
        Object.freeze({ ...current, database_correlation_id: correlationId }),
        use,
      );
    },
    run<A>(version: string | null, use: () => A, databaseCorrelationId?: string): A {
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
      const context = Object.freeze({
        ...identity,
        emit,
        ...(databaseCorrelationId === undefined
          ? {}
          : { database_correlation_id: databaseCorrelationId }),
      });
      return storage.run(context, () => {
        emit({
          phase: "request_entry",
          ...(databaseCorrelationId === undefined ? {} : { correlation_id: databaseCorrelationId }),
        });
        return use();
      });
    },
  };
}

export const httpRequestDiagnostics = makeWorkerRequestDiagnostics();
