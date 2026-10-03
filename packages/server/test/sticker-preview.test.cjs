const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { test } = require("node:test");
const ts = require("typescript");
const root = path.resolve(__dirname, "../src/server");

function loader(overrides = {}, fallback) {
    const cache = new Map();
    const read = filename => {
        filename = path.resolve(root, filename);
        if (cache.has(filename)) return cache.get(filename).exports;
        const module = { exports: {} }; cache.set(filename, module);
        const localRequire = name => {
            if (Object.hasOwn(overrides, name)) return overrides[name];
            if (fallback) { const value = fallback(name); if (value !== undefined) return value; }
            if (["fs", "path", "crypto", "child_process", "bplist-parser"].includes(name)) return require(name);
            if (name.startsWith("@server/api/sticker")) return read(`api/${name.split("/").at(-1)}.ts`);
            if (name.startsWith(".")) return read(`${path.resolve(path.dirname(filename), name)}.ts`);
            throw new Error(`Unmocked dependency: ${name}`);
        };
        const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
        }).outputText;
        new Function("require", "module", "exports", code)(localRequire, module, module.exports);
        return module.exports;
    };
    return read;
}
const load = loader();
const { StickerPreviewService, StickerPreviewError } = load("api/stickerPreview.ts");

// Header-only outputs test the TS preflight. Native tests establish decoded-pixel and animation fidelity.
function chunk(name, data) {
    const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(name, 4); data.copy(bytes, 8); return bytes;
}
function png(frames = 1) {
    const header = Buffer.alloc(13); header.writeUInt32BE(32); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 6;
    const chunks = [chunk("IHDR", header)];
    if (frames > 1) { const animation = Buffer.alloc(8); animation.writeUInt32BE(frames); chunks.push(chunk("acTL", animation)); }
    for (let index = 0; index < frames; index++) {
        if (frames > 1) {
            const control = Buffer.alloc(26); control.writeUInt32BE(index * 2); control.writeUInt32BE(32, 4); control.writeUInt32BE(32, 8);
            control.writeUInt16BE(1, 20); control.writeUInt16BE(10, 22); chunks.push(chunk("fcTL", control));
        }
        chunks.push(chunk(index === 0 ? "IDAT" : "fdAT", Buffer.from([1, 2, 3, 4, 5])));
    }
    return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), ...chunks, chunk("IEND", Buffer.alloc(0))]);
}
function metadata(bytes, frames = 1) {
    return { version: 1, ok: true, format: frames > 1 ? "apng" : "png", frames, width: 32, height: 32, hasAlpha: true, bytes: bytes.length };
}
function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bb-sticker-preview-test-"));
    const source = path.join(directory, "original.heic"); const binary = path.join(directory, "converter"); const cache = path.join(directory, "cache");
    fs.writeFileSync(source, "synthetic HEIC bytes", { mode: 0o600 }); fs.writeFileSync(binary, "synthetic converter", { mode: 0o700 });
    return { directory, source, binary, cache, attachment: { isSticker: true, filePath: source },
        cleanup() { fs.rmSync(directory, { recursive: true }); } };
}
function code(expected) { return error => { assert.equal(error instanceof StickerPreviewError, true); assert.equal(error.code, expected); return true; }; }

test("bounded preview preserves originals, publishes private cache and invalidates by source/converter bytes", async () => {
    const f = fixture(); let calls = 0; let frames = 1;
    const execute = (binary, args, options, callback) => {
        calls++; assert.equal(binary, f.binary); assert.equal(args.length, 2); assert.notEqual(args[0], f.source);
        assert.deepEqual(fs.readFileSync(args[0]), fs.readFileSync(f.source)); assert.equal(fs.existsSync(args[1]), false);
        assert.deepEqual(options, { encoding: "utf8", timeout: 10000, killSignal: "SIGKILL", maxBuffer: 8192 });
        const output = png(frames); fs.writeFileSync(args[1], output, { flag: "wx", mode: 0o600 }); callback(null, JSON.stringify(metadata(output, frames)));
    };
    try {
        const service = new StickerPreviewService(f.cache, f.binary, execute);
        const original = fs.readFileSync(f.source);
        const first = await service.get(f.attachment);
        assert.equal(first.format, "png"); assert.equal(first.hasAlpha, true); assert.equal(calls, 1);
        assert.equal(fs.statSync(f.cache).mode & 0o777, 0o700); assert.equal(fs.statSync(first.filePath).mode & 0o777, 0o600);
        assert.deepEqual(fs.readFileSync(f.source), original);
        assert.deepEqual(await service.get(f.attachment), first); assert.equal(calls, 1);
        const noEffect = Buffer.from("YnBsaXN0MDDRAQJfEBFzdGlja2VyRWZmZWN0VHlwZRP//////////wgLHwAAAAAAAAEBAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAo", "base64");
        assert.deepEqual(await service.get({ ...f.attachment, stickerUserInfo: noEffect }), first); assert.equal(calls, 1);
        fs.writeFileSync(f.source, "changed synthetic HEICS bytes"); frames = 2;
        const animated = await service.get(f.attachment);
        assert.equal(animated.format, "apng"); assert.equal(animated.frames, 2); assert.notEqual(animated.filePath, first.filePath); assert.equal(calls, 2);
        fs.appendFileSync(f.binary, "updated"); const updated = await service.get(f.attachment);
        assert.notEqual(updated.filePath, animated.filePath); assert.equal(calls, 3);
        assert.equal(fs.readdirSync(f.cache).some(name => name.startsWith("job-")), false);
    } finally { f.cleanup(); }
});

test("preview rejects unsupported effects, symlinks, oversized inputs and unavailable converters before dispatch", async () => {
    const f = fixture(); let calls = 0;
    const service = new StickerPreviewService(f.cache, f.binary, () => { calls++; });
    try {
        await assert.rejects(service.get({ ...f.attachment, isSticker: false }), code("not_found"));
        await assert.rejects(service.get({ ...f.attachment, stickerUserInfo: Buffer.from("invalid metadata") }), code("unsupported_effect"));
        const effects = Buffer.from("YnBsaXN0MDDWAQIDBAUGBwgJCgsMU3BpZFRzYmlkVXNoYXNoU3NpZF8QEXN0aWNrZXJFZmZlY3RUeXBlVHRzc2Fec3ludGhldGljLnBhY2tfEBBzeW50aGV0aWMuc291cmNlXnN5bnRoZXRpYy5oYXNoXxAPc3ludGhldGljLmFzc2V0EAMjP+gAAAAAAAAIFRkeJCg8QVBjcoSGAAAAAAAAAQEAAAAAAAAADQAAAAAAAAAAAAAAAAAAAI8=", "base64");
        await assert.rejects(service.get({ ...f.attachment, stickerUserInfo: effects }), code("unsupported_effect"));
        const zero = Buffer.from("YnBsaXN0MDDRAQJfEBFzdGlja2VyRWZmZWN0VHlwZRAACAsfAAAAAAAAAQEAAAAAAAAAAwAAAAAAAAAAAAAAAAAAACE=", "base64");
        await assert.rejects(service.get({ ...f.attachment, stickerUserInfo: zero }), code("unsupported_effect"));
        const link = path.join(f.directory, "link.heic"); fs.symlinkSync(f.source, link);
        await assert.rejects(service.get({ ...f.attachment, filePath: link }), code("input_unavailable"));
        fs.truncateSync(f.source, 5 * 1024 * 1024 + 1);
        await assert.rejects(service.get(f.attachment), code("input_too_large"));
        fs.writeFileSync(f.source, "small source"); fs.unlinkSync(f.binary);
        await assert.rejects(service.get(f.attachment), code("converter_unavailable")); assert.equal(calls, 0);
    } finally { f.cleanup(); }
});

test("preview descriptor reads cannot wait for a substituted pipe", async () => {
    const f = fixture(); let opens = 0;
    const tracedFs = { ...fs, promises: { ...fs.promises, open(filename, flags, ...args) {
        assert.ok(flags & fs.constants.O_NONBLOCK);
        assert.ok(flags & fs.constants.O_NOFOLLOW);
        opens++;
        return fs.promises.open(filename, flags, ...args);
    } } };
    const { StickerPreviewService: TracedService } = loader({ fs: tracedFs })("api/stickerPreview.ts");
    try {
        const service = new TracedService(f.cache, f.binary, (_, args, __, callback) => {
            const output = png();
            fs.writeFileSync(args[1], output, { flag: "wx", mode: 0o600 });
            callback(null, JSON.stringify(metadata(output)));
        });
        await service.get(f.attachment);
        assert.ok(opens >= 3);
    } finally { f.cleanup(); }
});

test("preview cache rejects symlinked or nonprivate roots without modifying their contents", async () => {
    for (const mode of ["symlink", "permissions"]) {
        const f = fixture(); let calls = 0;
        try {
            const outside = path.join(f.directory, "outside"); fs.mkdirSync(outside, { mode: 0o700 }); fs.writeFileSync(path.join(outside, "keep"), "keep");
            if (mode === "symlink") fs.symlinkSync(outside, f.cache);
            else fs.mkdirSync(f.cache, { mode: 0o755 });
            await assert.rejects(new StickerPreviewService(f.cache, f.binary, () => { calls++; }).get(f.attachment), code("cache_unavailable"));
            assert.equal(calls, 0); assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "keep");
        } finally { f.cleanup(); }
    }
});

test("actual preview route authenticates before lookup, rejects paths/options and safely streams only GUID-resolved artwork", async () => {
    const f = fixture(); const image = path.join(f.directory, "preview.png"); fs.writeFileSync(image, png(), { mode: 0o600 });
    let lookups = 0; let converted = 0; let attachment = { guid: "asset", isSticker: true, filePath: f.source }; let failure;
    const server = { repo: { getConfig: () => "synthetic-password" }, log() {}, iMessageRepo: {
        async getAttachment(guid) { lookups++; assert.equal(guid, "asset"); return attachment; }
    } };
    const common = { "@server": { Server: () => server }, "@server/helpers/utils": { safeTrim: value => value.trim() } };
    const Auth = loader(common)("api/http/api/v1/middleware/authMiddleware.ts").AuthMiddleware;
    const Validator = loader({ "./index": { ValidateInput() {} } })("api/http/api/v1/validators/attachmentValidator.ts").AttachmentValidator;
    const Router = loader({ ...common, electron: {}, "@server/fileSystem": {},
        "@server/api/stickerPreview": { StickerPreviewError }, "@server/databases/imessage/helpers/utils": {},
        "@server/api/serializers/AttachmentSerializer": {}, "@server/api/interfaces/attachmentInterface": { AttachmentInterface: {
            async getStickerPreview(value) { converted++; assert.equal(value, attachment); if (failure) throw failure;
                return { ...metadata(png()), filePath: image, etag: "synthetic-digest" }; }
        } }
    })("api/http/api/v1/routers/attachmentRouter.ts").AttachmentRouter;
    const noop = async (ctx, next) => next();
    const proxy = new Proxy(noop, { get: () => proxy });
    const Routes = loader({ ...common, "koa-router": {},
        "./routers/attachmentRouter": { AttachmentRouter: Router }, "./validators/attachmentValidator": { AttachmentValidator: Validator },
        "./middleware/authMiddleware": { AuthMiddleware: Auth }, "@server/lib/logging/Loggable": {},
        "../../types": { HttpMethod: { GET: "GET", POST: "POST", PUT: "PUT", PATCH: "PATCH", DELETE: "DELETE" } }
    }, name => /^\.\/(?:routers|validators|middleware)\//.test(name) ? proxy : undefined)("api/http/api/v1/httpRoutes.ts").HttpRoutes;
    const group = Routes.api.routeGroups.find(item => item.prefix === "attachment");
    const route = group.routes.find(item => item.path === ":guid/sticker-preview");
    assert.equal(route.method, "GET"); assert.ok(group.middleware.includes(Auth));
    const middleware = [...group.middleware, ...route.validators, route.controller];
    const invoke = ctx => { const dispatch = index => middleware[index]?.(ctx, () => dispatch(index + 1)); return dispatch(0); };
    const ctx = (query = { password: "synthetic-password" }) => ({ params: { guid: "asset" }, request: { query, ip: "synthetic" }, response: {
        headers: {}, set(key, value) { this.headers[key] = value; }
    } });
    try {
        await assert.rejects(invoke(ctx({})), error => error.status === 401); assert.equal(lookups, 0);
        await assert.rejects(invoke(ctx({ password: "wrong" })), error => error.status === 401); assert.equal(lookups, 0);
        await assert.rejects(invoke(ctx({ password: "synthetic-password", filePath: f.source })), error => error.status === 400);
        await assert.rejects(invoke(ctx({ password: "synthetic-password", width: "1" })), error => error.status === 400); assert.equal(lookups, 0);
        for (const value of [null, { isSticker: false, filePath: f.source }]) {
            attachment = value; await assert.rejects(invoke(ctx()), error => error.status === 404);
        }
        assert.equal(converted, 0); attachment = { guid: "asset", isSticker: true, filePath: f.source };
        const successful = ctx(); await invoke(successful);
        assert.equal(successful.status, 200); assert.equal(successful.response.headers["Content-Type"], "image/png");
        assert.equal(successful.response.headers["X-BB-Sticker-Preview-Has-Alpha"], "true");
        const data = []; for await (const bytes of successful.body) data.push(bytes); assert.deepEqual(Buffer.concat(data), png());
        for (const [name, status] of [["input_too_large", 400], ["unsupported_animation", 422], ["invalid_output", 422], ["busy", 503], ["timeout", 504]]) {
            failure = new StickerPreviewError(name); await assert.rejects(invoke(ctx()), error => error.status === status && error.response.error.message === name);
        }
        failure = new Error("private native path and stderr");
        await assert.rejects(invoke(ctx()), error => error.status === 422 && !JSON.stringify(error.response).includes("private native"));
        assert.equal(fs.readFileSync(f.source, "utf8"), "synthetic HEIC bytes");
    } finally { f.cleanup(); }
});

test("timeout, malformed output, untimed animation and partial native files never become cache successes", async () => {
    for (const mode of ["timeout", "malformed", "unsupported_animation", "dimensions", "truncated", "oversized", "extra-json"]) {
        const f = fixture();
        const service = new StickerPreviewService(f.cache, f.binary, (binary, args, options, callback) => {
            if (mode === "timeout") { fs.writeFileSync(path.join(path.dirname(args[1]), ".bb-sticker-preview.partial"), "partial"); callback({ killed: true }, "", "private source path"); return; }
            if (mode === "malformed") { callback(null, "private malformed native output", "private source path"); return; }
            if (mode === "unsupported_animation") { callback({ code: 1 }, JSON.stringify({ version: 1, ok: false, error: mode })); return; }
            const output = png(); const result = metadata(output);
            fs.writeFileSync(args[1], mode === "truncated" ? output.subarray(0, 40) : output, { mode: 0o600 });
            if (mode === "dimensions") result.width++;
            if (mode === "oversized") { fs.truncateSync(args[1], 16 * 1024 * 1024 + 1); result.bytes = 16 * 1024 * 1024 + 1; }
            if (mode === "extra-json") result.path = "private source path";
            callback(null, JSON.stringify(result));
        });
        try {
            await assert.rejects(service.get(f.attachment), code(mode === "timeout" ? "timeout" : mode === "unsupported_animation" ? mode : "invalid_output"));
            assert.deepEqual(fs.readdirSync(f.cache), []); assert.equal(fs.readFileSync(f.source, "utf8"), "synthetic HEIC bytes");
        } finally { f.cleanup(); }
    }
});

test("corrupt and partial cache entries rebuild; stale jobs and bounded cache images are pruned safely", async () => {
    const f = fixture(); let calls = 0;
    const service = new StickerPreviewService(f.cache, f.binary, (binary, args, options, callback) => {
        calls++; const output = png(); fs.writeFileSync(args[1], output, { mode: 0o600 }); callback(null, JSON.stringify(metadata(output)));
    });
    try {
        const first = await service.get(f.attachment); const manifest = first.filePath.replace(/\.png$/, ".json");
        fs.unlinkSync(manifest); await service.get(f.attachment); assert.equal(calls, 2);
        fs.writeFileSync(first.filePath, "corrupt"); await service.get(f.attachment); assert.equal(calls, 3);
        const stale = fs.mkdtempSync(path.join(f.cache, "job-")); fs.writeFileSync(path.join(stale, ".bb-sticker-preview.partial"), "stale");
        const old = new Date(Date.now() - 24 * 60 * 60 * 1000 - 1000); fs.utimesSync(stale, old, old);
        const unknown = path.join(f.cache, "unrelated-user-file"); fs.writeFileSync(unknown, "keep");
        for (let index = 0; index < 66; index++) {
            const key = crypto.createHash("sha256").update(`synthetic-${index}`).digest("hex");
            const image = path.join(f.cache, `${key}.png`); fs.writeFileSync(image, "stub", { mode: 0o600 });
            fs.writeFileSync(path.join(f.cache, `${key}.json`), "stub", { mode: 0o600 });
        }
        await service.get(f.attachment);
        assert.equal(fs.existsSync(stale), false); assert.equal(fs.readFileSync(unknown, "utf8"), "keep");
        assert.ok(fs.readdirSync(f.cache).filter(name => /^[a-f0-9]{64}\.png$/.test(name)).length <= 64);
        for (let index = 0; index < 10; index++) {
            const key = crypto.createHash("sha256").update(`large-${index}`).digest("hex");
            const image = path.join(f.cache, `${key}.png`); fs.writeFileSync(image, "stub", { mode: 0o600 }); fs.truncateSync(image, 16 * 1024 * 1024);
            fs.writeFileSync(path.join(f.cache, `${key}.json`), "stub", { mode: 0o600 });
        }
        await service.get(f.attachment);
        assert.ok(fs.readdirSync(f.cache).filter(name => /^[a-f0-9]{64}\.png$/.test(name))
            .reduce((bytes, name) => bytes + fs.statSync(path.join(f.cache, name)).size, 0) <= 128 * 1024 * 1024);
    } finally { f.cleanup(); }
});

test("same-source requests coalesce and distinct requests bound converter concurrency and pending jobs", async () => {
    const f = fixture(); let running = 0; let maximum = 0; let calls = 0;
    const execute = (binary, args, options, callback) => {
        calls++; maximum = Math.max(maximum, ++running);
        setTimeout(() => { const output = png(); fs.writeFileSync(args[1], output, { mode: 0o600 }); running--; callback(null, JSON.stringify(metadata(output))); }, 30);
    };
    try {
        const service = new StickerPreviewService(f.cache, f.binary, execute);
        await Promise.all(Array.from({ length: 20 }, () => service.get(f.attachment))); assert.equal(calls, 1);
        const requests = Array.from({ length: 12 }, (_, index) => {
            const filename = path.join(f.directory, `source-${index}.heic`); fs.writeFileSync(filename, `unique source ${index}`, { mode: 0o600 });
            return service.get({ isSticker: true, filePath: filename }).then(() => "success", error => error.code);
        });
        const results = await Promise.all(requests); assert.ok(results.filter(value => value === "busy").length >= 4);
        assert.ok(results.every(value => ["success", "busy"].includes(value))); assert.equal(maximum, 2); assert.ok(calls <= 9);
        assert.equal(fs.readdirSync(f.cache).some(name => name.startsWith("job-")), false);
    } finally { f.cleanup(); }
});
