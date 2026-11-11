#!/usr/bin/env bash
set -euo pipefail

if ! command -v systemctl >/dev/null 2>&1 || ! systemctl is-active --quiet systemd-resolved; then
  exit 0
fi

sudo mkdir -p /etc/systemd/resolved.conf.d
{
  # Query serve-stale public resolvers (Cloudflare and Quad9) in parallel with the runner's link DNS.
  printf '[Resolve]\nDNS=1.1.1.1 1.0.0.1 9.9.9.9\n'
  if resolvectl domain 2>/dev/null | grep -Eq '(^|[[:space:]])~\.($|[[:space:]])'; then
    printf 'Domains=~.\n'
  fi
} | sudo tee /etc/systemd/resolved.conf.d/ci-dns.conf >/dev/null

sudo systemctl restart systemd-resolved
sudo resolvectl flush-caches || true

if [ "$#" -gt 0 ]; then
  resolvectl query "$@"
else
  resolvectl query archive.ubuntu.com security.ubuntu.com
fi
