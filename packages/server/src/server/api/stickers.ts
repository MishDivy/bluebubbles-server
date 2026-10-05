import fs from "fs";
import os from "os";
import path from "path";

export const MAX_STICKER_BYTES = 500 * 1024;
export const MAX_STICKER_ROW_BYTES = 5 * 1024 * 1024;
export const MAX_STICKER_FIELDS_BYTES = 8192;
export const MAX_STICKER_COMPOSITION_UNITS = 4096;
export const stickerMultipartLimits = { maxFileSize: MAX_STICKER_BYTES, maxFieldsSize: MAX_STICKER_FIELDS_BYTES, multiples: true };
export const stickerRowMultipartLimits = { ...stickerMultipartLimits, maxFileSize: MAX_STICKER_ROW_BYTES };

export type StickerDescriptor = { name: string; stickerLabel?: string };
export type StickerLayout = { attachmentGuids: string[]; partIndex: 0 };
export type StickerComposition = { attachmentGuids: string[]; parts: { range: [number, 1]; partIndex: number }[] };
export type StickerPlacement = { x: number; y: number; scale: number; rotation: number; parentWidth: number };
export type StickerAction = "placement" | "tapback" | "remove";
export type StickerTarget = { selectedMessageGuid: string; partIndex: number };

export function isStickerRequest(method: string, pathname: string): boolean {
    return isStickerUploadRequest(method, pathname) ||
        (method === "POST" && /^\/api\/v1\/message\/remove-sticker-tapback\/?$/i.test(pathname));
}

export function isStickerUploadRequest(method: string, pathname: string): boolean {
    return method === "POST" && /^\/api\/v1\/message\/send-sticker(?:-row|-placement|-tapback)?\/?$/i.test(pathname);
}

export function isStickerRowUploadRequest(method: string, pathname: string): boolean {
    return method === "POST" && /^\/api\/v1\/message\/send-sticker-row\/?$/i.test(pathname);
}
const MAX_DIMENSION = 618;
const MAX_FRAMES = 100;
const MAX_DECODED_PIXELS = 25000000;
const allowedFields = new Set(["chatGuid", "tempGuid", "name", "stickerLabel"]);
const attempts = new Set<string>();

// Exact fixed responses from the pinned helper. Never stringify an unknown rejection.
const stickerHelperErrors = {
    "Invalid standalone sticker request": "helper_request_invalid",
    "Invalid sticker row request": "helper_request_invalid",
    "Invalid sticker placement request": "helper_request_invalid",
    "Invalid sticker reaction request": "helper_request_invalid",
    "Experimental sticker sending is disabled": "helper_disabled",
    "Experimental sticker placement is disabled": "helper_disabled",
    "Experimental sticker reactions are disabled": "helper_disabled",
    "Native sticker sending is unavailable": "helper_unavailable",
    "Native sticker placement is unavailable": "helper_unavailable",
    "Native sticker reactions are unavailable": "helper_unavailable",
    "Native sticker chat is unavailable": "helper_chat_unavailable",
    "Stickers require a native iMessage chat": "helper_chat_not_imessage",
    "Invalid or inaccessible sticker image": "helper_image_invalid",
    "Unable to snapshot sticker image": "helper_snapshot_failed",
    "Unable to prepare native sticker transfer": "helper_transfer_failed",
    "Unable to construct native sticker message": "helper_message_failed",
    "Native inline sticker preparation is unavailable": "helper_inline_unavailable",
    "Native sticker composition is unavailable": "helper_composition_unavailable",
    "Animated stickers cannot be sent inline": "helper_inline_animation_unsupported",
    "Inline stickers require static PNG images": "helper_inline_format_unsupported",
    "Inline sticker images exceed the decoded pixel limit": "helper_inline_limits",
    "Unable to prepare native inline sticker image": "helper_inline_preparation_failed",
    "Invalid sticker body mapping": "helper_request_invalid",
    "Unable to construct native sticker placement": "helper_placement_failed",
    "Unable to construct native sticker reaction": "helper_reaction_failed",
    "Native sticker preparation failed": "helper_preparation_failed",
    "Native sticker placement preparation failed": "helper_preparation_failed",
    "Native sticker reaction preparation failed": "helper_preparation_failed",
    "Sticker dispatch outcome is unknown; do not retry": "helper_dispatch_unknown",
    "Sticker registration outcome is unknown; do not retry": "helper_registration_unknown",
    "Sticker send outcome is unknown; do not retry": "helper_send_unknown",
    "Sticker message identifier is unavailable after dispatch; do not retry": "helper_identifier_unavailable",
    "Sticker message identifier lookup failed after dispatch; do not retry": "helper_identifier_lookup_failed",
    "Sticker placement dispatch outcome is unknown; do not retry": "helper_dispatch_unknown",
    "Sticker reaction dispatch outcome is unknown; do not retry": "helper_dispatch_unknown",
    "Native sticker target lookup timed out": "helper_target_timeout",
    "Native sticker target is unavailable": "helper_target_unavailable",
    "Native sticker placement target is unavailable": "helper_target_unavailable",
    "Native sticker reaction target is unavailable": "helper_target_unavailable",
    "Native sticker target part is unavailable": "helper_target_part_unavailable",
    "Native sticker target lookup failed": "helper_target_failed",
    "Native sticker placement target changed": "helper_target_changed",
    "Native sticker reaction target changed": "helper_target_changed",
    "Current own sticker reaction is unavailable or changed": "helper_reaction_changed",
    "Transaction timeout": "helper_timeout"
} as const;

type StickerFailureCode = typeof stickerHelperErrors[keyof typeof stickerHelperErrors] |
    "helper_unknown" | "helper_response_invalid" | "helper_row_response_invalid" |
    "confirmation_read_failed" | "confirmation_missing" | "confirmation_mismatch" | "outcome_unknown";

export function stickerHelperFailureCode(error: unknown): StickerFailureCode {
    return typeof error === "string" && Object.prototype.hasOwnProperty.call(stickerHelperErrors, error)
        ? stickerHelperErrors[error as keyof typeof stickerHelperErrors] : "helper_unknown";
}

export class StickerUnconfirmedError extends Error {
    constructor(message: string, readonly code: StickerFailureCode = "outcome_unknown") {
        super(message);
    }
}

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

export function parseStickerRowFields(body: Record<string, unknown>): StickerDescriptor[] {
    if (!body || Object.keys(body).some(key => !["chatGuid", "tempGuid", "stickers", "text"].includes(key)) ||
        typeof body.stickers !== "string" || Object.values(body).some(value => typeof value !== "string") ||
        Object.values(body).reduce<number>((total, value) => total + Buffer.byteLength(value as string, "utf8"), 0) > MAX_STICKER_FIELDS_BYTES) {
        throw new Error("Sticker rows require an ordered stickers JSON field.");
    }
    const descriptors = JSON.parse(body.stickers);
    const composition = Object.prototype.hasOwnProperty.call(body, "text");
    if (!Array.isArray(descriptors) || descriptors.length < (composition ? 1 : 2) || descriptors.length > 10) {
        throw new Error("A sticker row requires 2 to 10 stickers, or 1 to 10 with composition text.");
    }
    if (composition) validateStickerCompositionText(body.text, descriptors.length);
    for (const descriptor of descriptors) {
        if (!descriptor || Array.isArray(descriptor) || typeof descriptor !== "object" ||
            Object.keys(descriptor).some(key => !["name", "stickerLabel"].includes(key))) {
            throw new Error("Unsupported sticker row descriptor.");
        }
        validateStickerFields({ chatGuid: body.chatGuid, tempGuid: body.tempGuid, ...descriptor });
    }
    return descriptors;
}

export function validateStickerCompositionText(text: unknown, count: number): asserts text is string {
    if (typeof text !== "string" || text.length > MAX_STICKER_COMPOSITION_UNITS ||
        !Number.isInteger(count) || count < 1 || count > 10 || text.split("\uFFFC").length - 1 !== count)
        throw new Error("Sticker composition requires bounded text with one reserved placeholder per sticker.");
    for (let index = 0; index < text.length; index++) {
        const unit = text.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = text.charCodeAt(++index);
            if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("Sticker composition text must be well-formed UTF-16.");
        } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error("Sticker composition text must be well-formed UTF-16.");
    }
}

export function parseStickerActionFields(body: Record<string, unknown>, action: StickerAction): StickerTarget & {
    placement?: StickerPlacement;
    reactionGuid?: string;
} {
    const fields = ["chatGuid", "tempGuid", "selectedMessageGuid", "partIndex", ...(action === "remove"
        ? ["reactionGuid"] : ["name", "stickerLabel", ...(action === "placement" ? ["placement"] : [])])];
    if (!body || Object.keys(body).some(key => !fields.includes(key))) throw new Error("Unsupported sticker action fields.");
    validateStickerFields({ chatGuid: body.chatGuid, tempGuid: body.tempGuid,
        name: action === "remove" ? "sticker.png" : body.name,
        ...(action !== "remove" && body.stickerLabel != null ? { stickerLabel: body.stickerLabel } : {}) });
    const requireGuid = (value: unknown) => {
        if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\/\x00-\x1f\x7f]/.test(value))
            throw new Error("An exact message GUID is required.");
        return value;
    };
    const selectedMessageGuid = requireGuid(body.selectedMessageGuid);
    const partIndex = typeof body.partIndex === "string" && /^(?:0|[1-9]\d{0,9})$/.test(body.partIndex)
        ? Number(body.partIndex) : body.partIndex;
    if (typeof partIndex !== "number" || !Number.isInteger(partIndex) || partIndex < 0 || partIndex > 2147483647)
        throw new Error("A nonnegative message part index is required.");
    if (action === "remove") return { selectedMessageGuid, partIndex, reactionGuid: requireGuid(body.reactionGuid) };
    if (action !== "placement") return { selectedMessageGuid, partIndex };
    const placement = typeof body.placement === "string" && Buffer.byteLength(body.placement, "utf8") <= 8192
        ? JSON.parse(body.placement) : body.placement;
    if (!placement || Array.isArray(placement) || typeof placement !== "object" ||
        Object.keys(placement).length !== 5 || Object.keys(placement).some(key => !["x", "y", "scale", "rotation", "parentWidth"].includes(key)) ||
        Object.values(placement).some(value => typeof value !== "number" || !Number.isFinite(value)) ||
        placement.x < -4 || placement.x > 4 || placement.y < -4 || placement.y > 4 ||
        placement.scale < 0.01 || placement.scale > 4 || Math.abs(placement.rotation) > 2 * Math.PI ||
        placement.parentWidth < 1 || placement.parentWidth > 4096) throw new Error("Invalid sticker placement geometry.");
    return { selectedMessageGuid, partIndex, placement };
}

export function matchesStickerTarget(message: any, target: StickerTarget): boolean {
    return message?.associatedMessageGuid === `p:${target.partIndex}/${target.selectedMessageGuid}` ||
        (target.partIndex === 0 && message?.associatedMessageGuid === `bp:${target.selectedMessageGuid}`);
}

export function validateStickerTarget(message: any, chatGuid: string, target: StickerTarget) {
    if (message?.guid !== target.selectedMessageGuid || message?.service !== "iMessage" ||
        !message.chats?.some((chat: any) => chat.guid === chatGuid && chat.serviceName === "iMessage") ||
        message.associatedMessageGuid || message.isFullyUnsent ||
        (Array.isArray(message.retractedParts) && message.retractedParts.includes(target.partIndex)))
        throw new Error("Sticker target must be a visible message in the requested iMessage chat.");
    const hasPartCount = Number.isInteger(message.partCount);
    if (hasPartCount && (message.partCount < 1 || target.partIndex >= message.partCount))
        throw new Error("Sticker target part does not exist.");
    const knownParts = (message.attributedBody ?? []).flatMap((body: any) => (body?.runs ?? [])
        .map((run: any) => run?.attributes?.__kIMMessagePartAttributeName)).filter(Number.isInteger);
    if (!hasPartCount && knownParts.length && !knownParts.includes(target.partIndex)) throw new Error("Sticker target part does not exist.");
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
    let animated = false;
    let animatedFrameData = false;
    let format: string;
    if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
        format = "png";
        if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR")
            throw new Error("Invalid PNG header.");
        width = bytes.readUInt32BE(16);
        height = bytes.readUInt32BE(20);
        let controls = 0;
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
            if (type === "fdAT") animatedFrameData = true;
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
    return { width, height, frames, format, animated: animated || animatedFrameData || frames > 1 };
}

export function validateInlineStickerBytes(bytes: Buffer, filename: string) {
    const image = inspectStickerBytes(bytes, filename);
    if (image.format !== "png" || image.animated)
        throw new Error("Inline sticker rows and text currently require static PNG images.");
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
    return matchesSentStickerBatch(message, guid, chatGuid, sentAt, 1);
}

export function stickerBodyRuns(message: any): any[] | null {
    if (!Array.isArray(message?.attributedBody)) return null;
    const runs = message.attributedBody.flatMap((body: any) => Array.isArray(body?.runs) ? body.runs : []);
    return runs.filter((run: any) => run?.attributes?.__kIMFileTransferGUIDAttributeName)
        .sort((left: any, right: any) => (left.range?.[0] ?? 0) - (right.range?.[0] ?? 0));
}

export function getStickerLayout(message: any): StickerLayout | null {
    if (message?.associatedMessageGuid) return null;
    const bodies = message?.attributedBody;
    if (!Array.isArray(bodies) || bodies.length !== 1 || !Array.isArray(bodies[0]?.runs)) return null;
    const runs = stickerBodyRuns(message);
    const attachments = message?.attachments;
    if (!runs?.length || !Array.isArray(attachments) || attachments.length !== runs.length ||
        bodies[0].runs.length !== runs.length || bodies[0].string !== "\uFFFC".repeat(runs.length) ||
        attachments.some((attachment: any) => attachment?.isSticker !== true || !attachment.guid) ||
        new Set(attachments.map((attachment: any) => attachment.guid)).size !== attachments.length) return null;
    const guids: string[] = [];
    for (const run of runs) {
        const attrs = run.attributes;
        const guid = attrs.__kIMFileTransferGUIDAttributeName;
        if (typeof guid !== "string" || attrs.__kIMMessagePartAttributeName !== 0 ||
            attrs.__kIMEmojiImageAttributeName !== 1 || !Array.isArray(run.range) ||
            run.range.length !== 2 || !Number.isInteger(run.range[0]) || run.range[0] !== guids.length ||
            run.range[1] !== 1 || !attachments.some((attachment: any) => attachment.guid === guid)) return null;
        guids.push(guid);
    }
    if (new Set(guids).size !== guids.length) return null;
    return { attachmentGuids: guids, partIndex: 0 };
}

function matchesSentStickerIdentity(message: any, guid: string, chatGuid: string, sentAt: number, count: number): boolean {
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
        message.attachments?.length === count &&
        new Set(message.attachments.map((attachment: any) => attachment.guid)).size === count &&
        message.attachments.every((attachment: any) => attachment?.isSticker === true && !!attachment.guid &&
            !!attachment.stickerUserInfo && (attachment.stickerUserInfo.length > 0 ||
            attachment.stickerUserInfo.byteLength > 0 || attachment.stickerUserInfo.size > 0))
    );
}

export function matchesSentStickerBatch(message: any, guid: string, chatGuid: string, sentAt: number, count: number, filenames?: string[], expectedGuids?: string[]): boolean {
    return !!(matchesSentStickerIdentity(message, guid, chatGuid, sentAt, count) &&
        (count === 1 || (Array.isArray(expectedGuids) && expectedGuids.length === count &&
            new Set(expectedGuids).size === count && expectedGuids.every(expected => typeof expected === "string" &&
                message.attachments.some((attachment: any) => attachment.guid === expected)) &&
            (message.attributedBody == null || (getStickerLayout(message) &&
                stickerBodyRuns(message).every((run, index) => run.attributes.__kIMFileTransferGUIDAttributeName === expectedGuids[index] &&
                    (!filenames || !Object.prototype.hasOwnProperty.call(run.attributes, "__kIMFilenameAttributeName") ||
                        run.attributes.__kIMFilenameAttributeName === filenames[index]))))))
    );
}

export function matchesSentStickerComposition(message: any, guid: string, chatGuid: string, sentAt: number,
    text: string, expectedGuids: string[], filenames: string[]): boolean {
    const count = expectedGuids?.length;
    try { validateStickerCompositionText(text, count); } catch { return false; }
    if (!Array.isArray(expectedGuids) || !matchesSentStickerIdentity(message, guid, chatGuid, sentAt, count) ||
        !Array.isArray(filenames) || filenames.length !== count ||
        new Set(expectedGuids).size !== count || expectedGuids.some(expected => typeof expected !== "string" ||
            !expected || !message.attachments.some((attachment: any) => attachment.guid === expected))) return false;
    const bodies = message.attributedBody;
    if (!Array.isArray(bodies) || bodies.length !== 1 || bodies[0]?.string !== text || !Array.isArray(bodies[0]?.runs) ||
        bodies[0].runs.length < 1 || bodies[0].runs.length > text.length) return false;
    const runs = [...bodies[0].runs].sort((left, right) => (left?.range?.[0] ?? -1) - (right?.range?.[0] ?? -1));
    let offset = 0;
    let ordinal = 0;
    for (const run of runs) {
        const range = run?.range;
        const attrs = run?.attributes;
        if (!Array.isArray(range) || range.length !== 2 || !Number.isInteger(range[0]) || range[0] !== offset ||
            !Number.isInteger(range[1]) || range[1] < 1 || range[1] > text.length - offset || !attrs || typeof attrs !== "object" || Array.isArray(attrs)) return false;
        if (!Number.isInteger(attrs.__kIMMessagePartAttributeName) || attrs.__kIMMessagePartAttributeName < 0 ||
            attrs.__kIMMessagePartAttributeName > 2147483647) return false;
        const content = text.slice(offset, offset + range[1]);
        if (Object.prototype.hasOwnProperty.call(attrs, "__kIMFileTransferGUIDAttributeName")) {
            if (content !== "\uFFFC" || attrs.__kIMFileTransferGUIDAttributeName !== expectedGuids[ordinal] ||
                attrs.__kIMEmojiImageAttributeName !== 1 ||
                (Object.prototype.hasOwnProperty.call(attrs, "__kIMFilenameAttributeName") &&
                    attrs.__kIMFilenameAttributeName !== filenames[ordinal])) return false;
            ordinal++;
        } else if (content.includes("\uFFFC")) return false;
        offset += range[1];
    }
    return offset === text.length && ordinal === count;
}

export function matchesSentStickerAction(message: any, guid: string, chatGuid: string, sentAt: number,
    action: StickerAction, target: StickerTarget, removedAttachmentGuids?: string[]): boolean {
    const type = action === "placement" ? "sticker" : action === "tapback" ? "sticker-reaction" : "-sticker-reaction";
    if (!matchesStickerTarget(message, target) || message.associatedMessageType !== type) return false;
    if (action !== "remove") return matchesSentStickerBatch({ ...message, associatedMessageGuid: null }, guid, chatGuid, sentAt, 1);
    return !!(message.guid === guid && message.isFromMe === true && message.service === "iMessage" &&
        message.isSent === true && message.error === 0 && message.dateCreated instanceof Date &&
        message.dateCreated.getTime() >= sentAt &&
        message.chats?.some((chat: any) => chat.guid === chatGuid && chat.serviceName === "iMessage") &&
        (message.attachments ?? []).every((attachment: any) => attachment?.isSticker === true &&
            removedAttachmentGuids?.includes(attachment.guid)));
}
