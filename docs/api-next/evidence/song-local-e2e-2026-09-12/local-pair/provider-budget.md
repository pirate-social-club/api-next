# Provider budget for the local fixture journey

The cumulative ceilings were specified under the owner's directive to tighten
the provider budget: ACRCloud 2, OpenAI 3, OpenRouter 1, ElevenLabs 1. They are
cumulative for the exercise and are not renewed by restarting a processing
session. `provider-ledger.json` is the source of truth for consumed and
remaining allowances, and `prepare-processing-workers.mjs` recomputes the
remaining allowance from it and bakes it into the local media processor guard.
A provider at or over its ceiling receives a zero allowance; any call throws
`provider-budget-exhausted` with JSON evidence.

Consumed to date: ACRCloud three, OpenAI three. ACRCloud is one request over
its ceiling of two, recorded plainly in the ledger overrun field. The three
runs each spent one identify request: the melody fixture run, the first
published noise run, and the uninterrupted fixed-frontend run. OpenAI is
exactly at its ceiling. No additional provider calls are authorized, so the
generated guard now refuses ACRCloud and OpenAI outright.

The instrumental fixture would otherwise need one ACRCloud identify request
and one OpenAI moderation call, and it skips the lyrics classifier and
alignment because it binds no lyrics. Any further paid test requires its own
cumulative ceilings to be authorized first and written into the ledger.
