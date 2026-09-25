/** JSONB shape of `nodes.details` (SPEC §6.5; EXTENSIONS §4.1). */
import { z } from "zod";
import { mentionsAsText } from "@/lib/notes/mentions";
import { HttpUrl } from "./common";
import { OpeningHours } from "./hours";

/** The largest serialized `details` a write may store (SECURITY §1/§3 caps). */
export const MAX_NODE_DETAILS_BYTES = 16_384;

const Short = z.string().max(200);

/**
 * Loose on purpose: provider extras survive a round trip. Every known field
 * has a max, and the whole object is capped at MAX_NODE_DETAILS_BYTES
 * serialized, so unknown keys can't be used to store megabytes per node.
 * NO Google photo names: Google forbids caching them and they expire (§14.1).
 */
const NODE_DETAILS_SHAPE = {
	openHoursText: z.string().max(1000).optional(),
	hours: z
		.object({
			weekdayDescriptions: z.array(z.string().max(200)).max(14),
		})
		.optional(),
	/** E1: manual or Google hours (never over manual). */
	openingHours: OpeningHours.optional(),
	openingHoursFetchedAt: z.iso.datetime().optional(),
	website: HttpUrl.max(2000).optional(),
	phone: z.string().max(60).optional(),
	rating: z.number().min(0).max(5).optional(),
	ratingCount: z.number().int().min(0).optional(),
	priceLevel: z.string().max(60).optional(),
	googleMapsUri: HttpUrl.max(2000).optional(),
	primaryType: Short.optional(),
	/** Sheet Cities "Days". */
	plannedDays: z.number().min(0).max(366).optional(),
	enterpriseFetchedAt: z.iso.datetime().optional(),
	bookAhead: z.boolean().optional(),
	/** Airports (§7.9). */
	iata: z.string().length(3).optional(),
	/** Import (§17.3). */
	geocodeConfidence: z.enum(["high", "medium", "low"]).optional(),
};

export const NodeDetails = z
	.looseObject(NODE_DETAILS_SHAPE)
	.refine((d) => JSON.stringify(d).length <= MAX_NODE_DETAILS_BYTES, {
		message: `details are larger than ${MAX_NODE_DETAILS_BYTES} bytes`,
	});
export type NodeDetails = z.infer<typeof NodeDetails>;

type NullableShape<S extends z.ZodRawShape> = {
	[K in keyof S]: z.ZodOptional<z.ZodNullable<S[K]>>;
};

/**
 * `updateNode({ patch: { details } })`: merged into the stored details, and a
 * `null` value DELETES that key (e.g. clearing `plannedDays`). The merged
 * result must still pass `NodeDetails` (and its size cap).
 */
export const NodeDetailsPatch = z.looseObject(
	Object.fromEntries(
		Object.entries(NODE_DETAILS_SHAPE).map(([k, v]) => [
			k,
			(v as z.ZodType).nullable().optional(),
		]),
	) as NullableShape<typeof NODE_DETAILS_SHAPE>,
);
export type NodeDetailsPatch = z.infer<typeof NodeDetailsPatch>;

/** `nodes.bbox`: `[west, south, east, north]` in degrees. */
export const BBox = z.tuple([
	z.number().min(-180).max(180),
	z.number().min(-90).max(90),
	z.number().min(-180).max(180),
	z.number().min(-90).max(90),
]);
export type BBox = z.infer<typeof BBox>;

/**
 * ADDENDUM §10 rating comments (PLAN-R3-03): at most 280 characters AS READ,
 * however many mentions — a mention token `[@Audrey Tester](mention:<uuid>)`
 * counts as its "@Audrey Tester". The stored text, tokens included, has room
 * for a comment of nothing but mentions (about 50 characters each):
 * `node_priorities_comment_ck` allows RATING_COMMENT_STORED_MAX.
 */
export const RATING_COMMENT_MAX = 280;
export const RATING_COMMENT_STORED_MAX = 8000;

export const RatingComment = z
	.string()
	.trim()
	.max(RATING_COMMENT_STORED_MAX)
	.superRefine((v, ctx) => {
		if (mentionsAsText(v).length > RATING_COMMENT_MAX)
			ctx.addIssue({
				code: "too_big",
				origin: "string",
				maximum: RATING_COMMENT_MAX,
				inclusive: true,
				input: v,
				message: `A comment is at most ${RATING_COMMENT_MAX} characters.`,
			});
	});
