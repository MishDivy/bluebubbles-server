#!/bin/bash
set -euo pipefail
server_root=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
[[ $(uname -s) == Darwin ]] || { echo 'Requires macOS Command Line Tools.' >&2; exit 2; }
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/bb-sticker-preview-test.XXXXXXXX")
trap 'rm -f "$test_dir/tests" "$test_dir/cli"; rmdir "$test_dir"' EXIT
for unit in tests main; do
    output=tests
    [[ $unit == main ]] && output=cli
    xcrun clang -fobjc-arc -fblocks -Wall -Wextra -Werror \
        -mmacosx-version-min=10.15 -framework Foundation -framework ImageIO -framework CoreGraphics \
        "$server_root/native/sticker-preview/$unit.m" -o "$test_dir/$output"
done
"$test_dir/tests" "$test_dir/cli"
