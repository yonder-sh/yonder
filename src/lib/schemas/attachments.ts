/** JSONB shape of `attachments.meta` (SPEC §6.3 `{ fetch, aspect, license, licenseUrl, source }`, §17.3). */
import { z } from "zod";
import { HttpUrl } from "./common";

export const AttachmentMeta = z.looseObject({
	/** Link previews: `unfetched` for imported links until `refreshLinkMeta` runs (§13.4). */
	fetch: z.enum(["unfetched", "ok", "failed"]).optional(),
	/** width / height, for embeds without stored dimensions (TikTok and Shorts are 9:16). */
	aspect: z.number().positive().optional(),
	/** Imported photos: attribution (§17.3). */
	license: z.string().optional(),
	licenseUrl: HttpUrl.optional(),
	/** Where it came from, e.g. `wikimedia` or `web`. */
	source: z.string().optional(),
	sourceUrl: HttpUrl.optional(),
});
export type AttachmentMeta = z.infer<typeof AttachmentMeta>;
