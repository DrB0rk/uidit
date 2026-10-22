#!/usr/bin/env sh
# Install UIDIT from a public GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/DrB0rk/uidit/HEAD/install.sh | sh

set -eu

REPO="DrB0rk/uidit"
VERSION="${UIDIT_VERSION:-0.10.11}"
MIN_NODE_MAJOR=22
PACKAGE_NAME="@drb0rk/uidit"

die() { printf '\n  Error: %s\n' "$*" >&2; exit 1; }
step() { printf '\n  [%s] %s\n' "$1" "$2"; }

case "$VERSION" in
  ''|*[!0-9.]*|.*|*.|*..*) die "invalid UIDIT_VERSION '$VERSION' (expected a version such as 0.10.7)" ;;
esac

printf '\n  uidit installer\n  Release v%s · GitHub: https://github.com/%s/releases/tag/v%s\n' "$VERSION" "$REPO" "$VERSION"

step 1/4 "Checking requirements"
command -v node >/dev/null 2>&1 || die "Node.js ${MIN_NODE_MAJOR}+ is required. Install it from https://nodejs.org and run this installer again."
command -v npm >/dev/null 2>&1 || die "npm is required. Install Node.js from https://nodejs.org and run this installer again."

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || printf '0')
case "$NODE_MAJOR" in *[!0-9]*|'') NODE_MAJOR=0 ;; esac
[ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] || die "Node $(node -v) is too old; UIDIT v${VERSION} requires Node ${MIN_NODE_MAJOR}+."

printf '      Node.js %s\n      npm %s\n' "$(node -v)" "$(npm -v)"
if command -v uname >/dev/null 2>&1; then printf '      Platform %s\n' "$(uname -srm)"; fi

step 2/4 "Downloading the GitHub release"
PACKAGE_URL="https://github.com/${REPO}/releases/download/v${VERSION}/drb0rk-uidit-${VERSION}.tgz"
SOURCE_URL="https://codeload.github.com/${REPO}/tar.gz/refs/tags/v${VERSION}"
TARBALL=$(mktemp -t uidit.XXXXXX.tar.gz) || die "could not create a temporary download file"
trap 'rm -f "$TARBALL"' 0
trap 'exit 130' INT
trap 'exit 143' TERM

if curl --fail --location --show-error --retry 2 --retry-delay 1 --progress-bar "$PACKAGE_URL" --output "$TARBALL"; then
  INSTALL_SOURCE="GitHub release"
else
  printf '\n      Release archive unavailable; trying the tagged GitHub source.\n' >&2
  if curl --fail --location --show-error --retry 2 --retry-delay 1 --progress-bar "$SOURCE_URL" --output "$TARBALL"; then
    INSTALL_SOURCE="GitHub source archive"
  else
    die "could not download UIDIT v${VERSION}. Check https://github.com/${REPO}/releases/tag/v${VERSION} and try again."
  fi
fi

step 3/4 "Installing UIDIT v${VERSION} from ${INSTALL_SOURCE}"
npm install --global "$TARBALL" || die "npm could not install UIDIT. Review the npm output above, fix the reported issue, and rerun this command."

GLOBAL_PREFIX=$(npm prefix --global) || die "npm could not determine its global install directory"
GLOBAL_ROOT=$(npm root --global) || die "npm could not determine its global package directory"
UIDIT_BIN="${GLOBAL_PREFIX}/bin/uidit"
PACKAGE_JSON="${GLOBAL_ROOT}/${PACKAGE_NAME}/package.json"
[ -x "$UIDIT_BIN" ] || die "UIDIT was installed, but its executable is missing at ${UIDIT_BIN}. Check npm's global install output."
[ -f "$PACKAGE_JSON" ] || die "UIDIT was installed, but its package metadata is missing at ${PACKAGE_JSON}."

INSTALLED_VERSION=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version)' "$PACKAGE_JSON") || die "could not read the installed UIDIT version"
[ "$INSTALLED_VERSION" = "$VERSION" ] || die "expected UIDIT v${VERSION}, but npm installed v${INSTALLED_VERSION}"

if [ ! -f "${GLOBAL_ROOT}/${PACKAGE_NAME}/dashboard/dist/index.html" ]; then
  step 4/4 "Building the dashboard"
  "$UIDIT_BIN" build || die "the dashboard build failed. Review the output above and rerun the installer."
else
  step 4/4 "Checking the installed command"
fi

"$UIDIT_BIN" --help >/dev/null 2>&1 || die "UIDIT v${VERSION} is installed but could not start. Report this at https://github.com/${REPO}/issues"

printf '\n  Installed UIDIT v%s\n  Source: %s\n  Command: %s\n' "$INSTALLED_VERSION" "$INSTALL_SOURCE" "$UIDIT_BIN"
case ":${PATH}:" in
  *":${GLOBAL_PREFIX}/bin:"*) ;;
  *) printf '\n  Add the command to your PATH to run `uidit` from any terminal:\n    export PATH="%s/bin:$PATH"\n' "$GLOBAL_PREFIX" ;;
esac

cat <<EOF

  Next:
    cd your-project
    uidit init      # once, creates .uidit/
    uidit           # start the dashboard and choose your dev server

  Docs: https://github.com/${REPO}#readme
EOF
