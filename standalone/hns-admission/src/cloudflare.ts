import { Layer } from "effect";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import { AdmissionModel } from "./model.ts";

/** Alchemy owns the actual Durable Object declarations and storage.
 * A host Worker must provide the real observer/access Layers before exposing HTTP.
 * No test adapter, transaction signer or submission route is selected here.
 */
export const AdmissionCloudflare = AdmissionModel.layer(Layer.empty).pipe(
  Layer.provide(DomainCloudflare.layerDurableObjects()),
);
