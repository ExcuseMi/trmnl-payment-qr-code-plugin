#!/bin/sh
# Lints the plugin and runs plugin/tests with `trmnlp test`, in trmnlp's Docker image plus zbar.
# Arguments go to `trmnlp test`, e.g. ./test.sh tests/payment_qr_spec.rb -e "dark mode"
# The report with every device picture is written to report/index.html.
set -eu
cd "$(dirname "$0")"
docker build -q -t payment-qr-tests ${TRMNLP_IMAGE:+--build-arg TRMNLP_IMAGE="$TRMNLP_IMAGE"} plugin/tests >/dev/null
run() {
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e CI \
    ${GITHUB_STEP_SUMMARY:+-e GITHUB_STEP_SUMMARY=/summary.md -v "$GITHUB_STEP_SUMMARY":/summary.md} \
    -v "$PWD":/repo -w /repo/plugin payment-qr-tests "$@"
}
run lint
run test --report ../report "$@"
