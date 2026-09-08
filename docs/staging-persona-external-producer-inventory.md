# External producer inspection

Read-only observation on 2026-09-06. All three hosts accepted the existing
SSH-agent identity as ubuntu with BatchMode enabled. sudo -n read-only access
also succeeded. The earlier failure was specifically root@94.103.168.161;
the request to repair the owner's SSH setup was incorrect and is withdrawn.
No service was stopped or restarted, no environment value was printed, and
no credential moved. Installed unit names do not establish their actual write
destinations or prove a maintained fence.

## CI host 94.103.168.209

zkpassport-verifier.service is active/running with Restart=on-failure. Its
environment file is /etc/pirate-zkpassport/zkpassport-verifier.env. The observed
variable names are ZKPASSPORT_VERIFIER_SHARED_SECRET,
ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET,
ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID,
ZKPASSPORT_VERIFIER_WRITING_DIRECTORY, HOST and ZKPASSPORT_VERIFIER_PORT.
There is no API or PostgreSQL URL key in that file; this does not exclude
hard-coded destinations, unit-level variables or subprocess writes.

The deployed working directory is
/opt/pirate/zkpassport-verifier/current/packages/zkpassport-verifier-runtime.
Its src/server.ts, src/index.ts and package.json match the reviewed local
copies byte-for-byte, respectively SHA-256
de98e5de72ad5c1814f98295303213c809d5892ef1c5c633c78d7f7f0bb8ab11,
2f93b9e28b6275ed94d66b6a77c1620f75d3ad6bd48e67f4976b187dba9bc881 and
4ee4fe41e2254868ef4849204c7f9d67bf1a60487758bd842a8b5db27c4278fa.
The reviewed implementation serves /health and /verify, delegates proof
verification to the pinned SDK and signs responses. It has no SQL or API write
client; writingDirectory is SDK-local filesystem state. The HTTP Worker owns
verification persistence.

Disposition: retain this verifier in the inventory as an inbound verification
dependency, not a demonstrated direct database writer. Conservatively include
it in the staging stop/hold set for the window, with its exact pre-window state
and reversal. This is a plan, not a stop receipt. Recheck the deployed source
and service configuration when establishing the fence. The previously
inventoried Radicle node and broker are separate from this service.

## Primary authority 94.103.168.161

pirate-hns-authority-provisioner.service is active/running, Restart=on-failure,
and reads /etc/pirate/hns-authority-provisioner.env. CONTROL_PLANE_POSTGRES_URL
is present. Its other keys configure HNS_AUTHORITY executor/environment, DNS,
gateway, chain, HSD and PowerDNS settings. Values were not emitted.

A server-side redacted comparison reported environment_is_production=true and
staging_branch_suffix=false. The configured SQL hostname hash is
5f3cee527863bf06e3d8ed075b31d2cd978893d0e989098f1c1190fecb876fc4;
the independently bound staging operator/runtime hostname hash is
e4bbc875b3bf38a54f0f7c65aaef800553cb9a298e31bd28bd5e992bb650d9c3.
These observations distinguish the configured destination from staging.
A later live-process read bound MainPID to this exact systemd unit through
its cgroup and confirmed MainPID was unchanged after inspection. Its actual
process environment reports the same production assertion and hostname digest,
with neither the staging nor rehearsal branch suffix. The only PostgreSQL URL
parameter names are options and sslmode. Values were not emitted.
Disposition: exclude this observed running provisioner from the staging and
rehearsal writer sets; revalidate that process/target binding when establishing
the live fence. Do not stop this production service under staging-only authority.

The other installed units comprise community-app-gateway and its shadow,
platform-gateway and its disabled shadow, disabled public-gateway,
observer-driver, verifier, DoH resolver and health/alert pair, DANE health/alert
pair, RRSIG health/alert pair, state-backup and alert template, spaced,
spaces-verifier and its health/alert pair, and deployment-verify/role-alert
templates. Each name has the pirate- prefix and .service suffix; concrete
deployment-check instances cover authdns, backup, doh, gateway, observer,
spaces and verifier. Unit-file inventory is separate from loaded-state inventory.

Environment-file names were inspected for every loaded pirate unit. Deployment
checks expose DEPLOY_ROOT and OPS_ALERT webhook/token-file names, with additional
ROLE, CORE_COMMIT, IMAGE_DIGEST, CONTAINER_NAME, EXPECT_RUNNING and DEPLOYED_AT
keys on the DoH check. The observer exposes HSD reference/RPC/port names.
The HNS verifier exposes HNS chain, PowerDNS and observer-auth names. Spaces
units expose Bitcoin/SPACED RPC, publisher, Fabric and chain-health names.
The backup exposes storage credentials, retention, state directories,
BACKUP_QUIESCE_UNITS, DEPLOY_ROOT and alert names. The resolver exposes
HNSD_DATA_DIR. No values were emitted. Units with no EnvironmentFiles property
still require inline-environment and deployed-command review.

Disposition for these remaining primary units: do not stop production services
by inference. Their destination review is outstanding; classify each before
declaring the external writer set complete. Alert/webhook names alone do not
prove an API write destination. This inventory is intentionally not a fence
receipt or an assertion that all producers have been excluded.

## Secondary authority 81.15.150.159

The pirate unit-file inventory contains deployment-verify and role-alert
templates only; the secondary instances read
/etc/pirate-deployment-verify/secondary.env. Its observed keys are DEPLOY_ROOT,
OPS_ALERT_WEBHOOK_URL and OPS_ALERT_BEARER_TOKEN_FILE. Disposition: destination
review pending before exclusion; no stop is authorized merely from the name.

## Recovery ordering

An isolated rehearsal can be prepared without fencing the live source. The
authoritative final data-bearing capture remains inside the continuous fence
under the approved reset amendment. An earlier provider backup may support
rehearsal but does not replace that final recovery capture. No capture or
provider restore was created during this host inspection. Subsequently an
authorized rehearsal-only backup, xvvo8r6tcaa5, was requested on the bound
staging main branch syu03e00w3ux at 2026-09-06T04:10:41Z. Its initial readback
was running, unprotected, with expiry 2026-10-06T04:10:41Z. The strict backup
verifier refused that incomplete state as expected. It is not final recovery
evidence and no reset is authorized by that pending status. Later readback
confirmed completion at 2026-09-06T04:12:06.131Z. An isolated restore was then
requested as persona-reset-rehearsal-20260906, branch 0ny029b910ob, using the
source's observed PS_5_AWS_ARM cluster size. Initial restore state was pending,
ready=false. Retain this branch for rehearsal; no runtime binding targets it.
Completion of a backup or branch creation does not prove recovery contents,
extension availability, privileges or successful execution of the reset runner.
