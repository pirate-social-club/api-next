# Telegram interface localization

The bot owns English, Russian and Georgian interface catalogs in
packages/application/src/telegram/copy.ts. Practice bots open on the song list
and offer one Songs action, with no sign-in step. The language picker offers
English / Русский / ქართული when those catalogs are enabled. Discovery-only
bots offer browsing and help without advertising disabled practice.

## Offered languages

The compact configuration's optional interface_locales lists the catalogs a
deployment offers. It must include en and may add ru and ka. When it is absent
the bot offers English only: Telegram language suggestions, saved choices and
language callbacks for any other catalog fall back to English, and the language
picker row is hidden while only one language is offered. A code deploy therefore
cannot enable a catalog by itself. Add ru or ka to interface_locales only after
that catalog, including the song picker, practice and completion strings, has had
language-qualified review.

## Preference authority

A saved explicit bot interface choice wins. Otherwise a supported Telegram
language wins, followed by a saved automatic bot choice, a supported private
account UI preference, and English. Account preferences are accessible only
after a current bot grant, account association and active persona/community
binding. Linking an English website account cannot replace a saved Russian or
Georgian bot language, including on a callback without a Telegram language tag.
An automatic suggestion remains automatic; /start never invents explicit consent
to a language choice. Only a proven private sender can read or change
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
targets. Settings show an owned localized name for English, Russian, Georgian,
Chinese and Arabic helpers and point to Pirate to manage the preference. Other
languages safely retain the saved code. These labels do not qualify exercises.
This pilot practices English read-aloud lines; Russian/Georgian translation
exercises still require their separate corpus qualification. English song lines,
recognized answers, song titles, persona labels and identifiers remain data.

## Deployment and external metadata

Deploy in this order through the activation coordinator:

1. Read current staging serving identities, enabled flags and the actual runtime
   database role through managed workflows; capture no secret values. Confirm
   no competing staging writer before mutation.
2. Apply migration 0240 through the migration runner. The generated baseline
   and reset are for new/test schemas; do not run them over the live database.
3. Apply bounded preference-table permissions to the actual serving role:
   SELECT/INSERT/UPDATE allowed, DELETE/TRUNCATE refused. Use the reviewed
   roles.sql.example block with the verified role. Default DELETE grants on
   new tables must be revoked before upload. If inherited role membership still
   confers DELETE, stop and prepare a separate scoped privilege change; do not
   revoke permissions on unrelated tables or weaken default grants globally.
4. Run bun run db:preflight:telegram-activation using the same serving-role
   database connection as the candidate Workers. Require successful admission
   for both HTTP and jobs, including discovery-only operation.
5. Deploy reviewed source through scripts/deploy-worker-with-provenance.ts
   and capture fresh serving identities, bot delivery and language behavior.

This source review changes no serving grants, credentials or runtime flags.
Credential creation/rotation or permission changes remain subject to workspace
external-state policy; the activation owner must resolve applicable authority
for the exact operation before execution. Existing standing authorization is
not replaced with a new blanket approval requirement by this review.

Uploading first is unsafe: the new runtime guard fails closed when the table
is absent or DELETE remains effective, which would interrupt an enabled bot.
The activation preflight requires SELECT/INSERT/UPDATE and rejects DELETE/TRUNCATE and
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
every catalog key alongside English. Review song selection, voice instructions,
feedback, completion scores and next actions for accuracy and natural language.

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
