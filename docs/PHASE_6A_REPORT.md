# Phase 6a delivery report

4 November 2026, Asia/Manila. **Checkpoint 6a tooling and documentation are ready for owner review.**

## Delivered

- The [operator runbook](RELEASE_RUNBOOK.md) covers private Git setup, read-only deploy keys, verified tags, Ubuntu provisioning, isolated staging, separate PostgreSQL roles and credentials, systemd, Caddy, firewall, SSH, NTP, alerts, deployments and rollback. It gives minimum and recommended sizing with measurements to record on staging. The deploy archive excludes seeds, QA entry points and tests.
- The production-mode bootstrap uses a named first administrator, an individually chosen temporary password, baseline WORK and SECURITY settings, an unconfigured PAY policy and a bound upload verifier. A separate operation creates the named second administrator after the first confirms MFA. The operator tools validate the exact loopback target and require an explicit production flag. QA fixtures and seed refuse production.
- The Linux runner uses disposable PostgreSQL 18 clusters, random loopback ports, a sanitized environment, independent keyrings and private roots, a disposable Next checkout, and process-group supervision. Linux copies only permitted tracked sources. Storage hardening distinguishes POSIX case sensitivity and Windows path comparison, rejects UNC roots, and rechecks the single-link invariant when opening private files. Existing fixture coverage now includes the Linux permissions and hard-link cases when run on Linux.
- Backup waits for open shifts within a configurable window. A PostgreSQL lock and second check guard against a racing Clock In before the app stops. The paired dump and private files are encrypted, transferred offsite and verified by read-back. Restore requires the independently recorded ciphertext digest, the matching release and a fresh database. It checks published file hashes, rebinds the upload capability and invalidates restored auth artifacts.
- The [staging UAT script](RELEASE_UAT.md), [security and privacy checklist](RELEASE_SECURITY.md), and [evidence form](RELEASE_EVIDENCE.md) cover all Section 15 scenarios, staging capacity, open-shift backup behavior and restore evidence. The schema remains at 56 migrations and 43 application tables.

## Verification results

| Check | Result |
| --- | --- |
| Windows full regression, first run | **153/153 unit and PostgreSQL tests plus 70/70 real HTTP tests** |
| Windows full regression, second run | **153/153 unit and PostgreSQL tests plus 70/70 real HTTP tests** |
| Inventory per full run | **223 passed, 0 failed, 0 skipped** |
| Clean migration replay | **56 migrations and 43 RLS-enabled application tables** |
| Separate backup lock check | Passed on disposable PostgreSQL. Open shifts prevent quiescence, and the final lock excludes a concurrent attendance writer |
| Typecheck, Prisma generation and production webpack build | Passed |
| Dependency audit | `pnpm audit` reported no known vulnerabilities |
| Release template and file safeguards | Bash and Python syntax checked. Caddy 2.11.8 adapted and validated the configuration. Synthetic archive traversal was rejected and the recognized hard-link pair survived extraction. The tracked-path guard rejected five forbidden paths in an alternate Git index |
| Ubuntu 24.04 and PostgreSQL 18 full run | **Pending owner-run staging evidence** |

The two Windows passes, replay and backup check used disposable clusters and private directories. Their recorded listeners closed and their scratch checkouts were removed. Caddy validation adapted configuration without deploying a site. Production seed and QA refusals and the bootstrap refusal without the explicit flag were checked locally.

## Run locally or on staging

On Windows, use `pnpm test:all:win`. The isolated replay and backup gate use `scripts/test-all-win.ps1 -Replay` and `scripts/test-all-win.ps1 -ReleaseChecks` through PowerShell. On the Ubuntu staging host, use `pnpm test:all:linux` from a full Git checkout and record the host versions, counts, cleanup and interruption results. [Commands and evidence form](RELEASE_EVIDENCE.md)

## Known gaps

- This workstation has no usable Linux runtime. The full Linux suite, interruption recovery, systemd unit execution and live proxy/TLS behavior require staging verification. The Ubuntu 24.04 and PostgreSQL 18 pass is a go-live gate.
- The offsite backup and restore workflow needs a staged end-to-end run with the owner's storage and credentials. Linux host provisioning, real-phone staging acceptance, restoration evidence, pilot and go-live decisions are pending.
- The existing React Flight not-found transport behavior remains. The security checklist verifies that foreign content stays hidden and protected APIs respond with HTTP 404.

## Owner decisions

Choose DNS names, the VPS layout and region, the private Git account, operator and administrator identities, offsite provider and key custodians, alert channels, maintenance window, and retention and recovery targets. Assign staging, privacy and payroll reviewers. The owner and accountant must approve PAY decisions before live payroll. Checkpoint 6b is a separate approval.
