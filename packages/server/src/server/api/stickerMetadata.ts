import * as bplist from "bplist-parser";

export type StickerMetadata = {
    sourceBundleId?: string;
    packId?: string;
    assetId?: string;
    hash?: string;
    packName?: string;
    appStoreId?: number;
    accessibilityLabel?: string;
    effectType?: number;
    placement?: Partial<Record<"sro" | "spw" | "ssa" | "sai" | "sli" | "sys" | "sxs" | "tssa", string | number>> & {
        sir?: boolean;
        spv?: number;
    };
    dimensions?: { width?: number; height?: number };
    sizeClass?: Partial<Record<"mth" | "mtw" | "s" | "mpw", number>> & { st?: boolean };
    row?: { index: number; partIndex: 0; count: number };
};

const MAX_BYTES = 64 * 1024;
const MAX_NODES = 1024;
const MAX_DEPTH = 8;
const attributionKeys = ["bundle-id", "accessl", "name", "adam-id", "pgensh", "pgensw", "pgenszc"];
const stickerKeys = [
    "pid",
    "sid",
    "shash",
    "sbid",
    "sro",
    "spw",
    "ssa",
    "sai",
    "sli",
    "sys",
    "sxs",
    "tssa",
    "sir",
    "spv",
    "stickerEffectType"
];

// Bound reference expansion before the parser recursively materializes a plist graph.
function validatePlistGraph(bytes: Buffer) {
    const trailer = bytes.length - 32;
    const size = bytes[trailer + 6];
    const refSize = bytes[trailer + 7];
    const read = (offset: number, width: number) => {
        if (width < 1 || width > 6 || offset < 0 || offset + width > bytes.length)
            throw new Error("Invalid plist integer.");
        return bytes.readUIntBE(offset, width);
    };
    const trailerInteger = (offset: number) => {
        if (read(offset, 4) !== 0) throw new Error("Oversized plist graph.");
        return read(offset + 4, 4);
    };
    const count = trailerInteger(trailer + 8);
    const top = trailerInteger(trailer + 16);
    const table = trailerInteger(trailer + 24);
    if (
        !count ||
        count > MAX_NODES ||
        top >= count ||
        size < 1 ||
        size > 4 ||
        refSize < 1 ||
        refSize > 4 ||
        table < 8 ||
        table + count * size > trailer
    )
        throw new Error("Invalid plist table.");
    const offsets = Array.from({ length: count }, (_, index) => read(table + index * size, size));
    let visited = 0;
    const active = new Set<number>();
    const visit = (ref: number, depth: number) => {
        if (ref >= count || depth > MAX_DEPTH || ++visited > MAX_NODES || active.has(ref))
            throw new Error("Oversized or cyclic plist graph.");
        const offset = offsets[ref];
        if (offset < 8 || offset >= table) throw new Error("Invalid plist object.");
        const type = bytes[offset] >> 4;
        let length = bytes[offset] & 15;
        let start = offset + 1;
        if ([4, 5, 6, 7, 10, 12, 13].includes(type) && length === 15) {
            if (bytes[start] >> 4 !== 1) throw new Error("Invalid plist length.");
            const width = 1 << (bytes[start++] & 15);
            if (width > 4) throw new Error("Oversized plist object.");
            length = read(start, width);
            start += width;
        }
        if ([10, 12, 13].includes(type)) {
            const references = length * (type === 13 ? 2 : 1);
            if (references > MAX_NODES || start + references * refSize > table)
                throw new Error("Invalid plist references.");
            active.add(ref);
            for (let index = 0; index < references; index++) visit(read(start + index * refSize, refSize), depth + 1);
            active.delete(ref);
        } else {
            const width = [1, 2].includes(type)
                ? 1 << length
                : type === 3
                ? 8
                : [4, 5, 7].includes(type)
                ? length
                : type === 6
                ? length * 2
                : type === 8
                ? length + 1
                : type === 0
                ? 0
                : -1;
            if (width < 0 || width > MAX_BYTES || start + width > table) throw new Error("Invalid plist payload.");
        }
    };
    visit(top, 0);
}

function primitiveTree(value: any, depth = 0, budget = { remaining: MAX_NODES }): boolean {
    if (depth > MAX_DEPTH || --budget.remaining < 0) return false;
    if (value == null || typeof value === "boolean" || typeof value === "string")
        return typeof value !== "string" || value.length <= 4096;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(item => primitiveTree(item, depth + 1, budget));
    if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
    return Object.keys(value).every(
        key =>
            key !== "__proto__" &&
            key !== "constructor" &&
            key !== "prototype" &&
            primitiveTree(value[key], depth + 1, budget)
    );
}

export function decodeStickerPlist(value: unknown): Record<string, any> | null {
    if (
        !Buffer.isBuffer(value) ||
        value.length < 40 ||
        value.length > MAX_BYTES ||
        value.toString("ascii", 0, 8) !== "bplist00"
    )
        return null;
    try {
        validatePlistGraph(value);
        const decoded = bplist.parseBuffer(value);
        if (
            !Array.isArray(decoded) ||
            decoded.length !== 1 ||
            !decoded[0] ||
            Array.isArray(decoded[0]) ||
            Object.getPrototypeOf(decoded[0]) !== Object.prototype ||
            !primitiveTree(decoded[0])
        )
            return null;
        return decoded[0];
    } catch {
        return null;
    }
}

function allowlisted(value: unknown, keys: string[]): Record<string, any> | null {
    const decoded = decodeStickerPlist(value);
    if (!decoded) return null;
    return Object.fromEntries(
        keys.filter(key => Object.hasOwnProperty.call(decoded, key)).map(key => [key, decoded[key]])
    );
}

export function decodeStickerAttribution(value: unknown): Record<string, any>[] | null {
    const decoded = allowlisted(value, attributionKeys);
    if (decoded?.pgenszc && typeof decoded.pgenszc === "object" && !Array.isArray(decoded.pgenszc)) {
        decoded.pgenszc = Object.fromEntries(
            ["mth", "mtw", "s", "mpw", "st"]
                .filter(key => Object.prototype.hasOwnProperty.call(decoded.pgenszc, key))
                .map(key => [key, decoded.pgenszc[key]])
        );
    }
    return decoded ? [decoded] : null;
}

function string(value: any): string | undefined {
    return typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value)
        ? value
        : undefined;
}

function number(value: any): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numericValue(value: any): number | undefined {
    const numeric = number(value);
    if (numeric !== undefined) return numeric;
    const safe = string(value);
    if (safe === undefined || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(safe)) return undefined;
    return number(Number(safe));
}

export function normalizeStickerMetadata(attachment: any): StickerMetadata | null {
    if (attachment?.isSticker !== true) return null;
    const source = allowlisted(attachment.stickerUserInfo, stickerKeys) ?? {};
    const attribution =
        decodeStickerAttribution(attachment.attributionInfo)?.[0] ??
        (Array.isArray(attachment.attributionInfo) && primitiveTree(attachment.attributionInfo[0])
            ? attachment.attributionInfo[0]
            : {}) ??
        {};
    const output: StickerMetadata = {};
    const texts = {
        sourceBundleId: source.sbid ?? attribution["bundle-id"],
        packId: source.pid,
        assetId: source.sid,
        hash: source.shash,
        packName: attribution.name,
        accessibilityLabel: attribution.accessl
    };
    for (const key of Object.keys(texts) as (keyof typeof texts)[]) {
        const safe = string(texts[key]);
        if (safe !== undefined) output[key] = safe;
    }
    if (Number.isSafeInteger(attribution["adam-id"]) && attribution["adam-id"] >= 0)
        output.appStoreId = attribution["adam-id"];
    if (Number.isSafeInteger(source.stickerEffectType)) output.effectType = source.stickerEffectType;
    const placement: StickerMetadata["placement"] = {};
    for (const key of ["sro", "spw", "ssa", "sai", "sli", "sys", "sxs", "tssa"] as const) {
        const numeric = number(source[key]);
        if (numeric !== undefined) {
            placement[key] = numeric;
            continue;
        }
        const safe = string(source[key]);
        if (
            safe !== undefined &&
            /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(safe) &&
            Number.isFinite(Number(safe))
        )
            placement[key] = safe;
    }
    if (typeof source.sir === "boolean") placement.sir = source.sir;
    if (Number.isSafeInteger(source.spv)) placement.spv = source.spv;
    if (Object.keys(placement).length) output.placement = placement;
    const dimensions: StickerMetadata["dimensions"] = {};
    const width = numericValue(attribution.pgensw);
    const height = numericValue(attribution.pgensh);
    if (width > 0) dimensions.width = width;
    if (height > 0) dimensions.height = height;
    if (Object.keys(dimensions).length) output.dimensions = dimensions;
    const sizeClass: StickerMetadata["sizeClass"] = {};
    for (const key of ["mth", "mtw", "s", "mpw"] as const) {
        const safe = numericValue(attribution.pgenszc?.[key]);
        if (safe !== undefined) sizeClass[key] = safe;
    }
    if (typeof attribution.pgenszc?.st === "boolean") sizeClass.st = attribution.pgenszc.st;
    if (Object.keys(sizeClass).length) output.sizeClass = sizeClass;
    return Object.keys(output).length ? output : null;
}
