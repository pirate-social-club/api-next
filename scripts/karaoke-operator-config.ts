import { Schema } from "effect";
import { ReconciliationDigest as Digest } from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384));
export const KaraokeOperatorConfig = Schema.Struct({
  version: Schema.Literal("staging-karaoke-operator-config-v1"),
  directory: Text,
  collectorPath: Text,
  collectorSourceDigest: Digest,
  collectorPublicKeyPem: Text,
  epoch: Digest,
  bucket: Text,
  residualDispositionId: Digest,
  expectedHistory: Schema.Record(Schema.String, Schema.Array(Digest).check(Schema.isMaxLength(64))),
  operator: Schema.Struct({
    API_NEXT_ENV: Schema.Literal("staging"),
    KARAOKE_RESET_ENABLED: Schema.Literal("true"),
    KARAOKE_RESET_ACCESS_ISSUER: Text,
    KARAOKE_RESET_ACCESS_AUDIENCE: Text,
    KARAOKE_RESET_ACCESS_SUBJECT: Text,
  }),
});
