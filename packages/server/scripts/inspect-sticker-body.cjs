// Offline stdin-only structure inspection. No archive contents enter diagnostics.
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { Unarchiver, NSAttributedString } = require("node-typedstream");

const MAX_INPUT_BYTES = 128 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;
const publicKeys = new Set([
    "__kIMFileTransferGUIDAttributeName", "__kIMFilenameAttributeName", "__kIMMessagePartAttributeName",
    "__kIMEmojiImageAttributeName", "__kIMBaseWritingDirectionAttributeName",
    "__kIMInlineMediaWidthAttributeName", "__kIMInlineMediaHeightAttributeName",
    "NSFont", "NSColor", "NSBackgroundColor", "NSParagraphStyle", "NSWritingDirection", "NSAttachment",
    "NSUnderline", "NSUnderlineColor", "NSStrikethrough", "NSStrikethroughColor", "NSBaselineOffset",
    "NSKern", "NSLigature", "NSLink", "NSStrokeColor", "NSStrokeWidth", "NSShadow", "NSObliqueness",
    "NSExpansion", "NSVerticalGlyphForm"
]);

function validateInput(input) {
    if (!input || Array.isArray(input) || typeof input !== "object" ||
        Object.keys(input).some(key => !["attributedBody", "attachmentGuids"].includes(key)) ||
        typeof input.attributedBody !== "string" || input.attributedBody.length > Math.ceil(MAX_ARCHIVE_BYTES / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.attributedBody) ||
        !Array.isArray(input.attachmentGuids) || input.attachmentGuids.length > 32 ||
        input.attachmentGuids.some(guid => typeof guid !== "string" || !guid.length || guid.length > 1024) ||
        new Set(input.attachmentGuids).size !== input.attachmentGuids.length) throw new Error("invalid_input");
    const bytes = Buffer.from(input.attributedBody, "base64");
    if (!bytes.length || bytes.length > MAX_ARCHIVE_BYTES || bytes.toString("base64") !== input.attributedBody)
        throw new Error("invalid_input");
    return bytes;
}

function valueType(value) {
    if (value === null) return "null";
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return "bytes";
    if (Array.isArray(value)) return "array";
    return typeof value;
}
function numeric(value) {
    return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1000000 ? value : null;
}

function summarizeDecoded(decoded, linkedGuids) {
    if (!Array.isArray(decoded) || decoded.length > 32) throw new Error("summary_limits");
    const bodies = decoded.flatMap(item => Array.isArray(item?.values)
        ? item.values.filter(value => value instanceof NSAttributedString) : item instanceof NSAttributedString ? [item] : []);
    if (!bodies.length || bodies.length > 8) throw new Error("summary_limits");
    const summaries = bodies.map(body => {
        if (typeof body.string !== "string" || body.string.length > 1024 || !Array.isArray(body.runs) || body.runs.length > 64)
            throw new Error("summary_limits");
        const runs = body.runs.map(run => {
            if (!Array.isArray(run?.range) || run.range.length !== 2 || run.range.some(value => !Number.isInteger(value) || value < 0 || value > 1024) ||
                !run.attributes || typeof run.attributes !== "object" || Array.isArray(run.attributes)) throw new Error("summary_limits");
            const keys = Object.keys(run.attributes);
            if (keys.length > 64) throw new Error("summary_limits");
            const transfer = run.attributes.__kIMFileTransferGUIDAttributeName;
            const ordinal = typeof transfer === "string" ? linkedGuids.indexOf(transfer) : -1;
            return {
                range: [...run.range], hasTransfer: typeof transfer === "string", transferOrdinal: ordinal < 0 ? null : ordinal,
                part: numeric(run.attributes.__kIMMessagePartAttributeName), emoji: numeric(run.attributes.__kIMEmojiImageAttributeName),
                writing: numeric(run.attributes.__kIMBaseWritingDirectionAttributeName),
                attributes: keys.map(key => ({ key: publicKeys.has(key) ? key : "<redacted>", type: valueType(run.attributes[key]) }))
            };
        });
        const perCharacterTransferOrdinals = Array.from({ length: body.string.length }, (_, index) => runs
            .filter(run => run.hasTransfer && index >= run.range[0] && index < run.range[0] + run.range[1])
            .map(run => run.transferOrdinal));
        const fffcCount = body.string.split("\uFFFC").length - 1;
        const fffcOnly = body.string.length > 0 && fffcCount === body.string.length;
        const markerOffsets = [], newlineOffsets = [];
        for (let index = 0; index < body.string.length; index++) {
            if (body.string[index] === "\uFFFC") markerOffsets.push(index);
            if (body.string[index] === "\n" || body.string[index] === "\r") newlineOffsets.push(index);
        }
        return { length: body.string.length, fffcCount, fffcOnly, markerOffsets, newlineOffsets, runs, perCharacterTransferOrdinals,
            linkedOrderEqual: fffcOnly && body.string.length === linkedGuids.length &&
                perCharacterTransferOrdinals.every((ordinals, index) => ordinals.length === 1 && ordinals[0] === index) };
    });
    const result = { version: 1, ok: true, bodyCount: bodies.length, linkedAttachmentCount: linkedGuids.length, bodies: summaries };
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES) throw new Error("summary_limits");
    return result;
}

function emit(result) { process.stdout.write(JSON.stringify(result) + "\n"); }
async function main() {
    try {
        const chunks = []; let size = 0;
        for await (const chunk of process.stdin) {
            size += chunk.length;
            if (size > MAX_INPUT_BYTES) throw new Error("invalid_input");
            chunks.push(chunk);
        }
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        validateInput(input);
        const result = await new Promise(resolve => {
            const worker = new Worker(__filename, { workerData: input, stdout: true, stderr: true,
                resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 } });
            worker.stdout.resume(); worker.stderr.resume();
            let settled = false;
            const finish = result => {
                if (settled) return;
                settled = true; clearTimeout(deadline); void worker.terminate(); resolve(result);
            };
            const deadline = setTimeout(() => finish({ version: 1, ok: false, error: "parse_timeout" }), 5000);
            worker.once("message", finish);
            worker.once("error", () => finish({ version: 1, ok: false, error: "parse_failed" }));
            worker.once("exit", () => finish({ version: 1, ok: false, error: "parse_failed" }));
        });
        emit(result); if (!result.ok) process.exitCode = 1;
    } catch { emit({ version: 1, ok: false, error: "invalid_input" }); process.exitCode = 1; }
}

if (!isMainThread) {
    try {
        const bytes = validateInput(workerData);
        // Retain undecodable NSData keys for type reporting; never expose their bytes.
        const decoded = Unarchiver.open(bytes, Unarchiver.BinaryDecoding.all).decodeAll();
        parentPort.postMessage(summarizeDecoded(decoded, workerData.attachmentGuids));
    } catch { parentPort.postMessage({ version: 1, ok: false, error: "parse_failed" }); }
} else if (require.main === module) void main();

module.exports = { validateInput, summarizeDecoded };
