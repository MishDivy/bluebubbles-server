# Custom reaction checks

Run from the repository root:

```sh
npm ci --ignore-scripts --force
node --test packages/server/test/*.test.cjs
node_modules/.bin/tsc --noEmit -p packages/server/tsconfig.json
```

Use Node 20 and npm 10. The upstream manifest's `devEngines` shape is rejected by newer npm; on Linux, `--force` permits installing the locked macOS-only packages for static checks. Installation scripts are disabled. The tests transpile actual server modules using the existing TypeScript dependency and replace external/native boundaries. They never open Messages, send messages, inject helpers or start Electron. The checks workflow runs on `main`, `feature/custom-reactions`, `feature/native-stickers` and pull requests. It also builds the production webpack bundle, without packaging or publishing it.

## Fork production branch

The owner's fork uses `main` as the source base for the custom production deployment. It starts from tested revision `f7045711ef1bf72e8a209b316830db2eef70574c`; the existing `master` history remains unchanged. Both checks and macOS artifact builds run on `main`. Promoting the branch does not activate a deployment or change the installed custom app's identity, paths or updater policy.

The inherited `.github/workflows/main.yml` runs only on pushes to `master` and invokes the upstream publishing configuration. Keep it off `main`. The fork's macOS workflow has read-only repository permissions and uploads CI artifacts only; it does not publish tags or GitHub releases.

## API contract

Received reactions keep `associatedMessageType`: the six classic names, `emoji` / `-emoji` for database codes 2006 / 3006, `sticker` for 1000, and strings for unknown numeric codes. `associatedMessageEmoji` is a separate nullable field, available on macOS Sequoia and newer. It survives history, sockets and reduced notification serialization. Sticker attachments retain `isSticker` in reduced notifications too. Older macOS versions do not select the Sequoia database column. A Sequoia installation with an anomalously old Messages schema still requires native validation; there is no schema mutation or migration.

Send through the existing reaction endpoint with a classic descriptor or one emoji grapheme in `reaction` (for example `"👩🏾‍💻"`); prefix `-` to remove that exact emoji. Socket clients use the existing `tapback` field with the same values. The server validates emoji structure and a nonnegative integer `partIndex`, then sends `reactionType: "emoji"` / `"-emoji"` plus `reactionEmoji` to the helper. Arbitrary text, numeric codes and multiple emojis are rejected.

`server/info` exposes `privateApiCapabilities.customEmojiReactions`, which is true only while the connected `com.apple.MobileSMS` helper explicitly advertises that capability. Missing capability, old helper, another process or disconnect means false. Emoji sends go only to that helper. Received metadata remains available independently. `stickerReactions` remains false.

Custom confirmation checks the sender, target GUID, part, type, emoji, chat and send time. `bp:GUID` is accepted only for part zero for rich-link bubbles. Outgoing promise matching uses metadata, without relying on localized reaction text. A native dispatch without a matching message is an error; there is no automatic retry. Offline checks cannot establish macOS selector behavior, delivery acceptance, replacement/removal persistence or sticker-placement behavior. Those require a controlled native test after review.

## Experimental standalone stickers

The `feature/native-stickers` branch adds authenticated multipart `POST /api/v1/message/send-sticker`: one `attachment`, `chatGuid`, required `tempGuid`, safe basename `name` (at most 255 UTF-16 units), and optional `stickerLabel` (at most 150 UTF-16 units). It rejects every additional field, including reply targets, placement, row, reaction and audio fields. The chat must already exist and use iMessage. `privateApiCapabilities.stickerSending` requires explicit true from the connected Messages helper; `stickerPlacement`, `stickerRows` and `stickerReactions` are false. The packaged helper pin remains unchanged, so the production helper cannot enable this experiment.

The route limits multipart file bytes to 500 KiB before staging, preserves repeated file fields for rejection, bounds text fields to 8 KiB and cleans parsed uploads even when downstream auth or capability checks fail. Header checks accept PNG/APNG, GIF and JPEG with dimensions at most 618 by 618, at most 100 frames and at most 25 million canvas pixels across frames. These checks do not decode pixels; the opt-in native helper must fully decode and enforce the same bounds before dispatch. Neither layer substitutes an ordinary photo send.

The server dispatches `send-sticker` only to the capable Messages helper and confirms the exact returned GUID against a fresh outgoing, sent, error-free iMessage row in the requested chat, with exactly one outgoing sticker attachment and nonempty sticker metadata. A helper response without that row is an uncertain outcome. The server does not retry it. Attempted temporary GUIDs stay blocked for the life of the server process, including successful and uncertain outcomes. The bounded guard refuses additional attempts at 4096 entries without evicting earlier entries. Restart clears this process-local guard; review the chat and reconcile uncertain attempts before restarting or choosing a new temporary GUID. This is not durable exactly-once delivery.

Synthetic checks use the installed multipart parser, image header fixtures and mocked native/database boundaries. They verify bounds, repeated-file rejection, cleanup, capabilities, exact confirmation, concurrent duplicate suppression and ordinary send-route collisions. They do not establish native ABI behavior, remote delivery, placement, rows or sticker tapbacks. Controlled macOS fixtures and native acceptance remain required.

## Attribution

The Sequoia column, emoji reaction code mapping and helper wire shape adapt Zach Garcia's [server PR #839](https://github.com/BlueBubblesApp/bluebubbles-server/pull/839), specifically commits `6b578ab` and `19bc4e0`. The companion [app PR #3162](https://github.com/BlueBubblesApp/bluebubbles-app/pull/3162) informed the existing public raw-emoji request encoding. This implementation preserves reaction types separately from emoji metadata and adds validation, explicit capability negotiation and confirmation checks. Dock behavior, binary changes and other unrelated PR changes were excluded.

## Separate macOS preview artifact

The preview workflow runs only on the owner's fork, on `main` and `feature/custom-reactions` or by manual dispatch. It builds on an ARM64 `macos-15` runner with Node 20.11, Python 3.11 and the unchanged dependency lock. Package scripts are disabled during installation; the workflow explicitly downloads Electron 25.9.8 and rebuilds the three native modules for that Electron ABI. It tests and embeds helper revision `0a9072f1172bc46f1a33a2bc58b8df05cd8e81ef`, builds the existing UI, then packages a new `BlueBubbles Preview.app` with bundle ID `com.mishdivy.bluebubbles-preview` and version `1.9.9-preview.<server revision>`.

The builder generates the new ASAR integrity record and signs the new app ad hoc. The verified helper retains its build signature and bytes. The build verifies the full app signature, ASAR header integrity and embedded helper hash before creating a ZIP, checksums and a manifest with source revisions, code hashes and workflow provenance. These are CI artifacts, not a published release. The build does not copy, modify or re-sign the installed vendor app. An ad-hoc signature is not Developer ID signing or notarization; installation and privacy permissions remain separate host checks.

The packaging bootstrap requires an existing owner-only state clone at `~/Library/Application Support/divy-mac-utils/services/bluebubbles-preview/data`, including `config.db`. It chooses that directory before loading any server code. Deployment tooling in `divy-mac-utils` prepares the clone and coordinates the one existing LaunchAgent; this build script never activates an app or switches a process. Preview logs use `~/Library/Logs/divy-mac-utils/bluebubbles-preview/main.log`. Both automatic and manual updater checks and the install endpoint are disabled for the preview. Production app state, logs and updater behavior keep their existing paths and behavior.
