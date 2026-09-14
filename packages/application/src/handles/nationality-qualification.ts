import type { HandleNationalityQualificationProgressV1 } from "@pirate/contracts";
import type { Effect } from "effect";
import type { HandleSalesFailure } from "./sales.ts";
export type HandleNationalityQualificationStore = Readonly<{
  getProgress: (
    input: Readonly<{ accountId: string; intentId: string }>,
  ) => Effect.Effect<HandleNationalityQualificationProgressV1, HandleSalesFailure>;
}>;
