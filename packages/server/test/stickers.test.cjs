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
            if (["fs", "os", "path"].includes(name)) return require(name);
            if (name === "@server/api/stickers") return read(path.join(sourceRoot, "api/stickers.ts"));
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
    for (const pathname of ["/api/v1/message/send-sticker", "/api/v1/message/send-sticker/", "/API/V1/MESSAGE/SEND-STICKER", "/api/v1/message/attachment"]) {
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
    for (const pathname of ["/api/v1/message/send-sticker", "/API/V1/MESSAGE/SEND-STICKER", "/api/v1/message/attachment"]) {
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
    service.registerClient("com.apple.MobileSMS", messages, { stickerSending: true, stickerPlacement: true });
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
                    const destination = path.join(staging, name);
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
        for (helperMode of ["rejected", "missing-guid"]) {
            const attempt = { ...data, tempGuid: helperMode };
            await assert.rejects(MessageInterface.sendSticker(attempt), error => {
                assert.equal(error instanceof state.StickerUnconfirmedError, true);
                assert.equal(error.message.includes("private helper payload"), false);
                return true;
            });
            assert.equal(state.hasStickerAttempt(attempt.tempGuid), true);
            cached.clear();
            await assert.rejects(MessageInterface.sendSticker(attempt), /already queued/);
        }
        assert.equal(sends, 4);
    } finally {
        state.removeStickerUpload(parsed.files.attachment.path);
        fs.unlinkSync(path.join(staging, "fixture.png"));
        fs.rmdirSync(staging);
    }
});
