const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { NSAttributedString } = require("node-typedstream");
const { validateInput, summarizeDecoded } = require("../scripts/inspect-sticker-body.cjs");
const script = path.resolve(__dirname, "../scripts/inspect-sticker-body.cjs");

function body(guids, string = "\uFFFC".repeat(guids.length)) {
    return new NSAttributedString(string, guids.map((guid, index) => ({ range: [index, 1], attributes: {
        __kIMFileTransferGUIDAttributeName: guid, __kIMFilenameAttributeName: "private-filename.png",
        __kIMMessagePartAttributeName: 0, __kIMEmojiImageAttributeName: 1, __kIMBaseWritingDirectionAttributeName: -1,
        NSFont: { opaque: "private-font-value" }, "private-key-name": Buffer.from("private-opaque-value"),
        NSPrivateFilenameEncodedInKey: "private-attribute-value"
    } })));
}

test("inspector reports per-character transfer order, flags and safe key types only", () => {
    const guids = ["private-guid-first", "private-guid-second"];
    const result = summarizeDecoded([{ values: [body(guids)] }], guids);
    assert.equal(result.bodyCount, 1);
    assert.equal(result.linkedAttachmentCount, 2);
    const summary = result.bodies[0];
    assert.equal(summary.fffcOnly, true); assert.equal(summary.fffcCount, 2); assert.equal(summary.length, 2);
    assert.equal(summary.linkedOrderEqual, true);
    assert.deepEqual(summary.perCharacterTransferOrdinals, [[0], [1]]);
    assert.deepEqual(summary.runs.map(run => [run.range, run.transferOrdinal, run.part, run.emoji, run.writing]),
        [[[0, 1], 0, 0, 1, -1], [[1, 1], 1, 0, 1, -1]]);
    assert.deepEqual(summary.runs[0].attributes.slice(-3), [
        { key: "NSFont", type: "object" }, { key: "<redacted>", type: "bytes" }, { key: "<redacted>", type: "string" }
    ]);
    const output = JSON.stringify(result);
    assert.equal(output.includes("private-"), false);
    assert.equal(output.includes("NSPrivateFilenameEncodedInKey"), false);
    assert.equal(output.includes("\uFFFC"), false);
});

test("inspector distinguishes mixed text, reordered/unlinked GUIDs, overlap and nonnumeric flags", () => {
    const ids = ["first", "second"];
    const mixed = summarizeDecoded([body(ids, "private-text")], ids).bodies[0];
    assert.equal(mixed.fffcOnly, false); assert.equal(mixed.fffcCount, 0); assert.equal(mixed.linkedOrderEqual, false);
    assert.equal(JSON.stringify(mixed).includes("private-text"), false);
    const reversed = summarizeDecoded([body(ids)], ids.slice().reverse()).bodies[0];
    assert.deepEqual(reversed.perCharacterTransferOrdinals, [[1], [0]]); assert.equal(reversed.linkedOrderEqual, false);
    const unlinked = summarizeDecoded([body(ids)], ["other"]).bodies[0];
    assert.deepEqual(unlinked.perCharacterTransferOrdinals, [[null], [null]]); assert.equal(unlinked.linkedOrderEqual, false);
    const overlap = body(ids); overlap.runs[1].range = [0, 1];
    assert.deepEqual(summarizeDecoded([overlap], ids).bodies[0].perCharacterTransferOrdinals, [[0, 1], []]);
    const boolean = body(ids); boolean.runs[0].attributes.__kIMEmojiImageAttributeName = true;
    const run = summarizeDecoded([boolean], ids).bodies[0].runs[0];
    assert.equal(run.emoji, null); assert.equal(run.attributes.find(attr => attr.key === "__kIMEmojiImageAttributeName").type, "boolean");
    assert.equal(summarizeDecoded([body(ids), body(ids)], ids).bodyCount, 2);
});

test("inspector reports UTF-16 marker and newline positions without text", () => {
    const text = "private-😀\uFFFC\r\nend\uFFFC";
    const summary = summarizeDecoded([new NSAttributedString(text, [])], []).bodies[0];
    assert.deepEqual(summary.markerOffsets, [10, 16]);
    assert.deepEqual(summary.newlineOffsets, [11, 12]);
    assert.equal(JSON.stringify(summary).includes("private"), false);
    const wrapped = summarizeDecoded([new NSAttributedString("x\uFFFC same line", [])], []).bodies[0];
    assert.deepEqual(wrapped.newlineOffsets, []);
});

test("inspector rejects oversized or noncanonical inputs and decoded summary bounds", () => {
    const input = { attributedBody: Buffer.from("not an archive").toString("base64"), attachmentGuids: ["first"] };
    assert.deepEqual(validateInput(input), Buffer.from("not an archive"));
    for (const bad of [null, [], { ...input, extra: true }, { ...input, attributedBody: "private invalid base64" },
        { ...input, attributedBody: "Zh==" }, { ...input, attributedBody: Buffer.alloc(65537).toString("base64") },
        { ...input, attachmentGuids: Array(33).fill("first") }, { ...input, attachmentGuids: ["first", "first"] },
        { ...input, attachmentGuids: ["x".repeat(1025)] }]) assert.throws(() => validateInput(bad), /^Error: invalid_input$/);
    assert.throws(() => summarizeDecoded([body(["first"], "x".repeat(1025))], ["first"]), /summary_limits/);
    assert.throws(() => summarizeDecoded([], []), /summary_limits/);
});

test("CLI parses only bounded stdin and never emits parser errors or private input", () => {
    for (const input of ["private invalid json", JSON.stringify({ attributedBody: "not-base64-private", attachmentGuids: [] }),
        JSON.stringify({ attributedBody: Buffer.from("private-parser-exception-content").toString("base64"), attachmentGuids: ["private-guid"] }),
        " ".repeat(128 * 1024 + 1)]) {
        const result = spawnSync(process.execPath, [script], { input, encoding: "utf8", timeout: 7000, maxBuffer: 65536 });
        assert.equal(result.status, 1); assert.equal(result.stderr, "");
        const output = JSON.parse(result.stdout);
        assert.equal(output.version, 1); assert.equal(output.ok, false);
        assert.ok(["invalid_input", "parse_failed"].includes(output.error));
        assert.equal(result.stdout.includes("private"), false);
        assert.ok(Buffer.byteLength(result.stdout) < 128);
    }
});
