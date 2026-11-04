# Libetario release runbook

Checkpoint 6a supplies these instructions and templates. Use the staging sections on an owner-authorized, fresh staging target. Production provisioning, restore evidence, the pilot and general access are checkpoint 6b. The operator runs the commands and records results. Example DNS names and addresses must be replaced before use.

## 1. Capacity and environment layout

| Deployment | vCPU | RAM | Disk |
| --- | ---: | ---: | ---: |
| Minimum starting point for a single environment | 1 | 4 GB | 50 GB |
| Recommended for production and staging on one host | 2 | 8 GB | 100 GB |
| Separate staging VPS with fake data | 1 | 4 GB | 50 GB |

Use Ubuntu 24.04 LTS x86-64, a recorded patched Node.js 24.x, pnpm 11.25.0 and PostgreSQL 18. Minimum sizing assumes small file growth and one build at a time. Use a separate staging VPS if simultaneous usage or storage makes the shared host too tight. On staging, record peak build memory using `/usr/bin/time -v` and host-wide memory or systemd `MemoryPeak`, plus OOM events from the kernel journal. Record weekly `du -sh` for PostgreSQL, private files, releases and backup scratch, and check `df -h` and `df -i`. Rehearse backup at a representative data volume. Record the app outage, transfer time and scratch peak. Budget four times the source database plus private file size for this backup implementation, with an additional 256 MiB. Increase capacity if it cannot maintain at least 20% free disk through capture, if the build is killed or swaps persistently, or if capture exceeds the agreed downtime. [Hostinger VPS limits](https://www.hostinger.com/support/6976044-parameters-and-limits-of-hosting-plans-in-hostinger/)

| Target | DB | PostgreSQL loopback | Next loopback | HTTPS |
| --- | --- | ---: | ---: | --- |
| Stage | `libetario_stage` | 55433 | 3101 | `team-staging.example.com` |
| Prod | `libetario_prod` | 55432 | 3100 | `team.example.com` |
| Isolated restore drill | `libetario_restore_drill` | 55434 | 3102 if needed | Private test hostname |

Each environment gets its own cluster and service account even when sharing a VPS. Never reuse its keys, DB passwords or file roots. PostgreSQL and Next listen on IPv4 loopback only. The WordPress site adds a link to the final HTTPS hostname.

## 2. Private Git repository and release tags

On the workstation, create an **empty private repository** in the company Git account. Verify the visibility in the provider UI. Run the tracked-path guard and review the **existing history** for credentials, keys or private files before the first push. The guard checks the current index. Rotate an exposed credential and resolve any affected history before publishing it.

```powershell
pnpm release:check-tracked
git status --short
git remote -v
git remote add origin git@github.com:YOUR-COMPANY/YOUR-PRIVATE-REPO.git
git push -u origin main
```

Use the approved release commit to make an annotated tag. Record its commit SHA outside the VPS. Use a signed tag if the owner maintains signing keys, and verify the signature before deployment. Never retag a released version.

```powershell
git tag -a v0.1.0-rc.1 -m "Libetario staging release"
git rev-parse 'v0.1.0-rc.1^{commit}'
git push origin v0.1.0-rc.1
```

On each VPS, generate a separate SSH deploy key for the build account. Add its **public** key to the private repository as a deploy key with write access disabled. Verify the Git host's published host-key fingerprint before accepting it into the build account's known hosts. Keep the private key mode 0600 and the directory mode 0700. Revoke the key when replacing the host. The release comes from a tag archive. Git's export rules exclude test suites, QA fixtures and the development seed. [Read-only deploy keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)

## 3. Stage host provisioning

Verify the fresh OS and console access. Create a named sudo operator with key login and confirm a second SSH session. Apply the [firewall checklist](../deploy/security/firewall.md), then install the SSH, Fail2ban and journal templates from a verified copy of `deploy/`. Run `sudo sshd -t` and inspect `sudo sshd -T` before reload. Test key login and sudo again before closing the original connection. Enable Fail2ban, chrony and unattended upgrades. Review pending reboots and test the signed Ubuntu and PostgreSQL package origins with an unattended-upgrade dry run. [Ubuntu security updates](https://documentation.ubuntu.com/security/security-updates/)

```bash
cat /etc/os-release
uname -m
sudo apt update
sudo apt install -y ca-certificates curl git ufw fail2ban chrony unattended-upgrades age rclone python3 time postgresql-common
sudo timedatectl set-timezone UTC
sudo systemctl enable --now chrony fail2ban
chronyc tracking
chronyc sources -v
sudo unattended-upgrade --dry-run
```

Install Caddy from its signed repository instructions. Verify `caddy version` is at least 2.10 before using the provided request-body configuration. Enable HTTPS only for DNS pointing to this VPS. Do not add a CDN initially. Use Caddy's site-specific allowlist for staging and pre-cutover production. Test it from the intended phone or Wi-Fi. [Caddy installation](https://caddyserver.com/docs/install) · [Automatic HTTPS](https://caddyserver.com/docs/automatic-https)

Install PostgreSQL 18 using the official signed Ubuntu PGDG Apt instructions. Before installing the server on a fresh host, set `create_main_cluster = false` in `/etc/postgresql-common/createcluster.conf` so the package does not create a default cluster. If another cluster exists, stop and identify its owner before making changes. [PostgreSQL Apt repository](https://www.postgresql.org/download/linux/ubuntu/)

```bash
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
sudo apt install -y postgresql-18 postgresql-client-18
pg_lsclusters

TARGET=stage
PORT=55433
DB=libetario_stage
sudo pg_createcluster --port "$PORT" 18 "$TARGET" -- --auth-local=peer --auth-host=scram-sha-256
printf "listen_addresses = '127.0.0.1'\ntimezone = 'UTC'\npassword_encryption = 'scram-sha-256'\n" |
  sudo tee "/etc/postgresql/18/$TARGET/conf.d/90-libetario.conf" >/dev/null
sudo tee "/etc/postgresql/18/$TARGET/pg_hba.conf" >/dev/null <<EOF
local all postgres peer
host $DB libetario_migrator 127.0.0.1/32 scram-sha-256
host $DB libetario_runtime 127.0.0.1/32 scram-sha-256
host $DB libetario_auth 127.0.0.1/32 scram-sha-256
EOF
sudo pg_ctlcluster 18 "$TARGET" start
sudo -u postgres psql -X -h /var/run/postgresql -p "$PORT" -d postgres -v ON_ERROR_STOP=1 -v db="$DB" <<'SQL'
CREATE ROLE libetario_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE libetario_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE libetario_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE DATABASE :"db" OWNER libetario_migrator;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO libetario_runtime,libetario_auth;
SQL
sudo -u postgres psql -X -h /var/run/postgresql -p "$PORT" -d postgres
```

At the private psql prompt, use `\password libetario_migrator`, `\password libetario_runtime` and `\password libetario_auth`. Give each a different randomly generated password from the owner vault, ideally hex to avoid URL encoding. Exit with `\q`. The passwords belong only in the vault and the root-only environment files. A scratch cluster uses the same role names, a different port and an explicitly named empty `libetario_restore_…` database. Confirm `SHOW listen_addresses`, `SHOW TimeZone`, role flags and no public database listener.

Install the exact Linux x64 Node 24.x distribution selected from the Node release page. First provision an operator-trusted release keyring at `/etc/libetario/node-release.gpg` using Node's published release keys and fingerprints. Then use a fresh scratch directory to verify the signed list and archive before extracting:

```bash
set -euo pipefail
NODE_VERSION=v24.REPLACE.PATCH
[[ $NODE_VERSION =~ ^v24\.[0-9]+\.[0-9]+$ ]]
NODE_ARCHIVE="node-$NODE_VERSION-linux-x64.tar.xz"
NODE_SOURCE="https://nodejs.org/dist/$NODE_VERSION"
NODE_SCRATCH=$(mktemp -d)
cd "$NODE_SCRATCH"
for file in "$NODE_ARCHIVE" SHASUMS256.txt SHASUMS256.txt.sig; do
  curl --fail --silent --show-error --location "$NODE_SOURCE/$file" -o "$file"
done
sudo gpgv --keyring /etc/libetario/node-release.gpg SHASUMS256.txt.sig SHASUMS256.txt
grep -F "  $NODE_ARCHIVE" SHASUMS256.txt | sha256sum --check -
sudo install -d -m 0755 /opt/libetario-tools
sudo test ! -e "/opt/libetario-tools/node-$NODE_VERSION-linux-x64"
sudo tar -xJf "$NODE_ARCHIVE" -C /opt/libetario-tools --no-same-owner
sudo test ! -e /opt/libetario-tools/node
sudo ln -s "/opt/libetario-tools/node-$NODE_VERSION-linux-x64" /opt/libetario-tools/node
cd
export PATH=/opt/libetario-tools/node/bin:/usr/bin:/bin
node --version
sudo env PATH="$PATH" npm install --global pnpm@11.25.0
pnpm --version
```

[Node.js signed release verification](https://nodejs.org/en/download#verifying-binaries)

## 4. Build the tag and prepare secret files

Create the service and build identities once. Run these commands for a fresh staging host from the verified deploy checkout or tag:

```bash
TARGET=stage
sudo adduser --disabled-password --gecos '' libetario-build
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "libetario-$TARGET"
sudo install -d -m 0755 /opt/libetario "/opt/libetario/$TARGET" "/opt/libetario/$TARGET/releases"
sudo install -d -m 0700 "/etc/libetario/$TARGET"
sudo install -d -m 0755 "/var/lib/libetario/$TARGET"
sudo install -d -m 0700 -o "libetario-$TARGET" -g "libetario-$TARGET" "/var/lib/libetario/$TARGET/private"
sudo install -d -m 0700 "/var/lib/libetario/$TARGET/backup-scratch" "/var/lib/libetario/$TARGET/restore-scratch"
sudo -u libetario-build -H mkdir -m 0700 /home/libetario-build/.ssh
sudo -u libetario-build -H ssh-keygen -t ed25519 -f /home/libetario-build/.ssh/id_ed25519 -C "libetario-stage-read-only"
```

Register the public key and verify the host fingerprint as in §2. If unattended fetch uses an unencrypted deploy key, grant that key read-only access to this one repo and keep it off the app user. Then clone once:

```bash
sudo -u libetario-build -H git clone --no-checkout git@github.com:YOUR-COMPANY/YOUR-PRIVATE-REPO.git /home/libetario-build/libetario-source
```

For each build, set the intended tag and independently verified full commit. Review them before the archive is extracted. Keep a build log with no app secrets in the build environment.

```bash
set -euo pipefail
TARGET=stage
TAG=v0.1.0-rc.1
EXPECTED_COMMIT=REPLACE_WITH_FULL_COMMIT
SOURCE=/home/libetario-build/libetario-source
RELEASE="/opt/libetario/$TARGET/releases/$TAG"
[[ $TAG =~ ^v[0-9][a-zA-Z0-9._-]{0,49}$ && ! -e $RELEASE ]]
sudo -u libetario-build -H git -C "$SOURCE" fetch --tags origin
[[ $(sudo -u libetario-build -H git -C "$SOURCE" rev-parse "$TAG^{commit}") == "$EXPECTED_COMMIT" ]]
sudo install -d -m 0755 -o libetario-build -g libetario-build "$RELEASE"
sudo -u libetario-build -H git -C "$SOURCE" archive "$TAG" |
  sudo -u libetario-build -H tar -xf - -C "$RELEASE"
sudo -u libetario-build -H env PATH=/opt/libetario-tools/node/bin:/usr/bin:/bin RELEASE="$RELEASE" bash -c '
  set -e
  cd "$RELEASE"
  pnpm install --frozen-lockfile --package-import-method=copy
  /usr/bin/time -v pnpm build
'
printf '%s\n' "$TAG" | sudo tee "$RELEASE/RELEASE_TAG" >/dev/null
if [[ -d $RELEASE/.next/cache ]]; then sudo mv -- "$RELEASE/.next/cache" "$RELEASE/.next/build-cache"; fi
sudo ln -s "/var/cache/libetario-$TARGET" "$RELEASE/.next/cache"
sudo chown -hR root:root "$RELEASE"
```

For first installation only, create `current` after checking it is absent. Later deployments use the reviewed switch in §7. Install the verified unit files, root-run helpers and tmpfiles config:

```bash
[[ ! -e /opt/libetario/$TARGET/current && ! -L /opt/libetario/$TARGET/current ]]
sudo ln -s "$RELEASE" "/opt/libetario/$TARGET/current"
sudo install -d -m 0755 /usr/local/libexec
sudo install -m 0755 "$RELEASE"/deploy/bin/libetario-* /usr/local/libexec/
sudo install -m 0644 "$RELEASE"/deploy/systemd/*.service "$RELEASE"/deploy/systemd/*.timer /etc/systemd/system/
sudo install -m 0644 "$RELEASE/deploy/systemd/libetario-tmpfiles.conf" /etc/tmpfiles.d/libetario.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/libetario.conf
sudo systemd-analyze verify /etc/systemd/system/libetario*.service /etc/systemd/system/libetario*.timer
systemd-analyze calendar '*-*-* 02:30:00 Asia/Manila'
sudo systemctl daemon-reload
```

Create new files only. The command writes random values without echoing them. Use `sudoedit` in a private terminal to replace the URL placeholders with the vault passwords. Use the exact HTTPS hostname with no trailing slash. These files use simple shell assignments compatible with systemd `EnvironmentFile`. Keep any values containing JSON in single quotes and do not use shell expressions.

```bash
sudo bash <<'SH'
set -euo pipefail
set -C
umask 077
dir=/etc/libetario/stage
[[ ! -e $dir/runtime.env && ! -e $dir/operator.env ]]
session=$(openssl rand -hex 48)
mfa=$(openssl rand -base64 32)
upload=$(openssl rand -hex 32)
kid="stage-$(date -u +%Y%m%d)-$(openssl rand -hex 4)"
{
  printf '%s\n' NODE_ENV=production APP_PORT=3101 APP_ORIGIN=https://team-staging.example.com TRUST_PROXY=false
  printf '%s\n' 'DATABASE_URL=postgresql://libetario_runtime:REPLACE@127.0.0.1:55433/libetario_stage'
  printf '%s\n' 'AUTH_DATABASE_URL=postgresql://libetario_auth:REPLACE@127.0.0.1:55433/libetario_stage'
  printf 'SESSION_SECRET=%s\nMFA_ACTIVE_KEY_ID=%s\n' "$session" "$kid"
  printf "MFA_ENCRYPTION_KEYS='{\"%s\":\"%s\"}'\n" "$kid" "$mfa"
  printf 'UPLOAD_VALIDATION_KEY=%s\n' "$upload"
  printf '%s\n' PRIVATE_UPLOAD_ROOT=/var/lib/libetario/stage/private
} >"$dir/runtime.env"
{
  printf '%s\n' LIBETARIO_TARGET=stage LIBETARIO_DATABASE=libetario_stage LIBETARIO_DB_PORT=55433
  printf '%s\n' 'MIGRATION_DATABASE_URL=postgresql://libetario_migrator:REPLACE@127.0.0.1:55433/libetario_stage'
  printf '%s\n' BACKUP_REMOTE=offsite:libetario/stage BACKUP_WINDOW_START=02:30 BACKUP_WINDOW_END=03:30
  printf '%s\n' BACKUP_WAIT_SECONDS=900 BACKUP_POLL_SECONDS=15 BACKUP_CAPTURE_SECONDS=900 BACKUP_TRANSFER_SECONDS=3600
} >"$dir/operator.env"
SH
sudoedit /etc/libetario/stage/runtime.env
sudoedit /etc/libetario/stage/operator.env
sudo stat -c '%a %U %n' /etc/libetario/stage/{runtime,operator}.env
```

Back up the MFA keyring separately under owner-controlled encryption and access. Record key IDs, preserve historical keys for retained backups, and test retrieving a copy. Retain the session and upload secrets in protected recovery configuration. Losing all MFA keys requires re-enrollment. Generate fresh secrets separately for every environment. Changing the upload key requires stopping writers, changing the service secret and rebinding the verifier together with the bootstrap tool's `bind-upload` operation. An approved logo or licensed font must be local and read-only. [MFA key management](../README.md#mfa-keyring-backup-loss-and-rotation)

## 5. Migrate, create administrators and smoke test

Use the root-only operator wrapper. It sources the intended files and serializes deployments, backup, restore and reconciliation through the environment lock.

```bash
sudo /usr/local/libexec/libetario-ops stage pnpm db:migrate
sudo /usr/local/libexec/libetario-ops stage pnpm release:verify --allow-production
sudo /usr/local/libexec/libetario-ops stage pnpm release:bootstrap first-admin --allow-production --username stage.admin --email stage-admin@example.invalid
```

The bootstrap requires an empty application target and a private TTY. Type the confirmation and a vault-generated temporary password twice. The password is hidden and never an argument. Staging uses synthetic addresses. In production use the named owner's address and deliver the temporary password privately. Use the production-mode bootstrap on both environments. The development seed and QA fixtures remain blocked.

Substitute the Caddy hostnames and operator test CIDRs from [the template](../deploy/caddy/Caddyfile). For a single-host stage-only rehearsal, remove the production site block. Publish DNS, validate then reload Caddy:

```bash
sudo install -m 0644 "$RELEASE/deploy/caddy/Caddyfile" /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy libetario@stage.service
sudo systemctl reload caddy
sudo systemctl status libetario@stage.service --no-pager
curl -fsSI https://team-staging.example.com/login
```

Confirm HTTPS redirect, trusted certificate, nonce CSP, HSTS and cookie flags. From a permitted test client verify spoofed forwarding headers are replaced and Next cannot be reached directly. Use staging fixture rate-limit observations or an operator-only proxy header check and remove any diagnostic routing afterward. Then set `TRUST_PROXY=true` in the protected runtime file and restart. Sign in, change the password and confirm the first real authenticator. Create the second named administrator and repeat on their own phone. Store their recovery codes privately. Do not capture a QR or code in evidence.

```bash
sudo /usr/local/libexec/libetario-ops stage pnpm release:bootstrap second-admin --allow-production --username stage.backup --email stage-backup@example.invalid
```

Smoke check both independent sign-ins, empty PAY settings, absence of demo accounts, clock sync, service restart, ACL/RLS output and allowed file paths. Confirm the operator tools reject missing production flags. Run the [staging acceptance checklist](RELEASE_UAT.md).

## 6. Backups, restore and operational monitoring

Set up an offsite account separate from VPS access. Use a private AWS S3 or Backblaze B2 bucket with retention/immutability, or a separate SFTP backup host. Create a root-only `/etc/libetario/stage/rclone.conf` and run `sudo rclone --config /etc/libetario/stage/rclone.conf config` privately to configure the named remote. Scope it to this environment's prefix with create and read-back access and no delete permission. Keep recovery credentials separately. From an offline workstation generate an age keypair and keep the private identity off the VPS except during a restore. Put the public recipient line in `backup-recipients.txt` on the server. Use independent owner access to retain 14 daily, 8 weekly, 6 monthly and at least 30 days of pre-deploy restore points. The script labels weekly Sunday and monthly first-day copies in Manila time. Use prefix lifecycle policies for expiry and retain legal holds independently. [AWS Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-configure.html) · [Backblaze Object Lock](https://help.backblaze.com/hc/en-us/articles/360052973274-Object-Lock-FAQs)

The default backup schedule is 02:30 Manila with a 02:30–03:30 start window. Change both timer and window together. A timer override must clear `OnCalendar` before replacing it. `BACKUP_WAIT_SECONDS` bounds the wait for open shifts. The app remains running while waiting. If the wait expires, the backup fails and alerts. The backup never closes a shift itself. Once the first check is clear, a brief maintenance marker and database lock guard the second check against a concurrent Clock In. Capture the paired dump and entire private root while writers are stopped. The app restarts after local capture, then the script encrypts and transfers, reads back the encrypted bytes and records the verified SHA-256 and backup ID. Keep the journal receipt independently of the backup destination. Do not prune the last known-good copy after a failed backup. [PostgreSQL dump semantics](https://www.postgresql.org/docs/18/app-pgdump.html)

```bash
sudo /usr/local/libexec/libetario-ops stage pnpm release:backup --allow-production --on-demand
sudo systemctl enable --now libetario-reconcile@stage.timer libetario-backup@stage.timer libetario-health.timer
systemctl list-timers 'libetario-*'
sudo journalctl -u libetario-backup@stage.service -u libetario-reconcile@stage.service --since yesterday
```

Set the protected `/etc/libetario/alerts.curl` to the approved HTTPS notification endpoint and any authorization header in curl config syntax. The failure hook posts only unit, host, time and status. Set separate `heartbeat-backup-stage.curl` and `heartbeat-reconcile-stage.curl` files with the private success URLs issued by the external dead-man monitor. Configure alerts for overdue heartbeats and an independent HTTPS login probe and certificate renewal. Test each in staging. The host health timer checks disk, inodes, available memory and clock sync. The owner reviews app, job, Caddy and PostgreSQL journals, plus kernel OOM events, with the bounded journald template. Keep access logs off unless approved redaction and retention are configured.

After regular review of aged rejected uploads and payslip orphans, use the same lock:

```bash
sudo /usr/local/libexec/libetario-ops stage pnpm uploads:cleanup --allow-production
sudo /usr/local/libexec/libetario-ops stage pnpm payslips:cleanup --allow-production
```

Reconciliation runs at 01:30 Manila, uses bounded batches and alerts if due records remain. Review skipped backups promptly. After interruption, verify the job and writer lock are clear, inspect service state and the marker, then start the service and remove only the verified stale marker after it is healthy. A verified pre-deploy backup intentionally keeps the marker until cutover.

### Restore drill

1. Prepare an isolated scratch cluster with fresh migration and app role passwords and an **empty** `libetario_restore_drill` database. Use a separate root and matching tagged release under `/opt/libetario/scratch/current`. Create root-only `/etc/libetario/scratch/{runtime,operator}.env` using the scratch DB/port and a fresh session and upload capability. Include the separately recovered historical MFA keys. Keep the scratch app offline. Create `/var/lib/libetario/scratch/restore-scratch` mode 0700.
2. With separate offsite recovery credentials, fetch the selected `BACKUP_ID.age` into that directory, mode 0600. Place the recovered age private identity temporarily at `/etc/libetario/scratch/restore-identity.txt`, mode 0600. Obtain the ciphertext SHA-256 from the independently kept backup receipt. Run:

```bash
BACKUP_ID=REPLACE_WITH_VERIFIED_ID
BACKUP_SHA256=REPLACE_WITH_VERIFIED_SHA256
sudo /usr/local/libexec/libetario-ops scratch pnpm release:restore --allow-production --backup-id "$BACKUP_ID" --sha256 "$BACKUP_SHA256"
sudo /usr/local/libexec/libetario-ops scratch pnpm release:verify --allow-production
```

3. Confirm the restore completed against the intended empty target. It verifies manifest and file hashes, restores schema and ACLs, verifies 43 RLS tables and all AVAILABLE files, revokes sessions including expired reauthentication handles, invalidates challenges and reset tokens, and binds the fresh upload capability. The verified bytes are staged as `restored-private`. With a scratch service identity already provisioned and the scratch app still off, move the restored directory into place only if the scratch private root is absent:

```bash
set -e
sudo test ! -e /var/lib/libetario/scratch/private
sudo test ! -L /var/lib/libetario/scratch/private
sudo mv -T -- /var/lib/libetario/scratch/restored-private /var/lib/libetario/scratch/private
sudo chown -hR libetario-scratch:libetario-scratch /var/lib/libetario/scratch/private
```

Use a private HTTPS scratch origin, fresh sign-in, an actual authenticator and A/B private attachment and payslip checks. Verify totals and historical approvals. Keep the encrypted archive per retention and remove the temporary decryption identity from the host.
4. Record timings, digests, role probes, authorized and denied checks, scope and scratch disposal in the [evidence form](RELEASE_EVIDENCE.md). If a validation fails after PostgreSQL restore, keep the failed target offline and create a fresh scratch target for the next attempt. A complete offsite restore rehearsal must pass before go-live.

## 7. Staging updates and rollback

Build the next tag before opening the maintenance window. Rehearse upgrade and rollback on staging with synthetic data. For a same-cluster schema upgrade, hold one operator lock through the paired pre-deploy backup and migration. The backup command only leaves the app stopped after offsite verification and never stops it when shifts are open.

```bash
sudo /usr/local/libexec/libetario-ops stage /bin/bash --noprofile --norc
# This shell is root and holds the stage operations lock until exit.
set -euo pipefail
TAG=v0.1.0-rc.2
[[ $TAG =~ ^v[0-9][a-zA-Z0-9._-]{0,49}$ ]]
NEW="/opt/libetario/stage/releases/$TAG"
[[ $(cat "$NEW/RELEASE_TAG") == "$TAG" ]]
pnpm release:backup --allow-production --on-demand --leave-stopped
cd "$NEW"
pnpm db:migrate
pnpm release:verify --allow-production
ln -s "$NEW" /opt/libetario/stage/current.next
mv -Tf /opt/libetario/stage/current.next /opt/libetario/stage/current
systemctl start libetario@stage.service
systemctl is-active libetario@stage.service
curl -fsS -o /dev/null http://127.0.0.1:3101/login
rm -- /run/libetario/stage/maintenance
exit
```

If any step fails, keep maintenance in place and inspect before reopening. Roll back the symlink only when the previous build is compatible with the live schema. Otherwise preserve the failed target, create a separate clean cluster with the canonical database name on a new port, and restore the paired pre-deploy point with `--prepare-cutover` and the exact `--backup-id` and `--sha256`. Use a root-only operator environment for the new port. The service must be inactive and the marker present. The restore tool leaves verified bytes in `restored-private`. Preserve the old root and DB separately, switch the approved roots and all matching URLs while offline, verify the restored version and use fresh sessions. If user writes occurred after cutover, preserve and reconcile them before approving data loss. Recovery remains offline until the owner confirms the validation checks.

## 8. Account, access and release operations

Review **Security** and **Audit** in the admin app for failed login, lockout, reset and duty actions. Honor configured lockout expiry. Use logout, account disable and duty revoke to remove the applicable access. A user who knows their password and has a recovery code can enroll again. Use another administrator's verified reset for a lost phone and missing codes. Use a separate verified password reset if needed. For last-admin MFA recovery, use a private operator terminal with the migration owner and explicit flag:

```bash
sudo /usr/local/libexec/libetario-ops stage pnpm mfa:reset-admin --username stage.admin --allow-production
```

The existing CLI displays the one-time token to the private terminal. Do not capture terminal output and deliver it through the approved password-manager channel. Loss of both the last administrator's password and MFA is an owner recovery decision. Keep a second confirmed administrator and test independent sign-in before general access.

Before release, pass [Linux and release evidence](RELEASE_EVIDENCE.md), [staging UAT](RELEASE_UAT.md) and the [security and privacy checklist](RELEASE_SECURITY.md). Production PAY starts unconfigured. The owner/accountant publishes the approved decisions before live payroll. Production provisioning and pilot are recorded separately in 6b.
