#!/bin/sh
# Runs from the nginx image's /docker-entrypoint.d at start: turn the container's DNS server(s) into the
# `resolver` line that nginx.conf includes. Writes to /tmp (tmpfs) because the root filesystem is read-only.
set -eu
servers=""
for ns in $(awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf); do
  ns=${ns%%%*} # nginx rejects an IPv6 zone id such as fe80::1%eth0
  case "$ns" in *:*) ns="[$ns]" ;; esac
  servers="$servers $ns"
done
servers=${servers:-" 127.0.0.11"} # Docker's embedded DNS, if resolv.conf names none
# valid=5s: pick up a recreated backend's new address within seconds. resolver_timeout: fail fast if DNS is down.
echo "resolver$servers valid=5s ipv6=off; resolver_timeout 5s;" > /tmp/resolver.conf
echo "05-resolver: using$servers" >&2
