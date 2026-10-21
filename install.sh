#!/usr/bin/env sh
# uidit installer
#
#   curl -fsSL https://raw.githubusercontent.com/DrB0rk/uidit/HEAD/install.sh | sh
#
# Installs the `uidit` command. Needs Node 22+ and npm; if either is missing the
# script stops and tells you what to install rather than half-installing something.

set -eu

REPO="DrB0rk/uidit"
VERSION="0.10.4"
MIN_NODE_MAJOR=22

say()  { printf '%s\n' "$*"; }
warn() { printf '  %s\n' "$*" >&2; }
die()  { printf '\nError: %s\n' "$*" >&2; exit 1; }

printf '\n  uidit — local UI review dashboard\n\n'

# --- prerequisites ------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js ${MIN_NODE_MAJOR}+ is required but was not found.
  Install it from https://nodejs.org (or via nvm: nvm install --lts) and re-run."

command -v npm >/dev/null 2>&1 || die "npm is required but was not found.
  Install it from https://nodejs.org and re-run."

node_major() { node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0; }

if [ "$(node_major)" -lt "$MIN_NODE_MAJOR" ]; then
  die "Node $(node -v) is too old. uidit needs Node ${MIN_NODE_MAJOR}+."
fi

printf '  node %s · npm %s\n' "$(node -v)" "$(npm -v)"

# --- install ------------------------------------------------------------------
# Install the versioned release tarball hosted directly on GitHub.
PACKAGE_URL="https://github.com/${REPO}/releases/download/v${VERSION}/drb0rk-uidit-${VERSION}.tgz"
SOURCE_URL="https://codeload.github.com/${REPO}/tar.gz/refs/tags/v${VERSION}"
TARBALL="$(mktemp -t uidit.XXXXXX.tar.gz)"
trap 'rm -f "$TARBALL"' EXIT INT TERM

installed=""
say "  installing directly from the GitHub release"
if curl -fsSL "$PACKAGE_URL" -o "$TARBALL" && npm install -g "$TARBALL" >/dev/null 2>&1 && command -v uidit >/dev/null 2>&1; then
  installed="GitHub release"
fi

if [ -z "$installed" ]; then
  say "  release package unavailable; installing the tagged source"
  curl -fsSL "$SOURCE_URL" -o "$TARBALL" || die "could not download $SOURCE_URL
  Check the URL manually, or clone https://github.com/${REPO} and run: npm install -g ."
  npm install -g "$TARBALL" >/dev/null 2>&1 || die "npm install failed.
  Re-run with the log: sh -x <(curl -fsSL $0) 2>&1 | tail -40"
  installed="GitHub source"
fi

if [ "$installed" = "GitHub release" ]; then
  printf '  installed from the public GitHub release\n'
fi

# npm >= 11 blocks dependency install scripts unless explicitly allowed, so the
# dashboard UI may not have been built during install. Build it now — `uidit start`
# would otherwise build on first launch and look broken meanwhile.
UI_BUILT=""
for d in "$(npm prefix -g)/lib/node_modules/@drb0rk/uidit" "$(npm prefix -g)/node_modules/@drb0rk/uidit" "$(npm prefix -g)/lib/node_modules/uidit" "$(npm prefix -g)/node_modules/uidit"; do
  [ -f "$d/dashboard/dist/index.html" ] && { UI_BUILT=1; break; }
done

if [ -z "$UI_BUILT" ]; then
  say "  building the dashboard UI"
  uidit build >/dev/null 2>&1 || warn "could not pre-build the UI; it will build on first run"
fi

command -v uidit >/dev/null 2>&1 || die "install completed but 'uidit' is not on PATH.
  Add your npm global bin to PATH:
    export PATH=\"\$PATH:\$(npm prefix -g)/bin\""

printf '  %s\n' "uidit installed ($installed) → $(command -v uidit)"

# --- verify it actually runs --------------------------------------------------
uidit --help >/dev/null 2>&1 || die "uidit was installed but did not run.
  Please report this at https://github.com/${REPO}/issues"

cat <<EOF

  Next:
    cd your-project
    uidit init      # once, creates .uidit/
    uidit           # start the dashboard, then hit Discover

  Docs: https://github.com/${REPO}#readme
EOF
