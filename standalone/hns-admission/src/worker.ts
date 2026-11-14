import * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect, Layer } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { admissionCloudflare } from "./cloudflare.ts";
import { observerLayer } from "./hsd-observer.ts";
import { accessLayer } from "./access.ts";
import { loadConfig } from "./config.ts";
import { handle } from "./http.ts";

export default class HnsAdmissionWorker extends Cloudflare.Worker<HnsAdmissionWorker>()(
  "HnsAdmission",
  { main: import.meta.url, compatibility: { date: "2026-11-14" } },
  Effect.gen(function* () {
    const config = yield* loadConfig.pipe(Effect.orDie);
    const observer = observerLayer(config);
    const live = Layer.mergeAll(
      accessLayer(config.profiles, config.publicationEnabled),
      admissionCloudflare(observer),
    );
    return yield* Effect.gen(function* () {
      // Capture only initialized services; request I/O stays inside fetch.
      const context =
        yield* Effect.context<Effect.Services<ReturnType<typeof handle>>>();
      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const web = yield* HttpServerRequest.toWeb(request).pipe(
            Effect.orDie,
          );
          const response = yield* handle(web).pipe(
            Effect.provideContext(context),
          );
          response.headers.set("cache-control", "no-store");
          return HttpServerResponse.fromWeb(response);
        }),
      };
    }).pipe(Effect.provide(live));
  }),
) {}
