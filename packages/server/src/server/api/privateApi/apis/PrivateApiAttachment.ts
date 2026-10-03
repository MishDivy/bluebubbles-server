import { Server } from "@server";
import {
    TransactionPromise,
    TransactionResult,
    TransactionType
} from "@server/managers/transactionManager/transactionPromise";
import { PrivateApiAction } from ".";

export class PrivateApiAttachment extends PrivateApiAction {
    tag = "PrivateApiAttachment";

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
