import { Server } from "@server";
import {
    TransactionPromise,
    TransactionResult,
    TransactionType
} from "@server/managers/transactionManager/transactionPromise";
import { PrivateApiAction } from ".";
import type { StickerPlacement, StickerTarget } from "@server/api/stickers";

export class PrivateApiAttachment extends PrivateApiAction {
    tag = "PrivateApiAttachment";

    async sendStickerAction(action: "placement" | "tapback", data: StickerTarget & {
        chatGuid: string; filePath: string; filename?: string; stickerLabel?: string; placement?: StickerPlacement;
    }): Promise<TransactionResult> {
        if (!(action === "placement" ? this.api.capabilities.stickerPlacement : this.api.capabilities.stickerReactions))
            throw new Error("Native sticker action is not supported by the connected Messages helper.");
        this.throwForNoMissingFields("sticker action", [data.chatGuid, data.filePath, data.selectedMessageGuid]);
        if (!Number.isInteger(data.partIndex) || data.partIndex < 0) throw new Error("Invalid target part index.");
        return this.sendApiMessage(action === "placement" ? "send-sticker-placement" : "send-sticker-tapback", {
            chatGuid: data.chatGuid, selectedMessageGuid: data.selectedMessageGuid, partIndex: data.partIndex, filePath: data.filePath,
            ...(data.filename != null ? { filename: data.filename } : {}),
            ...(data.stickerLabel != null ? { stickerLabel: data.stickerLabel } : {}),
            ...(action === "placement" ? { placement: data.placement } : {})
        }, new TransactionPromise(TransactionType.ATTACHMENT));
    }

    async removeStickerTapback(data: StickerTarget & { chatGuid: string; reactionGuid: string }): Promise<TransactionResult> {
        if (!this.api.capabilities.stickerReactions) throw new Error("Native sticker reactions are not supported by the connected Messages helper.");
        this.throwForNoMissingFields("remove-sticker-tapback", [data.chatGuid, data.selectedMessageGuid, data.reactionGuid]);
        if (!Number.isInteger(data.partIndex) || data.partIndex < 0) throw new Error("Invalid target part index.");
        return this.sendApiMessage("remove-sticker-tapback", {
            chatGuid: data.chatGuid, selectedMessageGuid: data.selectedMessageGuid,
            partIndex: data.partIndex, reactionGuid: data.reactionGuid
        }, new TransactionPromise(TransactionType.ATTACHMENT));
    }

    async sendStickerRow({ chatGuid, stickers }: { chatGuid: string; stickers: { filePath: string; filename?: string; stickerLabel?: string }[] }): Promise<TransactionResult> {
        if (!this.api.capabilities.stickerRows) throw new Error("Native sticker rows are not supported by the connected Messages helper.");
        if (!Array.isArray(stickers) || stickers.length < 2 || stickers.length > 10) throw new Error("A sticker row must contain 2 to 10 stickers.");
        this.throwForNoMissingFields("send-sticker-row", [chatGuid, ...stickers.map(sticker => sticker.filePath)]);
        return this.sendApiMessage("send-sticker-row", { chatGuid, stickers: stickers.map(({ filePath, filename, stickerLabel }) => ({
            filePath, ...(filename != null ? { filename } : {}), ...(stickerLabel != null ? { stickerLabel } : {})
        })) }, new TransactionPromise(TransactionType.ATTACHMENT));
    }

    async sendSticker({
        chatGuid,
        filePath,
        filename,
        stickerLabel
    }: {
        chatGuid: string;
        filePath: string;
        filename?: string;
        stickerLabel?: string;
    }): Promise<TransactionResult> {
        if (!this.api.capabilities.stickerSending)
            throw new Error("Native sticker sending is not supported by the connected Messages helper.");
        this.throwForNoMissingFields("send-sticker", [chatGuid, filePath]);
        return this.sendApiMessage(
            "send-sticker",
            {
                chatGuid,
                filePath,
                ...(filename != null ? { filename } : {}),
                ...(stickerLabel != null ? { stickerLabel } : {})
            },
            new TransactionPromise(TransactionType.ATTACHMENT)
        );
    }

    async send({
        chatGuid,
        filePath,
        isAudioMessage = false,
        attributedBody = null,
        subject = null,
        effectId = null,
        selectedMessageGuid = null,
        partIndex = 0
    }: {
        chatGuid: string;
        filePath: string;
        isAudioMessage?: boolean;
        attributedBody?: Record<string, any> | null;
        subject?: string;
        effectId?: string;
        selectedMessageGuid?: string;
        partIndex?: number;
    }): Promise<TransactionResult> {
        const action = "send-attachment";
        this.throwForNoMissingFields(action, [chatGuid, filePath]);
        const request = new TransactionPromise(TransactionType.ATTACHMENT);
        return this.sendApiMessage(
            action,
            {
                chatGuid,
                filePath,
                isAudioMessage: isAudioMessage ? 1 : 0,
                attributedBody,
                subject,
                effectId,
                selectedMessageGuid,
                partIndex
            },
            request
        );
    }

    async downloadPurged(guid: string): Promise<TransactionResult> {
        const action = "download-purged-attachment";
        this.throwForNoMissingFields(action, [guid]);
        return this.sendApiMessage(action, { attachmentGuid: guid });
    }
}
