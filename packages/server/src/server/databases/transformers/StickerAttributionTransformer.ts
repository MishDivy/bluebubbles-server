import type { ValueTransformer } from "typeorm";
import { decodeStickerAttribution } from "@server/api/stickerMetadata";

export const StickerAttributionTransformer: ValueTransformer = {
    from: decodeStickerAttribution,
    to: _ => null
};
