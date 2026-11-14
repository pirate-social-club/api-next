import { Config, Effect, Redacted, Schema } from "effect";
import { AccessProfile } from "./access.ts";
import { Hash } from "./records.ts";
import { strictJson } from "./strict-json.ts";
const Manifest = Schema.Struct({
  network: Schema.Literals(["main", "regtest"]),
  genesis: Hash,
  treeInterval: Schema.Int,
  nodes: Schema.Tuple([Schema.String, Schema.String]),
  profiles: Schema.Array(AccessProfile),
  publicationEnabled: Schema.Boolean,
});
export const loadConfig = Effect.gen(function* () {
  const raw = yield* Config.String("HNS_ADMISSION_MANIFEST");
  const authA = yield* Config.Redacted("HNS_OBSERVER_A_AUTHORIZATION");
  const authB = yield* Config.Redacted("HNS_OBSERVER_B_AUTHORIZATION");
  const manifest = yield* Effect.try({
    try: () =>
      Schema.decodeUnknownSync(Manifest)(strictJson(raw), {
        onExcessProperty: "error",
      }),
    catch: () => new Error("invalid_admission_manifest"),
  });
  if (
    manifest.profiles.length === 0 ||
    manifest.profiles.length > 50 ||
    manifest.profiles.some((p) => p.network !== manifest.network)
  )
    return yield* Effect.fail(new Error("invalid_admission_profiles"));
  for (const value of manifest.nodes) {
    const url = new URL(value);
    if (manifest.network === "main" && url.protocol !== "https:")
      return yield* Effect.fail(new Error("observer_https_required"));
  }
  return {
    ...manifest,
    nodes: [
      { url: manifest.nodes[0], authorization: Redacted.value(authA) },
      { url: manifest.nodes[1], authorization: Redacted.value(authB) },
    ] as const,
  };
});
