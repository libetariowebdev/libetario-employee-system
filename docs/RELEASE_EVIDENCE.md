# Release verification and evidence form

Use synthetic data and redact account identifiers, cookies, QR codes, recovery codes, URLs containing credentials and payroll or file contents from any shared evidence. Record the exact tested commit and tag. A missing check remains pending.

## Required Linux run

Use an unprivileged operator account on Ubuntu 24.04 x86-64 with PostgreSQL 18 installed in `/usr/lib/postgresql/18/bin`, Python 3, Node 24 LTS and the project-pinned pnpm. Use a **clean full Git checkout**, since deploy archives omit tests. The runner does not use the system cluster. It creates two SCRAM clusters on distinct random loopback ports, an isolated Next port, unique keys and private roots under a mode-0700 scratch directory in `/tmp`. Its Linux supervisor owns and reaps the process group. It uses a sanitized child environment and invokes the existing `pnpm test` and `pnpm test:http` commands. The checkout gets a dependency-directory symlink and copies only tracked paths within the source allowlist after checking the index for forbidden paths. Never point the separate raw test commands at a production DB.

```bash
set -o pipefail
cat /etc/os-release
uname -m
node --version
pnpm --version
/usr/lib/postgresql/18/bin/postgres --version
python3 --version
git rev-parse HEAD
pnpm install --frozen-lockfile
pnpm release:check-tracked
mkdir -p test-results
pnpm test:all:linux 2>&1 | tee test-results/release-linux.log
pnpm test:all:linux --replay 2>&1 | tee test-results/release-linux-replay.log
pnpm test:all:linux --release-checks 2>&1 | tee test-results/release-linux-backup-gate.log
```

Expect **153 unit and PostgreSQL tests plus 70 HTTP tests**, zero failures/skips and **56 migrations with 43 RLS application tables**. Verify the scratch ID printed by the runner no longer exists and all reported test ports are closed. Use `ss -ltn` to inspect listeners. Run again and interrupt after a disposable server becomes ready. Confirm its scratch and listeners disappear and that a fresh replay succeeds. Normal completion, failures and catchable interruption are supervised. If the entire supervisor is forcibly killed or the machine fails, verify the exact recorded scratch identity and owned processes before manual cleanup. Never delete arbitrary `/tmp` paths or stop the system PostgreSQL cluster.

| Linux evidence | Record |
| --- | --- |
| Operator, date, OS and architecture | |
| Commit/tag and Node, pnpm, PostgreSQL versions | |
| Unit/integration count, HTTP count, failure/skip totals and log | |
| Clean replay count and RLS result | |
| Scratch ID and listener closure after full run | |
| Interruption outcome, scratch/port closure and recovery replay | |
| Linux case-sensitive paths, symlinks, exclusive/hard-link checks and mode 0400 evidence | |

**Go-live requires this pass on Ubuntu 24.04 and PostgreSQL 18.** A Windows run or syntax check does not satisfy it.

## Staging and host evidence

| Check | Record |
| --- | --- |
| Staging hostname, build commit/tag and role/proxy verification | |
| Build peak memory, host memory and OOM check | |
| Database/files/release/scratch disk measurements and inode use | |
| Systemd service, timers, time sync, log review and tested alerts | |
| Active-shift backup skip, no app stop, wait and alert evidence | |
| Idle backup, outage and transfer duration, checksum and retention destination | |
| Deployment and rollback rehearsal | |
| Blueprint 15.1–15.12 checklist and reviewer | |
| Privacy, security and owner sign-off | |

For the open-shift test, Clock In a fake staging employee, run an on-demand backup with a short wait inside the staging operator shell and watch the active service. Expect skip/alert, an unchanged open shift and no app stop. Clock Out and retry. Verify that the app reopens, the backup is paired and offsite read-back passed. Repeat around Clock In to cover the race and compare the service journal with actual punches.

## Offsite restore rehearsal

| Field | Record |
| --- | --- |
| Operator, date, scratch host/cluster and proof of isolation | |
| Backup ID, independent ciphertext SHA-256, release tag and capture time | |
| Owner-approved RPO/RTO and observed data age/restore time | |
| Decryption and archive member checks, matching key IDs | |
| Schema, 43 RLS tables, role grants and restricted connection checks | |
| Matching private bytes, SHA-256 and authenticated/denied download checks | |
| Sessions, challenges and reset-token invalidation and fresh MFA | |
| Attendance, payroll snapshot and payment history verification | |
| Scratch teardown and recovery identity removal | |
| Reviewer, result, deviations and remediation | |

No go-live approval until one offsite rehearsal passes. Production provisioning, initial production backup verification, pilot participation and go-live decision are recorded during 6b.
