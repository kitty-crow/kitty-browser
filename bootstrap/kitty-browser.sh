#!/bin/sh
set -eu

REPO="${KITTY_BROWSER_REPO:-kitty-crow/kitty-browser}"
CACHE_ROOT="${XDG_CACHE_HOME:-${HOME}/.cache}/kitty-browser"
BIN_DIR="${CACHE_ROOT}/bin"
mkdir -p "$BIN_DIR"

os_raw="$(uname -s)"
arch_raw="$(uname -m)"

case "$os_raw" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *)
    echo "kitty-browser: unsupported operating system: $os_raw" >&2
    exit 2
    ;;
esac

case "$arch_raw" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *)
    echo "kitty-browser: unsupported CPU architecture: $arch_raw" >&2
    exit 2
    ;;
esac

suffix="${os}-${arch}"
if [ "$os" = "linux" ]; then
  if [ -f /etc/alpine-release ] || (ldd --version 2>&1 || true) | grep -qi musl; then
    suffix="${suffix}-musl"
  fi
fi

asset="kitty-browser-${suffix}"
base="https://github.com/${REPO}/releases/latest/download"
checksum_url="${base}/${asset}.sha256"
binary_url="${base}/${asset}"
binary="${BIN_DIR}/${asset}"
checksum_tmp="${BIN_DIR}/.${asset}.sha256.tmp"
binary_tmp="${BIN_DIR}/.${asset}.tmp"

curl -fsSL "$checksum_url" -o "$checksum_tmp"
expected="$(awk 'NR==1 {print $1}' "$checksum_tmp")"
if [ -z "$expected" ]; then
  echo "kitty-browser: release checksum is empty" >&2
  rm -f "$checksum_tmp"
  exit 2
fi

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
    return
  fi
  echo "kitty-browser: sha256sum or shasum is required for release verification" >&2
  exit 2
}

current=""
if [ -f "$binary" ]; then
  current="$(hash_file "$binary")"
fi

if [ "$current" != "$expected" ]; then
  echo "kitty-browser: downloading ${asset}" >&2
  curl -fL "$binary_url" -o "$binary_tmp"
  actual="$(hash_file "$binary_tmp")"
  if [ "$actual" != "$expected" ]; then
    rm -f "$binary_tmp" "$checksum_tmp"
    echo "kitty-browser: SHA-256 verification failed" >&2
    echo "expected: $expected" >&2
    echo "actual:   $actual" >&2
    exit 2
  fi
  chmod 0755 "$binary_tmp"
  mv "$binary_tmp" "$binary"
fi

rm -f "$checksum_tmp"

if [ -r /dev/tty ]; then
  exec "$binary" "$@" </dev/tty
fi
exec "$binary" "$@"
