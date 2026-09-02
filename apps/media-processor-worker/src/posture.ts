import { isExplicitlyEnabled } from "@pirate/platform-cf/cloudflare-orchestration-primitives";

/** Provider effects stay disabled unless the binding is exactly `true`. */
export const isMediaProcessingEnabled = (value: string | undefined): boolean =>
  isExplicitlyEnabled(value);
