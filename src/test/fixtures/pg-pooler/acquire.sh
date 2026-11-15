#!/usr/bin/env bash
# Only a fresh caller-owned directory; never installs into the host.
set -euo pipefail
: "${1:?usage: acquire.sh NEW_EMPTY_DIRECTORY}"
mkdir "$1"
cd "$1"
curl --fail --location --silent --show-error \
  https://www.pgbouncer.org/downloads/files/1.26.1/pgbouncer-1.26.1.tar.gz -o pgbouncer-1.26.1.tar.gz
printf '%s\n' '00886a2994b4844cd37110970df777772cfc42a74c400522c82fba509a3f42d9  pgbouncer-1.26.1.tar.gz' | sha256sum -c -
tar -xzf pgbouncer-1.26.1.tar.gz
cd pgbouncer-1.26.1
./configure --without-cares --without-systemd > ../configure.log 2>&1
make -j2 pgbouncer > ../make.log 2>&1
./pgbouncer --version
sha256sum pgbouncer
