#!/bin/sh
set -eu

REPO="${KITTY_BROWSER_REPO:-kitty-crow/kitty-browser}"
CACHE_ROOT="${XDG_CACHE_HOME:-${HOME}/.cache}/kitty-browser"
mkdir -p "$CACHE_ROOT"

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

if [ "$os" = "linux" ]; then
  if [ -f /etc/alpine-release ] || (ldd --version 2>&1 || true) | grep -qi musl; then
    echo "kitty-browser: bundled Playwright Chromium currently requires glibc Linux; musl/Alpine is not supported" >&2
    exit 2
  fi
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "kitty-browser: curl is required to fetch the release bundle" >&2
  exit 2
fi
if ! command -v tar >/dev/null 2>&1; then
  echo "kitty-browser: tar is required to unpack the release bundle" >&2
  exit 2
fi

suffix="${os}-${arch}"
asset="kitty-browser-${suffix}.tar.gz"
base="https://github.com/${REPO}/releases/latest/download"
checksum_url="${base}/${asset}.sha256"
bundle_url="${base}/${asset}"
install_dir="${CACHE_ROOT}/bundles/${suffix}"
marker="${install_dir}/.archive.sha256"
binary="${install_dir}/kitty-browser"
mkdir -p "${CACHE_ROOT}/bundles"

checksum_tmp="${CACHE_ROOT}/.${asset}.sha256.tmp"
bundle_tmp="${CACHE_ROOT}/.${asset}.tmp"

curl -fsSL "$checksum_url" -o "$checksum_tmp"
expected="$(awk 'NR==1 {print $1}' "$checksum_tmp")"
if [ -z "$expected" ]; then
  rm -f "$checksum_tmp"
  echo "kitty-browser: release checksum is empty" >&2
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

installed=""
if [ -f "$marker" ]; then
  installed="$(cat "$marker" 2>/dev/null || true)"
fi

if [ "$installed" != "$expected" ] || [ ! -x "$binary" ]; then
  echo "kitty-browser: downloading ${asset} (includes Chromium)" >&2
  rm -f "$bundle_tmp"
  curl -fL "$bundle_url" -o "$bundle_tmp"
  actual="$(hash_file "$bundle_tmp")"
  if [ "$actual" != "$expected" ]; then
    rm -f "$bundle_tmp" "$checksum_tmp"
    echo "kitty-browser: SHA-256 verification failed" >&2
    echo "expected: $expected" >&2
    echo "actual:   $actual" >&2
    exit 2
  fi

  stage="$(mktemp -d "${CACHE_ROOT}/.kitty-browser-${suffix}.XXXXXX")"
  cleanup_stage() {
    rm -rf "$stage"
  }
  trap cleanup_stage EXIT HUP INT TERM

  tar -xzf "$bundle_tmp" -C "$stage"
  if [ ! -f "$stage/kitty-browser" ]; then
    echo "kitty-browser: release bundle does not contain kitty-browser" >&2
    exit 2
  fi
  if [ ! -d "$stage/chromium" ]; then
    echo "kitty-browser: release bundle does not contain Chromium" >&2
    exit 2
  fi

  chmod 0755 "$stage/kitty-browser"
  printf '%s\n' "$expected" > "$stage/.archive.sha256"
  rm -rf "$install_dir"
  mv "$stage" "$install_dir"
  trap - EXIT HUP INT TERM
  rm -f "$bundle_tmp"
fi

rm -f "$checksum_tmp"

if [ -r /dev/tty ]; then
  exec "$binary" "$@" </dev/tty
fi
exec "$binary" "$@"
