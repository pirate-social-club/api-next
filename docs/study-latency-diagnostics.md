# Study response timing

The October 22 phone observation measured spoken-answer requests at 13,590.5
and 15,042.3 ms. Response bodies took 7.8 and 5.2 ms. Ordinary Study session
reads also took 3,272.2 and 3,348.9 ms. Those observations do not separate request upload,
transport, authentication, database, archive or transcription time, and do not
establish a provider or host fault.

The HTTP Study handlers now give their existing request context an internal
random correlation. Existing explicit diagnostic ownership is retained.
Concurrent requests keep separate correlations and their original instance,
request sequence and Worker version. Correlation is added only inside an
existing Worker diagnostic context. Diagnostic sink or operation-correlation
generation failure cannot retry or reject an operation.

Workers Logs records under `worker.diagnostic` contain timing and outcome
metadata. They contain no account, persona, session, item or command identity,
route, SQL, parameters, recording, transcript, provider response or credential.
The correlation is not accepted from a participant and is not returned in an
API response. There is no contract, authentication, timeout, database command,
provider-call, recovery or financial behavior change.

`study_request` covers the handler's actual service operation. The existing
`client_initialization`, `connection_acquisition` and `query` phases use the
same correlation. `study_transcription` covers the actual transcriber effect,
including response consumption and decoding. `study_archive` covers the
captured archive protocol, including its database work and object storage. It
is not a measurement of object storage alone. A missing transcriber stays
unavailable, and retained successful continuations still avoid transcription.

For the next reviewed staging phone run, match records by Worker version,
instance and request sequence, then by correlation. Compare ordinary Study
reads and one normal spoken answer. `request_offset_ms` is measured from the
original Worker entry; the first `study_request` offset therefore also shows
the time before the handler operation. That gap can include composition,
authentication and body parsing. It does not distinguish those components.
The final outcome and elapsed fields distinguish a completed phase from a
failed or interrupted one without exposing its error contents.

Use phase intervals rather than adding all durations: database spans can nest
inside archive and total-operation spans. Browser and Worker clocks have
different origins, so compare durations rather than subtracting timestamps
from different clocks. These diagnostics still need actual serving evidence
before any latency cause or improvement is claimed. They are source-only
until a reviewed release supplies them; historical phone requests cannot be
attributed retroactively.
