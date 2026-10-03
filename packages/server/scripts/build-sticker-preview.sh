#!/bin/bash
set -euo pipefail
server_root=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
[[ $(uname -s) == Darwin ]] || { echo 'Requires macOS Command Line Tools.' >&2; exit 2; }
build_dir=$(mktemp -d "${TMPDIR:-/tmp}/bb-sticker-preview-build.XXXXXXXX")
trap 'rm -f "$build_dir/arm64" "$build_dir/x86_64" "$build_dir/universal"; rmdir "$build_dir"' EXIT
for architecture in arm64 x86_64; do
    xcrun clang -fobjc-arc -fblocks -Wall -Wextra -Werror \
        -arch "$architecture" -mmacosx-version-min=10.15 \
        -framework Foundation -framework ImageIO -framework CoreGraphics \
        "$server_root/native/sticker-preview/main.m" -o "$build_dir/$architecture"
done
xcrun lipo -create "$build_dir/arm64" "$build_dir/x86_64" -output "$build_dir/universal"
mkdir -p "$server_root/appResources/macos"
install -m 755 "$build_dir/universal" "$server_root/appResources/macos/sticker-preview"
echo 'Built appResources/macos/sticker-preview (arm64 and x86_64); no install, signing or deployment.'
