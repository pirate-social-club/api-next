# HNS member publication

A hosted HNS grant enqueues publication in its issuing transaction. Migration
0246 also queues existing hosted HNS grants. The provisioner reconciles the
current authority and accepted zone configuration under the existing root
session lock. Claim reads expose a host only while the publication receipt,
namespace authority and DNS health remain current. Publication failure does
not revoke the grant.

The publisher changes the exact member A, member TLSA and its ownership TXT
record. The marker binds the grant and record contents, allowing recovery from
a lost acknowledgement while refusing unrelated or subsequently modified
records. Address/certificate rotation and withdrawal reuse this path. The
existing root, app and wildcard record sets are retained.

## Runtime privileges and release order

Do not infer the connected database role from an example role name. Migration
0246 supplies its grants to api_next_app and the separate
hns_root_import_executor_login_v1 only when those roles exist. Shared staging
logins and other deployed Worker logins require an explicit reviewed mapping.
Reobserve the connected provisioner and Worker roles through the established
credential workflow before release, without exporting credentials.

For the observed provisioner role, require EXECUTE on
prepare_hns_member_host_publication_v1() and
hns_member_host_authorized_v1(text), plus SELECT and UPDATE on
hns_member_host_publications. The authorization helper uses a pinned
SECURITY DEFINER boundary, so the provisioner does not require direct reads
of member or persona tables. It does not need INSERT, DELETE or
TRUNCATE on the queue. The grant trigger is a pinned SECURITY DEFINER function.
For the observed Worker role, require SELECT on the queue and EXECUTE on the
authorized and ready projection functions, together with its existing handle
and authority read privileges. Verify effective privileges while using each
actual login; checking only the migration owner is insufficient.

Apply the migration through the supported runner, apply the reviewed role
grants, check the effective privileges, and only then start the provisioner
and deploy the matched API/client/UI. Test a connected provisioner transaction
that claims and rolls back one queued job before allowing DNS work. Do not
start this feature with only the example role installed.

## Acceptance still required

The source is not rollout acceptance. In the controlled authority fixture,
exercise a new claim, a backfilled grant, loss of the provider acknowledgement,
address/certificate rotation, authority loss and withdrawal. Verify the member
records on both authorities and retain unrelated records. Check that stale
publication receipts cannot advertise a Ready link.

Through the normal staging UI, open one new name and one backfilled name at
the intended persona, reload while Preparing, and refuse an unclaimed host.
The saved browser value is only an opaque claim identifier; status reads still
require the authenticated same-origin session. Recovery never repeats quote,
reservation or claim writes. The main merge hold and guarded published-main
staging deployment requirement remain binding. Production migration, backfill
and DNS changes require separate explicit authorization.

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
