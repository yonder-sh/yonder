/**
 * WP-Places server functions (SPEC §13.3; EXTENSIONS §1.4, §10). Every
 * provider call is bound to a trip, needs the `searchPlaces` capability
 * (editors and suggesters, never viewers: anonymous sign-in is cheap, so
 * nothing that costs money is open to them), and is rate-limited per user.
 * Google is used when `GOOGLE_MAPS_API_KEY` is set, else Photon (OSM).
 * Google photo NAMES never reach the client (§14.1): only indexes and
 * attributions, served through `/api/places/photo`.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/db.server";
import { nodes } from "@/db/schema";
import { fromGooglePeriods } from "@/lib/engine/hours-parse";
import { NodeType } from "@/lib/schemas/enums";
import type { NodeDetails } from "@/lib/schemas/nodes";
import { requireTripCapability } from "@/server/authz/access.server";
import { withNamedUser, withUser } from "@/server/authz/middleware";
import { fail } from "@/server/authz/session.server";
import { cacheGet, cacheSet, rateLimit } from "@/server/cache.server";
import { updateNodeCore } from "@/server/cores/nodes.server";
import { getEnv } from "@/server/env.server";
import { requireNode, tripOf } from "@/server/perms.server";
import {
	requireDirect,
	requireEditOnly,
} from "@/server/proposals/proposable.server";
import { actorOf } from "@/server/proposals/types";
import { mutationMeta, withTripTx } from "@/server/tx.server";
import { findDuplicate } from "./lib/filing";
import {
	GOOGLE_PLACE_ID_RE,
	googlePhotos,
	type PlacePhoto,
	type PlacePreview,
	type PlaceProvider,
	type PlaceSearchResult,
	type PreviewCore,
} from "./lib/providers";
import {
	crumbOf,
	DETAILS_PER_MIN,
	filingNodes,
	previewFor,
	resolveUrl,
	SEARCH_PER_MIN,
	type SharedLinkSpot,
	withFiling,
} from "./server/places.server";
import {
	googleEnterprise,
	googlePhotoMeta,
	googleSearch,
	photonReverse,
	photonSearch,
	provider,
} from "./server/providers.server";

export type { PlacePhoto, PlacePreview, PlaceProvider, PlaceSearchResult };

export const searchPlaces = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(
		z
			.object({
				tripId: z.uuid(),
				q: z.string().trim().min(1).max(200),
				sessionToken: z.string().max(100),
				bias: z
					.object({
						lat: z.number().min(-90).max(90),
						lng: z.number().min(-180).max(180),
						radiusM: z.number().min(100).max(50_000).optional(),
					})
					.optional(),
				level: NodeType.optional(),
			})
			.strict(),
	)
	.handler(
		async ({
			data,
			context,
		}): Promise<{
			provider: PlaceProvider;
			results: PlaceSearchResult[];
		}> => {
			await requireDirect("searchPlaces", data.tripId, context.user);
			await rateLimit(`places:search:${context.user.id}`, SEARCH_PER_MIN);
			const p = provider();
			const opts = { bias: data.bias, level: data.level };
			const results =
				p === "google"
					? await googleSearch(data.q, data.sessionToken, opts)
					: await photonSearch(data.q, opts);
			return { provider: p, results };
		},
	);

export const getPlacePreview = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(
		z
			.object({
				tripId: z.uuid(),
				provider: z.enum(["google", "photon"]),
				ref: z.string().min(1).max(300),
				sessionToken: z.string().max(100),
			})
			.strict(),
	)
	.handler(async ({ data, context }): Promise<PlacePreview> => {
		await requireDirect("getPlacePreview", data.tripId, context.user);
		await rateLimit(`places:details:${context.user.id}`, DETAILS_PER_MIN);
		if (data.provider !== provider())
			return fail("VALIDATION", "That result expired. Search again.");
		const core = await previewFor(data.provider, data.ref, data.sessionToken);
		return withFiling(core, await filingNodes(data.tripId));
	});

export const reverseGeocode = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(
		z
			.object({
				tripId: z.uuid(),
				lat: z.number().min(-90).max(90),
				lng: z.number().min(-180).max(180),
			})
			.strict(),
	)
	.handler(async ({ data, context }): Promise<PlacePreview | null> => {
		await requireDirect("reverseGeocode", data.tripId, context.user);
		await rateLimit(`places:details:${context.user.id}`, DETAILS_PER_MIN);
		const core = await photonReverse(data.lat, data.lng);
		if (!core) return null;
		// A dropped pin keeps the exact spot the user chose.
		return withFiling(
			{ ...core, lat: data.lat, lng: data.lng },
			await filingNodes(data.tripId),
		);
	});

const ENTERPRISE_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;

export const getPlaceMoreDetails = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(z.object({ nodeId: z.uuid() }).strict())
	.handler(async ({ data, context }): Promise<{ updatedAt: string }> => {
		const tripId = (await tripOf("nodes", data.nodeId)) ?? fail("NOT_FOUND");
		const access = await requireEditOnly(
			"getPlaceMoreDetails",
			tripId,
			context.user,
		);
		const [node] = await db
			.select({
				googlePlaceId: nodes.googlePlaceId,
				details: nodes.details,
				updatedAt: nodes.updatedAt,
			})
			.from(nodes)
			.where(
				and(
					eq(nodes.id, data.nodeId),
					eq(nodes.tripId, tripId),
					isNull(nodes.deletedAt),
				),
			);
		if (!node) return fail("NOT_FOUND");
		if (!getEnv().GOOGLE_MAPS_API_KEY)
			return fail("VALIDATION", "More details need a Google key.");
		if (!node.googlePlaceId)
			return fail("VALIDATION", "This place isn't linked to Google.");
		const fetched = node.details.enterpriseFetchedAt
			? Date.parse(node.details.enterpriseFetchedAt)
			: 0;
		if (Date.now() - fetched < ENTERPRISE_REFRESH_MS)
			return { updatedAt: node.updatedAt.toISOString() };
		await rateLimit(`places:details:${context.user.id}`, DETAILS_PER_MIN);
		const g = await googleEnterprise(node.googlePlaceId);
		const now = new Date().toISOString();
		const patch: NodeDetails = {
			enterpriseFetchedAt: now,
			...(g.websiteUri && /^https?:\/\//.test(g.websiteUri)
				? { website: g.websiteUri.slice(0, 2000) }
				: {}),
			...(g.nationalPhoneNumber
				? { phone: g.nationalPhoneNumber.slice(0, 60) }
				: {}),
			...(typeof g.rating === "number" ? { rating: g.rating } : {}),
			...(typeof g.userRatingCount === "number"
				? { ratingCount: g.userRatingCount }
				: {}),
			...(g.priceLevel ? { priceLevel: g.priceLevel.slice(0, 60) } : {}),
		};
		const weekdays = g.regularOpeningHours?.weekdayDescriptions;
		if (weekdays?.length)
			patch.hours = {
				weekdayDescriptions: weekdays.slice(0, 14).map((s) => s.slice(0, 200)),
			};
		const periods = g.regularOpeningHours?.periods;
		// E1: Google hours never overwrite manual ones.
		if (periods?.length && node.details.openingHours?.source !== "manual") {
			patch.openingHours = fromGooglePeriods(
				periods
					.filter((p) => p.open?.day !== undefined && p.open.hour !== undefined)
					.map((p) => ({
						open: {
							day: p.open?.day as number,
							hour: p.open?.hour as number,
							minute: p.open?.minute,
						},
						...(p.close?.day !== undefined && p.close.hour !== undefined
							? {
									close: {
										day: p.close.day,
										hour: p.close.hour,
										minute: p.close.minute,
									},
								}
							: {}),
					})),
				now,
			);
			patch.openingHoursFetchedAt = now;
		}
		return withTripTx(
			tripId,
			(tx, out) =>
				updateNodeCore(
					tx,
					out,
					{ nodeId: data.nodeId, patch: { details: patch } },
					{
						access,
						user: context.user,
						actor: actorOf(context.user),
						inputRedacted: false,
						dryRun: false,
					},
				),
			mutationMeta(access, context.user),
		).then((r) => ({ updatedAt: r.updatedAt }));
	});

export const getPlacePhotos = createServerFn({ method: "GET" })
	.middleware([withUser])
	.validator(z.object({ nodeId: z.uuid() }).strict())
	.handler(async ({ data, context }): Promise<PlacePhoto[]> => {
		const { tripId } = await requireNode(data.nodeId, "viewer", context.user);
		if (!getEnv().GOOGLE_MAPS_API_KEY) return [];
		const [node] = await db
			.select({ googlePlaceId: nodes.googlePlaceId })
			.from(nodes)
			.where(and(eq(nodes.id, data.nodeId), eq(nodes.tripId, tripId)));
		const placeId = node?.googlePlaceId;
		if (!placeId || !GOOGLE_PLACE_ID_RE.test(placeId)) return [];
		const cached = await cacheGet<PlacePhoto[]>("gphotometa", placeId);
		if (cached) return cached;
		await rateLimit(`places:photos:${context.user.id}`, 60);
		const photos = googlePhotos(await googlePhotoMeta(placeId));
		await cacheSet(["gphotometa", placeId], photos, 55 * 60);
		return photos;
	});

// ---------------------------------------------------------------------------
// E8: resolveSharedLink (WP-Places resolver for WP-Home's ShareInbox)
// ---------------------------------------------------------------------------

export type SharedLinkResolution = {
	preview: PlacePreview | null;
	existing?: { nodeId: string; name: string; crumb: string };
	/** What the URL named, for "Couldn't find that place — search" prefill. */
	query?: string;
};

export const resolveSharedLink = createServerFn({ method: "GET" })
	.middleware([withNamedUser])
	.validator(
		z
			.object({
				tripId: z.uuid(),
				url: z.url().max(2000),
			})
			.strict(),
	)
	.handler(async ({ data, context }): Promise<SharedLinkResolution> => {
		await requireTripCapability(data.tripId, "searchPlaces", context.user);
		await rateLimit(`places:share:${context.user.id}`, 20);
		const all = await filingNodes(data.tripId);
		const cacheKey = Buffer.from(data.url).toString("base64url").slice(0, 180);
		type Cached = {
			core: PreviewCore | null;
			query?: string;
			link?: SharedLinkSpot;
		};
		let hit = await cacheGet<Cached>("sharedlink2", provider(), cacheKey);
		if (!hit) {
			hit = await resolveUrl(data.url, context.user.id);
			await cacheSet(["sharedlink2", provider(), cacheKey], hit, 24 * 60 * 60);
		}
		const { core, query, link } = hit;
		if (!core) return { preview: null, ...(query ? { query } : {}) };
		const preview = withFiling(core, all);
		// The duplicate check always runs live (never cached). The link's own
		// spot counts too: the provider's match for it can sit a block away
		// from the trip's pin (SHR-07: Itoya, 110 m).
		const dup = findDuplicate(all, {
			googlePlaceId: core.provider === "google" ? core.ref : null,
			osmRef: preview.osmRef ?? null,
			name: core.name,
			lat: core.lat,
			lng: core.lng,
			also: link ?? null,
		});
		return {
			preview,
			...(dup
				? {
						existing: {
							nodeId: dup.id,
							name: dup.name,
							crumb: crumbOf(all, dup.id),
						},
					}
				: {}),
		};
	});
