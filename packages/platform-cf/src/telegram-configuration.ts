import { Schema } from "effect";

export interface TelegramConfigurationBindings {
  readonly TELEGRAM_CONFIG_JSON?: string | undefined;
  readonly TELEGRAM_SECRETS_JSON?: string | undefined;
}
const Configuration = Schema.Struct({
  version: Schema.Literal(1),
  enabled: Schema.Boolean,
  linking_enabled: Schema.Boolean,
  practice_enabled: Schema.Boolean,
  public_origin: Schema.optional(Schema.NonEmptyString),
  webhook_origin: Schema.optional(Schema.NonEmptyString),
  credential_active_version: Schema.optional(Schema.NonEmptyString),
  login_client_id: Schema.optional(Schema.NonEmptyString),
  login_redirect_uri: Schema.optional(Schema.NonEmptyString),
  practice_community_id: Schema.optional(Schema.NonEmptyString),
  practice_post_ids: Schema.optional(
    Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(8)),
  ),
});
const Credentials = Schema.Struct({
  version: Schema.Literal(1),
  credential_keys: Schema.Record(Schema.String, Schema.NonEmptyString),
  login_client_secret: Schema.optional(Schema.NonEmptyString),
});
function https(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}
/** Runtime and deployment use the same strict, non-secret feature intent. */
export function decodeTelegramConfiguration(bindings: TelegramConfigurationBindings) {
  try {
    if (!bindings.TELEGRAM_CONFIG_JSON || bindings.TELEGRAM_CONFIG_JSON.length > 16_384)
      throw Error();
    const config = Schema.decodeUnknownSync(Configuration, { onExcessProperty: "error" })(
      JSON.parse(bindings.TELEGRAM_CONFIG_JSON),
    );
    if ((config.linking_enabled || config.practice_enabled) && !config.enabled) throw Error();
    if (
      config.enabled &&
      (!https(config.public_origin) ||
        !https(config.webhook_origin) ||
        !config.credential_active_version)
    )
      throw Error();
    if (
      config.linking_enabled &&
      (!config.login_client_id ||
        !/^\d+$/.test(config.login_client_id) ||
        !https(config.login_redirect_uri))
    )
      throw Error();
    if (
      config.practice_enabled &&
      (!config.practice_community_id ||
        config.practice_community_id.length > 128 ||
        !config.practice_post_ids?.length ||
        config.practice_post_ids.some((id) => id.length > 128) ||
        new Set(config.practice_post_ids).size !== config.practice_post_ids.length)
    )
      throw Error();
    return config;
  } catch {
    // Schema and JSON errors can contain input values; never expose their cause.
    throw Error("Telegram compact configuration missing or invalid");
  }
}
export function decodeTelegramCredentials(bindings: TelegramConfigurationBindings) {
  try {
    if (!bindings.TELEGRAM_SECRETS_JSON || bindings.TELEGRAM_SECRETS_JSON.length > 16_384)
      throw Error();
    return Schema.decodeUnknownSync(Credentials, { onExcessProperty: "error" })(
      JSON.parse(bindings.TELEGRAM_SECRETS_JSON),
    );
  } catch {
    throw Error("Telegram compact credentials missing or invalid");
  }
}
