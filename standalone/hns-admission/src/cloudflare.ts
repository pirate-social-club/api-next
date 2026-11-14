import { Layer } from "effect";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import { OperationalModel } from "./model.ts";
import { AutomationLive } from "./automation.ts";
import type { HnsObserver } from "./service.ts";

/** Alchemy owns the actual Durable Object declarations and storage.
 * A host Worker must provide the real observer/access Layers before exposing HTTP.
 * No test adapter, transaction signer or submission route is selected here.
 */
export const admissionCloudflare = (observer: Layer.Layer<HnsObserver>) =>
  OperationalModel.layer(AutomationLive.pipe(Layer.provide(observer))).pipe(
    Layer.provide(DomainCloudflare.layerDurableObjects()),
    Layer.provideMerge(observer),
  );
