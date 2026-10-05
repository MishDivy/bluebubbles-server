const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const sourceRoot = path.resolve(__dirname, "../src/server");
const quietLogger = { info() {}, debug() {}, warn() {}, error() {} };
class Loggable {
    log = quietLogger;
    emit() {}
}
const utils = {
    isEmpty: value => value == null || value.length === 0,
    isNotEmpty: value => value != null && value.length !== 0,
    clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
    onlyAlphaNumeric: value => (value ?? "").replace(/[^a-z0-9]/gi, ""),
    getFilenameWithoutExtension: value => value,
    sanitizeStr: value => value
};

// Execute the real TypeScript modules, replacing only their external/native boundaries.
// This does not open Messages, start Electron, load dylibs or create network sockets.
function load(relative, overrides = {}) {
    const cache = new Map();
    function read(filename) {
        if (cache.has(filename)) return cache.get(filename).exports;
        const module = { exports: {} };
        cache.set(filename, module);
        const localRequire = name => {
            if (Object.hasOwn(overrides, name)) return overrides[name];
            if (name === "@server/helpers/utils") return utils;
            if (name === "@server/lib/logging/Loggable" || name.endsWith("lib/logging/Loggable")) return { Loggable };
            if (name === "@server/api/reactions") return read(path.join(sourceRoot, "api/reactions.ts"));
            if (name === "@server/api/stickers") return { getStickerLayout: () => null, hasStickerAttempt: () => false };
            if (name === "@server/api/stickerMetadata") return { normalizeStickerMetadata: () => null, decodeStickerAttribution: () => null };
            if (name === "@server/databases/transformers/StickerAttributionTransformer") return {};
            if (name === "@server/databases/transformers/MessageTypeTransformer") {
                return read(path.join(sourceRoot, "databases/transformers/MessageTypeTransformer.ts"));
            }
            throw new Error(`Unmocked dependency: ${name} (${filename})`);
        };
        const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.CommonJS,
                experimentalDecorators: true
            }
        }).outputText;
        new Function("require", "module", "exports", "setTimeout", code)(
            localRequire,
            module,
            module.exports,
            overrides.setTimeout ?? setTimeout
        );
        return module.exports;
    }
    return read(path.join(sourceRoot, relative));
}

const reactions = load("api/reactions.ts");
test("classic descriptors and one emoji normalize without accepting arbitrary text", () => {
    for (const classic of reactions.classicReactions) {
        assert.deepEqual(reactions.parseReaction(classic), { reactionType: classic });
    }
    for (const emoji of ["🫡", "👍🏽", "👨‍👩‍👧‍👦", "🏳️‍🌈", "🇮🇳", "1️⃣", "❤️", "👩🏾‍💻"]) {
        assert.deepEqual(reactions.parseReaction(emoji), { reactionType: "emoji", reactionEmoji: emoji });
        assert.deepEqual(reactions.parseReaction(`-${emoji}`), { reactionType: "-emoji", reactionEmoji: emoji });
    }
    for (const invalid of [
        null,
        2006,
        "",
        "emoji",
        "2006",
        "1",
        "-",
        "--🫡",
        "ok",
        "🫡🫡",
        " 🫡",
        "🫡\n",
        "🇮",
        "🏽",
        "🫡".repeat(200)
    ]) {
        assert.equal(reactions.parseReaction(invalid), null, String(invalid));
    }
});

test("custom send requires explicit capability; old helpers still accept classics", () => {
    assert.doesNotThrow(() => reactions.requireReactionCapability(reactions.parseReaction("love"), false));
    assert.throws(() => reactions.requireReactionCapability(reactions.parseReaction("🫡"), false), /not supported/);
    assert.doesNotThrow(() => reactions.requireReactionCapability(reactions.parseReaction("-🫡"), true));
});

test("database types preserve legacy, unknown and missing values", () => {
    const { MessageTypeTransformer: transformer } = load("databases/transformers/MessageTypeTransformer.ts");
    for (let index = 0; index < 6; index++) {
        const classic = reactions.classicReactions[index];
        assert.equal(transformer.from(2000 + index), classic);
        assert.equal(transformer.from(3000 + index), `-${classic}`);
    }
    assert.equal(transformer.from(1000), "sticker");
    assert.equal(transformer.from(2006), "emoji");
    assert.equal(transformer.from(3006), "-emoji");
    assert.equal(transformer.from(2007), "sticker-reaction");
    assert.equal(transformer.from(3007), "-sticker-reaction");
    assert.equal(transformer.from(2008), "2008");
    assert.equal(transformer.from(4000), "4000");
    assert.equal(transformer.from(null), null);
    assert.equal(transformer.from(undefined), null);
    assert.equal(transformer.to("emoji"), 2006);
    assert.equal(transformer.to("-emoji"), 3006);
});

test("received emoji/removal metadata survives full and reduced notification serialization", async () => {
    const { MessageSerializer } = load("api/serializers/MessageSerializer.ts", {
        "@server": {},
        "@server/env": { isMinHighSierra: false, isMinMonterey: false, isMinVentura: false },
        "./AttachmentSerializer": { AttachmentSerializer: { serializeList: async () => [] } },
        "./ChatSerializer": { ChatSerializer: { serializeList: async () => [] } },
        "./HandleSerializer": {},
        "./constants": { DEFAULT_MESSAGE_CONFIG: {}, DEFAULT_ATTACHMENT_CONFIG: {} }
    });
    for (const type of ["love", "sticker", "sticker-reaction", "-sticker-reaction", "emoji", "-emoji", "4000"]) {
        for (const notification of [false, true]) {
            const serialized = await MessageSerializer.serialize({
                message: {
                    guid: "reaction",
                    universalText: () => "",
                    associatedMessageGuid: "p:0/target",
                    associatedMessageType: type,
                    associatedMessageEmoji: type.includes("emoji") ? "🫡" : undefined
                },
                isForNotification: notification
            });
            assert.equal(serialized.associatedMessageType, type);
            assert.equal(serialized.associatedMessageGuid, "p:0/target");
            assert.equal(serialized.associatedMessageEmoji, type.includes("emoji") ? "🫡" : null);
        }
    }
});

function loadService() {
    const stubs = {
        os: {},
        net: {},
        "async-sema": { Sema: class { async acquire() {} release() {} } },
        "./Constants": {},
        "@server/managers/transactionManager/transactionPromise": {},
        "@server/managers/transactionManager": {},
        "./eventHandlers": {},
        "./modes": {},
        "./modes/ProcessDylibMode": {},
        "../types": {},
        uuid: {}
    };
    for (const name of [
        "PrivateApiTypingEventHandler",
        "PrivateApiPingEventHandler",
        "PrivateApiAddressEventHandler",
        "PrivateApiFaceTimeStatusHandler",
        "PrivateApiFindMyEventHandler"
    ]) {
        stubs[`./eventHandlers/${name}`] = {};
    }
    for (const name of ["Message", "Chat", "Handle", "Attachment", "FindMy", "Cloud", "FaceTime"]) {
        stubs[`./apis/PrivateApi${name}`] = {};
    }
    return load("api/privateApi/PrivateApiService.ts", stubs).PrivateApiService;
}

test("real helper ping, registration and disconnection gate the Messages capability", async () => {
    const PrivateApiService = loadService();
    const service = Object.create(PrivateApiService.prototype);
    service.log = quietLogger;
    service.clients = [];
    service.activeClients = {};
    const { PrivateApiPingEventHandler } = load("api/privateApi/eventHandlers/PrivateApiPingEventHandler.ts", {
        "@server": { Server: () => ({ privateApi: service }) },
        ".": {},
        "@server/api/types": {}
    });
    const handler = new PrivateApiPingEventHandler();
    const messages = {
        id: "messages",
        destroyed: false,
        destroy() {
            this.destroyed = true;
        }
    };
    const facetime = {
        id: "facetime",
        destroyed: false,
        destroy() {
            this.destroyed = true;
        }
    };
    service.addClient(messages);
    assert.equal(service.capabilities.customEmojiReactions, false);
    await handler.handle({ process: "com.apple.MobileSMS", capabilities: { customEmojiReactions: "true" } }, messages);
    assert.equal(service.capabilities.customEmojiReactions, false);
    await handler.handle({ process: "com.apple.MobileSMS", capabilities: { customEmojiReactions: true } }, messages);
    assert.deepEqual(service.capabilities, { customEmojiReactions: true, stickerSending: false, stickerPlacement: false, stickerRows: false, stickerComposition: false, stickerReactions: false });
    service.addClient(facetime);
    await handler.handle({ process: "com.apple.FaceTime", capabilities: { customEmojiReactions: true } }, facetime);
    service.removeClient(messages);
    assert.equal(service.capabilities.customEmojiReactions, false);
    service.addClient(messages);
    await handler.handle({ process: "com.apple.MobileSMS" }, messages);
    assert.equal(service.capabilities.customEmojiReactions, false);
    service.destroySocketClients();
    assert.equal(service.capabilities.customEmojiReactions, false);
});

test("private API uses emoji wire payload and rejects before dispatch to old helpers", async () => {
    let sends = 0;
    class Action {
        constructor(api) {
            this.api = api;
        }
        throwForNoMissingFields() {}
        async sendApiMessage(action, data) {
            sends++;
            return { action, data };
        }
    }
    const { PrivateApiMessage } = load("api/privateApi/apis/PrivateApiMessage.ts", {
        ".": { PrivateApiAction: Action },
        "@server/env": {},
        "@server/managers/transactionManager/transactionPromise": {
            TransactionPromise: class {},
            TransactionType: { MESSAGE: "message" }
        }
    });
    const api = new PrivateApiMessage({ capabilities: { customEmojiReactions: true } });
    assert.deepEqual((await api.react("chat", "target", "-👩🏾‍💻", 2)).data, {
        chatGuid: "chat",
        selectedMessageGuid: "target",
        reactionType: "-emoji",
        reactionEmoji: "👩🏾‍💻",
        partIndex: 2
    });
    assert.deepEqual((await api.react("chat", "target", "love")).data, {
        chatGuid: "chat",
        selectedMessageGuid: "target",
        reactionType: "love",
        partIndex: 0
    });
    api.api.capabilities.customEmojiReactions = false;
    await assert.rejects(api.react("chat", "target", "🫡"), /not supported/);
    await assert.rejects(api.react("chat", "target", "2006"), /single emoji/);
    assert.equal(sends, 2);
});

test("custom confirmation distinguishes emoji replacement, removal, parts and sender", () => {
    const add = reactions.parseReaction("🫡");
    const message = {
        isFromMe: true,
        associatedMessageGuid: "p:2/target",
        associatedMessageType: "emoji",
        associatedMessageEmoji: "🫡"
    };
    assert.equal(reactions.matchesEmojiReaction(message, "target", 2, add), true);
    for (const change of [
        { associatedMessageEmoji: "❤️" },
        { associatedMessageType: "-emoji" },
        { isFromMe: false },
        { associatedMessageGuid: "p:0/target" }
    ]) {
        assert.equal(reactions.matchesEmojiReaction({ ...message, ...change }, "target", 2, add), false);
    }
    assert.equal(
        reactions.matchesEmojiReaction(
            { ...message, associatedMessageType: "-emoji" },
            "target",
            2,
            reactions.parseReaction("-🫡")
        ),
        true
    );
    assert.equal(
        reactions.matchesEmojiReaction({ ...message, associatedMessageGuid: "bp:target" }, "target", 0, add),
        true
    );
    assert.equal(
        reactions.matchesEmojiReaction({ ...message, associatedMessageGuid: "bp:target" }, "target", 2, add),
        false
    );
});

test("emoji column is excluded from old macOS schemas and nullable on Sequoia", () => {
    for (const isMinSequoia of [false, true]) {
        const columns = [];
        const decorator = () => () => {};
        const overrides = {
            typeorm: {
                Entity: decorator,
                PrimaryGeneratedColumn: decorator,
                ManyToOne: decorator,
                JoinTable: decorator,
                JoinColumn: decorator,
                ManyToMany: decorator,
                Column: options => () => {
                    columns.push(options);
                }
            },
            "conditional-decorator": { conditional: (enabled, column) => (enabled ? column : () => {}) },
            "@server/env": { isMinSequoia },
            "node-typedstream": {},
            "@server/utils/AttributedBodyUtils": {}
        };
        for (const name of ["BooleanTransformer", "MessagesDateTransformer", "AttributedBodyTransformer"]) {
            overrides[`@server/databases/transformers/${name}`] = {};
        }
        for (const name of ["Handle", "Chat", "Attachment"]) {
            overrides[`@server/databases/imessage/entity/${name}`] = { [name]: class {} };
        }
        load("databases/imessage/entity/Message.ts", overrides);
        const emojiColumn = columns.find(column => column?.name === "associated_message_emoji");
        assert.equal(!!emojiColumn, isMinSequoia);
        if (emojiColumn) assert.equal(emojiColumn.nullable, true);
    }
});

test("raw history decoder carries emoji metadata and tolerates older missing fields", () => {
    const { MessageDecoder } = load("databases/imessage/entity/decoders/MessageDecoder.ts", {
        "../../helpers/dateUtil": { getDateUsing2001: () => new Date(0) },
        "../../helpers/utils": { convertAttributedBody: () => [] },
        "../Attachment": { Attachment: class {} },
        "../Chat": { Chat: class {} },
        "../Handle": { Handle: class {} },
        "../Message": { Message: class {} }
    });
    const decoder = new MessageDecoder();
    for (const [id, type, emoji] of [
        [1, 2006, "🫡"],
        [2, 3006, "🫡"],
        [3, 2000, undefined],
        [4, 9000, undefined]
    ]) {
        const decoded = decoder.decode({
            message_ROWID: id,
            message_associated_message_type: type,
            message_associated_message_emoji: emoji
        });
        assert.equal(decoded.associatedMessageEmoji, emoji ?? null);
        assert.equal(
            decoded.associatedMessageType,
            { 2006: "emoji", 3006: "-emoji", 2000: "love" }[type] ?? String(type)
        );
    }
});

test("REST validates emoji and rejects fractional message parts before dispatch", async () => {
    class BadRequest extends Error {
        constructor(data) {
            super(data.error);
        }
    }
    const { MessageValidator } = load("api/http/api/v1/validators/messageValidator.ts", {
        path: {},
        fs: {},
        "@server": {},
        "@server/fileSystem": {},
        "./index": { ValidateInput() {} },
        "../responses/errors": { BadRequest }
    });
    let calls = 0;
    const validate = body => MessageValidator.validateReaction({ request: { body } }, async () => calls++);
    await validate({ reaction: "🫡", partIndex: 0 });
    await validate({ reaction: "-love" });
    for (const body of [
        { reaction: "blah" },
        { reaction: "🫡", partIndex: 0.5 },
        { reaction: "🫡", partIndex: -1 },
        { reaction: "🫡", partIndex: "1" }
    ]) {
        await assert.rejects(validate(body), BadRequest);
    }
    assert.equal(calls, 2);
});

test("outgoing promise matches custom metadata instead of localized reaction text", () => {
    const { MessagePromise } = load("managers/outgoingMessageManager/messagePromise.ts", {
        "@server": {},
        "@server/databases/imessage/entity/Chat": {},
        "@server/databases/imessage/entity/Message": {},
        "@server/utils/AttributedBodyUtils": {},
        setTimeout() {}
    });
    const promise = new MessagePromise({
        chatGuid: "chat",
        text: "",
        isAttachment: false,
        sentAt: 100,
        emojiReaction: { targetGuid: "target", partIndex: 0, reaction: reactions.parseReaction("🫡") }
    });
    const message = {
        isFromMe: true,
        chats: [{ guid: "chat" }],
        dateCreated: new Date(200),
        associatedMessageGuid: "p:0/target",
        associatedMessageType: "emoji",
        associatedMessageEmoji: "🫡",
        universalText: () => "Localized reaction description"
    };
    assert.equal(promise.isSame(message), true);
    for (const changes of [
        { chats: [] },
        { chats: [{ guid: "other" }] },
        { dateCreated: new Date(50) },
        { associatedMessageEmoji: "❤️" },
        { associatedMessageType: "-emoji" }
    ]) {
        assert.equal(promise.isSame({ ...message, ...changes }), false);
    }
});

test("sticker marker survives both full and reduced attachment serialization", async () => {
    const { AttachmentSerializer } = load("api/serializers/AttachmentSerializer.ts", {
        "@server": { Server: () => ({ log() {} }) }, fs: {}, "byte-base64": {},
        "@server/databases/imessage/helpers/utils": {},
        "@server/fileSystem": { FileSystem: { getRealPath: () => null } },
        "./constants": { DEFAULT_ATTACHMENT_CONFIG: {} },
        "../interfaces/attachmentInterface": { AttachmentInterface: { getLivePhotoPath: () => null } }
    });
    for (const isForNotification of [false, true]) {
        const result = await AttachmentSerializer.serialize({
            attachment: { isSticker: true, getMimeType: () => "image/heic" }, isForNotification
        });
        assert.equal(result.isSticker, true);
    }
});

test("custom dispatch targets the capable Messages helper rather than broadcasting", async () => {
    const Service = loadService();
    const service = Object.create(Service.prototype);
    const writes = [];
    const messages = { id: "messages", write(data, cb) { writes.push(["messages", data]); cb(); } };
    const other = { id: "other", write(data, cb) { writes.push(["other", data]); cb(); } };
    service.clients = [messages, other];
    service.activeClients = {};
    service.log = quietLogger;
    service.registerClient("com.apple.MobileSMS", messages, { customEmojiReactions: true });
    await service.writeData("send-reaction", { reactionType: "emoji", reactionEmoji: "🫡" });
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], "messages");
    service.removeClient(messages);
    await service.writeData("send-reaction", { reactionType: "emoji", reactionEmoji: "🫡" });
    assert.equal(writes.length, 1);
});

test("malformed helper frames do not log private payload contents", async () => {
    const Service = loadService();
    const service = Object.create(Service.prototype);
    const logs = [];
    service.log = { info: message => logs.push(message) };
    await service.onEvent('{"message":"private content"', {});
    assert.equal(logs.length, 1);
    assert.equal(logs[0].includes("private content"), false);
});

test("send confirmation fails closed for cross-chat requests, stale rows and helper rejection", async () => {
    const selected = { guid: "target", chats: [{ guid: "chat" }], universalText: () => "hello" };
    const confirmed = {
        guid: "new", chats: [{ guid: "chat" }], dateCreated: new Date(), isFromMe: true,
        associatedMessageGuid: "p:0/target", associatedMessageType: "emoji", associatedMessageEmoji: "🫡"
    };
    let resultRow = confirmed;
    let failHelper = false;
    let sends = 0;
    let rejected = 0;
    const server = {
        privateApi: { capabilities: { customEmojiReactions: true }, message: {
            async react() { sends++; if (failHelper) throw new Error("helper failed"); return { identifier: "new" }; }
        } },
        iMessageRepo: { getMessage: async guid => guid === "target" ? selected : resultRow },
        messageManager: { add() {} }, log() {}
    };
    class PromiseStub {
        promise = Promise.resolve(null);
        async reject() { rejected++; }
    }
    const { MessageInterface } = load("api/interfaces/messageInterface.ts", {
        "@server": { Server: () => server }, fs: {}, path: {},
        "@server/fileSystem": {}, "@server/databases/imessage/entity/Message": {},
        "@server/managers/outgoingMessageManager/messagePromise": { MessagePromise: PromiseStub },
        "@server/helpers/utils": { ...utils, checkPrivateApiStatus() {}, resultAwaiter: async ({ getData }) => getData() },
        "@server/env": {}, "@server/api/apple/mappings": { negativeReactionTextMap: {}, reactionTextMap: {} },
        "@server/api/http/constants": { invisibleMediaChar: "\uFFFC" },
        "@server/api/apple/actions": {}, rimraf: {}, "@server/databases/imessage/entity/Chat": {}
    });
    const send = chatGuid => MessageInterface.sendReaction({ chatGuid, message: selected, reaction: "🫡", partIndex: 0 });
    assert.equal(await send("chat"), confirmed);
    await assert.rejects(send("other"), /does not belong/);
    assert.equal(sends, 1);
    for (const change of [{ associatedMessageEmoji: "❤️" }, { chats: [{ guid: "other" }] }, { dateCreated: new Date(0) }]) {
        resultRow = { ...confirmed, ...change };
        await assert.rejects(send("chat"), /not found/);
    }
    failHelper = true;
    await assert.rejects(send("chat"), /helper failed/);
    assert.equal(rejected, 1);
});
