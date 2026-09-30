# Custom reaction checks

Run from the repository root:

```sh
npm ci --ignore-scripts --force
node --test packages/server/test/*.test.cjs
node_modules/.bin/tsc --noEmit -p packages/server/tsconfig.json
```

Use Node 20 and npm 10. The upstream manifest's `devEngines` shape is rejected by newer npm; on Linux, `--force` permits installing the locked macOS-only packages for static checks. Installation scripts are disabled. The tests transpile actual server modules using the existing TypeScript dependency and replace external/native boundaries. They never open Messages, send messages, inject helpers or start Electron. The feature CI also builds the production webpack bundle, without packaging or publishing it.

## API contract

Received reactions keep `associatedMessageType`: the six classic names, `emoji` / `-emoji` for database codes 2006 / 3006, `sticker` for 1000, and strings for unknown numeric codes. `associatedMessageEmoji` is a separate nullable field, available on macOS Sequoia and newer. It survives history, sockets and reduced notification serialization. Sticker attachments retain `isSticker` in reduced notifications too. Older macOS versions do not select the Sequoia database column. A Sequoia installation with an anomalously old Messages schema still requires native validation; there is no schema mutation or migration.

Send through the existing reaction endpoint with a classic descriptor or one emoji grapheme in `reaction` (for example `"👩🏾‍💻"`); prefix `-` to remove that exact emoji. Socket clients use the existing `tapback` field with the same values. The server validates emoji structure and a nonnegative integer `partIndex`, then sends `reactionType: "emoji"` / `"-emoji"` plus `reactionEmoji` to the helper. Arbitrary text, numeric codes and multiple emojis are rejected.

`server/info` exposes `privateApiCapabilities.customEmojiReactions`, which is true only while the connected `com.apple.MobileSMS` helper explicitly advertises that capability. Missing capability, old helper, another process or disconnect means false. Emoji sends go only to that helper. Received metadata remains available independently. `stickerReactions` is false: receiving attachment metadata does not establish a native sticker-send API.

Custom confirmation checks the sender, target GUID, part, type, emoji, chat and send time. `bp:GUID` is accepted only for part zero for rich-link bubbles. Outgoing promise matching uses metadata, without relying on localized reaction text. A native dispatch without a matching message is an error; there is no automatic retry. Offline checks cannot establish macOS selector behavior, delivery acceptance, replacement/removal persistence or sticker-placement behavior. Those require a controlled native test after review.

## Attribution

The Sequoia column, emoji reaction code mapping and helper wire shape adapt Zach Garcia's [server PR #839](https://github.com/BlueBubblesApp/bluebubbles-server/pull/839), specifically commits `6b578ab` and `19bc4e0`. The companion [app PR #3162](https://github.com/BlueBubblesApp/bluebubbles-app/pull/3162) informed the existing public raw-emoji request encoding. This implementation preserves reaction types separately from emoji metadata and adds validation, explicit capability negotiation and confirmation checks. Dock behavior, binary changes and other unrelated PR changes were excluded.

## Separate macOS preview artifact

The preview workflow runs only on the owner's fork and feature branch or by manual dispatch. It builds on an ARM64 `macos-15` runner with Node 20.11, Python 3.11 and the unchanged dependency lock. Package scripts are disabled during installation; the workflow explicitly downloads Electron 25.9.8 and rebuilds the three native modules for that Electron ABI. It tests and embeds helper revision `0a9072f1172bc46f1a33a2bc58b8df05cd8e81ef`, builds the existing UI, then packages a new `BlueBubbles Preview.app` with bundle ID `com.mishdivy.bluebubbles-preview` and version `1.9.9-preview.<server revision>`.

The builder generates the new ASAR integrity record and signs the new app ad hoc. The verified helper retains its build signature and bytes. The build verifies the full app signature, ASAR header integrity and embedded helper hash before creating a ZIP, checksums and a manifest with source revisions, code hashes and workflow provenance. These are CI artifacts, not a published release. The build does not copy, modify or re-sign the installed vendor app. An ad-hoc signature is not Developer ID signing or notarization; installation and privacy permissions remain separate host checks.

The packaging bootstrap requires an existing owner-only state clone at `~/Library/Application Support/divy-mac-utils/services/bluebubbles-preview/data`, including `config.db`. It chooses that directory before loading any server code. Deployment tooling in `divy-mac-utils` prepares the clone and coordinates the one existing LaunchAgent; this build script never activates an app or switches a process. Preview logs use `~/Library/Logs/divy-mac-utils/bluebubbles-preview/main.log`. Both automatic and manual updater checks and the install endpoint are disabled for the preview. Production app state, logs and updater behavior keep their existing paths and behavior.
