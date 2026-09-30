# Custom reaction checks

Run from the repository root:

```sh
npm ci --ignore-scripts --force
node --test packages/server/test/reactions.test.cjs
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
