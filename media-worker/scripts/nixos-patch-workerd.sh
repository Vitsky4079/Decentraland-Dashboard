#!/usr/bin/env bash
# NixOS only: the npm workerd binary expects /lib64/ld-linux-x86-64.so.2.
# Repoint its interpreter at nixpkgs glibc (its only dependency). Re-run after `npm install`.
set -euo pipefail
cd "$(dirname "$0")/.."
bin=node_modules/@cloudflare/workerd-linux-64/bin/workerd
[ -e /etc/NIXOS ] || { echo "not NixOS, nothing to do"; exit 0; }
glibc=$(nix build --no-link --print-out-paths nixpkgs#glibc.out)
nix shell nixpkgs#patchelf -c patchelf \
  --set-interpreter "$glibc/lib/ld-linux-x86-64.so.2" --set-rpath "$glibc/lib" "$bin"
"$bin" --version
