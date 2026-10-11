#!/usr/bin/env sh
# uidit installer
#
#   curl -fsSL https://raw.githubusercontent.com/DrB0rk/uidit/master/install.sh | sh
#
# Installs the `uidit` command. Requires Node 18+ and npm; if they are missing the
# script stops and tells you what to install rather than half-installing something.

set -eu

REPO="DrB0rk/uidit"
MIN_NODE_MAJOR=18

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
# Prefer the npm registry; fall back to the GitHub source when the package is not
# published yet or the user is working from a fork.
if npm install -g "github:${REPO}" >/tmp/uidit-install.log 2>&1; then
  printf '  installed from GitHub source\n'
else
  warn "source install failed; see /tmp/uidit-install.log"
  die "could not install uidit"
fi

command -v uidit >/dev/null 2>&1 || die "install completed but 'uidit' is not on PATH.
  Add your npm global bin to PATH, e.g. export PATH=\"\$PATH:\$(npm prefix -g)/bin\"."

printf '\n  %s\n' "uidit installed → $(command -v uidit)"

# --- verify it actually runs --------------------------------------------------
if ! uidit --help >/dev/null 2>&1; then
  die "uidit was installed but did not run. Reinstall, or report this at https://github.com/${REPO}/issues"
fi

cat <<'EOF'

  Next:
    cd your-project
    uidit init      # once, creates .uidit/
    uidit           # start the dashboard, then hit Discover

  Docs: https://github.com/DrB0rk/uidit#readme
EOF