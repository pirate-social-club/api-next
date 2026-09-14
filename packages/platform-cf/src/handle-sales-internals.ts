import {
  type ControlPlaneError,
  type ControlPlaneTransaction,
  HandleSalesRejected,
  HandleSalesStorageFailed,
} from "@pirate/application";
import { Effect } from "effect";

export type Row = Readonly<Record<string, unknown>>;

export const storage = (reason: HandleSalesStorageFailed["reason"]): HandleSalesStorageFailed =>
  new HandleSalesStorageFailed({ reason });

export const reject = (
  reason: HandleSalesRejected["reason"],
  retryable = false,
  effectiveOfferingId?: string,
): HandleSalesRejected =>
  new HandleSalesRejected({
    reason,
    retryable,
    ...(effectiveOfferingId === undefined ? {} : { effectiveOfferingId }),
  });

const mapControlPlaneError = (error: ControlPlaneError): HandleSalesStorageFailed => {
  if (error._tag === "ControlPlaneTransactionOutcomeUnknown") return storage("outcome-unknown");
  if (error._tag === "ControlPlaneOperationTimedOut" && error.outcomeCertainty === "unknown") {
    return storage("outcome-unknown");
  }
  if (error._tag === "ControlPlaneStatementFailed" && error.sqlState !== null) {
    return storage("constraint");
  }
  return storage("unavailable");
};

export const mapped = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, ControlPlaneError> | HandleSalesStorageFailed, R> =>
  effect.pipe(
    Effect.mapError((error) =>
      typeof error === "object" && error !== null && "_tag" in error
        ? error._tag === "ControlPlaneAcquireFailed" ||
          error._tag === "ControlPlaneOperationTimedOut" ||
          error._tag === "ControlPlaneStatementFailed" ||
          error._tag === "ControlPlaneTransactionOutcomeUnknown"
          ? mapControlPlaneError(error as unknown as ControlPlaneError)
          : (error as Exclude<E, ControlPlaneError>)
        : (error as Exclude<E, ControlPlaneError>),
    ),
  );

export const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${key}`);
  return value;
};

export const nullableText = (row: Row, key: string): string | null => {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`invalid ${key}`);
  return value;
};

export const integer = (row: Row, key: string): number => {
  const parsed = typeof row[key] === "number" ? row[key] : Number(row[key]);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid ${key}`);
  return parsed as number;
};

export const nullableInteger = (row: Row, key: string): number | null =>
  row[key] === null ? null : integer(row, key);

export const boolean = (row: Row, key: string): boolean => {
  if (typeof row[key] !== "boolean") throw new Error(`invalid ${key}`);
  return row[key] as boolean;
};

export const instant = (value: unknown): string => {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error("invalid instant");
  return parsed.toISOString();
};

export const bytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  throw new Error("invalid ciphertext");
};

export const stringArray = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("invalid string array");
  }
  return value;
};

export const advisoryLock = (
  transaction: ControlPlaneTransaction,
  namespace: number,
  parts: readonly string[],
  label: string,
) =>
  transaction.execute({
    label,
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
    values: [JSON.stringify(parts), namespace],
    readonly: false,
  });

export const one = (rows: readonly Row[], label: string): Row => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error(`invalid ${label} cardinality`);
  return rows[0];
};
