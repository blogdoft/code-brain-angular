#!/usr/bin/env bash
# Packs code-brain-angular with the given version and verifies the tarball the way a user gets it:
#   1. contents: the CLI, the schema, README and LICENSE are in; sources, tests and fixtures are out;
#   2. install + run through npx (no global install): --version reports exactly <version>;
#   3. smoke test: analyzes fixtures/basic-angular-app with --fail-on-error and checks the outputs.
# The tarball is left in artifacts/ for the caller to upload/publish. package.json and
# package-lock.json are restored afterwards, so running it locally leaves no changes behind.
#
# Usage: scripts/verify-package.sh <version>      e.g. scripts/verify-package.sh 0.0.0-local.1
set -euo pipefail

version="${1:?usage: scripts/verify-package.sh <version>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
artifacts="$root/artifacts"
work="$(mktemp -d)"
backup="$(mktemp -d)"

cp "$root/package.json" "$root/package-lock.json" "$backup/"
restore() {
  cp "$backup/package.json" "$backup/package-lock.json" "$root/"
  rm -rf "$work" "$backup"
}
trap restore EXIT

cd "$root"
npm version "$version" --no-git-tag-version --allow-same-version >/dev/null
mkdir -p "$artifacts"
npm pack --silent --pack-destination "$artifacts" >/dev/null
tarball="$artifacts/code-brain-angular-$version.tgz"
[[ -f "$tarball" ]] || { echo "::error::$tarball was not produced"; exit 1; }
echo "Packed $tarball"

contents="$(tar -tzf "$tarball")"
for required in package/dist/cli/main.js package/schemas/ciir.schema.json package/package.json package/README.md package/LICENSE; do
  grep -qx "$required" <<<"$contents" || { echo "::error::$required is missing from the package"; exit 1; }
done
if grep -qE '^package/(src|tests|fixtures|scripts|\.specs)/' <<<"$contents"; then
  echo "::error::the package must not contain sources, tests, fixtures or specs"
  exit 1
fi
echo "Contents OK ($(wc -l <<<"$contents") files)"

cd "$work"
reported="$(npx --yes --package="$tarball" code-brain-angular --version)"
if [[ "$reported" != "$version" ]]; then
  echo "::error::--version reported '$reported', expected '$version'"
  exit 1
fi
echo "Version OK ($reported)"

CIIR_NOLOGO=1 npx --yes --package="$tarball" code-brain-angular \
  "$root/fixtures/basic-angular-app" --output "$work/out" --no-progress --fail-on-error
for file in ciir.jsonl ciir.schema.json manifest.json analysis-report.json; do
  [[ -s "$work/out/$file" ]] || { echo "::error::smoke test did not produce $file"; exit 1; }
done
grep -q "\"version\": \"$version\"" "$work/out/manifest.json" || { echo "::error::manifest.json does not carry version $version"; exit 1; }
echo "Smoke test OK ($(wc -l <"$work/out/ciir.jsonl") records)"
