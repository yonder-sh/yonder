/**
 * Saved in the app (`./server/saved.server.ts`), the caller's own rows only:
 *
 * - `listSavedLinks`: everything in Saved, newest first.
 * - `saveSharedLink`: a link from the share sheet, a paste or `/share?url=`
 *   (the device's `clientId` makes a retried upload save once).
 * - `markSavedAdded`: it went into a trip (the trip's own functions did the
 *   adding and checked the role); it stays in Saved, marked so.
 * - `setSavedPlace`: file some under a country (and city), or Unsorted.
 * - `searchSavedPlaces`: cities for the Where picker (Photon).
 * - `saveTripMedia`: a trip gallery's photo, video or link into my Saved.
 * - `deleteSavedLinks` / `restoreSavedLinks`: delete some, and Undo.
 * - `startSavedUpload`, `signSavedUploadParts`, `completeSavedUpload`: shared
 *   photos and videos into Saved (`./server/files.server.ts`).
 * - `attachSavedFiles`: a saved share's photos onto a place (edit access).
 * - `addSavedToTrip` / `undoSavedToTrip`: many into a trip as ideas (a
 *   suggester's as suggestions), and Undo (`./server/to-trip.server.ts`).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "@/db/db.server";
import { IMAGE_TYPES, VIDEO_TYPES } from "@/features/media/media-kinds";
import { photonSearch } from "@/features/places/server/providers.server";
import { roleAtLeast } from "@/lib/auth/roles";
import { withAccount, withNamedUser } from "@/server/authz/middleware";
import { fail } from "@/server/authz/session.server";
import { loadTripAccess } from "@/server/authz/trip-access.server";
import { rateLimit, rateLimitPer } from "@/server/cache.server";
import { shareInput } from "@/server/shortcut.server";
import {
	attachSaved,
	completeSavedFile,
	type StartedFile,
	signSavedFileParts,
	startSavedFile,
} from "./server/files.server";
import { filingOf, saveFromTrip } from "./server/from-trip.server";
import {
	deleteSaved,
	listSaved,
	markAdded,
	restoreSaved,
	SAVED,
	saveLink,
	setSavedWhere,
} from "./server/saved.server";
import {
	type AddedToTrip,
	addSavedToTrip as addToTrip,
	BULK_MAX,
	undoSavedToTrip as undoToTrip,
} from "./server/to-trip.server";
import type { SavedLink } from "./types";

export type { AddedToTrip, SavedLink };

export const listSavedLinks = createServerFn({ method: "GET" })
	.middleware([withAccount])
	.handler(
		async ({ context }): Promise<SavedLink[]> => listSaved(db, context.user.id),
	);

export const saveSharedLink = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(
		z
			.object({
				url: z.string().max(SAVED.textMax).nullish(),
				text: z.string().max(SAVED.textMax).nullish(),
				title: z.string().max(SAVED.titleMax).nullish(),
				clientId: z
					.string()
					.regex(/^[A-Za-z0-9_-]{1,64}$/)
					.nullish(),
			})
			.strict(),
	)
	.handler(async ({ data, context }): Promise<{ id: string }> => {
		await rateLimitPer(`saved:${context.user.id}`, 120, 3600);
		// The same reading as the Shortcut's: the link, and the words around it.
		const share = shareInput(
			data.url && data.text?.includes(data.url)
				? data.text
				: [data.url, data.text].filter(Boolean).join(" "),
		);
		if (!share.url && !share.text) return fail("VALIDATION", "nothing to save");
		const { id } = await saveLink(db, context.user.id, {
			...share,
			title: data.title?.trim() || null,
			clientId: data.clientId ?? null,
		});
		return { id };
	});

export const markSavedAdded = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(
		z
			.object({
				id: z.uuid(),
				tripId: z.uuid(),
				nodeId: z.uuid().nullable(),
			})
			.strict(),
	)
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		const access = await loadTripAccess(data.tripId, context.user.id);
		if (!access || !roleAtLeast(access.role, "suggester"))
			return fail("NOT_FOUND");
		if (
			!(await markAdded(db, context.user.id, data.id, {
				tripId: data.tripId,
				nodeId: data.nodeId,
			}))
		)
			return fail("NOT_FOUND");
		// Not filed yet: under the trip's city and country for that place.
		const where = await filingOf(data.tripId, data.nodeId);
		if (where)
			await setSavedWhere(db, context.user.id, [data.id], where, {
				onlyUnsorted: true,
			});
		return { ok: true };
	});

const Ids = z
	.object({ ids: z.array(z.uuid()).min(1).max(SAVED.list) })
	.strict();

export const deleteSavedLinks = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(Ids)
	.handler(
		async ({ data, context }): Promise<{ ids: string[] }> => ({
			ids: await deleteSaved(db, context.user.id, data.ids),
		}),
	);

export const restoreSavedLinks = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(Ids)
	.handler(
		async ({ data, context }): Promise<{ ids: string[] }> => ({
			ids: await restoreSaved(db, context.user.id, data.ids),
		}),
	);

const Coord = z.number().min(-180).max(180).nullable();

export const setSavedPlace = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(
		z
			.object({
				ids: z.array(z.uuid()).min(1).max(SAVED.list),
				where: z
					.object({
						countryCode: z.string().regex(/^[A-Za-z]{2}$/),
						city: z
							.object({
								name: z.string().trim().min(1).max(120),
								lat: Coord,
								lng: Coord,
							})
							.strict()
							.nullish(),
					})
					.strict()
					.nullable(),
			})
			.strict(),
	)
	.handler(
		async ({ data, context }): Promise<{ ids: string[] }> => ({
			ids: await setSavedWhere(db, context.user.id, data.ids, data.where),
		}),
	);

/** A city the Where picker found. */
export type CityHit = {
	name: string;
	/** "Kyoto Prefecture, Japan". */
	subtitle: string;
	countryCode: string;
	lat: number;
	lng: number;
};

export const searchSavedPlaces = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(z.object({ q: z.string().trim().min(2).max(100) }).strict())
	.handler(async ({ data, context }): Promise<CityHit[]> => {
		await rateLimit(`places:search:${context.user.id}`, 90);
		const found = await photonSearch(data.q, { level: "city" });
		const seen = new Set<string>();
		return found.flatMap((r) => {
			if (!r.countryCode || r.lat === undefined || r.lng === undefined)
				return [];
			const k = `${r.countryCode}|${r.title.toLowerCase()}`;
			if (seen.has(k)) return [];
			seen.add(k);
			return [
				{
					name: r.title,
					subtitle: r.subtitle,
					countryCode: r.countryCode,
					lat: r.lat,
					lng: r.lng,
				},
			];
		});
	});

export const saveTripMedia = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(z.object({ tripId: z.uuid(), attachmentId: z.uuid() }).strict())
	.handler(
		async ({ data, context }): Promise<{ id: string; created: boolean }> => {
			await rateLimitPer(`saved:${context.user.id}`, 120, 3600);
			return saveFromTrip(context.user, data);
		},
	);

const ClientId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const startSavedUpload = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(
		z
			.object({
				clientId: ClientId,
				text: z.string().max(SAVED.textMax).nullish(),
				title: z.string().max(SAVED.titleMax).nullish(),
				position: z.number().int().min(0).max(9),
				type: z.enum([...IMAGE_TYPES, ...VIDEO_TYPES]),
				size: z.number().int().positive(),
			})
			.strict(),
	)
	.handler(async ({ data, context }): Promise<StartedFile> => {
		await rateLimitPer(`upload:${context.user.id}`, 120, 60);
		return startSavedFile(context.user.id, {
			...data,
			text: data.text ?? null,
			title: data.title ?? null,
		});
	});

export const signSavedUploadParts = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(
		z
			.object({
				id: z.uuid(),
				parts: z.array(z.number().int().min(1).max(10_000)).min(1).max(32),
			})
			.strict(),
	)
	.handler(
		async ({
			data,
			context,
		}): Promise<{ urls: { part: number; url: string }[] }> => {
			await rateLimitPer(`upload-parts:${context.user.id}`, 600, 60);
			return {
				urls: await signSavedFileParts(context.user.id, data.id, data.parts),
			};
		},
	);

export const completeSavedUpload = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(
		z
			.object({
				id: z.uuid(),
				width: z.number().int().positive().max(100_000).optional(),
				height: z.number().int().positive().max(100_000).optional(),
				durationSec: z.number().nonnegative().max(86_400).optional(),
				takenAt: z.iso.datetime({ offset: true }).optional(),
				gps: z
					.object({
						lat: z.number().min(-90).max(90),
						lng: z.number().min(-180).max(180),
					})
					.strict()
					.optional(),
			})
			.strict(),
	)
	.handler(
		async ({ data, context }): Promise<{ savedId: string; done: boolean }> =>
			completeSavedFile(context.user.id, { ...data, fileId: data.id }),
	);

export const attachSavedFiles = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(
		z
			.object({ savedId: z.uuid(), tripId: z.uuid(), nodeId: z.uuid() })
			.strict(),
	)
	.handler(
		async ({ data, context }): Promise<{ count: number }> =>
			attachSaved(context.user, data),
	);

export const addSavedToTrip = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(
		z
			.object({
				tripId: z.uuid(),
				ids: z.array(z.uuid()).min(1).max(BULK_MAX),
			})
			.strict(),
	)
	.handler(
		async ({ data, context }): Promise<AddedToTrip> =>
			addToTrip(context.user, data),
	);

export const undoSavedToTrip = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(
		z
			.object({
				tripId: z.uuid(),
				added: z
					.array(z.object({ savedId: z.uuid(), nodeId: z.uuid() }).strict())
					.max(SAVED.list),
				made: z.array(z.uuid()).max(SAVED.list),
				proposals: z
					.array(z.uuid())
					.max(SAVED.list * 3)
					.optional(),
			})
			.strict(),
	)
	.handler(
		async ({ data, context }): Promise<{ ok: true }> =>
			undoToTrip(context.user, data),
	);
