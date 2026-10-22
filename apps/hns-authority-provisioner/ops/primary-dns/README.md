# Primary authoritative DNS

This directory independently owns the production PowerDNS role adopted from the exact live source recorded in scripts/hns-deployment/source-adoption.json. Root creation, DNSSEC and TLSA lifecycle mutations belong to the maintained api-next authority provisioner. The former manual TLSA CLIs and their legacy verifier imports are retired; they are deliberately absent.

Keep the SQLite database and DNSSEC keys in /srv/pirate-hns-authdns/shared/data across release replacement. Recover them from the daily encrypted state backup and verify their DNSKEY-derived DS records against the active chain before serving. Never generate replacement keys merely to make a restore start. The existing TSIG transfer secret and primary API key have managed-secret custody; a secondary can instead rebuild its database from authorized transfers.

The API listens only on loopback8081. Supply PDNS_API_KEY_CONFIG as an absolute path to a private runtime file containing the api-key setting. Mount that file read-only into pdns.d; never pass its value as a command argument or commit its contents. For the pinned image, verify the actual daemon UID/GID before setting root ownership and the narrow readable group. The current observed daemon UID is953. Keep the containing host directory restricted and prove both API authentication and absence of the key from the process argument vector after release.

RRSIG checks query both public authoritative serving paths. The six-day minimum leaves a margin around the weekly re-signing boundary; seven days falsely alarms during normal secondary lag. A secondary's hourly refresh is an interval, not guaranteed convergence. An expired or missing signature still fails. The DANE check independently compares the currently served certificate SPKI with every configured TLSA owner through both authorities.

Use the shared immutable release constructor and retain integrity checks. Do not enable a new release until isolated PowerDNS configuration/key loading, authenticated API access, signed queries, authorized transfers and effective unit/file/image checks pass. The live Caddy artifact is a separate ownership task; copying a historical manifest does not explain its production bytes.

The asset stager also rebuilds the retained production provisioner through the
fixed authority-provisioner profile. See scripts/hns-deployment/native-runtime-recovery.md
for its protected-base reconstruction, original manifest and managed runtime
inputs. The authdns verifier drop-in extends the existing check to the actual
provisioner and its read-only schema guard. This operational update preserves
PowerDNS, provisioner application bytes, signing keys, database state and
service identities. Stop only the verification timer during adoption; require
its local no-heartbeat pass and real scheduled hosted acknowledgement.
