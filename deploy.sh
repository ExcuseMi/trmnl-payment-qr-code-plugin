#!/bin/sh
# Pushes plugin/ to TRMNL, then downloads the server's copy again and compares its templates with the
# repository: a fix once stayed on GitHub while TRMNL kept the old template, and the web editor (which
# previews GitHub's copy) showed a screen the device never drew.
# ./deploy.sh --check only compares. Needs the trmnlp login in ~/.config/trmnlp.
set -eu
cd "$(dirname "$0")"
docker build -q -t payment-qr-tests ${TRMNLP_IMAGE:+--build-arg TRMNLP_IMAGE="$TRMNLP_IMAGE"} plugin/tests >/dev/null
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
run() {
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$HOME/.config/trmnlp":/tmp/.config/trmnlp:ro \
    -v "$PWD":/repo -v "$tmp":/server "$@"
}
[ "${1:-}" = "--check" ] || run -w /repo/plugin payment-qr-tests push --force
id=$(sed -n 's/^id: *//p' plugin/src/settings.yml)
run -w /server payment-qr-tests clone --skip-git copy "$id" >/dev/null
status=0
for file in plugin/src/*.liquid; do
  if ! tr -d '\r' < "$tmp/copy/src/$(basename "$file")" | cmp -s - "$file"; then
    echo "NOT DEPLOYED: TRMNL's $(basename "$file") differs from $file" >&2
    status=1
  fi
done
[ "$status" -ne 0 ] || echo "TRMNL has the templates of this repository."
exit "$status"
