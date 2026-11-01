#!/bin/sh
# Runs from the nginx image's /docker-entrypoint.d at start: turn the container's DNS server into the
# `resolver` line that nginx.conf includes. Writes to /tmp (tmpfs) because the root filesystem is read-only.
set -eu
ns=$(awk '$1 == "nameserver" { print $2; exit }' /etc/resolv.conf)
case "$ns" in *:*) ns="[$ns]" ;; esac
echo "resolver ${ns:-127.0.0.11} valid=5s ipv6=off;" > /tmp/resolver.conf
