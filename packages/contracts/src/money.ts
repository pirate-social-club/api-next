import { Schema } from "effect";

/**
 * Branded money types (api-next 000 §5; 001 phase 0 step 3).
 *
 * Money crosses the wire as integer smallest units or decimal strings —
 * never JSON floats. The brand lives in contracts so server and generated
 * client both inherit it. Frozen shapes; coordinator-mediated changes only.
 *
 * v4 note: `brand` adds the nominal tag but no runtime check of its own, so
 * each schema carries its validation up front (Natural for integer smallest
 * units; a regex type guard for decimal strings).
 */

/** Whole cents, integer smallest unit. */
export const Cents = Schema.Natural.pipe(Schema.brand("Cents"));
export type Cents = typeof Cents.Type;

/** Atomic USDC (6 decimals), integer smallest unit. */
export const AtomicUsdc = Schema.Natural.pipe(Schema.brand("AtomicUsdc"));
export type AtomicUsdc = typeof AtomicUsdc.Type;

type DecimalStringBrand = { readonly DecimalString: unique symbol };
/** Exact decimal string (e.g. "12.345678"); used where precision is textual. */
export type DecimalString = string & DecimalStringBrand;

const isDecimalString = (u: unknown): u is DecimalString =>
  typeof u === "string" && /^\d+(\.\d+)?$/.test(u);

export const DecimalStringSchema = Schema.declare<DecimalString>(isDecimalString, {
  title: "DecimalString",
  description: "Exact decimal string; never a JSON float",
});
