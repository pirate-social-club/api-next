export const disabledTelegramConfiguration = JSON.stringify({
  version: 1,
  enabled: false,
  linking_enabled: false,
  practice_enabled: false,
});
export const telegramConfigurationFixture = {
  version: 1,
  enabled: true,
  linking_enabled: true,
  practice_enabled: false,
  public_origin: "https://pirate.example.invalid",
  webhook_origin: "https://api.example.invalid",
  credential_active_version: "v1",
  login_client_id: "123",
  login_redirect_uri: "https://pirate.example.invalid/telegram/link/callback",
} as const;
export const telegramBindingsFixture = {
  TELEGRAM_CONFIG_JSON: JSON.stringify(telegramConfigurationFixture),
  TELEGRAM_SECRETS_JSON: JSON.stringify({
    version: 1,
    credential_keys: { v1: "a".repeat(43) },
    login_client_secret: "fixture-secret",
  }),
  TELEGRAM_QUEUE: { send: async () => {} },
};
