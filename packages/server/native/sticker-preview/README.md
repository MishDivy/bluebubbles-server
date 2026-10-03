# Sticker preview executable

This public-ImageIO executable reads one received HEIC attachment and writes a
separate PNG preview. It creates APNG only for a HEICS sequence with complete
frame timing and loop metadata. It never modifies the input. Original sticker
downloads must retain their existing bytes and MIME type.

## Build and invocation

Build explicitly on a macOS development or CI runner:

```sh
bash packages/server/scripts/test-sticker-preview.sh
bash packages/server/scripts/build-sticker-preview.sh
```

The build emits an ignored universal arm64/x86_64 executable at
`packages/server/appResources/macos/sticker-preview`, with a macOS 10.15 minimum.
It does not sign, deploy, start Electron, or install a service. Existing
`appResources` packaging places it at
`Contents/Resources/appResources/macos/sticker-preview`. Packaging must invoke
the build script explicitly and verify the embedded executable's SHA-256 against
the build output. A missing executable means preview unavailable. Requests must
not compile or install it.

The server invokes `execFile(executable, [inputPath, outputPath])`, with no shell,
a ten-second timeout and bounded stdout/stderr. The input comes only from an
authenticated GUID-resolved attachment, not an arbitrary HTTP path. Both paths
must be absolute lexical paths without traversal, repeated separators, or any
symlink component. Resolve server-owned cache roots before constructing the
private job directory; macOS `/tmp` and `/var` are symlinks, while `/private/tmp`
and `/private/var` are their direct paths.

The output must not exist and its immediate parent must be owned by the server
user with mode `0700`. The executable writes mode `0600` to an exclusive private
temporary file named `.bb-sticker-preview.partial`, syncs it, and publishes with
`linkat` without replacing another file. The caller owns job-directory cleanup, including timeout, cancellation,
failed output and any orphan temporary file. The server bounds concurrency and
cache bytes, coalesces same-source jobs, and verifies results before serving.

## Protocol version 1

Stdout contains exactly one JSON result under 8 KiB. Successful exit status is
zero:

```json
{"version":1,"ok":true,"format":"png","frames":1,"width":400,"height":400,"hasAlpha":true,"bytes":12345}
```

`format` is `png` or `apng`. `hasAlpha` means the decoded source carries alpha
and the preview retained it. The executable checks the output's frame count,
dimensions, timing, loops and canonical decoded RGBA pixels, including alpha,
against the normalized source frames before publishing.

Errors have nonzero exit status and fixed codes without paths, identifiers,
metadata, or native exception details:

```json
{"version":1,"ok":false,"error":"unsupported_animation"}
```

The codes are `invalid_arguments`, `input_unavailable`, `input_too_large`,
`unsupported_type`, `unsupported_animation`, `unsupported_auxiliary`,
`invalid_image`, `image_limits`, `output_limits`, `conversion_failed`, and
`output_unavailable`. Stderr has no protocol meaning and the caller must not log
it. A signal, timeout or malformed result also means unavailable preview, not
permission to flatten or overwrite the original.

## Limits and fidelity

Input is an owned regular file read through a bounded descriptor: at most 5 MiB,
dimensions at most 618 by 618, at most 100 frames, and at most 25 million aggregate
decoded pixels. The read checks stable inode, size and modification time. The
encoder uses a data consumer capped at 16 MiB. Full decoding occurs in the short
lived process with a ten-second CPU limit; the server also enforces a ten-second
wall timeout with SIGKILL. A killed process does not produce a valid result.

HEICS animation requires a finite positive delay of at most 3600 seconds on every
frame and an explicit integral loop count. Missing timing, untimed multi-image
HEIC, a one-frame sequence, differing frame canvases, unknown types, or oversized
images fail explicitly. The converter does not invent timing or flatten animation.
Orientation uses ImageIO's full-image transform and checks the resulting dimensions
without resizing. PNG encoding retains the image color profile; canonical sRGB
RGBA comparison checks preview pixels and alpha, not original compressed bytes.

Recognized alpha auxiliary planes are accepted. One narrow raster-only exception
also permits a static, single-image HEIC whose sole untyped auxiliary descriptor
contains exactly width, height, orientation and the public
`kCVPixelFormatType_OneComponent8` pixel format. Its bounded dimensions and normal
orientation must match the primary image, and the source must explicitly report
alpha. Decoded alpha and the full PNG pixel roundtrip are still required.

This matches the bounded metadata structure of controlled transparent sticker
fixtures. The public auxiliary-info queries did not identify their untyped plane.
The exception does not infer that plane's purpose or preserve its unknown
semantics: it preserves only ImageIO's decoded raster and alpha. Extra descriptor
keys, references, multiple planes, other formats, mismatched dimensions and
untyped animated auxiliaries are rejected. Depth, HDR gain maps and dynamic
effects are not rendered by this utility. The server
must reject unsupported sticker-effect metadata before invoking it. Original
download remains the fallback; a preview must not claim effect or HDR fidelity.
Public metadata inspection here is limited to image size, orientation, alpha,
auxiliary descriptor shape and animation timing. It does not access Messages databases,
private transport blobs, accounts, chats, or private-framework objects.

## Synthetic verification

The native workflow compiles both executable architectures and runs generated
fixtures on macOS. Always-run tests cover dimension/frame/pixel limits, strict
timing and auxiliary rejection, APNG frame order/alpha/delays/loops, bounded output
consumer, no-follow input paths, exclusive publication, fixed CLI errors and
original bytes. HEIC tests cover static conversion, orientation and alpha.
HEICS tests separately cover an opaque animation baseline and alpha-animation
acceptance when the runner can generate complete timing and supported auxiliary
metadata. Unknown animated auxiliaries must fail, not silently lose alpha.

Fixture encoder limitations produce specific `SKIP` lines for static HEIC, HEIC
alpha, or HEICS. Those skips do not establish fidelity for the skipped codec.
Separate always-run coverage still executes; controlled native acceptance with
approved user fixtures remains required. Linux can check shell syntax and diffs
but cannot run ImageIO tests. No fixture artwork or private identifiers are
stored in the repository.

The implementation uses Apple's public
[ImageIO destination API](https://developer.apple.com/library/archive/documentation/GraphicsImaging/Conceptual/ImageIOGuide/ikpg_dest/ikpg_dest.html),
[HEICS sequence timing](https://developer.apple.com/documentation/imageio/kcgimagepropertyheicsunclampeddelaytime),
and [auxiliary data type API](https://developer.apple.com/documentation/imageio/kcgimagepropertyauxiliarydatatype).
The alpha URNs are defined by the HEIF format, illustrated by the primary
[Nokia HEIF alpha-mask example](https://github.com/nokiatech/heif/wiki/II.-HEIF-Writer-Executable-and-Configuration-Examples)
and [libavif alpha constants](https://aomedia.googlesource.com/libavif/+/refs/heads/main/include/avif/internal.h).
This utility does not copy reference-source code.
