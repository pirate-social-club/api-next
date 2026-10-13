export { Clock, IdGen } from "../../ports.ts";
export * from "../../study-v2-service.ts";

// HTTP receives the controlled ordinary service shape, not its private capture primitives.
import type { makeControlledAccountSpokenService } from "../../controlled-account-spoken.ts";
export type ControlledAccountStudySpokenService = ReturnType<
  typeof makeControlledAccountSpokenService
>;
