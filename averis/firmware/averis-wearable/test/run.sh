#!/usr/bin/env bash
# ===========================================================================
# AVERIS wearable — firmware logic tests, on the host
#
#   firmware/averis-wearable/test/run.sh
#
# No ESP32, no toolchain, no PlatformIO. The headers under test are free of
# Arduino symbols specifically so this works with whatever compiler is already
# on the machine — which is what makes it something CI runs on every commit
# rather than something a person runs before a release.
#
# What this cannot cover is stated plainly rather than faked: anything touching
# I²C, WiFi or the radio is behind the interfaces in sensors.h and net.h, and
# is exercised on real hardware with the --self-test build flag. Mocking a
# MAX30102 would test the mock.
# ===========================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CXX="${CXX:-$(command -v clang++ || command -v g++)}"
OUT="$(mktemp -d)/test_signal_core"

trap 'rm -rf "$(dirname "$OUT")"' EXIT

"$CXX" -std=c++17 -Wall -Wextra -Wno-unused-parameter -O1 \
  -o "$OUT" "$HERE/test_signal_core.cpp"

"$OUT"
