import type { ValidTapback, ValidRemoveTapback } from "@server/types";

export const classicReactions = [
    "love",
    "like",
    "dislike",
    "laugh",
    "emphasize",
    "question",
    "-love",
    "-like",
    "-dislike",
    "-laugh",
    "-emphasize",
    "-question"
];

export type Reaction = {
    reactionType: ValidTapback | ValidRemoveTapback | "emoji" | "-emoji";
    reactionEmoji?: string;
};

// Plain digits have the Emoji property too, so validate the complete emoji cluster.
const emojiComponent = String.raw`(?:\p{Emoji_Modifier_Base}\uFE0F?\p{Emoji_Modifier}?|\p{Extended_Pictographic}\uFE0F?)`;
const emojiPattern = new RegExp(
    String.raw`^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}|${emojiComponent}(?:\u200D${emojiComponent})*)$`,
    "u"
);
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export function parseReaction(value: unknown): Reaction | null {
    if (typeof value !== "string" || value.length > 129) return null;
    if (classicReactions.includes(value)) {
        return { reactionType: value as ValidTapback | ValidRemoveTapback };
    }

    const removed = value.startsWith("-");
    const emoji = removed ? value.substring(1) : value;
    if (emoji.length > 128 || !emojiPattern.test(emoji) || [...segmenter.segment(emoji)].length !== 1) return null;
    return { reactionType: removed ? "-emoji" : "emoji", reactionEmoji: emoji };
}

export function requireReaction(value: unknown): Reaction {
    const reaction = parseReaction(value);
    if (!reaction) throw new Error("Reaction must be a classic tapback or a single emoji.");
    return reaction;
}

export function requireReactionCapability(reaction: Reaction, supported: boolean): void {
    if (reaction.reactionEmoji && !supported) {
        throw new Error("Custom emoji reactions are not supported by the connected Private API Helper.");
    }
}

export function matchesEmojiReaction(
    message: {
        associatedMessageGuid?: string;
        associatedMessageType?: string;
        associatedMessageEmoji?: string;
        isFromMe?: boolean;
    },
    targetGuid: string,
    partIndex: number,
    reaction: Reaction
): boolean {
    const expectedPart =
        message?.associatedMessageGuid === `p:${partIndex}/${targetGuid}` ||
        (partIndex === 0 && message?.associatedMessageGuid === `bp:${targetGuid}`);
    return (
        !!message?.isFromMe &&
        expectedPart &&
        message.associatedMessageType === reaction.reactionType &&
        message.associatedMessageEmoji === reaction.reactionEmoji
    );
}
