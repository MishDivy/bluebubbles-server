const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const crypto = require("node:crypto");
const sourceRoot = path.resolve(__dirname, "../src/server");

function load(relative, overrides = {}) {
    const cache = new Map();
    const read = filename => {
        if (cache.has(filename)) return cache.get(filename).exports;
        const module = { exports: {} };
        cache.set(filename, module);
        const localRequire = name => {
            if (Object.hasOwn(overrides, name)) return overrides[name];
            if (["fs", "os", "path", "crypto", "child_process"].includes(name)) return require(name);
            if (name === "@server/api/stickers") return read(path.join(sourceRoot, "api/stickers.ts"));
            if (name === "@server/api/stickerMetadata") return read(path.join(sourceRoot, "api/stickerMetadata.ts"));
            if (name === "@server/api/stickerPreview") return read(path.join(sourceRoot, "api/stickerPreview.ts"));
            if (name === "../responses/types") return read(path.join(sourceRoot, "api/http/api/v1/responses/types.ts"));
            if (name === "bplist-parser") return require(name);
            throw new Error(`Unmocked dependency: ${name}`);
        };
        const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
        }).outputText;
        new Function("require", "module", "exports", "setTimeout", code)(
            localRequire,
            module,
            module.exports,
            overrides.setTimeout ?? setTimeout
        );
        return module.exports;
    };
    return read(path.join(sourceRoot, relative));
}

// Header fixtures exercise the server bounds. Native decoder acceptance requires real images on macOS.
function chunk(type, data) {
    const result = Buffer.alloc(12 + data.length);
    result.writeUInt32BE(data.length);
    result.write(type, 4);
    data.copy(result, 8);
    return result;
}
function png(width = 64, height = 64, frames = 1) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    const chunks = [chunk("IHDR", header)];
    if (frames !== 1) {
        const animation = Buffer.alloc(8);
        animation.writeUInt32BE(frames);
        chunks.push(chunk("acTL", animation));
        for (let index = 0; index < frames; index++) chunks.push(chunk("fcTL", Buffer.alloc(26)));
    }
    chunks.push(chunk("IDAT", Buffer.from([1])), chunk("IEND", Buffer.alloc(0)));
    return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), ...chunks]);
}
const stickers = load("api/stickers.ts");
test("helper failure codes accept only exact fixed string rejections", () => {
    for (const [reason, code] of [
        ["Invalid or inaccessible sticker image", "helper_image_invalid"],
        ["Unable to construct native sticker message", "helper_message_failed"],
        ["Unable to construct native sticker placement", "helper_placement_failed"],
        ["Unable to construct native sticker reaction", "helper_reaction_failed"],
        ["Current own sticker reaction is unavailable or changed", "helper_reaction_changed"],
        ["Native sticker target lookup timed out", "helper_target_timeout"],
        ["Sticker dispatch outcome is unknown; do not retry", "helper_dispatch_unknown"],
        ["Transaction timeout", "helper_timeout"]
    ]) assert.equal(stickers.stickerHelperFailureCode(reason), code);
    for (const error of [null, undefined, 123, "constructor", "toString", "__proto__",
        "Unable to construct native sticker message private suffix", "Invalid or inaccessible sticker image\n",
        new Error("Unable to construct native sticker message"), { message: "Transaction timeout" },
        { toString() { throw new Error("Must not stringify private payloads"); } }]) {
        assert.equal(stickers.stickerHelperFailureCode(error), "helper_unknown");
    }
});

test("all native sticker routes expose and log fixed codes without private error contents", async () => {
    const state = load("api/stickers.ts");
    const logs = [];
    let mode;
    const privateDetails = "synthetic-private-path-guid-body";
    class IMessageError extends Error {
        constructor(response) { super(response.error); this.status = 500; this.response = response; }
    }
    class BadRequest extends Error {
        constructor(response) { super(response.error); this.status = 400; }
    }
    const send = async () => {
        if (mode === "unknown") throw new state.StickerUnconfirmedError(privateDetails, state.stickerHelperFailureCode(new Error(privateDetails)));
        if (mode === "known") throw new state.StickerUnconfirmedError(privateDetails,
            state.stickerHelperFailureCode("Unable to construct native sticker message"));
        if (mode === "validation") throw new Error(privateDetails);
        return {};
    };
    const { MessageRouter } = load("api/http/api/v1/routers/messageRouter.ts", {
        "@server": { Server: () => ({ log: (message, level) => logs.push({ message, level }) }) },
        "@server/api/stickers": state,
        "@server/api/interfaces/messageInterface": { MessageInterface: {
            sendSticker: send, sendStickerRow: send, sendStickerAction: send, removeStickerTapback: send
        } },
        "@server/api/serializers/MessageSerializer": { MessageSerializer: { async serialize() { throw new Error(privateDetails); } } },
        "@server/fileSystem": {}, "@server/helpers/utils": {}, "@server/databases/imessage/entity/Message": {},
        "@server/managers/outgoingMessageManager/messagePromise": {}, "@server/utils/CollectionUtils": {},
        "../responses/success": {}, "../responses/errors": { IMessageError, BadRequest }, "../utils": {}, "@server/env": {}
    });
    for (const route of ["sendSticker", "sendStickerRow", "sendStickerPlacement", "sendStickerTapback", "removeStickerTapback"]) {
        const body = { chatGuid: "chat", tempGuid: "temporary", name: "fixture.png" };
        if (route === "sendStickerRow") {
            delete body.name; body.stickers = JSON.stringify([{ name: "fixture.png" }, { name: "fixture.png" }]);
        }
        if (["sendStickerPlacement", "sendStickerTapback", "removeStickerTapback"].includes(route)) {
            body.selectedMessageGuid = "target"; body.partIndex = 0;
        }
        if (route === "sendStickerPlacement") body.placement = JSON.stringify({ x: 0, y: 0, scale: 1, rotation: 0, parentWidth: 400 });
        if (route === "removeStickerTapback") { delete body.name; body.reactionGuid = "reaction"; }
        const ctx = { request: { body, files: { attachment: { path: "unused" }, attachment0: { path: "unused" }, attachment1: { path: "unused" } } } };
        for (mode of ["known", "unknown", "serialization", "validation"]) {
            const before = logs.length;
            const code = { known: "helper_message_failed", unknown: "helper_unknown", serialization: "response_serialization_failed" }[mode];
            await assert.rejects(MessageRouter[route](ctx), error => {
                assert.equal(error.status, mode === "validation" ? 400 : 500);
                assert.equal(error.message.includes(privateDetails), false);
                if (mode !== "validation") assert.equal(error.message,
                    `Check the chat before sending again. Automatic retry is disabled. [${code}]`);
                return true;
            });
            assert.equal(logs.length - before, mode === "validation" ? 0 : 1);
            if (mode !== "validation") assert.deepEqual(logs.at(-1), {
                message: `[NativeSticker] Failure code=${code}; automatic retry disabled.`, level: "warn"
            });
        }
    }
});

function parseMultipart(files, limits = stickers.stickerMultipartLimits) {
    const { Readable } = require("node:stream");
    const { IncomingForm } = require("formidable");
    const boundary = "native-sticker-synthetic-boundary";
    const parts = [];
    for (const [name, bytes] of files) {
        parts.push(
            Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\n`
            ),
            bytes,
            Buffer.from("\r\n")
        );
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);
    const request = Readable.from([body]);
    request.headers = {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(body.length)
    };
    const form = new IncomingForm(limits);
    return new Promise(resolve =>
        form.parse(request, (error, fields, parsed) =>
            resolve({ error, fields, files: parsed, openedFiles: form.openedFiles })
        )
    );
}

test("installed multipart parser generates trusted uploads and enforces native byte bounds", async () => {
    assert.equal(stickers.isStickerUploadRequest("POST", "/api/v1/message/send-sticker"), true);
    assert.equal(stickers.isStickerUploadRequest("POST", "/api/v1/message/send-sticker/"), true);
    assert.equal(stickers.isStickerUploadRequest("POST", "/API/V1/MESSAGE/SEND-STICKER"), true);
    assert.equal(stickers.isStickerUploadRequest("POST", "/api/v1/message/attachment"), false);
    assert.equal(stickers.isStickerUploadRequest("GET", "/api/v1/message/send-sticker"), false);
    const parsed = await parseMultipart([["attachment", png()]]);
    assert.ifError(parsed.error);
    try {
        assert.match(path.basename(parsed.files.attachment.path), /^upload_[a-f0-9]{32}$/);
        assert.equal(path.dirname(parsed.files.attachment.path), os.tmpdir());
        assert.deepEqual(stickers.readStickerUpload(parsed.files.attachment.path, "fixture.png"), png());
    } finally {
        stickers.removeStickerUpload(parsed.files.attachment.path);
    }
    const oversized = await parseMultipart([["attachment", Buffer.alloc(stickers.MAX_STICKER_BYTES + 1)]]);
    assert.match(oversized.error.message, /maxFileSize/);
    await new Promise(resolve => setTimeout(resolve, 20));
    for (const file of oversized.openedFiles) assert.equal(fs.existsSync(file.path), false);
});

function rowFixture(count = 2) {
    return { guid: "row", service: "iMessage", isFromMe: true, isSent: true, error: 0,
        dateCreated: new Date(), chats: [{ guid: "chat", serviceName: "iMessage" }],
        attachments: Array.from({ length: count }, (_, index) => ({ guid: `attachment-${index}`, isSticker: true, isOutgoing: false,
            stickerUserInfo: Buffer.from([1]) })).reverse(),
        attributedBody: [{ string: "\uFFFC".repeat(count), runs: Array.from({ length: count }, (_, index) => ({
            range: [index, 1], attributes: { __kIMFileTransferGUIDAttributeName: `attachment-${index}`,
                __kIMMessagePartAttributeName: 0, __kIMEmojiImageAttributeName: 1, __kIMFilenameAttributeName: "fixture.png" }
        })) }] };
}

test("row JSON enforces 2 to 10 ordered descriptors and rejects unsupported fields", () => {
    const descriptors = [{ name: "first.png" }, { name: "second.gif", stickerLabel: "Second" }];
    const body = { chatGuid: "chat", tempGuid: "row", stickers: JSON.stringify(descriptors) };
    assert.deepEqual(stickers.parseStickerRowFields(body), descriptors);
    for (const invalid of [[], [descriptors[0]], Array(11).fill(descriptors[0]), [{ name: "../fixture.png" }, descriptors[1]],
        [{ name: "fixture.png", selectedMessageGuid: "target" }, descriptors[1]], [null, descriptors[1]]]) {
        assert.throws(() => stickers.parseStickerRowFields({ ...body, stickers: JSON.stringify(invalid) }));
    }
    assert.throws(() => stickers.parseStickerRowFields({ ...body, selectedMessageGuid: "target" }));
    assert.throws(() => stickers.parseStickerRowFields({ ...body, stickers: "x".repeat(8193) }));
    assert.equal(stickers.isStickerRowUploadRequest("POST", "/API/V1/MESSAGE/SEND-STICKER-ROW/"), true);
});

test("row confirmation checks constructed transfer order even with duplicate filenames and reversed DB attachment order", () => {
    const row = rowFixture();
    const ids = ["attachment-0", "attachment-1"];
    const names = ["fixture.png", "fixture.png"];
    assert.deepEqual(stickers.getStickerLayout(row), { attachmentGuids: ids, partIndex: 0 });
    assert.equal(stickers.matchesSentStickerBatch(row, "row", "chat", Date.now() - 1000, 2, names, ids), true);
    assert.equal(stickers.matchesSentStickerBatch(row, "row", "chat", Date.now() - 1000, 2, names, ids.slice().reverse()), false);
    assert.equal(stickers.matchesSentStickerBatch(row, "row", "chat", Date.now() - 1000, 2, names), false);
    for (const change of [{ isFromMe: false }, { associatedMessageGuid: "p:0/target" },
        { attachments: [row.attachments[0], row.attachments[0]] }, { attachments: row.attachments.slice(1) }]) {
        assert.equal(stickers.matchesSentStickerBatch({ ...row, ...change }, "row", "chat", Date.now() - 1000, 2, names, ids), false);
    }
    for (const change of [{ __kIMMessagePartAttributeName: 1 }, { __kIMEmojiImageAttributeName: 0 }, { __kIMFileTransferGUIDAttributeName: "attachment-0" }]) {
        const bad = rowFixture();
        Object.assign(bad.attributedBody[0].runs[1].attributes, change);
        assert.equal(stickers.getStickerLayout(bad), null);
        assert.equal(stickers.matchesSentStickerBatch(bad, "row", "chat", Date.now() - 1000, 2, names, ids), false);
    }
    const mixed = rowFixture(); mixed.attributedBody[0].string += "text";
    const extraRun = rowFixture(); extraRun.attributedBody[0].runs.push({ range: [2, 1], attributes: {} });
    const overlapping = rowFixture(); overlapping.attributedBody[0].runs[1].range = [0, 1];
    const multipleBodies = rowFixture(); multipleBodies.attributedBody.push({ string: "text", runs: [] });
    for (const invalid of [mixed, extraRun, overlapping, multipleBodies]) assert.equal(stickers.getStickerLayout(invalid), null);
});

test("row upload validator rejects oversized individual files, extras and repeated indexes", async () => {
    const Validator = validator({ httpService: { sendCache: { find: () => null } } });
    const body = { chatGuid: "chat", tempGuid: "row", stickers: JSON.stringify([{ name: "fixture.png" }, { name: "fixture.png" }]) };
    for (const files of [[ ["attachment0", png()], ["attachment1", png()] ],
        [["attachment0", png()], ["attachment1", Buffer.alloc(stickers.MAX_STICKER_BYTES + 1)]],
        [["attachment0", png()], ["attachment1", png()], ["extra", png()]],
        [["attachment0", png()], ["attachment0", png()], ["attachment1", png()]]]) {
        const parsed = await parseMultipart(files, stickers.stickerRowMultipartLimits);
        assert.ifError(parsed.error);
        try {
            let reached = false;
            const validate = () => Validator.validateStickerRow({ request: { body, files: parsed.files } }, async () => { reached = true; });
            if (files.length === 2 && files[1][1].length <= stickers.MAX_STICKER_BYTES) { await validate(); assert.equal(reached, true); }
            else { await assert.rejects(validate()); assert.equal(reached, false); }
        } finally { for (const file of parsed.openedFiles) stickers.removeStickerUpload(file.path); }
    }
    const oversized = await parseMultipart([["attachment0", Buffer.alloc(stickers.MAX_STICKER_ROW_BYTES + 1)]], stickers.stickerRowMultipartLimits);
    assert.match(oversized.error.message, /maxFileSize/);
    await new Promise(resolve => setTimeout(resolve, 20));
    for (const file of oversized.openedFiles) assert.equal(fs.existsSync(file.path), false);
});

const syntheticSource = Buffer.from("YnBsaXN0MDDdAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRpTcGlkU3NhaVVzaGFzaFNzaWRTc2lyU3NsaVNzcHZTc3B3U3Nyb1Nzc2FTc3hzU3N5c1d1bmtub3duXxAQc3ludGhldGljLmJ1bmRsZVExXnN5bnRoZXRpYy5oYXNoXxAPc3ludGhldGljLmFzc2V0CVEyEAFSNzJUMC4yNVMxLjVSLTRROFdvbWl0LW1lCCMnKzE1OT1BRUlNUVVdcHKBk5SWmJugpKepAAAAAAAAAQEAAAAAAAAAGwAAAAAAAAAAAAAAAAAAALE=", "base64");
const syntheticAttribution = Buffer.from("YnBsaXN0MDDYAQIDBAUGBwgJCgsMDQ4PGldhY2Nlc3NsV2FkYW0taWRZYnVuZGxlLWlkVG5hbWVWcGdlbnNoVnBnZW5zd1dwZ2Vuc3pjV3Vua25vd25fEBFTeW50aGV0aWMgc3RpY2tlchB7XxASc3ludGhldGljLmZhbGxiYWNrXlN5bnRoZXRpYyBwYWNrI0BUAAAAAAAAI0BQAAAAAAAA1RAREhMUFRYXGBlTbXB3U210aFNtdHdRc1JzdCNAPgAAAAAAACNAJAAAAAAAACNANAAAAAAAACM/8AAAAAAAAAhXb21pdC1tZQgZISkzOD9GTlZqbIGQmaKtsbW5u77H0Nni4wAAAAAAAAEBAAAAAAAAABsAAAAAAAAAAAAAAAAAAADr", "base64");
const syntheticNumericGeometry = Buffer.from("YnBsaXN0MDDcAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYU3BpZFNzYWlVc2hhc2hTc2lkU3NpclNzbGlTc3B2U3Nwd1Nzcm9Tc3NhU3N4c1NzeXNfEBBzeW50aGV0aWMuYnVuZGxlIz/wAAAAAAAAXnN5bnRoZXRpYy5oYXNoXxAPc3ludGhldGljLmFzc2V0CSNAAAAAAAAAABABI0BSAAAAAAAAIz/QAAAAAAAAIz/4AAAAAAAAI8AQAAAAAAAAI0AgAAAAAAAACCElKS8zNzs/Q0dLT1Nmb36QkZqcpa63wAAAAAAAAAEBAAAAAAAAABkAAAAAAAAAAAAAAAAAAADJ", "base64");
const syntheticSourceKeys = Buffer.from("YnBsaXN0MDDWAQIDBAUGBwgJCgsMU3BpZFRzYmlkVXNoYXNoU3NpZF8QEXN0aWNrZXJFZmZlY3RUeXBlVHRzc2Fec3ludGhldGljLnBhY2tfEBBzeW50aGV0aWMuc291cmNlXnN5bnRoZXRpYy5oYXNoXxAPc3ludGhldGljLmFzc2V0EAMjP+gAAAAAAAAIFRkeJCg8QVBjcoSGAAAAAAAAAQEAAAAAAAAADQAAAAAAAAAAAAAAAAAAAI8=", "base64");
const safeMetadata = load("api/stickerMetadata.ts");

test("helper numeric-string dimensions and size-class values normalize to finite numbers", () => {
    const helperAttribution = Buffer.from("YnBsaXN0MDDUAQIDBAUGBwhZYnVuZGxlLWlkVnBnZW5zaFZwZ2Vuc3dXcGdlbnN6Y18QEHN5bnRoZXRpYy5oZWxwZXJSODBSNjTVCQoLDA0HBgcOD1NtcHdTbXRoU210d1FzUnN0UTEICBEbIikxREdKVVldYWNmaAAAAAAAAAEBAAAAAAAAABAAAAAAAAAAAAAAAAAAAABp", "base64");
    assert.deepEqual(safeMetadata.normalizeStickerMetadata({ isSticker: true, attributionInfo: helperAttribution }), {
        sourceBundleId: "synthetic.helper", dimensions: { width: 64, height: 80 },
        sizeClass: { mpw: 64, mth: 80, mtw: 64, s: 1, st: false }
    });
    for (const value of [true, false, "", " ", "0x40", "NaN", "Infinity", "1e999", "64px", "6".repeat(1025), Infinity]) {
        assert.equal(safeMetadata.normalizeStickerMetadata({ isSticker: true, attributionInfo: [{
            pgensw: value, pgensh: value, pgenszc: { mpw: value, mth: value, mtw: value, s: value }
        }] }), null);
    }
    assert.deepEqual(safeMetadata.normalizeStickerMetadata({ isSticker: true, attributionInfo: [{
        pgensw: "6.4e1", pgensh: 80, pgenszc: { mpw: "64", mth: 80, mtw: "6.4e1", s: "1.25", st: false }
    }] }), { dimensions: { width: 64, height: 80 }, sizeClass: { mpw: 64, mth: 80, mtw: 64, s: 1.25, st: false } });
});

test("binary sticker metadata exports only allowlisted source and raw geometry with absent values omitted", () => {
    const expected = { sourceBundleId: "synthetic.fallback", packId: "synthetic.bundle", assetId: "synthetic.asset", hash: "synthetic.hash", packName: "Synthetic pack",
        appStoreId: 123, accessibilityLabel: "Synthetic sticker", placement: { sro: "0.25", spw: "72", ssa: "1.5", sai: "1", sli: "2", sys: "8", sxs: "-4", sir: true, spv: 1 },
        dimensions: { width: 64, height: 80 }, sizeClass: { mth: 10, mtw: 20, s: 1, mpw: 30, st: false } };
    assert.deepEqual(safeMetadata.normalizeStickerMetadata({ isSticker: true, stickerUserInfo: syntheticSource, attributionInfo: syntheticAttribution }), expected);
    const decoded = safeMetadata.decodeStickerAttribution(syntheticAttribution);
    assert.equal(decoded[0].unknown, undefined);
    assert.deepEqual(safeMetadata.normalizeStickerMetadata({ isSticker: true, attributionInfo: decoded }), {
        sourceBundleId: "synthetic.fallback", packName: "Synthetic pack", appStoreId: 123, accessibilityLabel: "Synthetic sticker",
        dimensions: { width: 64, height: 80 }, sizeClass: expected.sizeClass
    });
    assert.equal(safeMetadata.normalizeStickerMetadata({ isSticker: false, stickerUserInfo: syntheticSource }), null);
    assert.equal(safeMetadata.normalizeStickerMetadata({ isSticker: true }), null);
    const numeric = safeMetadata.normalizeStickerMetadata({ isSticker: true, stickerUserInfo: syntheticNumericGeometry });
    assert.equal(numeric.sourceBundleId, undefined);
    assert.equal(numeric.packId, "synthetic.bundle");
    assert.deepEqual(numeric.placement, { sro: 0.25, spw: 72, ssa: 1.5, sai: 1, sli: 2, sys: 8, sxs: -4, sir: true, spv: 1 });
    assert.deepEqual(safeMetadata.normalizeStickerMetadata({ isSticker: true, stickerUserInfo: syntheticSourceKeys, attributionInfo: syntheticAttribution }), {
        sourceBundleId: "synthetic.source", packId: "synthetic.pack", assetId: "synthetic.asset", hash: "synthetic.hash", packName: "Synthetic pack",
        accessibilityLabel: "Synthetic sticker", appStoreId: 123, effectType: 3, placement: { tssa: 0.75 }, dimensions: expected.dimensions, sizeClass: expected.sizeClass
    });
});

test("malformed, oversized and cyclic binary metadata fails closed without a payload", () => {
    for (const bytes of [Buffer.from("invalid"), Buffer.alloc(64 * 1024 + 1), syntheticSource.subarray(0, 40)]) {
        assert.equal(safeMetadata.decodeStickerPlist(bytes), null);
    }
    const cyclic = Buffer.alloc(43);
    cyclic.write("bplist00"); cyclic[8] = 0xa1; cyclic[9] = 0; cyclic[10] = 8;
    cyclic[17] = 1; cyclic[18] = 1; cyclic.writeUInt32BE(1, 23); cyclic.writeUInt32BE(10, 39);
    assert.equal(safeMetadata.decodeStickerPlist(cyclic), null);
    const deep = Buffer.from("YnBsaXN0MDDSAQIDDVVjaGlsZFNwaWTRAQTRAQXRAQbRAQfRAQjRAQnRAQrRAQvRAQzQXnN5bnRoZXRpYy5wYWNrCA0TFxodICMmKSwvMjMAAAAAAAABAQAAAAAAAAAOAAAAAAAAAAAAAAAAAAAAQg==", "base64");
    assert.equal(safeMetadata.decodeStickerPlist(deep), null);
});

test("raw history uses the bounded binary attribution decoder and keeps placement and sticker tapback types distinct", () => {
    const { MessageTypeTransformer } = load("databases/transformers/MessageTypeTransformer.ts");
    const { MessageDecoder } = load("databases/imessage/entity/decoders/MessageDecoder.ts", {
        "../../helpers/dateUtil": { getDateUsing2001: value => value }, "../../helpers/utils": { convertAttributedBody: value => value },
        "../Attachment": { Attachment: class {} }, "../Chat": { Chat: class {} }, "../Handle": { Handle: class {} }, "../Message": { Message: class {} },
        "@server/databases/transformers/MessageTypeTransformer": { MessageTypeTransformer }
    });
    for (const [code, type] of [[1000, "sticker"], [2007, "sticker-reaction"], [3007, "-sticker-reaction"]]) {
        const decoded = new MessageDecoder().decode({ message_ROWID: 1, message_guid: "fixture", message_associated_message_type: code,
            attachment_ROWID: 2, attachment_guid: "asset", attachment_is_sticker: 1, attachment_sticker_user_info: syntheticSource,
            attachment_attribution_info: syntheticAttribution });
        assert.equal(decoded.associatedMessageType, type);
        assert.equal(decoded.attachments[0].attributionInfo[0].unknown, undefined);
        assert.equal(safeMetadata.normalizeStickerMetadata(decoded.attachments[0]).packName, "Synthetic pack");
    }
});

test("raw SQLite sticker flags normalize before metadata serialization and conversion decisions", async () => {
    const { MessageTypeTransformer } = load("databases/transformers/MessageTypeTransformer.ts");
    const { MessageDecoder } = load("databases/imessage/entity/decoders/MessageDecoder.ts", {
        "../../helpers/dateUtil": { getDateUsing2001: value => value }, "../../helpers/utils": { convertAttributedBody: value => value },
        "../Attachment": { Attachment: class {} }, "../Chat": { Chat: class {} }, "../Handle": { Handle: class {} }, "../Message": { Message: class {} },
        "@server/databases/transformers/MessageTypeTransformer": { MessageTypeTransformer }
    });
    let conversions = 0;
    const convert = async () => { conversions++; return null; };
    const { AttachmentSerializer } = load("api/serializers/AttachmentSerializer.ts", {
        "@server": { Server: () => ({ log() {} }) }, fs: { existsSync: () => true }, "byte-base64": {},
        "@server/databases/imessage/helpers/utils": { convertImage: convert, convertAudio: convert },
        "@server/fileSystem": { FileSystem: { getRealPath: () => "/synthetic/fixture.heic", convertDir: "/synthetic/converted" } },
        "./constants": { DEFAULT_ATTACHMENT_CONFIG: {} }, "../interfaces/attachmentInterface": { AttachmentInterface: { getLivePhotoPath: () => null } }
    });
    for (const value of [0, 1, true, undefined]) {
        conversions = 0;
        const expected = value === 1 || value === true;
        const message = new MessageDecoder().decode({ message_ROWID: 1, message_is_from_me: value, attachment_ROWID: 2,
            attachment_guid: "asset", attachment_is_sticker: value, attachment_is_outgoing: value,
            attachment_sticker_user_info: syntheticSource, attachment_attribution_info: syntheticAttribution });
        assert.equal(message.isFromMe, expected);
        const attachment = message.attachments[0];
        assert.equal(attachment.isSticker, expected); assert.equal(attachment.isOutgoing, expected);
        attachment.getMimeType = () => "image/heic";
        const output = await AttachmentSerializer.serialize({ attachment, config: { convert: true, loadMetadata: false } });
        assert.equal(output.isSticker, expected);
        assert.equal(!!output.metadata?.sticker, expected);
        assert.equal(conversions, expected ? 0 : 2);
    }
});

test("sticker metadata and verified row layout survive reduced notifications and disabled body/metadata options", async () => {
    const { AttachmentSerializer } = load("api/serializers/AttachmentSerializer.ts", {
        "@server": { Server: () => ({ log() {} }) }, "byte-base64": {}, "@server/databases/imessage/helpers/utils": {},
        "@server/fileSystem": { FileSystem: { getRealPath: () => null } }, "./constants": { DEFAULT_ATTACHMENT_CONFIG: {} },
        "../interfaces/attachmentInterface": { AttachmentInterface: { getLivePhotoPath: () => null } }
    });
    const { MessageSerializer } = load("api/serializers/MessageSerializer.ts", {
        "@server": {}, "@server/helpers/utils": { isEmpty: value => value == null || value.length === 0, isNotEmpty: value => value != null && value.length > 0 },
        "@server/env": {}, "./AttachmentSerializer": { AttachmentSerializer }, "./ChatSerializer": {}, "./HandleSerializer": {},
        "./constants": { DEFAULT_MESSAGE_CONFIG: {}, DEFAULT_ATTACHMENT_CONFIG: {} }
    });
    for (const notification of [false, true]) {
        const row = rowFixture();
        row.universalText = () => "\uFFFC\uFFFC";
        for (const attachment of row.attachments) Object.assign(attachment, { stickerUserInfo: syntheticSource, attributionInfo: syntheticAttribution, getMimeType: () => "image/heic" });
        const output = await MessageSerializer.serialize({ message: row, config: { parseAttributedBody: false }, attachmentConfig: { loadMetadata: false }, isForNotification: notification });
        assert.equal(output.attributedBody, null);
        assert.deepEqual(output.stickerLayout, { attachmentGuids: ["attachment-0", "attachment-1"], partIndex: 0 });
        assert.equal(output.attachments[0].isSticker, true);
        assert.equal(output.attachments[0].metadata.sticker.packName, "Synthetic pack");
        assert.deepEqual(output.attachments[0].metadata.sticker.row, { index: 1, partIndex: 0, count: 2 });
        assert.equal(JSON.stringify(output).includes("omit-me"), false);
    }
});

test("sticker serialization and download preserve original bytes despite conversion or resize options", async () => {
    const attachment = { guid: "asset", filePath: "/synthetic/fixture.heic", mimeType: "image/heic", isSticker: true,
        stickerUserInfo: syntheticSource, attributionInfo: syntheticAttribution, getMimeType: () => "image/heic" };
    const neverConvert = () => { throw new Error("Sticker conversion must use an explicit faithful preview path"); };
    const server = { log() {}, iMessageRepo: { async getAttachment() { return attachment; } } };
    const { AttachmentSerializer } = load("api/serializers/AttachmentSerializer.ts", {
        "@server": { Server: () => server }, fs: { existsSync: () => true }, "byte-base64": {},
        "@server/databases/imessage/helpers/utils": { convertImage: neverConvert, convertAudio: neverConvert },
        "@server/fileSystem": { FileSystem: { getRealPath: value => value, convertDir: "/synthetic/converted" } },
        "./constants": { DEFAULT_ATTACHMENT_CONFIG: {} }, "../interfaces/attachmentInterface": { AttachmentInterface: { getLivePhotoPath: () => null } }
    });
    const serialized = await AttachmentSerializer.serialize({ attachment, config: { convert: true } });
    assert.equal(serialized.mimeType, "image/heic"); assert.equal(attachment.filePath, "/synthetic/fixture.heic");
    let streamed;
    const { AttachmentRouter } = load("api/http/api/v1/routers/attachmentRouter.ts", {
        "@server": { Server: () => server }, electron: { nativeImage: { createFromPath: neverConvert } }, fs: { existsSync: () => true },
        "@server/fileSystem": { FileSystem: { getRealPath: value => value } },
        "@server/databases/imessage/helpers/utils": { convertImage: neverConvert, convertAudio: neverConvert },
        "@server/helpers/utils": { isTruthyBool: value => value === "true" }, "@server/api/interfaces/attachmentInterface": {},
        "../responses/success": { FileStream: class { constructor(ctx, filename, mime) { streamed = { filename, mime }; } send() {} } },
        "../responses/errors": {}, "@server/api/serializers/AttachmentSerializer": {}
    });
    await AttachmentRouter.download({ params: { guid: "asset" }, request: { query: { original: "false", width: "100", quality: "good" } } }, async () => {});
    assert.deepEqual(streamed, { filename: "/synthetic/fixture.heic", mime: "image/heic" });
});

test("real HTTP parser cleans native uploads after downstream auth or capability rejection", async () => {
    const { Readable } = require("node:stream");
    const Koa = require("koa");
    const stubs = {
        "socket.io": {}, koa: Koa, "koa-body": require("koa-body"), "koa-json": () => async () => {},
        "koa-router": class { routes() { return async () => {}; } allowedMethods() { return async () => {}; } }, "koa-cors": () => async () => {}, https: {}, http: {},
        "@server": {}, "@server/api/stickers": stickers, "@server/helpers/utils": {},
        "@server/eventCache": {}, "@server/services/certificateService": {},
        "./api/v1/httpRoutes": { HttpRoutes: { createRoutes() {} } }, "./api/v1/socketRoutes": {},
        "./api/v1/middleware/errorMiddleware": { ErrorMiddleware: async () => {} },
        "./api/v1/responses": {}, "@server/events": {}, "../../lib/ScheduledService": {},
        "../../lib/logging/Loggable": { Loggable: class {} }, "@server/databases/server/constants": {},
        "@server/lib/ProcessSpawner": {}
    };
    const { HttpService } = load("api/http/index.ts", stubs);
    const service = Object.create(HttpService.prototype);
    service.koaApp = new Koa();
    service.configureKoa();
    const parser = service.koaApp.middleware[2];
    const nativePaths = ["/api/v1/message/send-sticker", "/api/v1/message/send-sticker/", "/API/V1/MESSAGE/SEND-STICKER",
        "/api/v1/message/send-sticker-placement", "/API/V1/MESSAGE/SEND-STICKER-TAPBACK/", "/api/v1/message/remove-sticker-tapback"];
    for (const pathname of [...nativePaths, "/api/v1/message/attachment"]) {
        const boundary = "synthetic-http-upload";
        const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\n`), png(), Buffer.from(`\r\n--${boundary}--\r\n`)]);
        const request = Readable.from([body]);
        request.headers = { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.length) };
        request.method = "POST";
        request.url = pathname;
        const ctx = service.koaApp.createContext(request, {});
        let uploaded;
        await assert.rejects(parser(ctx, async () => {
            uploaded = ctx.request.files.attachment.path;
            assert.equal(fs.existsSync(uploaded), true);
            throw new Error("synthetic auth or capability rejection");
        }), /synthetic auth/);
        assert.equal(fs.existsSync(uploaded), pathname === "/api/v1/message/attachment");
        stickers.removeStickerUpload(uploaded);
    }
    for (const pathname of [...nativePaths, "/api/v1/message/attachment"]) {
        const body = Buffer.from(JSON.stringify({ ignored: "x".repeat(9000) }));
        const request = Readable.from([body]);
        request.headers = { "content-type": "application/json", "content-length": String(body.length) };
        request.method = "POST";
        request.url = pathname;
        const ctx = service.koaApp.createContext(request, {});
        let reached = false;
        const parse = () => parser(ctx, async () => { reached = true; });
        if (pathname === "/api/v1/message/attachment") {
            await parse();
            assert.equal(ctx.request.body.ignored.length, 9000);
            assert.equal(reached, true);
        } else {
            await assert.rejects(parse(), /request entity too large/);
            assert.equal(reached, false);
        }
    }
});

function validator(server, stickerModule = stickers) {
    class BadRequest extends Error {
        constructor(response) {
            super(response.error);
        }
    }
    return load("api/http/api/v1/validators/messageValidator.ts", {
        "@server": { Server: () => server },
        "@server/api/stickers": stickerModule,
        "@server/helpers/utils": { isEmpty: value => value == null || value.length === 0 },
        "@server/fileSystem": {},
        "@server/api/reactions": {},
        "./index": { ValidateInput: body => body },
        "../responses/errors": { BadRequest }
    }).MessageValidator;
}

test("validator rejects multiple multipart files and unsupported fields", async () => {
    const parsed = await parseMultipart([
        ["attachment", png()],
        ["extra", png()]
    ]);
    assert.ifError(parsed.error);
    const Validator = validator({ httpService: { sendCache: { find: () => null } } });
    const ctx = {
        request: { files: parsed.files, body: { chatGuid: "chat", tempGuid: "fixture", name: "fixture.png" } }
    };
    let reached = false;
    try {
        await assert.rejects(
            Validator.validateSticker(ctx, async () => {
                reached = true;
            })
        );
        assert.equal(reached, false);
    } finally {
        for (const file of parsed.openedFiles) stickers.removeStickerUpload(file.path);
    }
    const unsupported = await parseMultipart([["attachment", png()]]);
    try {
        await assert.rejects(
            Validator.validateSticker(
                { request: { files: unsupported.files, body: { ...ctx.request.body, selectedMessageGuid: "target" } } },
                async () => {}
            )
        );
    } finally {
        for (const file of unsupported.openedFiles) stickers.removeStickerUpload(file.path);
    }
    const repeated = await parseMultipart([
        ["attachment", png()],
        ["attachment", png()]
    ]);
    try {
        assert.equal(repeated.files.attachment.length, 2);
        await assert.rejects(
            Validator.validateSticker({ request: { files: repeated.files, body: ctx.request.body } }, async () => {})
        );
    } finally {
        for (const file of repeated.openedFiles) stickers.removeStickerUpload(file.path);
    }
});
test("standalone fields reject paths, placement, rows, reactions and audio", () => {
    const body = { chatGuid: "iMessage;+;fixture", tempGuid: "fixture", name: "fixture.png", stickerLabel: "Fixture" };
    assert.doesNotThrow(() => stickers.validateStickerFields(body));
    for (const key of [
        "selectedMessageGuid",
        "partIndex",
        "placement",
        "row",
        "reaction",
        "isAudioMessage",
        "filePath",
        "method"
    ]) {
        assert.throws(() => stickers.validateStickerFields({ ...body, [key]: "fixture" }), /standalone/);
    }
    for (const name of ["../fixture.png", "a/b.png", "a\\b.png", "fixture\0.png", ".", "..", ""]) {
        assert.throws(() => stickers.validateStickerFields({ ...body, name }));
    }
    assert.throws(() => stickers.validateStickerFields({ ...body, tempGuid: undefined }));
    assert.throws(() => stickers.validateStickerFields({ ...body, stickerLabel: "x".repeat(257) }));
    assert.doesNotThrow(() => stickers.validateStickerFields({ ...body, name: `${"x".repeat(251)}.png`, stickerLabel: "x".repeat(150) }));
    assert.throws(() => stickers.validateStickerFields({ ...body, name: `${"x".repeat(252)}.png` }));
    assert.throws(() => stickers.validateStickerFields({ ...body, stickerLabel: "x".repeat(151) }));
    assert.throws(() => stickers.validateStickerFields({ ...body, stickerLabel: "" }));
});

test("bounded image inspection rejects oversized, malformed and incompatible images", () => {
    assert.deepEqual(stickers.inspectStickerBytes(png(), "fixture.png"), {
        width: 64,
        height: 64,
        frames: 1,
        format: "png"
    });
    assert.equal(stickers.inspectStickerBytes(png(64, 64, 2), "fixture.apng").frames, 2);
    const gif = Buffer.from("47494638396101000100800000000000ffffff2c00000000010001000002024401003b", "hex");
    assert.equal(stickers.inspectStickerBytes(gif, "fixture.gif").format, "gif");
    const jpeg = Buffer.from("ffd8ffc00011080001000103012200021101031101ffd9", "hex");
    assert.equal(stickers.inspectStickerBytes(jpeg, "fixture.jpg").format, "jpeg");
    for (const [bytes, name] of [
        [png(619, 64), "fixture.png"],
        [png(64, 619), "fixture.png"],
        [png(64, 64, 101), "fixture.apng"],
        [png(618, 618, 66), "fixture.apng"],
        [Buffer.alloc(500 * 1024 + 1), "fixture.png"],
        [png(), "fixture.jpg"],
        [png().subarray(0, 40), "fixture.png"],
        [Buffer.from("not an image"), "fixture.png"]
    ]) {
        assert.throws(() => stickers.inspectStickerBytes(bytes, name));
    }
});

test("only generated multipart staging files can be read", () => {
    const upload = path.join(os.tmpdir(), `upload_${crypto.randomBytes(16).toString("hex")}`);
    const other = path.join(os.tmpdir(), `native-sticker-test-${crypto.randomBytes(16).toString("hex")}.png`);
    const link = path.join(os.tmpdir(), `upload_${crypto.randomBytes(16).toString("hex")}`);
    fs.writeFileSync(upload, png(), { flag: "wx" });
    fs.writeFileSync(other, png(), { flag: "wx" });
    fs.symlinkSync(other, link);
    try {
        assert.deepEqual(stickers.readStickerUpload(upload, "fixture.png"), png());
        assert.throws(() => stickers.readStickerUpload(other, "fixture.png"), /staging directory/);
        assert.throws(() => stickers.readStickerUpload(link, "fixture.png"), /staging file/);
        assert.throws(() => stickers.readStickerUpload("/etc/passwd", "fixture.png"), /staging directory/);
    } finally {
        for (const file of [upload, other, link]) fs.unlinkSync(file);
    }
});

test("confirmation requires exact outgoing sent row, chat and sticker metadata", () => {
    const row = {
        guid: "sent",
        service: "iMessage",
        isFromMe: true,
        isSent: true,
        error: 0,
        dateCreated: new Date(),
        chats: [{ guid: "chat", serviceName: "iMessage" }],
        attachments: [{ guid: "attachment", isSticker: true, isOutgoing: true, stickerUserInfo: Buffer.from([1]) }]
    };
    assert.equal(stickers.matchesSentSticker(row, "sent", "chat", Date.now() - 1000), true);
    const synced = { ...row, attachments: [{ ...row.attachments[0], isOutgoing: false }] };
    assert.equal(stickers.matchesSentSticker(synced, "sent", "chat", Date.now() - 1000), true);
    assert.equal(stickers.matchesSentSticker({ ...synced, isFromMe: false }, "sent", "chat", Date.now() - 1000), false);
    for (const change of [
        { guid: "other" },
        { isFromMe: false },
        { service: "SMS" },
        { isSent: false },
        { error: 1 },
        { dateCreated: new Date(0) },
        { chats: [{ guid: "other", serviceName: "iMessage" }] },
        { associatedMessageGuid: "p:0/target" },
        { attachments: [] },
        { attachments: [{ ...row.attachments[0], isSticker: false }] },
        { attachments: [{ ...row.attachments[0], stickerUserInfo: Buffer.alloc(0) }] }
    ]) {
        assert.equal(stickers.matchesSentSticker({ ...row, ...change }, "sent", "chat", Date.now() - 1000), false);
    }
});

test("native helper payload requires capability and has no ordinary attachment fallback", async () => {
    const writes = [];
    class Action {
        constructor(api) {
            this.api = api;
        }
        throwForNoMissingFields() {}
        async sendApiMessage(action, data) {
            writes.push({ action, data });
            return { identifier: "sent" };
        }
    }
    const { PrivateApiAttachment } = load("api/privateApi/apis/PrivateApiAttachment.ts", {
        "@server": {},
        ".": { PrivateApiAction: Action },
        "@server/managers/transactionManager/transactionPromise": {
            TransactionPromise: class {},
            TransactionType: { ATTACHMENT: 2 }
        }
    });
    const api = new PrivateApiAttachment({ capabilities: { stickerSending: false } });
    const data = {
        chatGuid: "chat",
        filePath: "/staged/fixture.png",
        filename: "fixture.png",
        stickerLabel: "Fixture"
    };
    await assert.rejects(api.sendSticker(data), /not supported/);
    api.api.capabilities.stickerSending = true;
    assert.equal((await api.sendSticker(data)).identifier, "sent");
    assert.deepEqual(writes, [{ action: "send-sticker", data }]);
});

function serviceClass() {
    class Loggable {
        emit() {}
    }
    const stubs = {
        net: {},
        os: {},
        uuid: {},
        "async-sema": {
            Sema: class {
                async acquire() {}
                release() {}
            }
        },
        "@server/helpers/utils": {
            isEmpty: value => value == null,
            isNotEmpty: value => value != null,
            clamp: value => value
        },
        "@server/managers/transactionManager/transactionPromise": {},
        "@server/managers/transactionManager": {},
        "./Constants": {},
        "./eventHandlers": {},
        "./modes": {},
        "./modes/ProcessDylibMode": {},
        "../types": {},
        "../../lib/logging/Loggable": { Loggable },
        setTimeout: callback => callback()
    };
    for (const name of ["Message", "Chat", "Handle", "Attachment", "FindMy", "Cloud", "FaceTime"])
        stubs[`./apis/PrivateApi${name}`] = {};
    for (const name of ["Typing", "Ping", "Address", "FaceTimeStatus", "FindMy"])
        stubs[`./eventHandlers/PrivateApi${name}EventHandler`] = {};
    stubs["./eventHandlers/PrivateApiFaceTimeStatusHandler"] = {};
    return load("api/privateApi/PrivateApiService.ts", stubs).PrivateApiService;
}

test("only connected Messages helper explicit true advertises and receives native stickers", async () => {
    const Service = serviceClass();
    const service = Object.create(Service.prototype);
    const writes = [];
    const messages = {
        id: "messages",
        destroyed: false,
        write(data, callback) {
            writes.push(["messages", data]);
            callback();
        }
    };
    const other = {
        id: "other",
        destroyed: false,
        write(data, callback) {
            writes.push(["other", data]);
            callback();
        }
    };
    service.clients = [messages, other];
    service.activeClients = {};
    service.log = { info() {}, debug() {} };
    assert.equal(service.capabilities.stickerSending, false);
    service.registerClient("com.apple.FaceTime", other, { stickerSending: true });
    assert.equal(service.capabilities.stickerSending, false);
    service.registerClient("com.apple.MobileSMS", messages, { stickerSending: "true" });
    assert.equal(service.capabilities.stickerSending, false);
    service.registerClient("com.apple.MobileSMS", messages, { stickerSending: true });
    assert.equal(service.capabilities.stickerSending, true);
    for (const name of ["stickerPlacement", "stickerRows", "stickerReactions"])
        assert.equal(service.capabilities[name], false);
    await service.writeData("send-sticker", { chatGuid: "chat", filePath: "/fixture" });
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], "messages");
    service.removeClient(messages);
    assert.equal(service.capabilities.stickerSending, false);
    await service.writeData("send-sticker", { chatGuid: "chat", filePath: "/fixture" });
    assert.equal(writes.length, 1);
});

test("rows require explicit connected Messages capability and preserve constructed transfer IDs", async () => {
    const Service = serviceClass();
    const service = Object.create(Service.prototype);
    const writes = [];
    const messages = { id: "messages", destroyed: false, write(data, callback) { writes.push(JSON.parse(data)); callback(); } };
    const other = { id: "other", destroyed: false, write(data, callback) { writes.push({ other: true }); callback(); } };
    service.clients = [messages, other]; service.activeClients = {}; service.log = { info() {}, debug() {} };
    service.registerClient("com.apple.FaceTime", other, { stickerRows: true });
    service.registerClient("com.apple.MobileSMS", messages, { stickerRows: "true", stickerSending: true });
    assert.equal(service.capabilities.stickerRows, false);
    await service.writeData("send-sticker-row", { chatGuid: "chat", stickers: [] });
    assert.equal(writes.length, 0);
    service.registerClient("com.apple.MobileSMS", messages, { stickerRows: true });
    assert.equal(service.capabilities.stickerRows, true);
    assert.equal(service.capabilities.stickerSending, false);
    await service.writeData("send-sticker-row", { chatGuid: "chat", stickers: [{ filePath: "/synthetic" }] });
    assert.equal(writes.length, 1); assert.equal(writes[0].action, "send-sticker-row");
    assert.deepEqual(service.readTransactionData({ transactionId: "transaction", identifier: "row", attachmentGuids: ["first", "second"] }), { attachmentGuids: ["first", "second"] });
    service.removeClient(messages);
    assert.equal(service.capabilities.stickerRows, false);
});

test("placement and sticker tapback protocols require their own connected helper capabilities", async () => {
    const Service = serviceClass();
    const service = Object.create(Service.prototype);
    const writes = [];
    const messages = { id: "messages", destroyed: false, write(data, callback) { writes.push(JSON.parse(data)); callback(); } };
    const other = { id: "other", destroyed: false, write(data, callback) { writes.push({ other: true }); callback(); } };
    service.clients = [messages, other]; service.activeClients = {}; service.log = { info() {}, debug() {} };
    service.registerClient("com.apple.FaceTime", other, { stickerPlacement: true, stickerReactions: true });
    service.registerClient("com.apple.MobileSMS", messages, { stickerSending: true, stickerPlacement: "true", stickerReactions: 1 });
    for (const action of ["send-sticker-placement", "send-sticker-tapback", "remove-sticker-tapback"]) {
        await service.writeData(action, {}); assert.equal(writes.length, 0);
    }
    service.registerClient("com.apple.MobileSMS", messages, { stickerPlacement: true, stickerReactions: true });
    assert.equal(service.capabilities.stickerSending, false);
    for (const action of ["send-sticker-placement", "send-sticker-tapback", "remove-sticker-tapback"]) await service.writeData(action, {});
    assert.deepEqual(writes.map(frame => frame.action), ["send-sticker-placement", "send-sticker-tapback", "remove-sticker-tapback"]);
    service.removeClient(messages);
    assert.equal(service.capabilities.stickerPlacement, false); assert.equal(service.capabilities.stickerReactions, false);
});

test("sticker action fields enforce exact targets, bounded geometry, no transfer-path/removal uploads", () => {
    const base = { chatGuid: "chat", tempGuid: "action", selectedMessageGuid: "target", partIndex: "0", name: "fixture.png" };
    const placement = { x: -4, y: 4, scale: 0.01, rotation: 2 * Math.PI, parentWidth: 4096 };
    assert.deepEqual(stickers.parseStickerActionFields({ ...base, placement: JSON.stringify(placement) }, "placement"), {
        selectedMessageGuid: "target", partIndex: 0, placement
    });
    assert.deepEqual(stickers.parseStickerActionFields(base, "tapback"), { selectedMessageGuid: "target", partIndex: 0 });
    for (const partIndex of [true, false, -1, 0.5, "00", "1.5", " 0", undefined, 2147483648])
        assert.throws(() => stickers.parseStickerActionFields({ ...base, partIndex }, "tapback"));
    for (const extra of ["transferGuid", "filePath", "reactionGuid", "placement", "isAudioMessage", "row"])
        assert.throws(() => stickers.parseStickerActionFields({ ...base, [extra]: "unsupported" }, "tapback"));
    for (const [key, value] of [["x", 4.1], ["y", -4.1], ["scale", 0], ["scale", 4.1], ["rotation", 7], ["parentWidth", 0],
        ["parentWidth", 4097], ["x", true], ["scale", "1"], ["rotation", Infinity], ["extra", 0]])
        assert.throws(() => stickers.parseStickerActionFields({ ...base, placement: { ...placement, [key]: value } }, "placement"));
    const removal = { chatGuid: "chat", tempGuid: "remove", selectedMessageGuid: "target", partIndex: 0, reactionGuid: "reaction" };
    assert.equal(stickers.parseStickerActionFields(removal, "remove").reactionGuid, "reaction");
    for (const extra of ["name", "stickerLabel", "filePath", "transferGuid", "placement"])
        assert.throws(() => stickers.parseStickerActionFields({ ...removal, [extra]: "unsupported" }, "remove"));
    for (const path of ["p:0/target", "target\u0000", "", "x".repeat(257)])
        assert.throws(() => stickers.parseStickerActionFields({ ...base, selectedMessageGuid: path }, "tapback"));
    for (const suffix of ["send-sticker-placement", "send-sticker-tapback", "remove-sticker-tapback"])
        assert.equal(stickers.isStickerRequest("POST", `/API/V1/MESSAGE/${suffix.toUpperCase()}/`), true);
});

test("associated sticker confirmation keeps placements, auto-layout placements and tapback slots distinct", () => {
    const target = { selectedMessageGuid: "target", partIndex: 0 };
    const autoLayout = Buffer.from("YnBsaXN0MDDUAQIDBAUGBwhTcGlkU3NpZFNzaXJTc3B2XnN5bnRoZXRpYy5wYWNrXxAPc3ludGhldGljLmFzc2V0CRAACBEVGR0hMEJDAAAAAAAAAQEAAAAAAAAACQAAAAAAAAAAAAAAAAAAAEU=", "base64");
    const row = { guid: "sent", service: "iMessage", isFromMe: true, isSent: true, error: 0, dateCreated: new Date(),
        chats: [{ guid: "chat", serviceName: "iMessage" }], associatedMessageGuid: "p:0/target", associatedMessageType: "sticker",
        attachments: [{ guid: "asset", isSticker: true, isOutgoing: false, stickerUserInfo: autoLayout }] };
    assert.equal(stickers.matchesSentStickerAction(row, "sent", "chat", 0, "placement", target), true);
    assert.equal(stickers.matchesSentStickerAction(row, "sent", "chat", 0, "tapback", target), false);
    assert.equal(safeMetadata.normalizeStickerMetadata(row.attachments[0]).placement.sir, true);
    assert.equal(safeMetadata.normalizeStickerMetadata(row.attachments[0]).placement.spv, 0);
    const tapback = { ...row, associatedMessageType: "sticker-reaction" };
    assert.equal(stickers.matchesSentStickerAction(tapback, "sent", "chat", 0, "tapback", target), true);
    for (const change of [{ guid: "other" }, { service: "SMS" }, { isFromMe: false }, { isSent: false }, { error: 1 },
        { dateCreated: new Date(0) }, { chats: [{ guid: "other", serviceName: "iMessage" }] },
        { associatedMessageGuid: "p:1/target" }, { associatedMessageGuid: "p:0/other" },
        { associatedMessageType: "sticker" }, { attachments: [] }, { attachments: [{ guid: "asset", isSticker: false }] }])
        assert.equal(stickers.matchesSentStickerAction({ ...tapback, ...change }, "sent", "chat", 1, "tapback", target), false);
    assert.equal(stickers.matchesSentStickerAction({ ...tapback, associatedMessageGuid: "bp:target" }, "sent", "chat", 0, "tapback", target), true);
    assert.equal(stickers.matchesSentStickerAction({ ...tapback, associatedMessageGuid: "bp:target" }, "sent", "chat", 0, "tapback", { ...target, partIndex: 1 }), false);
    const removed = { ...tapback, associatedMessageType: "-sticker-reaction", attachments: [] };
    assert.equal(stickers.matchesSentStickerAction(removed, "sent", "chat", 0, "remove", target, ["asset"]), true);
    assert.equal(stickers.matchesSentStickerAction({ ...removed, attachments: row.attachments }, "sent", "chat", 0, "remove", target, ["asset"]), true);
    assert.equal(stickers.matchesSentStickerAction({ ...removed, attachments: row.attachments }, "sent", "chat", 0, "remove", target, ["other"]), false);
});

test("sticker target validation rejects cross-chat, missing/retracted parts and associated rows", () => {
    const target = { selectedMessageGuid: "target", partIndex: 1 };
    const selected = { guid: "target", service: "iMessage", isFromMe: false, partCount: 2,
        chats: [{ guid: "chat", serviceName: "iMessage" }], attributedBody: [{ runs: [0, 1].map(index => ({
            attributes: { __kIMMessagePartAttributeName: index }
        })) }] };
    assert.doesNotThrow(() => stickers.validateStickerTarget(selected, "chat", target));
    for (const change of [{ guid: "other" }, { service: "SMS" }, { partCount: 1 }, { partCount: 0 },
        { chats: [] }, { associatedMessageGuid: "p:0/other" }, { isFullyUnsent: true }, { retractedParts: [1] },
        { partCount: undefined, attributedBody: [{ runs: [{ attributes: { __kIMMessagePartAttributeName: 0 } }] }] }])
        assert.throws(() => stickers.validateStickerTarget({ ...selected, ...change }, "chat", target));
    assert.doesNotThrow(() => stickers.validateStickerTarget({ ...selected,
        attributedBody: [{ runs: [{ attributes: { __kIMMessagePartAttributeName: 0 } }] }] }, "chat", target));
});

test("sticker action validators require exactly one bounded upload, while removal rejects all uploads", async () => {
    const Validator = validator({ httpService: { sendCache: { find: () => null } } });
    const parsed = await parseMultipart([["attachment", png()]]);
    const base = { chatGuid: "chat", tempGuid: "validated-action", selectedMessageGuid: "target", partIndex: "0", name: "fixture.png" };
    try {
        await Validator.validateStickerTapback({ request: { body: base, files: parsed.files } }, async () => {});
        await Validator.validateStickerPlacement({ request: { body: { ...base, placement: JSON.stringify({ x: 0, y: 0, scale: 1, rotation: 0, parentWidth: 400 }) }, files: parsed.files } }, async () => {});
        await assert.rejects(Validator.validateStickerTapback({ request: { body: base, files: { attachment: [parsed.files.attachment, parsed.files.attachment] } } }, async () => {}));
        const removal = { chatGuid: "chat", tempGuid: "validated-remove", selectedMessageGuid: "target", partIndex: 0, reactionGuid: "reaction" };
        await Validator.validateStickerRemoval({ request: { body: removal } }, async () => {});
        await assert.rejects(Validator.validateStickerRemoval({ request: { body: removal, files: parsed.files } }, async () => {}));
    } finally { for (const file of parsed.openedFiles) stickers.removeStickerUpload(file.path); }
});

test("native placement and tapback helper payloads omit temporary IDs and caller transfer identifiers", async () => {
    const writes = [];
    const capabilities = { stickerPlacement: false, stickerReactions: false };
    class Action {
        constructor(api) { this.api = api; }
        throwForNoMissingFields() {}
        async sendApiMessage(action, data) { writes.push({ action, data }); return { identifier: "sent" }; }
    }
    const { PrivateApiAttachment } = load("api/privateApi/apis/PrivateApiAttachment.ts", {
        "@server": {}, ".": { PrivateApiAction: Action },
        "@server/managers/transactionManager/transactionPromise": { TransactionPromise: class {}, TransactionType: { ATTACHMENT: 2 } }
    });
    const api = new PrivateApiAttachment({ capabilities });
    const target = { chatGuid: "chat", selectedMessageGuid: "target", partIndex: 0 };
    const asset = { ...target, filePath: "/synthetic/staged.png", filename: "fixture.png", stickerLabel: "Fixture" };
    const placement = { x: 0, y: 0, scale: 1, rotation: 0, parentWidth: 400 };
    await assert.rejects(api.sendStickerAction("placement", { ...asset, placement }), /not supported/);
    await assert.rejects(api.sendStickerAction("tapback", asset), /not supported/);
    await assert.rejects(api.removeStickerTapback({ ...target, reactionGuid: "reaction" }), /not supported/);
    capabilities.stickerPlacement = true; capabilities.stickerReactions = true;
    await api.sendStickerAction("placement", { ...asset, placement, tempGuid: "not-on-wire", transferGuid: "not-on-wire" });
    await api.sendStickerAction("tapback", { ...asset, placement, tempGuid: "not-on-wire" });
    await api.removeStickerTapback({ ...target, reactionGuid: "reaction", filePath: "not-on-wire", transferGuid: "not-on-wire" });
    assert.deepEqual(writes, [{ action: "send-sticker-placement", data: { ...asset, placement } },
        { action: "send-sticker-tapback", data: asset }, { action: "remove-sticker-tapback", data: { ...target, reactionGuid: "reaction" } }]);
});

test("native attempts block duplicates without evicting unknown outcomes", () => {
    stickers.reserveStickerAttempt("duplicate");
    assert.throws(() => stickers.reserveStickerAttempt("duplicate"), /already attempted/);
    for (let index = 0; index < 4095; index++) stickers.reserveStickerAttempt(`bounded-${index}`);
    assert.throws(() => stickers.reserveStickerAttempt("overflow"), /limit reached/);
    assert.throws(() => stickers.reserveStickerAttempt("duplicate"), /already attempted/);
});

test("real send flow fails closed before dispatch, blocks concurrent duplicates and retains uncertain outcomes", async () => {
    const state = load("api/stickers.ts");
    const parsed = await parseMultipart([["attachment", png()]]);
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "native-sticker-stage-"));
    const created = [];
    const cached = new Set();
    let sends = 0;
    let release;
    let row = null;
    let chatService = "SMS";
    let helperMode = "pending";
    const pending = new Promise(resolve => {
        release = resolve;
    });
    const server = {
        privateApi: {
            capabilities: { stickerSending: true },
            attachment: {
                async sendSticker() {
                    sends++;
                    if (helperMode === "rejected") throw new Error("synthetic private helper payload");
                    if (helperMode === "image-invalid") throw "Invalid or inaccessible sticker image";
                    if (helperMode === "message-failed") throw "Unable to construct native sticker message";
                    if (helperMode === "timeout") throw "Transaction timeout";
                    if (helperMode === "missing-guid") return {};
                    return pending;
                }
            }
        },
        iMessageRepo: {
            async getChats() {
                return [[{ guid: "chat", serviceName: chatService }], 1];
            },
            async getMessage(guid, withChats, withAttachments) {
                assert.equal(guid, "sent");
                assert.equal(withChats, true);
                assert.equal(withAttachments, true);
                if (helperMode === "db-error") throw new Error("private database details");
                if (helperMode === "missing-row") return null;
                if (helperMode === "wrong-row") return { ...row, isFromMe: false };
                return row;
            }
        },
        httpService: { sendCache: { find: id => cached.has(id), add: id => cached.add(id) } }
    };
    const { MessageInterface } = load("api/interfaces/messageInterface.ts", {
        "@server": { Server: () => server },
        "@server/api/stickers": state,
        "@server/fileSystem": {
            FileSystem: {
                copyAttachment(source, name, method) {
                    assert.equal(method, "private-api");
                    const directory = fs.mkdtempSync(path.join(staging, "asset-"));
                    const destination = path.join(directory, name);
                    created.push({ destination, directory });
                    fs.copyFileSync(source, destination);
                    return destination;
                }
            }
        },
        "@server/helpers/utils": { checkPrivateApiStatus() {}, resultAwaiter: async ({ getData }) => getData() },
        "@server/managers/outgoingMessageManager/messagePromise": {},
        "@server/databases/imessage/entity/Message": {},
        "@server/env": {},
        "@server/api/apple/mappings": {},
        "@server/api/http/constants": {},
        "@server/api/apple/actions": {},
        "@server/api/reactions": {},
        rimraf: {},
        "@server/databases/imessage/entity/Chat": {}
    });
    const data = {
        chatGuid: "chat",
        tempGuid: "uncertain",
        name: "fixture.png",
        attachmentPath: parsed.files.attachment.path
    };
    try {
        await assert.rejects(MessageInterface.sendSticker(data), /iMessage chat/);
        assert.equal(sends, 0);
        assert.equal(state.hasStickerAttempt(data.tempGuid), false);
        chatService = "iMessage";
        server.privateApi.capabilities.stickerSending = false;
        await assert.rejects(MessageInterface.sendSticker(data), /not supported/);
        assert.equal(sends, 0);
        server.privateApi.capabilities.stickerSending = true;
        const first = MessageInterface.sendSticker(data);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(sends, 1);
        await assert.rejects(MessageInterface.sendSticker(data), /already queued/);
        release({ identifier: "sent" });
        await assert.rejects(first, /not confirmed/);
        cached.clear();
        await assert.rejects(MessageInterface.sendSticker(data), /already queued/);
        assert.equal(sends, 1);
        const Validator = validator(server, state);
        await assert.rejects(
            Validator.validateText(
                {
                    request: {
                        body: { chatGuid: "chat", tempGuid: data.tempGuid, method: "private-api", message: "fixture" }
                    }
                },
                async () => {}
            ),
            /already queued/
        );
        await assert.rejects(
            Validator.validateAttachment(
                {
                    request: {
                        files: parsed.files,
                        body: { chatGuid: "chat", tempGuid: data.tempGuid, method: "private-api", name: "fixture.png" }
                    }
                },
                async () => {}
            ),
            /already queued/
        );
        row = {
            guid: "sent",
            service: "iMessage",
            isFromMe: true,
            isSent: true,
            error: 0,
            dateCreated: new Date(),
            chats: [{ guid: "chat", serviceName: "iMessage" }],
            attachments: [{ guid: "attachment", isOutgoing: true, isSticker: true, stickerUserInfo: Buffer.from([1]) }]
        };
        const success = await MessageInterface.sendSticker({ ...data, tempGuid: "confirmed" });
        assert.equal(success, row);
        assert.equal(sends, 2);
        await assert.rejects(MessageInterface.sendSticker({ ...data, tempGuid: "confirmed" }), /already queued/);
        const failures = {
            rejected: "helper_unknown", "image-invalid": "helper_image_invalid", "message-failed": "helper_message_failed",
            timeout: "helper_timeout", "missing-guid": "helper_response_invalid", "db-error": "confirmation_read_failed",
            "missing-row": "confirmation_missing", "wrong-row": "confirmation_mismatch"
        };
        for (helperMode of Object.keys(failures)) {
            const attempt = { ...data, tempGuid: helperMode };
            await assert.rejects(MessageInterface.sendSticker(attempt), error => {
                assert.equal(error instanceof state.StickerUnconfirmedError, true);
                assert.equal(error.message.includes("private helper payload"), false);
                assert.equal(error.code, failures[helperMode]);
                return true;
            });
            assert.equal(state.hasStickerAttempt(attempt.tempGuid), true);
            cached.clear();
            await assert.rejects(MessageInterface.sendSticker(attempt), /already queued/);
        }
        assert.equal(sends, 2 + Object.keys(failures).length);
    } finally {
        state.removeStickerUpload(parsed.files.attachment.path);
        for (const { destination, directory } of created) {
            if (fs.existsSync(destination)) fs.unlinkSync(destination);
            if (fs.existsSync(directory)) fs.rmdirSync(directory);
        }
        fs.rmdirSync(staging);
    }
});

test("row send stages every asset before one dispatch and retains uncertain attempts without partial-message fallback", async () => {
    const state = load("api/stickers.ts");
    const parsed = await parseMultipart([["attachment0", png(64, 64)], ["attachment1", png(32, 32)]], state.stickerRowMultipartLimits);
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "native-sticker-row-stage-"));
    const created = [];
    const cached = new Set();
    let sends = 0;
    let ordinary = 0;
    let responseIds = ["attachment-0", "attachment-1"];
    let resultRow = rowFixture();
    let rejection;
    const server = { privateApi: { capabilities: { stickerRows: false, stickerSending: true }, attachment: {
        async sendSticker() { ordinary++; throw new Error("No individual fallback"); },
        async sendStickerRow({ chatGuid, stickers: prepared }) {
            sends++; assert.equal(chatGuid, "chat"); assert.equal(prepared.length, 2);
            if (rejection) throw rejection;
            assert.equal(prepared[0].filename, "fixture.png"); assert.equal(prepared[1].filename, "fixture.png");
            assert.deepEqual(fs.readFileSync(prepared[0].filePath), png(64, 64));
            assert.deepEqual(fs.readFileSync(prepared[1].filePath), png(32, 32));
            resultRow.attachments.find(attachment => attachment.guid === "attachment-0").filePath = prepared[0].filePath;
            return { identifier: "row", data: { attachmentGuids: responseIds } };
        }
    } }, iMessageRepo: { async getChats() { return [[{ guid: "chat", serviceName: "iMessage" }], 1]; }, async getMessage() { return resultRow; } },
        httpService: { sendCache: { find: guid => cached.has(guid), add: guid => cached.add(guid) } } };
    const { MessageInterface } = load("api/interfaces/messageInterface.ts", {
        "@server": { Server: () => server }, "@server/api/stickers": state,
        "@server/fileSystem": { FileSystem: { copyAttachment(source, name) {
            const directory = fs.mkdtempSync(path.join(staging, "asset-"));
            const filename = path.join(directory, name); fs.copyFileSync(source, filename); created.push({ filename, directory }); return filename;
        }, getRealPath: value => value } }, "@server/helpers/utils": { checkPrivateApiStatus() {}, resultAwaiter: async ({ getData }) => getData() },
        "@server/managers/outgoingMessageManager/messagePromise": {}, "@server/databases/imessage/entity/Message": {},
        "@server/env": {}, "@server/api/apple/mappings": {}, "@server/api/http/constants": {},
        "@server/api/apple/actions": {}, "@server/api/reactions": {}, rimraf: {}, "@server/databases/imessage/entity/Chat": {}
    });
    const request = { chatGuid: "chat", tempGuid: "row", stickers: [0, 1].map(index => ({ name: "fixture.png", attachmentPath: parsed.files[`attachment${index}`].path })) };
    try {
        await assert.rejects(MessageInterface.sendStickerRow(request), /not supported/);
        assert.equal(sends, 0); assert.equal(created.length, 0);
        server.privateApi.capabilities.stickerRows = true;
        const sent = await MessageInterface.sendStickerRow(request);
        assert.equal(sends, 1); assert.equal(ordinary, 0);
        assert.deepEqual(sent.verifiedStickerLayout, { attachmentGuids: responseIds, partIndex: 0 });
        assert.equal(fs.existsSync(created[0].filename), true);
        assert.equal(fs.existsSync(created[1].filename), false);
        await assert.rejects(MessageInterface.sendStickerRow(request), /already queued/);
        responseIds = ["attachment-1", "attachment-0"];
        await assert.rejects(MessageInterface.sendStickerRow({ ...request, tempGuid: "order-mismatch" }), error => {
            assert.equal(error.code, "confirmation_mismatch"); return true;
        });
        cached.clear();
        await assert.rejects(MessageInterface.sendStickerRow({ ...request, tempGuid: "order-mismatch" }), /already queued/);
        responseIds = [];
        await assert.rejects(MessageInterface.sendStickerRow({ ...request, tempGuid: "missing-ids" }), error => {
            assert.equal(error.code, "helper_row_response_invalid"); return true;
        });
        assert.equal(ordinary, 0); assert.equal(sends, 3);
        rejection = "Unable to prepare native sticker transfer";
        await assert.rejects(MessageInterface.sendStickerRow({ ...request, tempGuid: "row-rejected" }), error => {
            assert.equal(error.code, "helper_transfer_failed"); return true;
        });
        cached.clear();
        await assert.rejects(MessageInterface.sendStickerRow({ ...request, tempGuid: "row-rejected" }), /already queued/);
        assert.equal(ordinary, 0); assert.equal(sends, 4);
        const bad = await parseMultipart([["attachment1", png(619, 64)]]);
        try {
            const before = created.length;
            await assert.rejects(MessageInterface.sendStickerRow({ ...request, tempGuid: "bad-image", stickers: [request.stickers[0], { name: "fixture.png", attachmentPath: bad.files.attachment1.path }] }), /limits/);
            assert.equal(created.length, before); assert.equal(sends, 4); assert.equal(state.hasStickerAttempt("bad-image"), false);
        } finally { for (const file of bad.openedFiles) state.removeStickerUpload(file.path); }
    } finally {
        for (const file of parsed.openedFiles) state.removeStickerUpload(file.path);
        for (const { filename, directory } of created) {
            if (fs.existsSync(filename)) fs.unlinkSync(filename);
            if (fs.existsSync(directory)) fs.rmdirSync(directory);
        }
        fs.rmdirSync(staging);
    }
});

test("native associated sends reuse staging, ownership checks and non-retryable attempt IDs", async () => {
    const state = load("api/stickers.ts");
    const parsed = await parseMultipart([["attachment", png()]]);
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "native-sticker-action-stage-"));
    const created = []; const cached = new Set(); const calls = [];
    let mode = "success"; let release; let resultRow;
    const selected = { guid: "target", service: "iMessage", partCount: 1, isFromMe: false,
        chats: [{ guid: "chat", serviceName: "iMessage" }] };
    const makeRow = type => ({ guid: "sent", service: "iMessage", isFromMe: true, isSent: true, error: 0, dateCreated: new Date(),
        chats: selected.chats, associatedMessageGuid: "p:0/target", associatedMessageType: type,
        attachments: [{ guid: "asset", isSticker: true, isOutgoing: false, stickerUserInfo: Buffer.from([1]) }] });
    let reaction = { ...makeRow("sticker-reaction"), guid: "reaction" };
    const server = { privateApi: { capabilities: { stickerPlacement: true, stickerReactions: true, stickerSending: false }, attachment: {
        async sendStickerAction(action, data) {
            calls.push({ action, data }); assert.deepEqual(fs.readFileSync(data.filePath), png());
            assert.equal(data.selectedMessageGuid, "target"); assert.equal(data.partIndex, 0);
            resultRow = makeRow(action === "placement" ? "sticker" : "sticker-reaction");
            if (mode === "wrong-row") resultRow.associatedMessageGuid = "p:1/target";
            if (mode === "error") throw new Error("private synthetic native error");
            if (mode === "known-error") throw "Unable to construct native sticker reaction";
            if (mode === "pending") return new Promise(resolve => { release = resolve; });
            return mode === "missing-guid" ? {} : { identifier: "sent" };
        },
        async removeStickerTapback(data) {
            calls.push({ action: "remove", data });
            assert.deepEqual(data, { chatGuid: "chat", selectedMessageGuid: "target", partIndex: 0, reactionGuid: "reaction" });
            if (mode === "replacement-race") throw new Error("private newer reaction details");
            if (mode === "known-error") throw "Current own sticker reaction is unavailable or changed";
            resultRow = { ...makeRow("-sticker-reaction"), attachments: [] };
            if (mode === "wrong-row") resultRow.isFromMe = false;
            return mode === "missing-guid" ? {} : { identifier: "sent" };
        }
    } }, iMessageRepo: {
        async getChats() { return [[{ guid: "chat", serviceName: "iMessage" }], 1]; },
        async getMessage(guid, chats, attachments) {
            assert.equal(chats, true); assert.equal(attachments, true);
            return guid === "target" ? selected : guid === "reaction" ? reaction : guid === "sent" ? resultRow : null;
        }
    }, httpService: { sendCache: { find: guid => cached.has(guid), add: guid => cached.add(guid) } } };
    const { MessageInterface } = load("api/interfaces/messageInterface.ts", {
        "@server": { Server: () => server }, "@server/api/stickers": state,
        "@server/fileSystem": { FileSystem: { copyAttachment(source, name) {
            const directory = fs.mkdtempSync(path.join(staging, "asset-")); const filename = path.join(directory, name);
            fs.copyFileSync(source, filename); created.push({ filename, directory }); return filename;
        }, getRealPath: value => value } }, "@server/helpers/utils": { checkPrivateApiStatus() {}, resultAwaiter: async ({ getData }) => getData() },
        "@server/managers/outgoingMessageManager/messagePromise": {}, "@server/databases/imessage/entity/Message": {},
        "@server/env": {}, "@server/api/apple/mappings": {}, "@server/api/http/constants": {},
        "@server/api/apple/actions": {}, "@server/api/reactions": {}, rimraf: {}, "@server/databases/imessage/entity/Chat": {}
    });
    const base = { chatGuid: "chat", tempGuid: "placement", selectedMessageGuid: "target", partIndex: 0,
        name: "fixture.png", attachmentPath: parsed.files.attachment.path };
    const placement = { x: 0.5, y: 0.25, scale: 1, rotation: 0, parentWidth: 400 };
    const removal = { chatGuid: "chat", tempGuid: "remove", selectedMessageGuid: "target", partIndex: 0, reactionGuid: "reaction" };
    try {
        server.privateApi.capabilities.stickerPlacement = false;
        await assert.rejects(MessageInterface.sendStickerAction("placement", { ...base, placement }), /not supported/);
        assert.equal(created.length, 0); assert.equal(state.hasStickerAttempt(base.tempGuid), false);
        server.privateApi.capabilities.stickerPlacement = true;
        selected.chats = [{ guid: "other", serviceName: "iMessage" }];
        await assert.rejects(MessageInterface.sendStickerAction("placement", { ...base, placement }), /requested iMessage chat/);
        selected.chats = [{ guid: "chat", serviceName: "iMessage" }];
        await assert.rejects(MessageInterface.sendStickerAction("tapback", { ...base, partIndex: 1 }), /part does not exist/);
        assert.equal(created.length, 0); assert.equal(calls.length, 0);
        assert.equal((await MessageInterface.sendStickerAction("placement", { ...base, placement })).associatedMessageType, "sticker");
        assert.equal(fs.existsSync(created[0].filename), false);
        assert.deepEqual(calls[0].data.placement, placement);
        for (const tempGuid of ["tapback-add", "tapback-replace"]) {
            assert.equal((await MessageInterface.sendStickerAction("tapback", { ...base, tempGuid })).associatedMessageType, "sticker-reaction");
            assert.equal(calls.at(-1).data.placement, undefined);
        }
        mode = "pending";
        const pending = MessageInterface.sendStickerAction("tapback", { ...base, tempGuid: "concurrent" });
        await new Promise(resolve => setImmediate(resolve));
        const before = calls.length;
        await assert.rejects(MessageInterface.sendStickerAction("tapback", { ...base, tempGuid: "concurrent" }), /already queued/);
        assert.equal(calls.length, before); release({ identifier: "sent" }); await pending;
        for (mode of ["wrong-row", "error", "missing-guid", "known-error"]) {
            const tempGuid = `uncertain-${mode}`;
            await assert.rejects(MessageInterface.sendStickerAction("tapback", { ...base, tempGuid }), error => {
                assert.equal(error instanceof state.StickerUnconfirmedError, true); assert.equal(error.message.includes("private"), false);
                assert.equal(error.code, { "wrong-row": "confirmation_mismatch", error: "helper_unknown",
                    "missing-guid": "helper_response_invalid", "known-error": "helper_reaction_failed" }[mode]); return true;
            });
            assert.equal(fs.existsSync(created.at(-1).filename), true);
            cached.clear(); assert.equal(state.hasStickerAttempt(tempGuid), true);
            await assert.rejects(MessageInterface.sendStickerAction("tapback", { ...base, tempGuid }), /already queued/);
        }
        const beforeRemoval = created.length;
        const owned = { ...makeRow("sticker-reaction"), guid: "reaction" };
        for (const change of [{ isFromMe: false }, { associatedMessageType: "sticker" }, { associatedMessageType: "emoji" },
            { associatedMessageGuid: "p:1/target" }, { chats: [] }, { attachments: [] }]) {
            reaction = { ...owned, ...change };
            await assert.rejects(MessageInterface.removeStickerTapback(removal), /owned sticker tapback/);
            assert.equal(state.hasStickerAttempt(removal.tempGuid), false);
        }
        reaction = owned; mode = "success";
        assert.equal((await MessageInterface.removeStickerTapback(removal)).associatedMessageType, "-sticker-reaction");
        assert.equal(created.length, beforeRemoval);
        await assert.rejects(MessageInterface.removeStickerTapback(removal), /already queued/);
        for (mode of ["replacement-race", "wrong-row", "missing-guid", "known-error"]) {
            const tempGuid = `remove-${mode}`;
            await assert.rejects(MessageInterface.removeStickerTapback({ ...removal, tempGuid }), error => {
                assert.equal(error instanceof state.StickerUnconfirmedError, true); assert.equal(error.message.includes("private"), false);
                assert.equal(error.code, { "replacement-race": "helper_unknown", "wrong-row": "confirmation_mismatch",
                    "missing-guid": "helper_response_invalid", "known-error": "helper_reaction_changed" }[mode]); return true;
            });
            cached.clear(); assert.equal(state.hasStickerAttempt(tempGuid), true);
            await assert.rejects(MessageInterface.removeStickerTapback({ ...removal, tempGuid }), /already queued/);
        }
    } finally {
        for (const file of parsed.openedFiles) state.removeStickerUpload(file.path);
        for (const { filename, directory } of created) {
            if (fs.existsSync(filename)) fs.unlinkSync(filename); if (fs.existsSync(directory)) fs.rmdirSync(directory);
        }
        fs.rmdirSync(staging);
    }
});
