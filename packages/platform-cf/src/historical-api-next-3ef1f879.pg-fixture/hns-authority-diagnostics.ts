import { Context, Effect, Exit } from "effect";
import {
  httpRequestDiagnostics,
  type WorkerDiagnosticFields,
} from "./worker-request-diagnostics.ts";

export const HNS_DIAGNOSTIC_ID_HEADER = "x-pirate-hns-diagnostic-id" as const;

const diagnosticIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export function isHnsDiagnosticId(value: string): boolean {
  return diagnosticIdPattern.test(value);
}

type AuthorityDiagnostic = Readonly<{
  emit: (fields: WorkerDiagnosticFields) => void;
  correlation_id: string;
}>;
export const HnsAuthorityDiagnostic = Context.Reference<AuthorityDiagnostic | undefined>(
  "@pirate/platform-cf/HnsAuthorityDiagnostic",
  { defaultValue: () => undefined },
);

export function makeHnsAuthorityDiagnostic(id: string | null): AuthorityDiagnostic | undefined {
  const current = httpRequestDiagnostics.current();
  return id === null || !isHnsDiagnosticId(id) || current === undefined
    ? undefined
    : { emit: current.emit, correlation_id: id };
}

export const withHnsAuthoritySpan = Effect.fn("hns.authority.diagnostic-span")(function* <A, E, R>(
  phase: "authority" | "client_initialization" | "connection_acquisition" | "query",
  effect: Effect.Effect<A, E, R>,
) {
  const diagnostic = yield* HnsAuthorityDiagnostic;
  if (diagnostic === undefined) return yield* effect;
  const startedAt = performance.now();
  diagnostic.emit({ phase, outcome: "started", correlation_id: diagnostic.correlation_id });
  return yield* effect.pipe(
    Effect.onExit((exit) =>
      Effect.sync(() => {
        diagnostic.emit({
          phase,
          outcome: Exit.isSuccess(exit)
            ? "success"
            : Exit.hasInterrupts(exit)
              ? "canceled"
              : "failed",
          correlation_id: diagnostic.correlation_id,
          elapsed_ms: Math.max(0, performance.now() - startedAt),
        });
      }),
    ),
  );
});
