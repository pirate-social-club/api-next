import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import { Effect, Layer } from "effect";
import HnsAdmissionWorker from "./src/worker.ts";

export default Alchemy.Stack(
  "HnsAdmission",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      DomainCloudflare.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* HnsAdmissionWorker;
    return { url: worker.url };
  }),
);
