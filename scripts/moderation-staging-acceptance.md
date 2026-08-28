# Moderation staging acceptance

This verifier turns a staging test transcript into one sanitized digest. It
does not create accounts, alter policy, upload media, call a provider, or retain
request content. It refuses production origins.

Collect evidence with three dedicated staging accounts—a community owner, an
ordinary non-owner, and a viewer without an adult-age receipt—and a disposable
community. Do not seed a staging adult-age receipt or add a fixture provider.
The adult-capable branch is exercised in the isolated PostgreSQL suite with a
synthetic accepted-provider receipt in a disposable schema; a real passport
ceremony belongs to verification acceptance. Use harmless text and synthetic
clean artwork. Provider failure is tested by a
controlled staging deployment with `OPENAI_MODERATION_ENABLED=false`; do not
damage or replace the API key. Suspected-minor escalation is tested only with a
stubbed provider verdict in the automated adapter suite. Never source or upload
illegal or exploitative material.

The evidence JSON supplied on stdin has these sections:

- `attestation`: status from an authenticated route before and after the same
  account accepts the 16+ attestation.
- `locked_resources`: the complete object observed in home feed, post detail,
  and public community threads for an adult-rated post viewed without adult
  capability.
- `rating_ancestry`: stored parent and child ratings before and after an atomic
  parent-rating raise.
- `prospectivity`: the evaluation policy revision read before and after changing
  the community's current policy.
- `legacy_action`: the fresh V1 refusal and the original and replayed committed
  response bodies.
- `authority`: owner and non-owner action statuses. Non-owner access must be
  redacted as not-found.
- `text_provider`: clean, flagged, and deliberately disabled outcomes.
- `cover`: clean projection, withheld projection, and public-object fetch status.

Run the verifier without putting session cookies, CSRF values, raw text, object
URLs, provider payloads, or account identifiers in the evidence file:

```sh
bun scripts/moderation-staging-acceptance.ts < /secure/path/evidence.json
```

Success emits only `environment`, the check count, and a SHA-256 digest. Keep
the source transcript outside Git and delete it according to the staging test
retention plan after the result is recorded.
