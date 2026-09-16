# PostgreSQL probe evidence

These logs are from the local PostgreSQL 17 host harness on 2026-09-06.
No provider, staging or production database was called.

`pg-first.log` through `pg-fourth.log` preserve fixture/assertion mistakes.
`pg-fifth.log` is the first complete focused run: ten pass and one desired
regression red. `pg-final.log` reruns the final test name: eight pass, the same
regression red and two unrelated control timeouts under concurrent host load.
Neither a timeout increase nor a production change was used to conceal them.
The parent baseline document explains the exact implementation gap and the
assertions that the red case has not reached.

The committed text copies strip trailing whitespace only so source whitespace
checks remain useful. Original byte-for-byte stdout/stderr files remain under
`/tmp/participation-authority-pg-*.log` for the coordinator's archive capture.
