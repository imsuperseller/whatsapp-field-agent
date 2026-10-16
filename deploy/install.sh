#!/usr/bin/env bash
# Install Bobot's gateway on the the server server, prove it, or put the old one back.
#
# Why this exists (2026-09-22): the gateway used to be hand-copied into /opt/waha
# from a laptop. Nothing recorded what was running, and each install needed a
# human to paste a command. This is the only install path now; the
# "Deploy WhatsApp Gateway (Bobot)" workflow runs it on every change to this
# folder on main.
#
# Steps: back up the files the services load, copy the new ones, syntax-check
# them on the server, restart the webhook receiver, then run the end-to-end
# probe. If any step after the copy fails, the backup is restored and the
# receiver restarted, and the script exits non-zero.
#
# Env: VPS_HOST, VPS_USER (default root@<server-ip>). Needs ssh access.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${VPS_USER:-root}@${VPS_HOST:-<server-ip>}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-${GITHUB_SHA:-local}"
BACKUP="/opt/waha/.deploy-backups/${STAMP:0:40}"
FILES=$(node -e "console.log(require('$HERE/deploy/runtime-files.json').join(' '))")
SSH=(ssh -o ConnectTimeout=15 -o BatchMode=yes "$TARGET")

echo "::group::Back up the running gateway to $BACKUP"
"${SSH[@]}" "set -e; mkdir -p '$BACKUP'; cd /opt/waha; for f in $FILES; do [ -f \"\$f\" ] && cp -p \"\$f\" '$BACKUP/'; done; ls '$BACKUP'; ls -1dt /opt/waha/.deploy-backups/* | tail -n +11 | xargs -r rm -rf"
echo "::endgroup::"

rollback() {
  echo "::error::Install failed — restoring $BACKUP"
  "${SSH[@]}" "set -e; cp -p '$BACKUP'/* /opt/waha/; systemctl restart waha-webhook; sleep 3; systemctl is-active waha-webhook" || true
}

echo "::group::Copy the new gateway"
for f in $FILES; do
  scp -q -o ConnectTimeout=15 -o BatchMode=yes "$HERE/$f" "$TARGET:/opt/waha/.incoming-$f"
done
# Move into place only once every file has arrived, so the receiver never loads
# a half-copied set.
"${SSH[@]}" "set -e; cd /opt/waha; for f in $FILES; do node --check \".incoming-\$f\"; done; for f in $FILES; do mv -f \".incoming-\$f\" \"\$f\"; done" || { rollback; exit 1; }
echo "::endgroup::"

echo "::group::Restart the webhook receiver"
# The announcer and watchdog are timer-driven one-shots; they pick up the new
# files on their next run. Only the long-running receiver needs a restart.
"${SSH[@]}" "systemctl restart waha-webhook; sleep 3; systemctl is-active waha-webhook" || { rollback; exit 1; }
echo "::endgroup::"

echo "::group::Install log retention (30 days)"
scp -q -o ConnectTimeout=15 -o BatchMode=yes "$HERE/deploy/logrotate.conf" "$TARGET:/etc/logrotate.d/waha-gateway.incoming"
"${SSH[@]}" "set -e; command -v logrotate >/dev/null; logrotate -d /etc/logrotate.d/waha-gateway.incoming >/dev/null 2>&1; mv -f /etc/logrotate.d/waha-gateway.incoming /etc/logrotate.d/waha-gateway; chmod 644 /etc/logrotate.d/waha-gateway" || { rollback; exit 1; }
echo "::endgroup::"

echo "::group::Prove it end to end"
if ! node "$HERE/probe/does-bobot-reach-its-brain.js"; then
  rollback
  exit 1
fi
echo "::endgroup::"
echo "Bobot gateway installed and proven (backup kept at $BACKUP)"
