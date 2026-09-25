/**
 * The whole import (SPEC §17.3): load → plan → (Photon for misses) → zones →
 * photos to S3 → ONE transaction → after the commit: old S3 prefix, autofill
 * jobs, the report and the graph dump. The QA seed calls it with hooks that
 * patch the plan and add its fixtures inside the same transaction.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { type Db, getDb, type Tx } from "@/db/db.server";
import { indexGraph } from "@/lib/engine/graph-index";
import { suggestPair } from "@/lib/engine/suggest";
import type { LegTarget } from "@/lib/schemas/targets";
import { cleanSlugBase } from "@/lib/trip-slug";
import { loadGraphForServer } from "@/server/graph.server";
import { enqueue } from "@/server/live/jobs.server";
import { autofillDedupeId } from "@/server/live/outbox.server";
import { freshTripSlug } from "@/server/trip-slug.server";
import { tzAt } from "@/server/tz.server";
import type { ImportArgs } from "./args";
import { describeArgs } from "./args";
import { loadSheetData } from "./data";
import { photonSearch } from "./geocode";
import {
	deleteTripObjects,
	mapLimit,
	type ProcessedPhoto,
	photoPath,
	processPhoto,
	uploadPhoto,
} from "./media";
import { buildPlan, type ImportPlan } from "./plan";
import { type RunFacts, renderReport } from "./report";
import { clearSlug, findOrCreateUser, writePlan } from "./write";

export type ImportHooks = {
	/** Change the plan before anything is written (the QA seed's F4 edits). */
	patchPlan?: (plan: ImportPlan) => void;
	/** Map member keys to users (the QA seed links Audrey). Runs inside the transaction. */
	memberUsers?: (tx: Tx) => Promise<{ audrey?: string }>;
	/** Extra writes in the SAME transaction, after the plan is written. */
	extend?: (
		tx: Tx,
		ctx: { plan: ImportPlan; ownerUserId: string },
	) => Promise<void>;
	log?: (line: string) => void;
	/**
	 * Keep `--slug` as the whole address, with no random tail: the QA seed's
	 * fixed `asia-2027`, which the e2e specs open. Every other import gets an
	 * unguessable address (`asia-2027-k7m2qxw9`, `src/lib/trip-slug.ts`), and
	 * a re-import (`--replace`) keeps the replaced trip's.
	 */
	fixedSlug?: boolean;
};

export type ImportResult = {
	tripId: string;
	slug: string;
	ownerUserId: string;
	replacedTripId: string | null;
	plan: ImportPlan;
	report: string;
	facts: RunFacts;
};

export async function runImport(
	a: ImportArgs,
	hooks: ImportHooks = {},
	db: Db = getDb(),
): Promise<ImportResult> {
	const t0 = Date.now();
	const log = hooks.log ?? ((s: string) => console.log(`[sheet:import] ${s}`));
	if (process.env.NODE_ENV === "production" && a.owner.endsWith(".test"))
		throw new Error(
			"refusing to import a .test owner with NODE_ENV=production",
		);

	const data = loadSheetData({
		dataDir: a.dataDir,
		mediaDir: a.media ? a.mediaDir : null,
		overridesFile: a.overrides,
	});
	const plan = buildPlan(data, {
		slug: a.slug,
		name: a.name,
		start: a.start,
		day1: a.day1,
		end: a.end,
		actionTimeline: a.actionTimeline,
		flightRows: a.flightRows,
	});
	hooks.patchPlan?.(plan);
	log(
		`planned ${plan.nodes.length} nodes, ${plan.items.length} items, ${plan.legs.length} legs, ${plan.listItems.length} list items, ${plan.attachments.length} attachments`,
	);

	// Photon only for nodes with no hint and no override (SPEC §17.3 step 2).
	const fallbacks: string[] = [];
	const misses = plan.nodes.filter(
		(n) => n.geo === "none" && n.type !== "country",
	);
	if (misses.length && a.geocodeFallback && !a.dryRun) {
		const byId = new Map(plan.nodes.map((n) => [n.id, n]));
		for (const n of misses) {
			const up: string[] = [];
			for (
				let p = n.parentId ? byId.get(n.parentId) : undefined;
				p;
				p = p.parentId ? byId.get(p.parentId) : undefined
			)
				up.push(p.name);
			const hit = await photonSearch([n.name, ...up.slice(0, 2)].join(", "));
			if (!hit) continue;
			n.lat = hit.lat;
			n.lng = hit.lng;
			n.geo = "hint";
			n.details.geocodeConfidence = "low";
			fallbacks.push(
				`${n.name} (${n.source}) → Photon "${hit.label}" ${hit.lat.toFixed(4)},${hit.lng.toFixed(4)}`,
			);
		}
	}
	// Zones: the hint's, else a lookup from the coordinates (§7.4).
	for (const n of plan.nodes)
		if (n.lat !== null && n.lng !== null && !n.tz)
			n.tz = await tzAt(n.lat, n.lng);

	const flags = describeArgs(a);
	if (a.dryRun) {
		const facts: RunFacts = {
			owner: { email: a.owner, created: false },
			tripId: plan.trip.id,
			slug: a.slug,
			replacedTripId: null,
			photosUploaded: 0,
			geocodeFallbacks: fallbacks,
			autofillJobs: null,
			dryRun: true,
			durationMs: Date.now() - t0,
			flags,
		};
		const report = renderReport(plan, facts);
		writeReport(a.report, report);
		return {
			tripId: plan.trip.id,
			slug: a.slug,
			ownerUserId: "",
			replacedTripId: null,
			plan,
			report,
			facts,
		};
	}

	// Photos first (under the NEW trip id, so nothing can clash); a failed
	// transaction deletes them again.
	const photos = new Map<string, ProcessedPhoto>();
	const photoRows = plan.attachments.filter(
		(x) => x.kind === "photo" && x.photo,
	);
	if (photoRows.length) {
		log(`processing ${photoRows.length} photos…`);
		await mapLimit(photoRows, 4, async (att) => {
			const f = att.photo as NonNullable<typeof att.photo>;
			try {
				const p = await processPhoto(
					photoPath(a.mediaDir, f.file),
					f.contentType,
				);
				await uploadPhoto(plan.trip.id, att.id, p);
				photos.set(att.id, p);
			} catch (e) {
				plan.report.unmatched.push(
					`photo ${f.file}: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		});
	}

	let ownerUserId = "";
	let ownerCreated = false;
	let replacedTripId: string | null = null;
	try {
		await db.transaction(async (tx) => {
			const owner = await findOrCreateUser(tx, {
				email: a.owner,
				firstName: a.ownerFirst,
				lastName: a.ownerLast,
			});
			ownerUserId = owner.id;
			ownerCreated = owner.created;
			const replaced = await clearSlug(tx, a.slug, a.replace, ownerUserId);
			replacedTripId = replaced?.id ?? null;
			if (!hooks.fixedSlug) {
				const address = replaced?.slugTail
					? { slug: replaced.slug, slugTail: replaced.slugTail }
					: await freshTripSlug(tx, cleanSlugBase(a.slug) || "trip");
				plan.trip.slug = address.slug;
				plan.trip.slugTail = address.slugTail;
			}
			const memberUsers = (await hooks.memberUsers?.(tx)) ?? {};
			await writePlan(tx, plan, { ownerUserId, photos, memberUsers });
			await hooks.extend?.(tx, { plan, ownerUserId });
		});
	} catch (e) {
		if (photos.size) await deleteTripObjects(plan.trip.id).catch(() => 0);
		throw e;
	}
	log(
		`committed trip ${plan.trip.slug} (${plan.trip.id})${replacedTripId ? `, replacing ${replacedTripId}` : ""}`,
	);
	if (replacedTripId) {
		const n = await deleteTripObjects(replacedTripId).catch(() => 0);
		if (n) log(`deleted ${n} objects of the replaced trip`);
	}

	const graph = await loadGraphForServer(db, plan.trip.id);
	let autofillJobs: number | null = null;
	if (a.autofill && graph && graph.trip.settings.autofillLegs !== false) {
		autofillJobs = await enqueueAutofillAll(graph).catch((e) => {
			log(`autofill not queued: ${e instanceof Error ? e.message : String(e)}`);
			return null;
		});
	}
	if (a.dumpGraph && graph) {
		mkdirSync(path.dirname(a.dumpGraph), { recursive: true });
		writeFileSync(a.dumpGraph, `${JSON.stringify(graph, null, "\t")}\n`);
		log(`graph written to ${a.dumpGraph}`);
	}

	const facts: RunFacts = {
		owner: { email: a.owner, created: ownerCreated },
		tripId: plan.trip.id,
		slug: plan.trip.slug,
		replacedTripId,
		photosUploaded: photos.size,
		geocodeFallbacks: fallbacks,
		autofillJobs,
		dryRun: false,
		durationMs: Date.now() - t0,
		flags,
	};
	const report = renderReport(plan, facts);
	writeReport(a.report, report);
	return {
		tripId: plan.trip.id,
		slug: plan.trip.slug,
		ownerUserId,
		replacedTripId,
		plan,
		report,
		facts,
	};
}

/**
 * `--remove`: hard-deletes the live trip at `slug` (everything cascades) and
 * its S3 prefix: the whole address, or its readable part for a trip that
 * `ownerEmail` imported (`clearSlug`). Returns the removed trip id, or null
 * when there was none.
 */
export async function removeImport(
	slug: string,
	db: Db = getDb(),
	ownerEmail?: string,
): Promise<string | null> {
	const trip = await db.transaction(async (tx) => {
		const owner = ownerEmail
			? ((
					await tx.execute(
						sql`select id from "user" where email = ${ownerEmail.toLowerCase()}`,
					)
				).rows[0] as { id: string } | undefined)
			: undefined;
		return clearSlug(tx, slug, true, owner?.id ?? null);
	});
	if (trip) await deleteTripObjects(trip.id).catch(() => 0);
	return trip?.id ?? null;
}

function writeReport(file: string | null, text: string): void {
	if (!file) return;
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text);
}

/**
 * SPEC §17.3 step 11 / §10.9: after the commit, every unset pair whose
 * suggestion is a walk or transit, plus the stay legs of nights with a stay,
 * go on the BullMQ `autofill` queue (deduplicated per target).
 */
async function enqueueAutofillAll(
	graph: NonNullable<Awaited<ReturnType<typeof loadGraphForServer>>>,
): Promise<number> {
	const ix = indexGraph(graph);
	const targets: LegTarget[] = [];
	for (const p of ix.pairs) {
		const row = ix.legByPair.get(p.key);
		if (row?.mode || row?.isEdited) continue;
		const s = suggestPair(ix, p.fromItemId, p.toItemId);
		if (s.mode !== "walk" && s.mode !== "transit") continue;
		targets.push({
			kind: "pair",
			fromItemId: p.fromItemId,
			toItemId: p.toItemId,
		});
	}
	const days = graph.days;
	for (let i = 0; i < days.length; i++) {
		const d = days[i];
		if (!d?.nightNodeId) continue;
		targets.push({ kind: "stay", dayId: d.id, end: "end" });
		const next = days[i + 1];
		if (next) targets.push({ kind: "stay", dayId: next.id, end: "start" });
	}
	for (const target of targets)
		await enqueue(
			"autofill",
			"autofill",
			{ tripId: graph.trip.id, target },
			{ dedupeId: autofillDedupeId(target) },
		);
	return targets.length;
}
