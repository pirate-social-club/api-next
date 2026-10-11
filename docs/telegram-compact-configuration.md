# Telegram Worker configuration

Telegram uses `TELEGRAM_CONFIG_JSON` for non-secret configuration and
`TELEGRAM_SECRETS_JSON` for credentials. `TELEGRAM_QUEUE` remains a separate
Cloudflare resource binding. HTTP and jobs use the same versioned format.
The previous individual Telegram text settings are not read as a fallback.

Every checked-in environment declares all three feature switches false.
Missing, invalid or unknown configuration fields disable Telegram and emit a
fixed configuration diagnostic without including the input. Runtime setup
failures leave unrelated routes and scheduled jobs available. Deployment
refuses invalid configuration rather than skipping its permission guard.

The following non-secret example enables the staging practice pilot on HTTP.
Replace the catalogue and login registration with the exact reviewed values.
For jobs, leave `linking_enabled` false and omit the unused login fields.

```json
{
  "version": 1,
  "enabled": true,
  "linking_enabled": true,
  "practice_enabled": true,
  "public_origin": "https://web-next-staging.pirate.sc",
  "webhook_origin": "https://api-next-staging.pirate.sc",
  "credential_active_version": "v1",
  "login_client_id": "123456789",
  "login_redirect_uri": "https://web-next-staging.pirate.sc/telegram/link/callback",
  "practice_community_id": "the-reviewed-staging-community",
  "practice_post_ids": ["the-reviewed-ready-song"]
}
```

The JSON secret contains `version: 1`, a `credential_keys` object mapping key
versions to the existing vault's wrapping keys, and, on HTTP with linking
enabled, `login_client_secret`. It must be provisioned through the approved
secret store and reviewed runtime workflow. Never place it in `vars`, source,
logs, chat, a command argument or evidence. Jobs does not need a login secret.
The active wrapping key must be shared by HTTP and jobs under the existing
credential-vault contract. Community bot tokens remain encrypted application
data entered through Community settings; they are not Worker configuration.

The compact format does not change permissions or admission. Runtime services
still check the actual serving role before use. The deployment wrapper decodes
the same feature intent and retains Telegram, rewards and HNS preflights.
Practice still requires staging, one explicit community, one to eight distinct
ready song IDs, transcription credentials and learner audio storage. Its
sessions remain permanently practice-only and cannot earn rewards.

The binding-capacity tests simulate fully enabled practice and HTTP linking,
including the combined secret. With the declared non-Telegram inventory, HTTP
uses 124 text bindings and jobs uses 47. Before live activation, reconcile
actual serving secrets and all proposed bindings against the reviewed inventory
and Cloudflare's limit. Unexpected retained secrets can change these counts.
Source integration alone neither provisions credentials nor enables Telegram.
