#!/usr/bin/env bash
# Optional CI bootstrap only. Local native runs reuse an existing binary prefix.
set -euo pipefail
: "${1:?usage: acquire-postgres.sh NEW_EMPTY_DIRECTORY}"
mkdir "$1"
cd "$1"
curl --fail --location --silent --show-error \
  https://ftp.postgresql.org/pub/source/v18.6/postgresql-18.6.tar.bz2 -o postgresql-18.6.tar.bz2
printf '%s\n' '555610c24d53e4316da5b7d3fc25c279d96856d5e0e23ee308c328c5fa881d9f  postgresql-18.6.tar.bz2' | sha256sum -c -
tar -xjf postgresql-18.6.tar.bz2
install_prefix="$PWD/install"
cd postgresql-18.6
./configure --prefix="$install_prefix" --without-icu --without-readline --without-zlib > ../configure.log 2>&1
make -j2 > ../make.log 2>&1
make install > ../install.log 2>&1
"$install_prefix/bin/postgres" --version
sha256sum "$install_prefix/bin/postgres"
