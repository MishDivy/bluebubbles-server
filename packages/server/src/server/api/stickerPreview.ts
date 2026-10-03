import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { decodeStickerPlist } from "@server/api/stickerMetadata";

const MAX_INPUT = 5 * 1024 * 1024;
const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_ENTRIES = 64;
const MAX_CACHE = 128 * 1024 * 1024;
const MAX_PENDING = 8;
const MAX_AGE = 24 * 60 * 60 * 1000;
const hash = (bytes: Buffer | string) => crypto.createHash("sha256").update(bytes).digest("hex");

export class StickerPreviewError extends Error {
    constructor(public code: string) {
        super(code);
    }
}

export type StickerPreview = {
    filePath: string;
    etag: string;
    format: "png" | "apng";
    frames: number;
    width: number;
    height: number;
    hasAlpha: boolean;
    bytes: number;
};
type Result = Omit<StickerPreview, "filePath" | "etag">;
type Executor = (
    binary: string,
    args: string[],
    options: {
        timeout: number;
        maxBuffer: number;
        encoding: "utf8";
        killSignal: "SIGKILL";
    },
    callback: (error: any, stdout: string, stderr?: string) => void
) => unknown;

export class StickerPreviewService {
    private requests = new Map<string, Promise<StickerPreview>>();
    private conversions = new Map<string, Promise<StickerPreview>>();
    private activeDirectories = new Set<string>();
    private running = 0;
    private queue: (() => void)[] = [];
    private binaryIdentity?: { key: string; digest: Promise<string> };
    private pruning: Promise<void> = Promise.resolve();

    constructor(private cacheDir: string, private binary: string, private execute: Executor = execFile) {}

    async get(attachment: {
        isSticker?: boolean;
        filePath?: string;
        stickerUserInfo?: unknown;
    }): Promise<StickerPreview> {
        if (
            attachment?.isSticker !== true ||
            typeof attachment.filePath !== "string" ||
            !path.isAbsolute(attachment.filePath)
        )
            throw new StickerPreviewError("not_found");
        const metadata = decodeStickerPlist(attachment.stickerUserInfo);
        // BBHStickerStamp uses -1 for the pinned imsg 640f58f4 user-generated no-effect fixture. Other enums remain unverified.
        if (
            (attachment.stickerUserInfo != null && !metadata) ||
            (metadata &&
                Object.prototype.hasOwnProperty.call(metadata, "stickerEffectType") &&
                metadata.stickerEffectType !== -1)
        )
            throw new StickerPreviewError("unsupported_effect");
        let stat: fs.Stats;
        let converter: string;
        try {
            stat = await fs.promises.lstat(attachment.filePath);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
        } catch {
            throw new StickerPreviewError("input_unavailable");
        }
        if (!stat.size || stat.size > MAX_INPUT) throw new StickerPreviewError("input_too_large");
        try {
            const binaryStat = await fs.promises.lstat(this.binary);
            if (
                !binaryStat.isFile() ||
                binaryStat.isSymbolicLink() ||
                binaryStat.mode & 0o022 ||
                !(binaryStat.mode & 0o111)
            )
                throw new Error();
            const key = JSON.stringify([
                binaryStat.dev,
                binaryStat.ino,
                binaryStat.size,
                binaryStat.mtimeMs,
                binaryStat.ctimeMs
            ]);
            if (this.binaryIdentity?.key !== key)
                this.binaryIdentity = { key, digest: this.readBounded(this.binary, 8 * 1024 * 1024).then(hash) };
            converter = await this.binaryIdentity.digest;
        } catch {
            throw new StickerPreviewError("converter_unavailable");
        }
        const identity = hash(
            JSON.stringify([attachment.filePath, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, converter])
        );
        const previous = this.requests.get(identity);
        if (previous) return previous;
        if (this.requests.size >= MAX_PENDING) throw new StickerPreviewError("busy");
        const request = this.run(attachment.filePath, converter).finally(() => this.requests.delete(identity));
        this.requests.set(identity, request);
        return request;
    }

    private async readBounded(filename: string, limit: number): Promise<Buffer> {
        const handle = await fs.promises.open(filename,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
            const before = await handle.stat();
            if (!before.isFile() || !before.size || before.size > limit) throw new Error();
            const bytes = Buffer.alloc(before.size);
            let offset = 0;
            while (offset < bytes.length) {
                const read = await handle.read(bytes, offset, bytes.length - offset, offset);
                if (!read.bytesRead) throw new Error();
                offset += read.bytesRead;
            }
            const after = await handle.stat();
            if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
                throw new Error();
            return bytes;
        } finally {
            await handle.close();
        }
    }

    private async acquire() {
        if (this.running < 2) {
            this.running++;
            return;
        }
        await new Promise<void>(resolve => this.queue.push(resolve));
    }

    private release() {
        const next = this.queue.shift();
        if (next) next();
        else this.running--;
    }

    private async run(source: string, converter: string): Promise<StickerPreview> {
        await this.acquire();
        try {
            let bytes: Buffer;
            try {
                bytes = await this.readBounded(source, MAX_INPUT);
            } catch {
                throw new StickerPreviewError("input_unavailable");
            }
            await this.ensureCache();
            const key = hash(`sticker-preview-v1:${converter}:${hash(bytes)}`);
            const previous = this.conversions.get(key);
            if (previous) return await previous;
            const conversion = this.convert(bytes, key).finally(() => this.conversions.delete(key));
            this.conversions.set(key, conversion);
            return await conversion;
        } catch (error) {
            if (error instanceof StickerPreviewError) throw error;
            throw new StickerPreviewError("cache_unavailable");
        } finally {
            this.release();
        }
    }

    private async ensureCache() {
        await fs.promises.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
        const stat = await fs.promises.lstat(this.cacheDir);
        if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            stat.mode & 0o077 ||
            (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
            (await fs.promises.realpath(this.cacheDir)) !== path.resolve(this.cacheDir)
        )
            throw new StickerPreviewError("cache_unavailable");
    }

    private validateResult(value: any): Result {
        if (
            !value ||
            value.version !== 1 ||
            value.ok !== true ||
            Object.keys(value).some(
                key => !["version", "ok", "format", "frames", "width", "height", "hasAlpha", "bytes"].includes(key)
            ) ||
            !["png", "apng"].includes(value.format) ||
            !Number.isInteger(value.frames) ||
            value.frames < 1 ||
            value.frames > 100 ||
            (value.format === "png" ? value.frames !== 1 : value.frames < 2) ||
            !Number.isInteger(value.width) ||
            value.width < 1 ||
            value.width > 618 ||
            !Number.isInteger(value.height) ||
            value.height < 1 ||
            value.height > 618 ||
            value.width * value.height * value.frames > 25000000 ||
            typeof value.hasAlpha !== "boolean" ||
            !Number.isInteger(value.bytes) ||
            value.bytes < 33 ||
            value.bytes > MAX_OUTPUT
        )
            throw new StickerPreviewError("invalid_output");
        const { format, frames, width, height, hasAlpha, bytes } = value;
        return { format, frames, width, height, hasAlpha, bytes };
    }

    private validatePng(bytes: Buffer, result: Result) {
        if (
            bytes.length !== result.bytes ||
            !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
            bytes.readUInt32BE(8) !== 13 ||
            bytes.toString("ascii", 12, 16) !== "IHDR" ||
            bytes.readUInt32BE(16) !== result.width ||
            bytes.readUInt32BE(20) !== result.height
        )
            throw new StickerPreviewError("invalid_output");
        let controls = 0;
        let frames = 1;
        let animated = false;
        let ended = false;
        let imageData = false;
        for (let offset = 8; offset + 12 <= bytes.length; ) {
            const length = bytes.readUInt32BE(offset);
            if (length > bytes.length - offset - 12) throw new StickerPreviewError("invalid_output");
            const type = bytes.toString("ascii", offset + 4, offset + 8);
            if (type === "acTL") {
                if (animated || length !== 8) throw new StickerPreviewError("invalid_output");
                animated = true;
                frames = bytes.readUInt32BE(offset + 8);
            }
            if (type === "fcTL") {
                if (length !== 26) throw new StickerPreviewError("invalid_output");
                const width = bytes.readUInt32BE(offset + 12);
                const height = bytes.readUInt32BE(offset + 16);
                const x = bytes.readUInt32BE(offset + 20);
                const y = bytes.readUInt32BE(offset + 24);
                if (!width || !height || width + x > result.width || height + y > result.height)
                    throw new StickerPreviewError("invalid_output");
                controls++;
            }
            if (type === "IDAT" && length) imageData = true;
            offset += length + 12;
            if (type === "IEND") {
                ended = !length && offset === bytes.length;
                break;
            }
        }
        if (
            !ended ||
            !imageData ||
            frames !== result.frames ||
            (animated ? controls !== frames : controls !== 0) ||
            animated !== (result.format === "apng")
        )
            throw new StickerPreviewError("invalid_output");
    }

    private async cached(key: string): Promise<StickerPreview | null> {
        try {
            const manifest = JSON.parse(
                (await this.readBounded(path.join(this.cacheDir, `${key}.json`), 2048)).toString("utf8")
            );
            if (
                !manifest ||
                manifest.key !== key ||
                typeof manifest.hash !== "string" ||
                !/^[a-f0-9]{64}$/.test(manifest.hash)
            )
                return null;
            const result = this.validateResult(manifest.result);
            const filePath = path.join(this.cacheDir, `${key}.png`);
            const stat = await fs.promises.lstat(filePath);
            if (stat.mode & 0o077 || Date.now() - stat.mtimeMs > MAX_AGE) return null;
            const bytes = await this.readBounded(filePath, MAX_OUTPUT);
            this.validatePng(bytes, result);
            if (hash(bytes) !== manifest.hash) return null;
            return { ...result, filePath, etag: manifest.hash };
        } catch {
            return null;
        }
    }

    private invoke(input: string, output: string): Promise<Result> {
        return new Promise((resolve, reject) => {
            try {
                this.execute(
                    this.binary,
                    [input, output],
                    { encoding: "utf8", timeout: 10000, killSignal: "SIGKILL", maxBuffer: 8192 },
                    (error, stdout) => {
                        if (error?.killed || error?.signal === "SIGKILL")
                            return reject(new StickerPreviewError("timeout"));
                        let result: any;
                        try {
                            result = JSON.parse(stdout);
                        } catch {
                            return reject(new StickerPreviewError("invalid_output"));
                        }
                        const allowed = [
                            "unsupported_type",
                            "unsupported_animation",
                            "unsupported_auxiliary",
                            "invalid_image",
                            "image_limits",
                            "output_limits",
                            "conversion_failed",
                            "output_unavailable",
                            "input_unavailable",
                            "input_too_large",
                            "invalid_arguments"
                        ];
                        if (error || result?.ok !== true)
                            return reject(
                                new StickerPreviewError(
                                    result?.version === 1 && result.ok === false && allowed.includes(result.error)
                                        ? result.error
                                        : "conversion_failed"
                                )
                            );
                        try {
                            resolve(this.validateResult(result));
                        } catch (failure) {
                            reject(failure);
                        }
                    }
                );
            } catch {
                reject(new StickerPreviewError("converter_unavailable"));
            }
        });
    }

    private async convert(bytes: Buffer, key: string): Promise<StickerPreview> {
        await this.prune();
        const cached = await this.cached(key);
        if (cached) return cached;
        const directory = await fs.promises.mkdtemp(path.join(this.cacheDir, "job-"));
        this.activeDirectories.add(directory);
        const input = path.join(directory, "source.bin");
        const output = path.join(directory, "preview.png");
        try {
            await fs.promises.writeFile(input, bytes, { flag: "wx", mode: 0o600 });
            const result = await this.invoke(input, output);
            const preview = await this.readBounded(output, MAX_OUTPUT);
            this.validatePng(preview, result);
            const etag = hash(preview);
            await fs.promises.chmod(output, 0o600);
            const manifest = path.join(directory, "preview.json");
            await fs.promises.writeFile(
                manifest,
                JSON.stringify({ key, hash: etag, result: { version: 1, ok: true, ...result } }),
                { flag: "wx", mode: 0o600 }
            );
            const filePath = path.join(this.cacheDir, `${key}.png`);
            await fs.promises.rename(output, filePath);
            await fs.promises.rename(manifest, path.join(this.cacheDir, `${key}.json`));
            await this.prune(key);
            return { ...result, etag, filePath };
        } catch (error) {
            if (error instanceof StickerPreviewError) throw error;
            throw new StickerPreviewError("invalid_output");
        } finally {
            await this.removeJob(directory);
            this.activeDirectories.delete(directory);
        }
    }

    private async removeJob(directory: string) {
        for (const filename of ["source.bin", "preview.png", "preview.json", ".bb-sticker-preview.partial"]) {
            try {
                await fs.promises.unlink(path.join(directory, filename));
            } catch {
                /* A successful publish already moved output. */
            }
        }
        try {
            await fs.promises.rmdir(directory);
        } catch {
            /* Preserve unknown files. */
        }
    }

    private prune(protectedKey?: string): Promise<void> {
        const pruning = this.pruning.then(() => this.pruneCache(protectedKey));
        this.pruning = pruning.catch(() => {});
        return pruning;
    }

    private async pruneCache(protectedKey?: string) {
        const files = await fs.promises.readdir(this.cacheDir);
        const entries: { key: string; bytes: number; modified: number; complete: boolean }[] = [];
        for (const name of files) {
            if (/^job-[a-zA-Z0-9]{6}$/.test(name)) {
                const directory = path.join(this.cacheDir, name);
                let stat: fs.Stats;
                try {
                    stat = await fs.promises.lstat(directory);
                } catch (error: any) {
                    if (error.code === "ENOENT") continue;
                    throw error;
                }
                if (
                    stat.isDirectory() &&
                    !stat.isSymbolicLink() &&
                    !(stat.mode & 0o077) &&
                    Date.now() - stat.mtimeMs > 600000 &&
                    !this.activeDirectories.has(directory)
                )
                    await this.removeJob(directory);
            } else if (/^[a-f0-9]{64}\.png$/.test(name)) {
                const key = name.slice(0, -4);
                const stat = await fs.promises.lstat(path.join(this.cacheDir, name));
                const complete = files.includes(`${key}.json`);
                const manifestBytes = complete
                    ? (await fs.promises.lstat(path.join(this.cacheDir, `${key}.json`))).size
                    : 0;
                entries.push({ key, bytes: stat.size + manifestBytes, modified: stat.mtimeMs, complete });
            } else if (/^[a-f0-9]{64}\.json$/.test(name) && !files.includes(`${name.slice(0, -5)}.png`)) {
                await fs.promises.unlink(path.join(this.cacheDir, name));
            }
        }
        entries.sort((left, right) => left.modified - right.modified);
        let size = entries.reduce((total, entry) => total + entry.bytes, 0);
        let count = entries.length;
        for (const entry of entries) {
            if (entry.bytes <= MAX_OUTPUT + 2048 && (entry.key === protectedKey || this.conversions.has(entry.key)))
                continue;
            if (entry.complete && count <= MAX_ENTRIES && size <= MAX_CACHE && Date.now() - entry.modified <= MAX_AGE)
                continue;
            for (const extension of ["png", "json"]) {
                try {
                    await fs.promises.unlink(path.join(this.cacheDir, `${entry.key}.${extension}`));
                } catch {
                    /* Concurrent pruning may already remove it. */
                }
            }
            count--;
            size -= entry.bytes;
        }
    }
}
