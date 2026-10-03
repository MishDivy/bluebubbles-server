import fs from "fs";
import os from "os";
import path from "path";

export const MAX_STICKER_BYTES = 500 * 1024;
export const stickerMultipartLimits = { maxFileSize: MAX_STICKER_BYTES, maxFieldsSize: 8192, multiples: true };

export function isStickerUploadRequest(method: string, pathname: string): boolean {
    return method === "POST" && /^\/api\/v1\/message\/send-sticker\/?$/i.test(pathname);
}
const MAX_DIMENSION = 618;
const MAX_FRAMES = 100;
const MAX_DECODED_PIXELS = 25000000;
const allowedFields = new Set(["chatGuid", "tempGuid", "name", "stickerLabel"]);
const attempts = new Set<string>();

export class StickerUnconfirmedError extends Error {}

export function hasStickerAttempt(tempGuid: string): boolean {
    return attempts.has(tempGuid);
}

export function validateStickerFields(body: Record<string, unknown>) {
    if (!body || Object.keys(body).some(key => !allowedFields.has(key))) {
        throw new Error("Only standalone sticker fields are supported.");
    }
    for (const field of ["chatGuid", "tempGuid", "name"]) {
        if (
            typeof body[field] !== "string" ||
            !(body[field] as string).trim() ||
            (body[field] as string).length > 256
        ) {
            throw new Error("A chat GUID, temporary GUID and filename are required.");
        }
    }
    const name = body.name as string;
    if (
        name.length > 255 ||
        name === "." ||
        name === ".." ||
        /[\\/\x00-\x1f\x7f]/.test(name) ||
        path.basename(name) !== name
    ) {
        throw new Error("Sticker filename must be a safe basename.");
    }
    if (
        body.stickerLabel != null &&
        (typeof body.stickerLabel !== "string" ||
            body.stickerLabel.length === 0 ||
            body.stickerLabel.length > 150 ||
            /[\x00-\x1f\x7f]/.test(body.stickerLabel))
    ) {
        throw new Error("Sticker label must contain at most 150 printable UTF-16 units.");
    }
}

export function reserveStickerAttempt(tempGuid: string) {
    if (attempts.has(tempGuid))
        throw new Error("This sticker was already attempted. Check the chat before sending again.");
    if (attempts.size >= 4096)
        throw new Error("Sticker attempt limit reached. Review previous attempts before restarting the server.");
    attempts.add(tempGuid);
}

// These bounds do not decode pixels. The native helper must fully decode before dispatch.
export function inspectStickerBytes(bytes: Buffer, filename: string) {
    if (!bytes.length || bytes.length > MAX_STICKER_BYTES) throw new Error("Sticker must be at most 500 KiB.");
    let width = 0;
    let height = 0;
    let frames = 1;
    let format: string;
    if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
        format = "png";
        if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR")
            throw new Error("Invalid PNG header.");
        width = bytes.readUInt32BE(16);
        height = bytes.readUInt32BE(20);
        let controls = 0;
        let animated = false;
        let ended = false;
        for (let offset = 8; offset + 12 <= bytes.length; ) {
            const length = bytes.readUInt32BE(offset);
            const type = bytes.toString("ascii", offset + 4, offset + 8);
            if (length > bytes.length - offset - 12) throw new Error("Invalid PNG chunk.");
            if (type === "acTL") {
                if (animated || length !== 8) throw new Error("Invalid APNG animation header.");
                animated = true;
                frames = bytes.readUInt32BE(offset + 8);
            }
            if (type === "fcTL") controls++;
            offset += length + 12;
            if (type === "IEND") {
                ended = length === 0 && offset === bytes.length;
                break;
            }
        }
        if (!ended || (animated && controls !== frames) || (!animated && controls))
            throw new Error("Invalid PNG animation structure.");
    } else if (bytes.length >= 14 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) {
        format = "gif";
        width = bytes.readUInt16LE(6);
        height = bytes.readUInt16LE(8);
        frames = 0;
        let offset = 13 + (bytes[10] & 128 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0);
        let ended = false;
        const skipBlocks = () => {
            while (offset < bytes.length) {
                const length = bytes[offset++];
                if (!length) return;
                offset += length;
                if (offset > bytes.length) throw new Error("Invalid GIF block.");
            }
            throw new Error("Invalid GIF block.");
        };
        while (offset < bytes.length) {
            const type = bytes[offset++];
            if (type === 0x3b) {
                ended = offset === bytes.length;
                break;
            }
            if (type === 0x21) {
                offset++;
                skipBlocks();
            } else if (type === 0x2c) {
                if (offset + 9 > bytes.length) throw new Error("Invalid GIF frame.");
                const frameWidth = bytes.readUInt16LE(offset + 4);
                const frameHeight = bytes.readUInt16LE(offset + 6);
                if (!frameWidth || !frameHeight || frameWidth > width || frameHeight > height)
                    throw new Error("Invalid GIF dimensions.");
                const packed = bytes[offset + 8];
                offset += 9 + (packed & 128 ? 3 * (1 << ((packed & 7) + 1)) : 0);
                offset++;
                skipBlocks();
                frames++;
            } else throw new Error("Invalid GIF structure.");
        }
        if (!ended) throw new Error("Invalid GIF trailer.");
    } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        format = "jpeg";
        for (let offset = 2; offset + 4 <= bytes.length; ) {
            if (bytes[offset++] !== 0xff) throw new Error("Invalid JPEG structure.");
            while (bytes[offset] === 0xff) offset++;
            if (offset + 3 > bytes.length) throw new Error("Invalid JPEG marker.");
            const marker = bytes[offset++];
            if (marker === 0xda || marker === 0xd9) break;
            const length = bytes.readUInt16BE(offset);
            if (length < 2 || offset + length > bytes.length) throw new Error("Invalid JPEG segment.");
            if ([0xc0, 0xc1, 0xc2].includes(marker)) {
                if (length < 8) throw new Error("Invalid JPEG dimensions.");
                height = bytes.readUInt16BE(offset + 3);
                width = bytes.readUInt16BE(offset + 5);
                break;
            }
            offset += length;
        }
    } else throw new Error("Sticker must be PNG, APNG, GIF or JPEG.");
    const extensions = format === "jpeg" ? [".jpg", ".jpeg"] : format === "png" ? [".png", ".apng"] : [".gif"];
    if (!extensions.includes(path.extname(filename).toLowerCase()))
        throw new Error("Sticker filename does not match its image format.");
    if (
        !width ||
        !height ||
        width > MAX_DIMENSION ||
        height > MAX_DIMENSION ||
        !frames ||
        frames > MAX_FRAMES ||
        width * height * frames > MAX_DECODED_PIXELS
    ) {
        throw new Error("Sticker exceeds image dimensions, frame count or decoded pixel limits.");
    }
    return { width, height, frames, format };
}

export function readStickerUpload(filePath: string, filename: string): Buffer {
    const root = fs.realpathSync(os.tmpdir());
    if (
        typeof filePath !== "string" ||
        path.dirname(filePath) !== os.tmpdir() ||
        !/^upload_[a-f0-9]{32}$/.test(path.basename(filePath))
    ) {
        throw new Error("Sticker must come from the multipart upload staging directory.");
    }
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || path.dirname(fs.realpathSync(filePath)) !== root)
        throw new Error("Invalid sticker staging file.");
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const actual = fs.fstatSync(fd);
        if (!actual.isFile() || actual.size < 1 || actual.size > MAX_STICKER_BYTES)
            throw new Error("Sticker must be at most 500 KiB.");
        const bytes = Buffer.alloc(actual.size);
        if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error("Incomplete sticker upload.");
        inspectStickerBytes(bytes, filename);
        return bytes;
    } finally {
        fs.closeSync(fd);
    }
}

export function removeStickerUpload(filePath: string) {
    if (
        typeof filePath !== "string" ||
        path.dirname(filePath) !== os.tmpdir() ||
        !/^upload_[a-f0-9]{32}$/.test(path.basename(filePath))
    )
        return;
    try {
        const stat = fs.lstatSync(filePath);
        if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(filePath);
    } catch {
        // The multipart parser may already have removed the upload.
    }
}

export function matchesSentSticker(message: any, guid: string, chatGuid: string, sentAt: number): boolean {
    const attachment = message?.attachments?.[0];
    return !!(
        message?.guid === guid &&
        message?.isFromMe === true &&
        message?.service === "iMessage" &&
        message?.isSent === true &&
        message?.error === 0 &&
        message?.dateCreated instanceof Date &&
        message.dateCreated.getTime() >= sentAt &&
        message?.chats?.some((chat: any) => chat.guid === chatGuid && chat.serviceName === "iMessage") &&
        !message.associatedMessageGuid &&
        message.attachments?.length === 1 &&
        attachment.isSticker === true &&
        !!attachment.guid &&
        !!attachment.stickerUserInfo &&
        (attachment.stickerUserInfo.length > 0 ||
            attachment.stickerUserInfo.byteLength > 0 ||
            attachment.stickerUserInfo.size > 0)
    );
}
