#!/usr/bin/env bash
# deploy/oracle/deploy.sh — deploy the SornadoCash devnet beta to one server, on one origin.
#
#   https://<SITE>/            the app (static)
#   https://<SITE>/relayer/*   the relayer, on 127.0.0.1:3000 under systemd
#   https://<SITE>/rpc         Solana JSON-RPC (HTTP + WebSocket), proxied to the RPC provider by
#                              Caddy, which adds the API key. The key is never in the bundle.
#
# Usage, from the repository root:
#   SITE=203.0.113.10 deploy/oracle/deploy.sh provision   # once: Caddy, service user, host firewall
#   SITE=203.0.113.10 deploy/oracle/deploy.sh secrets     # relayer key + RPC key -> /etc/sornadocash
#   SITE=203.0.113.10 deploy/oracle/deploy.sh release     # build the app, ship app + relayer, restart
#   SITE=203.0.113.10 deploy/oracle/deploy.sh status
#
# Environment:
#   SITE       public IPv4 address or hostname the site is served on (required)
#   SSH_HOST   ssh alias of the server (default: oracle)
#   TLS_MODE   internal     Caddy's own CA: works before the cloud firewall is open, browsers warn
#              letsencrypt  a publicly trusted certificate; for a bare IP this is Let's Encrypt's
#                           6-day "shortlived" profile. Needs 80/443 reachable from the internet.
#   RPC_HOST   RPC provider host the /rpc proxy forwards to (default: devnet.helius-rpc.com)
#
# Secrets are read from relayer/.env (SOLANA_RPC_URL with ?api-key=, RELAYER_KEYPAIR) and sent over
# ssh on stdin. Nothing secret is printed, passed on a command line, or written to disk locally.
#
# The app is built from the WORKING TREE, so uncommitted UI work is included; the relayer is shipped
# from the committed HEAD (git archive), so only committed server code ever runs.
set -euo pipefail

SITE=${SITE:?set SITE to the public IPv4 address or hostname}
SSH_HOST=${SSH_HOST:-oracle}
TLS_MODE=${TLS_MODE:-internal}
RPC_HOST=${RPC_HOST:-devnet.helius-rpc.com}
ROOT=$(git rev-parse --show-toplevel)
HERE="$ROOT/deploy/oracle"
ENV_FILE="$ROOT/relayer/.env"

die() { echo "deploy: $*" >&2; exit 1; }
say() { echo "== $*"; }
remote() { ssh -o BatchMode=yes "$SSH_HOST" "$@"; }

env_value() { # env_value NAME: the value of NAME in relayer/.env, never printed by callers
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}

cmd_provision() {
  say "provisioning $SSH_HOST"
  remote 'sudo -n bash -s' < "$HERE/provision.sh"
}

cmd_secrets() {
  [ -f "$ENV_FILE" ] || die "missing $ENV_FILE"
  local rpc_url program_id keypair key
  rpc_url=$(env_value SOLANA_RPC_URL); program_id=$(env_value PROGRAM_ID); keypair=$(env_value RELAYER_KEYPAIR)
  [ -n "$rpc_url" ] || die "SOLANA_RPC_URL is not set in relayer/.env"
  [ -f "$keypair" ] || die "RELAYER_KEYPAIR in relayer/.env does not point at a file"
  key=$(printf '%s' "$rpc_url" | sed -n 's/.*[?&]api-key=\([^&]*\).*/\1/p')
  [ -n "$key" ] || die "SOLANA_RPC_URL has no api-key parameter"
  case "$rpc_url" in "https://$RPC_HOST/"*) ;; *) die "SOLANA_RPC_URL is not on $RPC_HOST (RPC_HOST)";; esac

  say "installing secrets in $SSH_HOST:/etc/sornadocash (values not shown)"
  {
    printf 'SOLANA_RPC_URL=%s\n' "$rpc_url"
    printf 'PROGRAM_ID=%s\n' "${program_id:-DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59}"
    printf 'ALLOWED_ORIGINS=https://%s\n' "$SITE"
    # A small hot wallet: warn below 0.05 SOL, critical below 0.01 (about ten withdrawals of rent).
    printf 'RELAYER_ALERT_SOL=0.05\nRELAYER_CRITICAL_SOL=0.01\n'
  } | remote "sudo -n sh -c 'umask 077; cat > /etc/sornadocash/relayer.env'"
  printf 'HELIUS_API_KEY=%s\n' "$key" |
    remote "sudo -n sh -c 'umask 077; cat > /etc/sornadocash/caddy.env'"
  remote "sudo -n sh -c 'umask 077; cat > /etc/sornadocash/relayer-keypair.json'" < "$keypair"
  remote 'sudo -n ls -l /etc/sornadocash | sed 1d | awk "{print \"  \" \$1, \$3, \$NF}"'
}

build_app() { # build_app OUTDIR
  local out=$1 work
  work=$(mktemp -d)
  # A copy without any .env file: app/.env.local holds the RPC URL WITH its key for local use, and
  # Vite would otherwise inline it wherever the shell does not override it.
  rsync -a --exclude node_modules --exclude dist --exclude '.env*' "$ROOT/app/" "$work/app/"
  ln -s "$ROOT/app/node_modules" "$work/app/node_modules"
  (cd "$ROOT/sdk" && npm run build >/dev/null)
  (cd "$work/app" &&
    env -u VITE_POOLS -u VITE_PROGRAM_ID \
      VITE_SOLANA_NETWORK=devnet \
      VITE_RPC_ENDPOINT="https://$SITE/rpc" \
      VITE_RELAYER_URL="https://$SITE/relayer" \
      sh -c 'npx tsc --noEmit && npx vite build --logLevel warn')
  rm -rf "$out"; mv "$work/app/dist" "$out"; rm -rf "$work"
  # _headers is for Netlify-style hosts; here Caddy sets the headers, and the file is stale.
  rm -f "$out/_headers"
}

check_bundle() { # check_bundle DIR: refuse to ship a bundle that knows the RPC key or provider
  local dir=$1 key
  key=$(env_value SOLANA_RPC_URL | sed -n 's/.*[?&]api-key=\([^&]*\).*/\1/p')
  if [ -n "$key" ] && grep -rqF -- "$key" "$dir"; then die "the RPC API key is in the bundle; not shipping"; fi
  if grep -rqiE 'api-key=|helius' "$dir"; then die "the bundle references the RPC provider directly; not shipping"; fi
  grep -qF "connect-src 'self' https://$SITE wss://$SITE" "$dir/index.html" ||
    die "unexpected connect-src in index.html: $(grep -o 'connect-src[^;]*' "$dir/index.html")"
  echo "  bundle: no RPC key, no provider URL; connect-src is same-origin (+ solflare.com)"
}

render_headers() { # render_headers DIR > file: Caddy header block with the build's CSP
  local csp
  csp=$(sed -n 's/.*http-equiv="Content-Security-Policy" content="\([^"]*\)".*/\1/p' "$1/index.html")
  [ -n "$csp" ] || die "no CSP meta tag in the built index.html"
  cat <<EOF
# Generated by deploy/oracle/deploy.sh from the built index.html. Do not edit on the server.
header {
	# The meta-tag policy from the build, plus what a meta tag cannot express.
	Content-Security-Policy "$csp; frame-ancestors 'none'"
	X-Frame-Options DENY
	X-Content-Type-Options nosniff
	Referrer-Policy no-referrer
	Permissions-Policy "geolocation=(), microphone=(), camera=(), usb=(), payment=()"
	# allow-popups: wallet adapters that open a popup (Solflare web) need their opener.
	Cross-Origin-Opener-Policy same-origin-allow-popups
	-Server
}
# Revalidate everything but content-hashed assets, so a redeploy (new circuits included) is picked
# up on the next load. Both matchers are explicit: an unmatched header directive would be ordered
# after the matched one and overwrite it.
@hashed path /assets/*
header @hashed Cache-Control "public, max-age=31536000, immutable"
@unhashed not path /assets/*
header @unhashed Cache-Control no-cache
EOF
}

render_caddyfile() {
  local tls global
  case "$TLS_MODE" in
    internal)
      tls='tls internal'
      global="default_sni $SITE
	skip_install_trust" ;;
    letsencrypt)
      tls='tls {
		issuer acme {
			dir https://acme-v02.api.letsencrypt.org/directory
			profile shortlived
		}
	}'
      # A client connecting to an IP sends no SNI; this tells Caddy which certificate to present.
      global="default_sni $SITE" ;;
    *) die "TLS_MODE must be internal or letsencrypt" ;;
  esac
  SITE="$SITE" RPC_HOST="$RPC_HOST" TLS="$tls" GLOBAL="$global" python3 - "$HERE/Caddyfile.template" <<'PY'
import os, sys
s = open(sys.argv[1], encoding="utf8").read()
for k, v in {"@SITE@": os.environ["SITE"], "@RPC_HOST@": os.environ["RPC_HOST"],
             "@TLS@": os.environ["TLS"], "@GLOBAL_OPTIONS@": os.environ["GLOBAL"]}.items():
    assert k in s, k
    s = s.replace(k, v)
sys.stdout.write(s)
PY
}

stage_release() { # stage_release DIR: everything that goes to the server, nothing secret
  local stage=$1
  say "building the app for https://$SITE (working tree)"
  build_app "$stage/app"
  check_bundle "$stage/app"
  render_headers "$stage/app" > "$stage/sornadocash-headers.caddy"
  render_caddyfile > "$stage/Caddyfile"
  cp "$HERE/sornadocash-relayer.service" "$HERE/caddy-sornadocash.conf" "$stage/"

  say "packing the relayer from HEAD $(git -C "$ROOT" rev-parse --short HEAD)"
  mkdir -p "$stage/relayer"
  git -C "$ROOT" archive HEAD relayer/src relayer/package.json relayer/package-lock.json | tar -x -C "$stage"
  git -C "$ROOT" show HEAD:app/src/idl/solnadocash.json > "$stage/relayer/idl.json"
  git -C "$ROOT" show HEAD:circuits/build/withdraw_vk.json > "$stage/relayer/withdraw_vk.json"
}

cmd_render() { # render OUTDIR: stage a release locally without touching the server
  local out=${1:?usage: deploy.sh render OUTDIR}
  mkdir -p "$out"
  stage_release "$out"
  echo "  staged in $out"
}

cmd_release() {
  local stage
  stage=$(mktemp -d)
  trap 'rm -rf "$stage"' RETURN
  stage_release "$stage"

  say "uploading"
  remote 'rm -rf ~/sornado-release && mkdir -p ~/sornado-release'
  rsync -a --delete "$stage/" "$SSH_HOST:sornado-release/"

  say "installing on $SSH_HOST"
  remote 'bash -s' <<'REMOTE'
set -euo pipefail
R=~/sornado-release
for f in /etc/sornadocash/relayer.env /etc/sornadocash/caddy.env /etc/sornadocash/relayer-keypair.json; do
  sudo -n test -s "$f" || { echo "missing $f: run 'deploy.sh secrets' first" >&2; exit 1; }
done
(cd "$R/relayer" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

sudo -n rsync -a --delete --chown=root:root --chmod=D0755,F0644 "$R/relayer/" /opt/sornadocash/relayer/
sudo -n rsync -a --delete --chown=root:root --chmod=D0755,F0644 "$R/app/" /srv/sornadocash/app/
sudo -n install -m 0644 "$R/sornadocash-headers.caddy" /etc/caddy/sornadocash-headers.caddy
sudo -n install -m 0644 "$R/Caddyfile" /etc/caddy/Caddyfile.new
sudo -n install -m 0644 "$R/sornadocash-relayer.service" /etc/systemd/system/sornadocash-relayer.service
sudo -n install -d -m 0755 /etc/systemd/system/caddy.service.d
sudo -n install -m 0644 "$R/caddy-sornadocash.conf" /etc/systemd/system/caddy.service.d/sornadocash.conf
sudo -n systemctl daemon-reload

# Validate before swapping in, so a bad config never replaces a working one.
sudo -n -u caddy env HELIUS_API_KEY=x caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile >/tmp/caddy-validate.log 2>&1 ||
  { cat /tmp/caddy-validate.log >&2; exit 1; }
sudo -n mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
started=$(date +%s)
sudo -n systemctl enable --now caddy >/dev/null 2>&1
# A restart (not a reload) picks up a changed environment drop-in.
sudo -n systemctl restart caddy
sudo -n systemctl enable sornadocash-relayer >/dev/null 2>&1
sudo -n systemctl restart sornadocash-relayer
sleep 4
systemctl is-active caddy sornadocash-relayer | paste -sd' ' | sed 's/^/  services (caddy, relayer): /'
rm -rf "$R"
# Neither service may ever print the RPC key (the packaged Caddy unit used to, via --environ).
leaks=$(sudo -n sh -c 'k=$(sed -n "s/^HELIUS_API_KEY=//p" /etc/sornadocash/caddy.env); journalctl -u caddy -u sornadocash-relayer --since "@'"$started"'" --no-pager -o cat | grep -cF -- "$k"' || true)
[ "$leaks" = 0 ] || { echo "  THE RPC KEY WAS LOGGED ($leaks lines since the restart)" >&2; exit 1; }
echo "  journal since restart: RPC key not logged"
REMOTE
}

cmd_status() {
  remote "bash -s" <<REMOTE
systemctl is-active caddy sornadocash-relayer | paste -sd' ' | sed 's/^/  services (caddy, relayer): /'
c() { curl -sk -m 15 --connect-to $SITE:443:127.0.0.1:443 "\$@"; }
echo "  app:     \$(c -o /dev/null -w '%{http_code} %{size_download} bytes' https://$SITE/)"
echo "  health:  \$(c https://$SITE/relayer/health)"
echo "  rpc:     \$(c -H 'Origin: https://$SITE' -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' https://$SITE/rpc)"
echo "  foreign: \$(c -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.example' -H 'content-type: application/json' -d '{}' https://$SITE/rpc) (expect 403)"
sudo -n journalctl -u sornadocash-relayer -n 8 --no-pager -o cat | sed 's/^/  relayer log: /'
REMOTE
}

case "${1:-}" in
  provision) cmd_provision ;;
  secrets) cmd_secrets ;;
  release) cmd_release ;;
  render) shift; cmd_render "$@" ;;
  status) cmd_status ;;
  *) sed -n '2,30p' "$0"; exit 2 ;;
esac
