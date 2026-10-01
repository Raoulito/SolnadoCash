#!/usr/bin/env bash
# deploy/oracle/provision.sh — one-time (idempotent) server setup. Runs ON the server, as root.
# Invoked by `deploy.sh provision`; safe to re-run.
#
#   - Caddy from the official repository. Ubuntu 24.04 ships 2.6, which predates ACME profiles and
#     IP-address certificates.
#   - A system user for the relayer, and the directories the release and secrets go into.
#   - Host firewall: open 80 and 443 ahead of the image's final REJECT rule, and persist it. Oracle's
#     cloud firewall (the subnet security list) is separate and must be opened in the console.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

caddy_ok() {
  command -v caddy >/dev/null || return 1
  # Need 2.10+ (ACME profiles); IP certificates on IPv4 work from 2.10, on IPv6 from 2.11.
  caddy version | grep -qE '^v2\.(1[0-9]|[2-9][0-9])\.'
}
if ! caddy_ok; then
  apt-get update -q
  apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
    gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi
caddy_ok || { echo "caddy $(caddy version) is too old" >&2; exit 1; }
echo "caddy: $(caddy version | cut -d' ' -f1)"

id sornado >/dev/null 2>&1 ||
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin sornado

install -d -o root -g root -m 0755 /opt/sornadocash /opt/sornadocash/relayer /srv/sornadocash /srv/sornadocash/app

# TCP congestion control: BBR with the fq qdisc, instead of the default cubic. Measured downloading the
# 5.4 MB proving key from Europe to this Tokyo server: cubic finished 6 of 11 runs at about 0.5 MB/s
# and stalled near 30 KB/s on the other 5, because cubic treats every lost packet as congestion and
# the route loses packets. BBR finished 11 of 11 at 0.8 to 1.5 MB/s. The file sorts after the image's
# 10-bufferbloat.conf, which sets fq_codel; BBR needs fq for pacing on older kernels.
modprobe tcp_bbr 2>/dev/null || true
echo tcp_bbr > /etc/modules-load.d/sornadocash-bbr.conf
cat > /etc/sysctl.d/90-sornadocash-bbr.conf <<'SYSCTL'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
SYSCTL
sysctl -q -p /etc/sysctl.d/90-sornadocash-bbr.conf
# default_qdisc only applies to interfaces brought up later; set the live one now.
dev=$(ip -o route show default | awk '{print $5; exit}')
[ -n "$dev" ] && tc qdisc replace dev "$dev" root fq
echo "tcp: $(sysctl -n net.ipv4.tcp_congestion_control), qdisc on ${dev:-?}: $(tc qdisc show dev "$dev" 2>/dev/null | awk 'NR==1{print $2}')"
install -d -o root -g root -m 0700 /etc/sornadocash

# Host firewall. The image ends INPUT with "REJECT --reject-with icmp-host-prohibited"; rules
# appended after it would never match, so insert ahead of it.
for port in 80 443; do
  if ! iptables -C INPUT -p tcp -m state --state NEW -m tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    pos=$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')
    if [ -n "$pos" ]; then
      iptables -I INPUT "$pos" -p tcp -m state --state NEW -m tcp --dport "$port" -j ACCEPT
    else
      iptables -A INPUT -p tcp -m state --state NEW -m tcp --dport "$port" -j ACCEPT
    fi
  fi
done
if command -v netfilter-persistent >/dev/null; then
  netfilter-persistent save >/dev/null 2>&1
else
  iptables-save > /etc/iptables/rules.v4
fi
echo "host firewall:"; iptables -S INPUT | sed 's/^/  /'
