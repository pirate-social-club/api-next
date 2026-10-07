# HNS member publication

A hosted HNS grant enqueues publication in its issuing transaction. Migration
0246 also queues existing active hosted HNS grants. The provisioner reconciles
the current authority and accepted zone configuration under the existing root
session lock. Claim reads expose a host only while the publication receipt,
namespace authority and DNS health remain current. Publication failure does
not revoke the grant.

The publisher changes the exact member A, member TLSA and its ownership TXT
record. The marker binds the grant and record contents, allowing recovery from
a lost acknowledgement while refusing unrelated or subsequently modified
records. Address/certificate rotation and withdrawal reuse this path. The
existing root, app and wildcard record sets are retained.

The member address and certificate association come from the accepted zone the
readiness observer stored for the root, which is the canonical authority zone
(`{version, root_label, records}` with hexadecimal RDATA), not a provider rrset
list. A zone is bound to its session by the published challenge record. Its
provider account is not compared, because root provisioning adopts a delegated
zone that still carries an earlier reservation.

## Locks, scheduling and failure

A publication turn holds its own job row and the root session row, which is the
existing root zone mutation lock. It holds no grant, persona, community or
activation row while the provider is slow, so member-facing writes never wait
on DNS. Authority is evaluated again when the turn completes and on every claim
read; a change during the provider exchange therefore leaves the job preparing
and the next turn corrects the records.

A ready receipt is valid for twenty minutes and is checked again every five. A
single failed check keeps a receipt that is still valid, because a provider
timeout says nothing about the published records; a receipt that lapses
without a successful check returns the host to preparing. A withdrawn job is
re-evaluated every ten minutes without a provider call, so a host returns when
its authority does. A busy root defers the job by five seconds. Any other
failure while reading the job's context defers it with the ordinary backoff
and reports the SQLSTATE, so one bad job cannot hold the head of the queue.

Failures that prevent the queue from being read at all, such as a missing
migration or a missing grant, are logged as `executor_class: "members"`,
`outcome: "error"` with the SQLSTATE at most once a minute.

## Enabling publication

The provisioner publishes nothing unless `HNS_AUTHORITY_MEMBER_PUBLICATION` is
`enabled`. Installing a provisioner that contains this code, or applying the
migration, changes no member record by itself: jobs wait in the queue. Enable
the switch per environment only after the steps below.

## Runtime privileges and release order

The Worker needs no new grant. Its claim reads call
`hns_member_host_authorized_v1(text)` and `hns_member_host_ready_v1(text)`.
Both return one boolean about a grant, run with the function owner's rights
and remain executable by every service role, so they behave the same wherever
role names differ.

The role the provisioner logs in with needs EXECUTE on
`prepare_hns_member_host_publication_v1()` and
`complete_hns_member_host_publication_v1(text,text,bigint,bigint,text,text)`,
and nothing else: no privilege on the queue table and no read of grant, persona
or community tables. The migration grants both to
`hns_root_import_executor_login_v1` only when that role exists. Do not infer
the connected role from an example name. Where the provisioner uses another
login, including an environment where it shares the Worker runtime login, grant
both functions to that login explicitly and together; a role that can claim
but not complete would repeat the same job.

Apply the migration through the supported runner, grant the two functions to
the observed provisioner login, and confirm with that login that both are
executable. Install the provisioner with the switch unset and confirm it
serves its other work as before. Then set the switch and let the backfill
finish: the turns should log `ready` for existing active grants, and
`deferred_prepare_failed`, `error` or a growing `attempts` count on the queue
means stop and inspect.

Deploy the matched API, client and UI only after existing grants are ready.
The API that ships with this change reports a member host as available only
while its publication receipt is current, where the previous API reported it
whenever the sale namespace was effective. Deploying the API first would
therefore show every existing member host as unavailable until the
provisioner caught up.

## Acceptance still required

The source is not rollout acceptance. In the controlled authority fixture,
exercise a new claim, a backfilled grant, loss of the provider acknowledgement,
address/certificate rotation, authority loss and withdrawal. Verify the member
records on both authorities and retain unrelated records. Check that stale
publication receipts cannot advertise a Ready link.

No automated test yet drives the queue runner through a successful provider
exchange: the runner's database behaviour, the zone parser and the record
writer are tested separately, and the parser was checked against a real stored
zone. The first end-to-end success is therefore the staging run, and it is the
gate for anything further.

Through the normal staging UI, open one new name and one backfilled name at
the intended persona, reload while Preparing, and refuse an unclaimed host.
The saved browser value is only an opaque claim identifier; status reads still
require the authenticated same-origin session. Recovery never repeats quote,
reservation or claim writes. Production migration, backfill and DNS changes
require separate explicit authorization.

## Known limits

Every published member adds three record sets to the root zone, and each turn
reads the whole zone from both authorities. The zone transfer, the canonical
zone and the stored zone bytes are each bounded at one mebibyte, which a single
root reaches at some hundreds of members. One turn handles one job, so the
five-minute recheck also bounds how many ready hosts one provisioner can keep
current. Neither limit is close for the first communities; both need a
different design before a large one.

Member writes change the zone between the root's own readiness observations.
The observer records whatever it reads and retries on disagreement, but that
interaction has only been reasoned about, not measured.

## Disposable authority acceptance

Run `bun run test:hns-member-publication` with Docker, dig and delv installed
and the test's exact pinned PowerDNS image available locally. The test creates
a unique loopback-only authority with synthetic values and removes only that
container and its temporary files. Docker is capped at one CPU and 512 MB
without swap. It cannot be pointed at a deployed authority.

The test executes the product provisioner and member writer, simulates a lost
acknowledgement after the real provider accepts a write, retries, validates A
and TLSA answers with delv, rotates the address and certificate, refuses
unowned/conflicting records, withdraws the member twice, and verifies retained
root/app/wildcard and operator records. The DNSSEC anchor is the local zone key;
this proves zone validation, not the Handshake chain or browser routing. It
is explicit opt-in so the ordinary unit suite does not start Docker. It does
not substitute for queue-to-secondary or staging browser acceptance.
