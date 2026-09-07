import {
  handleKaraokeResetCaller,
  type KaraokeResetCallerBindings,
} from "@pirate/platform-cf/karaoke-reset-caller";
import type { StagingKaraokeResetCallerEnv } from "../worker-configuration.d.ts";

// Wrangler cannot infer a remote named entrypoint's RPC shape; bind it explicitly.
type Env = Omit<StagingKaraokeResetCallerEnv, "RESET_OPERATOR"> & KaraokeResetCallerBindings;

export default { fetch: (request: Request, env: Env) => handleKaraokeResetCaller(request, env) };
