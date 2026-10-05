import { Server } from "@server";
import * as fs from "fs";
import { FileSystem } from "@server/fileSystem";
import { MessagePromise } from "@server/managers/outgoingMessageManager/messagePromise";
import { Message } from "@server/databases/imessage/entity/Message";
import { checkPrivateApiStatus, isEmpty, isNotEmpty, resultAwaiter } from "@server/helpers/utils";
import { isMinMonterey, isMinVentura } from "@server/env";
import { negativeReactionTextMap, reactionTextMap } from "@server/api/apple/mappings";
import { invisibleMediaChar } from "@server/api/http/constants";
import { ActionHandler } from "@server/api/apple/actions";
import { rimrafSync } from "rimraf";
import type {
    SendMessageParams,
    SendAttachmentParams,
    SendMessagePrivateApiParams,
    SendReactionParams,
    UnsendMessageParams,
    EditMessageParams,
    SendAttachmentPrivateApiParams,
    SendMultipartTextParams
} from "@server/api/types";
import { Chat } from "@server/databases/imessage/entity/Chat";
import path from "path";
import { DBWhereItem } from "@server/databases/imessage/types";
import type { TransactionResult } from "@server/managers/transactionManager/transactionPromise";
import {
    classicReactions,
    requireReaction,
    requireReactionCapability,
    matchesEmojiReaction
} from "@server/api/reactions";
import {
    validateStickerFields,
    readStickerUpload,
    reserveStickerAttempt,
    hasStickerAttempt,
    matchesSentStickerBatch,
    matchesSentStickerComposition,
    stickerBodyRuns,
    parseStickerRowFields,
    MAX_STICKER_ROW_BYTES,
    parseStickerActionFields,
    validateStickerTarget,
    matchesSentStickerAction,
    StickerTarget,
    StickerPlacement,
    StickerUnconfirmedError,
    stickerHelperFailureCode
} from "@server/api/stickers";

export class MessageInterface {
    static possibleReactions: string[] = classicReactions;

    static async sendSticker({
        chatGuid,
        tempGuid,
        name,
        stickerLabel,
        attachmentPath
    }: {
        chatGuid: string;
        tempGuid: string;
        name: string;
        stickerLabel?: string;
        attachmentPath: string;
    }): Promise<Message> {
        validateStickerFields({ chatGuid, tempGuid, name, ...(stickerLabel != null ? { stickerLabel } : {}) });
        return MessageInterface.sendStickerBatch(chatGuid, tempGuid, [{ attachmentPath, name, stickerLabel }]);
    }

    static async sendStickerRow({ chatGuid, tempGuid, stickers, text }: {
        chatGuid: string;
        tempGuid: string;
        stickers: { attachmentPath: string; name: string; stickerLabel?: string }[];
        text?: string;
    }): Promise<Message> {
        parseStickerRowFields({ chatGuid, tempGuid, stickers: JSON.stringify(stickers.map(({ name, stickerLabel }) => ({ name, stickerLabel }))),
            ...(text !== undefined ? { text } : {}) });
        return MessageInterface.sendStickerBatch(chatGuid, tempGuid, stickers, undefined, text);
    }

    static async sendStickerAction(action: "placement" | "tapback", request: StickerTarget & {
        chatGuid: string; tempGuid: string; name: string; stickerLabel?: string;
        attachmentPath: string; placement?: StickerPlacement;
    }): Promise<Message> {
        const { attachmentPath, ...fields } = request;
        const target = parseStickerActionFields(fields, action);
        return MessageInterface.sendStickerBatch(request.chatGuid, request.tempGuid,
            [{ attachmentPath, name: request.name, stickerLabel: request.stickerLabel }], { action, ...target });
    }

    static async removeStickerTapback(request: StickerTarget & {
        chatGuid: string; tempGuid: string; reactionGuid: string;
    }): Promise<Message> {
        const target = parseStickerActionFields(request, "remove");
        checkPrivateApiStatus();
        if (!Server().privateApi.capabilities.stickerReactions) throw new Error("Native sticker reactions are not supported by the connected Messages helper.");
        const selected = await Server().iMessageRepo.getMessage(target.selectedMessageGuid, true, true);
        validateStickerTarget(selected, request.chatGuid, target);
        const reaction = await Server().iMessageRepo.getMessage(target.reactionGuid, true, true);
        if (!matchesSentStickerAction(reaction, target.reactionGuid, request.chatGuid, 0, "tapback", target))
            throw new Error("Removal requires an owned sticker tapback on the exact target part.");
        if (Server().httpService.sendCache.find(request.tempGuid) || hasStickerAttempt(request.tempGuid))
            throw new Error("This temporary GUID is already queued.");
        reserveStickerAttempt(request.tempGuid);
        Server().httpService.sendCache.add(request.tempGuid);
        const sentAt = Date.now() - 10000;
        let result: TransactionResult;
        try {
            result = await Server().privateApi.attachment.removeStickerTapback({
                chatGuid: request.chatGuid, selectedMessageGuid: target.selectedMessageGuid,
                partIndex: target.partIndex, reactionGuid: target.reactionGuid
            });
        } catch (error) {
            throw new StickerUnconfirmedError("Sticker removal outcome is unknown. Check the chat before sending again.", stickerHelperFailureCode(error));
        }
        if (typeof result?.identifier !== "string" || !result.identifier)
            throw new StickerUnconfirmedError("Sticker removal outcome is unknown. Check the chat before sending again.", "helper_response_invalid");
        const matches = (message: Message) => matchesSentStickerAction(message, result.identifier, request.chatGuid,
            sentAt, "remove", target, [reaction.attachments[0].guid]);
        let message: Message;
        let sawRow = false;
        try {
            message = await resultAwaiter({ maxWaitMs: 60000, getData: async () => {
                const row = await Server().iMessageRepo.getMessage(result.identifier, true, true);
                sawRow ||= row != null;
                return matches(row) ? row : null;
            } });
        } catch {
            throw new StickerUnconfirmedError("Sticker removal outcome is unknown. Check the chat before sending again.", "confirmation_read_failed");
        }
        if (!matches(message)) throw new StickerUnconfirmedError("Sticker removal was not confirmed. Check the chat before sending again.",
            sawRow ? "confirmation_mismatch" : "confirmation_missing");
        return message;
    }

    private static async sendStickerBatch(chatGuid: string, tempGuid: string,
        stickers: { attachmentPath: string; name: string; stickerLabel?: string }[],
        target?: StickerTarget & { action: "placement" | "tapback"; placement?: StickerPlacement }, text?: string): Promise<Message> {
        checkPrivateApiStatus();
        const composition = text !== undefined;
        const rowSend = stickers.length > 1 || composition;
        const capability = target ? (target.action === "placement" ? "stickerPlacement" : "stickerReactions")
            : composition ? "stickerComposition" : rowSend ? "stickerRows" : "stickerSending";
        if (!Server().privateApi.capabilities[capability])
            throw new Error("Native sticker sending is not supported by the connected Messages helper.");
        const [chats] = await Server().iMessageRepo.getChats({
            chatGuid,
            withParticipants: false,
            withLastMessage: false
        });
        if (chats.length !== 1 || chats[0].guid !== chatGuid || chats[0].serviceName !== "iMessage") {
            throw new Error("Native stickers require an existing iMessage chat.");
        }
        if (target) validateStickerTarget(await Server().iMessageRepo.getMessage(target.selectedMessageGuid, true, true), chatGuid, target);
        const sources = stickers.map(sticker => readStickerUpload(sticker.attachmentPath, sticker.name));
        if (sources.reduce((total, bytes) => total + bytes.length, 0) > MAX_STICKER_ROW_BYTES) throw new Error("Sticker row exceeds 5 MiB.");
        if (Server().httpService.sendCache.find(tempGuid) || hasStickerAttempt(tempGuid))
            throw new Error("This temporary GUID is already queued.");
        const prepared: { filePath: string; filename: string; stickerLabel?: string }[] = [];
        const cleanupPrepared = (confirmedMessage?: Message) => {
            let referenced: Set<string>;
            try {
                referenced = new Set((confirmedMessage?.attachments ?? []).filter(attachment => typeof attachment.filePath === "string")
                    .map(attachment => FileSystem.getRealPath(attachment.filePath)));
            } catch {
                return;
            }
            for (const { filePath } of prepared) {
                if (referenced.has(filePath)) continue;
                try { fs.unlinkSync(filePath); fs.rmdirSync(path.dirname(filePath)); } catch { /* Preserve the preparation error. */ }
            }
        };
        try {
            for (let index = 0; index < stickers.length; index++) {
                const sticker = stickers[index];
                const filePath = FileSystem.copyAttachment(sticker.attachmentPath, sticker.name, "private-api");
                prepared.push({ filePath, filename: sticker.name, stickerLabel: sticker.stickerLabel });
                const bytes = sources[index];
                if (fs.statSync(filePath).size !== bytes.length || !fs.readFileSync(filePath).equals(bytes)) {
                    throw new Error("Sticker staging changed during validation.");
                }
            }
        } catch (error) {
            cleanupPrepared();
            throw error;
        }
        try {
            reserveStickerAttempt(tempGuid);
        } catch (error) {
            cleanupPrepared();
            throw error;
        }
        Server().httpService.sendCache.add(tempGuid);
        const sentAt = Date.now() - 10000;
        let result: TransactionResult;
        try {
            result = target
                ? await Server().privateApi.attachment.sendStickerAction(target.action, {
                    chatGuid, ...prepared[0], selectedMessageGuid: target.selectedMessageGuid,
                    partIndex: target.partIndex, ...(target.action === "placement" ? { placement: target.placement } : {})
                }) : rowSend
                ? await Server().privateApi.attachment.sendStickerRow({ chatGuid, stickers: prepared, ...(composition ? { text } : {}) })
                : await Server().privateApi.attachment.sendSticker({ chatGuid, ...prepared[0] });
        } catch (error) {
            throw new StickerUnconfirmedError("Sticker send outcome is unknown. Check the chat before sending again.", stickerHelperFailureCode(error));
        }
        if (typeof result?.identifier !== "string" || !result.identifier) {
            throw new StickerUnconfirmedError("Sticker send outcome is unknown. Check the chat before sending again.", "helper_response_invalid");
        }
        const expectedGuids = rowSend ? result.data?.attachmentGuids : undefined;
        if (rowSend && (!Array.isArray(expectedGuids) || expectedGuids.length !== stickers.length ||
            new Set(expectedGuids).size !== stickers.length || expectedGuids.some(guid => typeof guid !== "string" || !guid))) {
            throw new StickerUnconfirmedError("Sticker row send outcome is unknown. Check the chat before sending again.", "helper_row_response_invalid");
        }
        let message: Message;
        const matches = (row: Message) => target
            ? matchesSentStickerAction(row, result.identifier, chatGuid, sentAt, target.action, target)
            : composition ? matchesSentStickerComposition(row, result.identifier, chatGuid, sentAt, text, expectedGuids, stickers.map(sticker => sticker.name))
            : matchesSentStickerBatch(row, result.identifier, chatGuid, sentAt, stickers.length, stickers.map(sticker => sticker.name), expectedGuids);
        let sawRow = false;
        try {
            message = await resultAwaiter({
                maxWaitMs: 60000,
                getData: async () => {
                    const row = await Server().iMessageRepo.getMessage(result.identifier, true, true);
                    sawRow ||= row != null;
                    return matches(row) ? row : null;
                }
            });
        } catch {
            throw new StickerUnconfirmedError("Sticker send outcome is unknown. Check the chat before sending again.", "confirmation_read_failed");
        }
        if (!matches(message)) {
            throw new StickerUnconfirmedError("Sticker send was not confirmed. Check the chat before sending again.",
                sawRow ? "confirmation_mismatch" : "confirmation_missing");
        }
        if (rowSend && !composition) message.verifiedStickerLayout = { attachmentGuids: [...expectedGuids], partIndex: 0 };
        if (composition) message.verifiedStickerComposition = {
            attachmentGuids: [...expectedGuids],
            parts: stickerBodyRuns(message).map(run => ({ range: [run.range[0], 1], partIndex: run.attributes.__kIMMessagePartAttributeName }))
        };
        cleanupPrepared(message);
        return message;
    }

    /**
     * Sends a message by executing the sendMessage AppleScript
     *
     * @param chatGuid The GUID for the chat
     * @param message The message to send
     * @param attachmentName The name of the attachment to send (optional)
     * @param attachment The bytes (buffer) for the attachment
     *
     * @returns The command line response
     */
    static async sendMessageSync({
        chatGuid,
        message,
        method = "apple-script",
        attributedBody = null,
        subject = null,
        effectId = null,
        selectedMessageGuid = null,
        tempGuid = null,
        partIndex = 0,
        ddScan = false
    }: SendMessageParams): Promise<Message> {
        if (!chatGuid) throw new Error("No chat GUID provided");

        Server().log(`Sending message "${message}" to ${chatGuid}`, "debug");

        // We need offsets here due to iMessage's save times being a bit off for some reason
        const now = new Date(new Date().getTime() - 10000).getTime(); // With 10 second offset
        const awaiter = new MessagePromise({
            chatGuid,
            text: message,
            isAttachment: false,
            sentAt: now,
            subject,
            tempGuid
        });

        // Add the promise to the manager
        Server().log(`Adding await for chat: "${chatGuid}"; text: ${awaiter.text}; tempGuid: ${tempGuid ?? "N/A"}`);
        Server().messageManager.add(awaiter);

        // Remove the chat from the typing cache
        if (Server().typingCache.includes(chatGuid)) {
            Server().typingCache = Server().typingCache.filter(c => c !== chatGuid);

            try {
                // Try to stop typing for that chat. Don't await so we don't block the message
                await Server().privateApi.chat.stopTyping(chatGuid);
            } catch {
                // Do nothing
            }
        }

        // Try to send the iMessage
        let sentMessage = null;
        if (method === "apple-script") {
            // Attempt to send the message
            await ActionHandler.sendMessage(chatGuid, message ?? "", null);
            sentMessage = await awaiter.promise;
        } else if (method === "private-api") {
            sentMessage = await MessageInterface.sendMessagePrivateApi({
                chatGuid,
                message,
                attributedBody,
                subject,
                effectId,
                selectedMessageGuid,
                partIndex,
                ddScan
            });
        } else {
            throw new Error(`Invalid send method: ${method}`);
        }

        return sentMessage;
    }

    /**
     * Sends a message by executing the sendMessage AppleScript
     *
     * @param chatGuid The GUID for the chat
     * @param message The message to send
     * @param attachmentName The name of the attachment to send (optional)
     * @param attachment The bytes (buffer) for the attachment
     *
     * @returns The command line response
     */
    static async sendAttachmentSync({
        chatGuid,
        attachmentPath,
        attachmentName = null,
        attachmentGuid = null,
        method = "apple-script",
        attributedBody = null,
        subject = null,
        effectId = null,
        selectedMessageGuid = null,
        partIndex = 0,
        isAudioMessage = false
    }: SendAttachmentParams): Promise<Message> {
        if (!chatGuid) throw new Error("No chat GUID provided");

        // Copy the attachment to a more permanent storage
        const newPath = FileSystem.copyAttachment(attachmentPath, attachmentName, method);

        Server().log(`Sending attachment "${attachmentName}" to ${chatGuid}`, "debug");

        // Make sure messages is open
        if (method === "apple-script") {
            await FileSystem.startMessages();
        }

        // Since we convert mp3s to cafs we need to correct the name for the awaiter
        let aName = attachmentName;
        if (aName !== null && aName.endsWith(".mp3") && isAudioMessage) {
            aName = `${aName.substring(0, aName.length - 4)}.caf`;
        }

        // We need offsets here due to iMessage's save times being a bit off for some reason
        const now = new Date(new Date().getTime() - 10000).getTime(); // With 10 second offset
        const awaiter = new MessagePromise({
            chatGuid: chatGuid,
            text: aName,
            isAttachment: true,
            sentAt: now,
            tempGuid: attachmentGuid
        });

        // Add the promise to the manager
        Server().log(
            `Adding await for chat: "${chatGuid}"; attachment: ${aName}; tempGuid: ${attachmentGuid ?? "N/A"}`
        );
        Server().messageManager.add(awaiter);

        let sentMessage = null;
        if (method === "apple-script") {
            // Attempt to send the attachment
            await ActionHandler.sendMessage(chatGuid, "", newPath, isAudioMessage);
            sentMessage = await awaiter.promise;
        } else if (method === "private-api") {
            sentMessage = await MessageInterface.sendAttachmentPrivateApi({
                chatGuid,
                filePath: newPath,
                attributedBody,
                subject,
                effectId,
                selectedMessageGuid,
                partIndex,
                isAudioMessage
            });

            try {
                // Wait for the promise so that we can confirm the message was sent.
                // Wrapped in a try/catch because if the private API returned a sentMessage,
                // we know it sent, and maybe it just took a while (longer than the timeout).
                // Only wait for the promise if it's not sent yet.
                if (sentMessage && !sentMessage.isSent) {
                    sentMessage = await awaiter.promise;
                }
            } catch (e) {
                if (sentMessage) {
                    Server().log("Attachment sent via Private API, but message match failed", "debug");
                } else {
                    throw e;
                }
            }
        } else {
            throw new Error(`Invalid send method: ${method}`);
        }

        // Delete the attachment.
        // Only if below Monterey. On Monterey, we store attachments
        // within the iMessage App Support directory. When AppleScript sees this
        // it _does not_ copy the attachment to a permanent location.
        // This means that if we delete the attachment, it won't be downloadable anymore.
        if (!isMinMonterey && method === "apple-script") {
            fs.unlink(newPath, _ => null);
        }

        return sentMessage;
    }

    static async sendMessagePrivateApi({
        chatGuid,
        message,
        attributedBody = null,
        subject = null,
        effectId = null,
        selectedMessageGuid = null,
        partIndex = 0,
        ddScan = false
    }: SendMessagePrivateApiParams) {
        checkPrivateApiStatus();
        const result = await Server().privateApi.message.send(
            chatGuid,
            message,
            attributedBody ?? null,
            subject ?? null,
            effectId ?? null,
            selectedMessageGuid ?? null,
            partIndex ?? 0,
            ddScan ?? false
        );

        if (!result?.identifier) {
            throw new Error("Failed to send message!");
        }

        const maxWaitMs = 60000;
        const retMessage = await resultAwaiter({
            maxWaitMs,
            getData: async _ => {
                return await Server().iMessageRepo.getMessage(result.identifier, true, false);
            }
        });

        if (!retMessage) {
            throw new Error(`Failed to send message! Message not found in database after ${maxWaitMs / 1000} seconds!`);
        }

        return retMessage;
    }

    static async sendAttachmentPrivateApi({
        chatGuid,
        filePath,
        attributedBody = null,
        subject = null,
        effectId = null,
        selectedMessageGuid = null,
        partIndex = 0,
        isAudioMessage = false
    }: SendAttachmentPrivateApiParams): Promise<Message> {
        checkPrivateApiStatus();

        if (filePath.endsWith(".mp3") && isAudioMessage) {
            try {
                const newPath = `${filePath.substring(0, filePath.length - 4)}.caf`;
                await FileSystem.convertMp3ToCaf(filePath, newPath);
                filePath = newPath;
            } catch (ex) {
                Server().log("Failed to convert MP3 to CAF!", "warn");
            }
        }

        const result = await Server().privateApi.attachment.send({
            chatGuid,
            filePath,
            attributedBody,
            subject,
            effectId,
            selectedMessageGuid,
            partIndex,
            isAudioMessage
        });

        if (!result?.identifier) {
            throw new Error("Failed to send attachment!");
        }

        const maxWaitMs = 60000;
        const retMessage = await resultAwaiter({
            maxWaitMs,
            getData: async _ => {
                return await Server().iMessageRepo.getMessage(result.identifier, true, false);
            }
        });

        // Check if the name changed
        if (!retMessage) {
            throw new Error(
                `Failed to send attachment! Attachment not found in database after ${maxWaitMs / 1000} seconds!`
            );
        }

        return retMessage;
    }

    static async unsendMessage({ chatGuid, messageGuid, partIndex = 0 }: UnsendMessageParams) {
        checkPrivateApiStatus();
        if (!isMinVentura) throw new Error("Unsend message is only supported on macOS Ventura and newer!");

        const msg = await Server().iMessageRepo.getMessage(messageGuid, false, false);
        const currentEditDate = msg?.dateEdited ?? 0;
        await Server().privateApi.message.unsend({ chatGuid, messageGuid, partIndex: partIndex ?? 0 });

        const maxWaitMs = 30000;
        const retMessage = await resultAwaiter({
            maxWaitMs,
            getData: async _ => {
                return await Server().iMessageRepo.getMessage(messageGuid, true, false);
            },
            // Keep looping if the edit date is less than or equal to the original edit date.
            extraLoopCondition: data => {
                return (data?.dateEdited ?? 0) <= currentEditDate;
            }
        });

        // Check if the name changed
        if (!retMessage) {
            throw new Error(`Failed to unsend message! Message not edited (unsent) after ${maxWaitMs / 1000} seconds!`);
        }

        return retMessage;
    }

    static async editMessage({
        chatGuid,
        messageGuid,
        editedMessage,
        backwardsCompatMessage,
        partIndex = 0
    }: EditMessageParams) {
        checkPrivateApiStatus();
        if (!isMinVentura) throw new Error("Unsend message is only supported on macOS Ventura and newer!");

        const msg = await Server().iMessageRepo.getMessage(messageGuid, false, false);
        const currentEditDate = msg?.dateEdited ?? 0;
        await Server().privateApi.message.edit({
            chatGuid,
            messageGuid,
            editedMessage,
            backwardsCompatMessage,
            partIndex: partIndex ?? 0
        });

        const maxWaitMs = 30000;
        const retMessage = await resultAwaiter({
            maxWaitMs,
            getData: async _ => {
                return await Server().iMessageRepo.getMessage(messageGuid, true, false);
            },
            // Keep looping if the edit date is less than or equal to the original edit date.
            extraLoopCondition: data => {
                return (data?.dateEdited ?? 0) <= currentEditDate;
            }
        });

        // Check if the name changed
        if (!retMessage) {
            throw new Error(`Failed to edit message! Message not edited after ${maxWaitMs / 1000} seconds!`);
        }

        return retMessage;
    }

    static async sendReaction({
        chatGuid,
        message,
        reaction,
        tempGuid = null,
        partIndex = 0
    }: SendReactionParams): Promise<Message> {
        checkPrivateApiStatus();

        // Rebuild the selected message text to make it what the reaction text
        // would be in the database
        const parsedReaction = requireReaction(reaction);
        requireReactionCapability(parsedReaction, Server().privateApi.capabilities.customEmojiReactions);
        if (!Number.isInteger(partIndex) || partIndex < 0) throw new Error("Invalid message part index.");
        if (parsedReaction.reactionEmoji) {
            const selected = await Server().iMessageRepo.getMessage(message.guid, true, false);
            if (!selected?.chats?.some(chat => chat.guid === chatGuid)) {
                throw new Error("Selected message does not belong to the requested chat.");
            }
        }
        const prefix = (reaction as string).startsWith("-")
            ? negativeReactionTextMap[reaction as string]
            : reactionTextMap[reaction as string];

        // If the message text is just the invisible char, we know it's probably just an attachment
        const text = message.universalText(false) ?? "";
        const isOnlyMedia = text.length === 1 && text === invisibleMediaChar;

        // Default the message to the other message surrounded by greek quotes
        let msg = `“${text}”`;

        let matchingGuid: string = null;
        for (const i of message?.attributedBody ?? []) {
            for (const run of i?.runs ?? []) {
                if (run?.attributes?.__kIMMessagePartAttributeName === partIndex) {
                    matchingGuid = run?.attributes?.__kIMFileTransferGUIDAttributeName;
                    if (matchingGuid) break;
                }
            }

            if (matchingGuid) break;
        }

        // If we have a matching guid, we know it's an attachment. Pull it out
        let attachment = (message?.attachments ?? []).find(a => a.guid === matchingGuid);

        // If we don't have a match, but we know it's media only, select the first attachment
        if (!attachment && isOnlyMedia && isNotEmpty(message.attachments)) {
            attachment = message?.attachments[0];
        }

        // If we have an attachment, build the message based on the mime type
        if (attachment) {
            const mime = attachment.mimeType ?? "";
            const uti = attachment.uti ?? "";
            if (mime.startsWith("image")) {
                msg = `an image`;
            } else if (mime.startsWith("video")) {
                msg = `a movie`;
            } else if (mime.startsWith("audio") || uti.includes("coreaudio-format")) {
                msg = `an audio message`;
            } else {
                msg = `an attachment`;
            }
        } else {
            // If there is no attachment, use the message text
            msg = msg.replace(invisibleMediaChar, "");
        }

        // Build the final message to match on
        const messageText = parsedReaction.reactionEmoji ? "" : `${prefix} ${msg}`;

        // We need offsets here due to iMessage's save times being a bit off for some reason
        const now = new Date(new Date().getTime() - 10000).getTime(); // With 10 second offset
        const awaiter = new MessagePromise({
            chatGuid,
            text: messageText,
            isAttachment: false,
            sentAt: now,
            tempGuid,
            emojiReaction: parsedReaction.reactionEmoji
                ? {
                      targetGuid: message.guid,
                      partIndex,
                      reaction: parsedReaction
                  }
                : undefined
        });
        Server().messageManager.add(awaiter);

        // Send the reaction
        let result: TransactionResult;
        try {
            result = await Server().privateApi.message.react(chatGuid, message.guid, reaction, partIndex ?? 0);
        } catch (error) {
            if (parsedReaction.reactionEmoji) await awaiter.reject("Emoji reaction was not confirmed.");
            throw error;
        }
        if (!result?.identifier) {
            if (parsedReaction.reactionEmoji) await awaiter.reject("Emoji reaction was not confirmed.");
            throw new Error("Failed to send reaction! No message GUID returned.");
        } else {
            Server().log(`Reaction sent with Message GUID: ${result.identifier}`, "debug");
        }

        const maxWaitMs = 60000;
        let retMessage = await resultAwaiter({
            maxWaitMs,
            getData: async _ => {
                const sent = await Server().iMessageRepo.getMessage(result.identifier, true, false);
                // A helper identifier can reflect lastSentMessage; never confirm an unrelated or stale GUID.
                if (parsedReaction.reactionEmoji) {
                    if (
                        !matchesEmojiReaction(sent, message.guid, partIndex, parsedReaction) ||
                        !sent?.chats?.some(chat => chat.guid === chatGuid) ||
                        sent.dateCreated.getTime() < now
                    ) {
                        return null;
                    }
                }
                return sent;
            }
        });

        // If we can't get the message via the transaction, try via the promise
        if (!retMessage) {
            retMessage = await awaiter.promise;
        }

        // Check if the name changed
        if (!retMessage) {
            throw new Error(
                `Failed to send reaction! Message not found in database after ${maxWaitMs / 1000} seconds!`
            );
        }

        // Return the message
        return retMessage;
    }

    static async notifySilencedMessage(chat: Chat, message: Message): Promise<Message> {
        checkPrivateApiStatus();
        if (!isMinMonterey) {
            throw new Error("Notifing silenced messages is only supported on macOS Monterey and newer!");
        }

        if (message.didNotifyRecipient) {
            throw new Error("The recipient has already been notified of this message!");
        }

        // Notify the recipient
        await Server().privateApi.message.notify(chat.guid, message.guid);

        // Wait for the didNotifyRecipient flag to be true
        const maxWaitMs = 30000;
        const retMessage = await resultAwaiter({
            maxWaitMs,
            // Keep looping until the didNotifyRecipient flag is true
            dataLoopCondition: (data: Message) => !data.didNotifyRecipient,
            getData: async _ => {
                return await Server().iMessageRepo.getMessage(message.guid, true, false);
            }
        });

        return retMessage;
    }

    static async getEmbeddedMedia(chat: Chat, message: Message): Promise<string | null> {
        checkPrivateApiStatus();
        if (!message.isDigitalTouch && !message.isHandwritten) {
            throw new Error("Message must be a digital touch message or handwritten message!");
        }

        // Get the media path via the private api
        const transaction = await Server().privateApi.message.getEmbeddedMedia(chat.guid, message.guid);
        if (!transaction?.data?.path) return null;
        const mediaPath = transaction.data.path.replace("file://", "");
        return mediaPath;
    }

    static async sendMultipart({
        chatGuid,
        attributedBody = null,
        subject = null,
        effectId = null,
        selectedMessageGuid = null,
        partIndex = 0,
        parts = [],
        ddScan = false
    }: SendMultipartTextParams): Promise<Message> {
        checkPrivateApiStatus();
        if (!chatGuid) throw new Error("No chat GUID provided");
        if (isEmpty(parts)) throw new Error("No parts provided");

        // Copy the attachments with the correct name.
        // And delete the original
        for (let i = 0; i < parts.length; i++) {
            if (parts[i].attachment) {
                const baseDir = FileSystem.getAttachmentDirectory("private-api");
                const currentPath = path.join(baseDir, parts[i].attachment);
                const newPath = FileSystem.copyAttachment(currentPath, parts[i].name, "private-api");
                parts[i].filePath = newPath;
            }
        }

        // Send the message
        const result = await Server().privateApi.message.sendMultipart(
            chatGuid,
            parts,
            attributedBody ?? null,
            subject ?? null,
            effectId ?? null,
            selectedMessageGuid ?? null,
            partIndex ?? 0,
            ddScan ?? false
        );

        if (!result?.identifier) {
            throw new Error("Failed to send message!");
        }

        const maxWaitMs = 60000;
        const retMessage = await resultAwaiter({
            maxWaitMs,
            getData: async _ => {
                return await Server().iMessageRepo.getMessage(result.identifier, true, false);
            }
        });

        // Check if the name changed
        if (!retMessage) {
            throw new Error(`Failed to send message! Message not found in database after ${maxWaitMs / 1000} seconds!`);
        }

        return retMessage;
    }

    static async searchMessagesPrivateApi({
        chatGuid = null,
        withChats = false,
        withAttachments = false,
        offset = 0,
        limit = 100,
        sort = "DESC",
        before = null,
        after = null,
        where = [],
        query,
        matchType = "contains"
    }: {
        chatGuid?: string,
        withChats?: boolean,
        withAttachments?: boolean,
        offset?: number,
        limit?: number,
        sort?: "ASC" | "DESC",
        before?: number | null,
        after?: number | null,
        where?: DBWhereItem[],
        query: string,
        matchType?: "contains" | "exact"
    }): Promise<[Message[], number]> {
        checkPrivateApiStatus();

        const result = await Server().privateApi.message.search(query, matchType);
        if (result?.data?.error) {
            throw new Error(`Failed to search messages: ${result.data.error}`);
        }

        const results = result.data.results ?? [];
        if (isEmpty(results)) return [[], 0];

        // Modify the WHERE clause to include the message GUIDs
        where.push({
            statement: `message.guid IN (:...guids)`,
            args: {
                guids: results
            }
        });

        // Fetch the info for the message by GUID
        return await Server().iMessageRepo.getMessages({
            chatGuid,
            withChats,
            withAttachments,
            offset,
            limit,
            sort,
            before,
            after,
            where: where ?? []
        });
    }
}
