# Telegram interface localization

The bot owns English, Russian and Georgian interface catalogs in
packages/application/src/telegram/copy.ts. First contact names the community,
explains English voice-note practice and owner access when practice is enabled,
and offers actions plus English / Русский / ქართული before sign-in. Discovery-only
bots offer browsing and help without advertising disabled practice.

## Preference authority

A saved explicit bot interface choice wins. Otherwise a supported private
account UI preference wins after a current bot grant, account association and
active persona/community binding; then a supported Telegram language, a saved
automatic choice, and English. Only a proven private sender can read or change
the bot choice. Preferences are scoped to community, stable bot ID and sender;
same-bot token/ingress rotation preserves them, while another bot cannot read
them. Writes from a stale bot epoch fail. Receipt timestamps fence reordered
writes of the same authority, and automatic choices never replace explicit ones.

Language tags use Intl.Locale canonicalization with a 64-character bound.
Supported regional variants resolve to en, ru or ka. Explicit scripts must
match Latin, Cyrillic or Georgian respectively. Missing, malformed, unsupported
and incompatible-script tags are ignored; they cannot erase a saved choice.

/language, /settings and /preferences reopen the picker. Language callbacks
are separate from Study callbacks and never submit answers, call voice grading
or replace the current presentation. Previously queued replies keep their
original language so delivery retries do not change an accepted reply.

Interface language, account Study helper language and exercise learning language
remain separate. Interface changes never write account preferences or exercise
targets. Settings show the saved helper code and point to Pirate to manage it.
This pilot practices English read-aloud lines; Russian/Georgian translation
exercises still require their separate corpus qualification. English song lines,
recognized answers, song titles, persona labels and identifiers remain data.

## Deployment and external metadata

Apply migration 0240, the generated baseline and bounded preference-table role
access before deploying this change to any enabled Telegram bot. The activation
preflight requires SELECT/INSERT/UPDATE and rejects DELETE/TRUNCATE and
owner-equivalent permissions on the preference table. Existing linking and
practice admission checks remain in force.

The repository has no setMyCommands, setMyDescription or setMyShortDescription
registration path. Telegram command menus, bot descriptions and the bot's
external identity are operator-owned BotFather/Bot API configuration. This
change localizes in-chat actions and responses; it has not changed external
metadata. The staging operator must inventory the live metadata and register
language-specific command descriptions for en/ru/ka before cohort acceptance,
advertising only enabled commands. No credentials or external settings were
created or changed by implementation tests.

## Acceptance boundary

The owned Russian/Georgian copy is a draft for review. The audit handoff exports
every catalog key alongside English. Review owner recording access,
cross-bot identity correlation, no-reward wording, voice instructions and
feedback for accuracy, natural language and consent clarity.

This API change does not translate the website. The separately registered Solid
task owns sign-in, persona, consent, account management and return pages. A
bounded journey slice can precede general translated-content runtime work, but
requires owned Russian/Georgian catalogs, a durable host UI preference and
SSR/OIDC return handling. A query-string locale alone is insufficient: the
current callback scrubber drops it and the transaction parser does not retain it.

Unit, PostgreSQL and Worker checks are technical evidence. They do not establish
live flags, credentials, Telegram delivery, translated website behavior or phone
acceptance. Full acceptance still requires language review and a complete
ten-card phone lesson in Russian and Georgian after the activation and web
journey dependencies are ready.
