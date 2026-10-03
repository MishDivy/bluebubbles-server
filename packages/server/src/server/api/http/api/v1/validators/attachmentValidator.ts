import { RouterContext } from "koa-router";
import { Next } from "koa";

import { ValidateInput } from "./index";
import { BadRequest } from "../responses/errors";

export class AttachmentValidator {
    static async validateStickerPreview(ctx: RouterContext, next: Next) {
        if (typeof ctx.params.guid !== "string" || !ctx.params.guid || ctx.params.guid.length > 256 ||
            /[\\/\x00-\x1f\x7f]/.test(ctx.params.guid) ||
            Object.keys(ctx.request?.query ?? {}).some(key => !["password", "token", "guid"].includes(key)))
            throw new BadRequest({ error: "Sticker preview requires an attachment GUID and only authentication parameters." });
        await next();
    }

    static findParamRules = {
        guid: "required|string"
    };

    static async validateFind(ctx: RouterContext, next: Next) {
        ValidateInput(ctx.params, AttachmentValidator.findParamRules);
        await next();
    }

    static downloadRules = {
        height: "numeric|min:1",
        width: "numeric|min:1",
        quality: "string|in:good,better,best",
        force: "boolean",
        original: "boolean"
    };

    static async validateDownload(ctx: RouterContext, next: Next) {
        ValidateInput(ctx?.request?.query, AttachmentValidator.downloadRules);
        await next();
    }

    static async validateUpload(ctx: RouterContext, next: Next) {
        const { files } = ctx.request;

        // Make sure the message isn't already in the queue
        const attachment = files?.attachment as unknown as File;
        if (!attachment || attachment.size === 0) {
            throw new BadRequest({ error: "Attachment not provided or was empty!" });
        }

        await next();
    }
}
