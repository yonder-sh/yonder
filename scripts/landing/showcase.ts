/**
 * The landing page's showcase trip: "East Asia in autumn", the demo route of
 * `src/features/landing/demo-route.ts` (Tokyo, Kyoto, Seoul, Busan, Taipei,
 * Hanoi, Hội An, Saigon; 26 nights) as a full trip for the product
 * screenshots (`pnpm landing:shots`). Everything is invented: four
 * travellers (Alex, the owner, is alex@example.com; Maya is the demo seed's
 * maya@example.com; Jonas and Priya are placeholders), their ratings, days,
 * flights, to-dos, notes, expenses and budgets (the tables are in
 * `showcase-data.ts`). The photos are the public domain (CC0) ones from
 * `seed/media` (see its LICENSES.md).
 *
 * Only for an isolated env: refuses production and the main stack. Re-running
 * replaces the trip.
 *
 *   pnpm agent:env <n> …; set -a; . .data/agent-<n>.env; set +a
 *   tsx scripts/landing/showcase.ts
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { getDb, type Tx } from "../../src/db/db.server";
import {
	attachments,
	budgetLines,
	expensePaymentPayers,
	expensePayments,
	expenseShares,
	expenses,
	listItems,
	trips,
	user,
	yjsDocuments,
} from "../../src/db/schema";
import type { Scenario } from "../../src/lib/engine/__fixtures__/demo";
import {
	DEMO_MEMBERS,
	flightDetails,
	scenario,
} from "../../src/lib/engine/__fixtures__/demo";
import type { TripGraph } from "../../src/lib/engine/types";
import { mainTargets } from "../../src/lib/main-targets";
import { markdownToYdoc } from "../../src/lib/notes/ydoc.server";
import type { Priority } from "../../src/lib/schemas/enums";
import { DEMO_USERS, writeTripGraph } from "../../src/server/fixture.server";
import { freshKeys } from "../../src/server/position.server";
import { hardDeleteTripsWhere } from "../../src/server/trip-delete.server";
import { run } from "../lib/lifecycle";
import {
	deleteTripObjects,
	type ProcessedPhoto,
	processPhoto,
	uploadPhoto,
} from "../sheet/lib/media";
import {
	COUNTRY_EXTRA,
	DAYS,
	FIRST_DATE,
	FLIGHTS,
	GROUND,
	NODES,
	PHOTOS,
	RATINGS,
	REUSE,
} from "./showcase-data";

export const SHOWCASE_SLUG = "east-asia";
export const SHOWCASE_NAME = "East Asia in autumn";
export const SHOWCASE_OWNER = {
	email: "alex@example.com",
	firstName: "Alex",
	lastName: "Morgan",
};

const ROOT = path.resolve(import.meta.dirname, "../..");

// ---- the travellers and their ratings ---------------------------------------

const M = {
	alex: DEMO_MEMBERS.dennis,
	maya: uuidv7(),
	jonas: uuidv7(),
	priya: uuidv7(),
} as const;
const WHO = [M.alex, M.maya, M.jonas, M.priya];
const P: Record<string, Priority> = {
	M: "must",
	R: "really_want",
	W: "want",
	S: "sure_why_not",
	E: "meh",
	N: "nah",
};

function buildGraph(): TripGraph & Pick<Scenario, "N" | "I" | "D"> {
	const sc = scenario({
		firstDate: FIRST_DATE,
		defaultTz: "Asia/Tokyo",
		settings: { currency: "USD" },
		nodes: NODES.map(([key, parent, type, name, lat, lng, category]) => ({
			key,
			parent: parent || null,
			type,
			name,
			at: [lat, lng] as [number, number],
			...(category ? { category } : {}),
			...(COUNTRY_EXTRA[key] ?? {}),
		})),
		days: DAYS.map((d) => ({
			...(d.night ? { night: d.night } : {}),
			...(d.start ? { start: d.start } : {}),
			items: d.items.map(([k, node, min, pin, title]) => ({
				k,
				...(node ? { node } : {}),
				...(title ? { title } : {}),
				min: min ?? 60,
				...(pin ? { pin } : {}),
			})),
		})),
		legs: [
			...FLIGHTS.map((f) => ({
				from: f.from,
				to: f.to,
				mode: "flight" as const,
				dep: [f.dep, f.a[1]] as [string, string],
				arr: [f.arr, f.b[1]] as [string, string],
				details: flightDetails({
					number: f.number,
					from: {
						iata: f.a[0],
						tz: f.a[1],
						country: f.a[2],
						at: [...f.a[3]] as [number, number],
					},
					to: {
						iata: f.b[0],
						tz: f.b[1],
						country: f.b[2],
						at: [...f.b[3]] as [number, number],
					},
					dep: f.dep,
					arr: f.arr,
				}),
			})),
			...GROUND.map((g) => ({
				from: g.from,
				to: g.to,
				mode: g.mode,
				min: g.min,
				isEdited: true,
			})),
		],
	});
	const g = sc.graph;
	// Keep the demo nodes this trip uses (and every ancestor of what's kept).
	const byId = new Map(g.nodes.map((n) => [n.id, n]));
	const keep = new Set<string>();
	const add = (id: string | null | undefined) => {
		for (
			let n = id ? byId.get(id) : undefined;
			n;
			n = n.parentId ? byId.get(n.parentId) : undefined
		)
			keep.add(n.id);
	};
	for (const k of [...REUSE, ...NODES.map((n) => n[0])]) add(sc.N[k]);
	g.nodes = g.nodes.filter((n) => keep.has(n.id));
	// Ratings.
	for (const n of g.nodes) {
		const key = Object.entries(sc.N).find(([, id]) => id === n.id)?.[0];
		const r = key ? RATINGS[key] : undefined;
		n.priorities = {};
		if (!r) continue;
		[...r].forEach((c, i) => {
			const p = P[c];
			const who = WHO[i];
			if (p && who) n.priorities[who] = p;
		});
	}
	g.members = [
		{
			id: M.alex,
			userId: "user-alex",
			status: "active",
			role: "owner",
			name: "Alex",
			color: 0,
		},
		{
			id: M.maya,
			userId: null,
			status: "placeholder",
			role: "editor",
			name: "Maya",
			color: 1,
		},
		{
			id: M.jonas,
			userId: null,
			status: "placeholder",
			role: "editor",
			name: "Jonas",
			color: 2,
		},
		{
			id: M.priya,
			userId: null,
			status: "placeholder",
			role: "editor",
			name: "Priya",
			color: 3,
		},
	];
	return Object.assign(g, { N: sc.N, I: sc.I, D: sc.D });
}

// ---- the rest: lists, notes, money ------------------------------------------------

async function writeExtras(
	tx: Tx,
	tripId: string,
	id: (x: string) => string,
	g: ReturnType<typeof buildGraph>,
	by: string,
	photos: Map<string, { node: string; caption: string; p: ProcessedPhoto }>,
) {
	const node = (k: string) => id(g.N[k] as string);
	const item = (k: string) => id(g.I[k] as string);
	const mem = (m: string) => id(m);
	const todos: {
		text: string;
		kind: "due" | "opens" | "on";
		date: string;
		time?: string;
		tz?: string;
		node?: string;
		done?: boolean;
		note?: string;
	}[] = [
		{
			text: "Ghibli Museum tickets go on sale",
			kind: "opens",
			date: "2026-09-10",
			time: "10:00",
			tz: "Asia/Tokyo",
			node: "ghibli",
			done: true,
		},
		{
			text: "Book Shinkansen seats to Kyoto",
			kind: "opens",
			date: "2026-09-22",
			time: "10:00",
			tz: "Asia/Tokyo",
			node: "tokyoSt",
			done: true,
		},
		{
			text: "Book the KTX to Busan",
			kind: "opens",
			date: "2026-09-30",
			time: "07:00",
			tz: "Asia/Seoul",
			node: "seoulSt",
		},
		{
			text: "Night train seats, Hanoi → Da Nang",
			kind: "opens",
			date: "2026-10-08",
			time: "08:00",
			tz: "Asia/Ho_Chi_Minh",
			node: "hanoiSt",
		},
		{
			text: "Reserve the Ha Long Bay cruise",
			kind: "due",
			date: "2026-10-05",
			node: "halongCruise",
		},
		{
			text: "Taipei 101 sunset slot",
			kind: "opens",
			date: "2026-10-18",
			time: "09:00",
			tz: "Asia/Taipei",
			node: "taipei101",
		},
		{ text: "eSIMs for everyone", kind: "due", date: "2026-10-14" },
		{
			text: "Check Vietnam's visa-free days",
			kind: "due",
			date: "2026-09-30",
			done: true,
		},
	];
	const shopping = [
		{ text: "Matcha for home", node: "tokichi", price: 2400, cur: "JPY" },
		{
			text: "Chef's knife from Kappabashi",
			node: "kappabashi2",
			price: 18000,
			cur: "JPY",
		},
		{
			text: "Linen shirt from a Hội An tailor",
			node: "oldTown",
			price: 900000,
			cur: "VND",
		},
	];
	const keys = freshKeys(todos.length + shopping.length);
	let k = 0;
	for (const t of todos)
		await tx.insert(listItems).values({
			tripId,
			...(t.node ? { nodeId: node(t.node) } : {}),
			list: "todo",
			text: t.text,
			dueKind: t.kind,
			dueDate: t.date,
			dueTime: t.time ?? null,
			dueTz: t.time ? (t.tz ?? null) : null,
			status: t.done ? "done" : "open",
			doneAt: t.done ? new Date("2026-09-24T10:00:00Z") : null,
			doneBy: t.done ? by : null,
			position: keys[k++] as string,
			createdBy: by,
		});
	for (const s of shopping)
		await tx.insert(listItems).values({
			tripId,
			nodeId: node(s.node),
			list: "shopping",
			text: s.text,
			priceAmount: s.price,
			priceCurrency: s.cur,
			position: keys[k++] as string,
			createdBy: by,
		});

	const notes: { name: string; md: string; nodeId?: string }[] = [
		{
			name: `trip/${tripId}/root`,
			md: [
				"# East Asia in autumn",
				"",
				"Four countries, 26 nights, one carry-on each. We move every few days, so pack light.",
				"",
				"- Passports valid until at least May 2027",
				"- IC cards: **Suica** in Japan, **T-money** in Korea, **EasyCard** in Taiwan",
				"- Grab works in Vietnam; keep some cash for markets",
				"- Download offline maps for every city before we fly",
				"",
				"Leaves turn in Kyoto around mid-November, so the gardens will be early. Worth it anyway.",
			].join("\n"),
		},
		{
			name: `trip/${tripId}/node/${node("kyoto")}`,
			nodeId: node("kyoto"),
			md: "Fushimi Inari before 8 to beat the crowds. The machiya has bikes for us.",
		},
	];
	for (const n of notes) {
		const snap = markdownToYdoc(n.md);
		await tx.insert(yjsDocuments).values({
			name: n.name,
			tripId,
			nodeId: n.nodeId ?? null,
			state: snap.state,
			json: snap.json,
			markdown: snap.markdown,
			plainText: snap.plainText,
			updatedBy: by,
		});
	}

	// Money: USD at home; four people split most things equally.
	const RATE: Record<string, number> = {
		JPY: 0.0067,
		KRW: 0.00073,
		VND: 0.000039,
	};
	const fx = (cur: string, minor: number, date: string) => ({
		homeCurrency: "USD",
		homeAmountMinor: Math.round(minor * (RATE[cur] as number) * 100),
		fxRate: RATE[cur] as number,
		fxDate: date,
		fxSource: "currency-api",
		fxManual: false,
	});
	const spend: {
		title: string;
		cat: "lodging" | "transport" | "food_drink" | "activities" | "shopping";
		cur: string;
		amount: number;
		paidBy: string;
		paidOn: string;
		tz: string;
		node?: string;
		item?: string;
	}[] = [
		{
			title: "Machiya in Gion, 4 nights",
			cat: "lodging",
			cur: "JPY",
			amount: 168_000,
			paidBy: M.alex,
			paidOn: "2026-08-02",
			tz: "America/Los_Angeles",
			node: "machiya",
		},
		{
			title: "Shinkansen to Kyoto",
			cat: "transport",
			cur: "JPY",
			amount: 55_760,
			paidBy: M.maya,
			paidOn: "2026-09-22",
			tz: "America/Los_Angeles",
			item: "tokyoSt1",
		},
		{
			title: "Hotel in Seoul, 4 nights",
			cat: "lodging",
			cur: "KRW",
			amount: 1_280_000,
			paidBy: M.jonas,
			paidOn: "2026-08-10",
			tz: "Europe/Berlin",
			node: "seoul",
		},
		{
			title: "Ghibli Museum tickets",
			cat: "activities",
			cur: "JPY",
			amount: 4_000,
			paidBy: M.priya,
			paidOn: "2026-09-10",
			tz: "America/Los_Angeles",
			node: "ghibli",
		},
		{
			title: "Dinner at Gwangjang Market",
			cat: "food_drink",
			cur: "KRW",
			amount: 96_000,
			paidBy: M.maya,
			paidOn: "2026-10-26",
			tz: "Asia/Seoul",
			node: "gwangjang",
		},
		{
			title: "Cooking class",
			cat: "activities",
			cur: "VND",
			amount: 3_200_000,
			paidBy: M.priya,
			paidOn: "2026-09-18",
			tz: "Asia/Kolkata",
			node: "cooking",
		},
		{
			title: "Ha Long Bay cruise",
			cat: "activities",
			cur: "VND",
			amount: 14_800_000,
			paidBy: M.jonas,
			paidOn: "2026-09-20",
			tz: "Europe/Berlin",
			node: "halongCruise",
		},
	];
	for (const s of spend) {
		const e = uuidv7();
		const pay = uuidv7();
		await tx.insert(expenses).values({
			id: e,
			tripId,
			...(s.node ? { nodeId: node(s.node) } : {}),
			...(s.item ? { itemId: item(s.item) } : {}),
			title: s.title,
			category: s.cat,
			amountMinor: s.amount,
			currency: s.cur,
			...fx(s.cur, s.amount, s.paidOn),
			splitMode: "equal",
			createdBy: by,
		});
		await tx.insert(expensePayments).values({
			id: pay,
			tripId,
			expenseId: e,
			paidAt: new Date(`${s.paidOn}T12:00:00Z`),
			paidTz: s.tz,
			currency: s.cur,
			amountMinor: s.amount,
			...fx(s.cur, s.amount, s.paidOn),
			method: "card",
			createdBy: by,
		});
		await tx.insert(expensePaymentPayers).values({
			tripId,
			paymentId: pay,
			memberId: mem(s.paidBy),
			amountMinor: s.amount,
		});
		await tx
			.insert(expenseShares)
			.values(WHO.map((m) => ({ tripId, expenseId: e, memberId: mem(m) })));
	}
	await tx.insert(budgetLines).values([
		{ tripId, amountMinor: 1_600_000, createdBy: by },
		{ tripId, nodeId: node("japan"), amountMinor: 600_000, createdBy: by },
		{ tripId, category: "food_drink", amountMinor: 350_000, createdBy: by },
	]);

	const pos = freshKeys(photos.size);
	let i = 0;
	for (const [attId, { node: n, caption, p }] of photos) {
		await tx.insert(attachments).values({
			id: attId,
			tripId,
			nodeId: node(n),
			kind: "photo",
			status: "ready",
			visibility: "everyone",
			storageKey: `trips/${tripId}/${attId}/`,
			mime: p.contentType,
			sizeBytes: p.sizeBytes,
			width: p.width,
			height: p.height,
			thumbhash: p.thumbhash,
			caption,
			position: pos[i++] as string,
			createdBy: by,
		});
	}
}

/** alex@example.com (Alex Morgan), created on first use. */
async function ownerUser(tx: Tx): Promise<string> {
	const [existing] = await tx
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, SHOWCASE_OWNER.email));
	if (existing) return existing.id;
	const [row] = await tx
		.insert(user)
		.values({
			id: randomBytes(16).toString("hex"),
			...SHOWCASE_OWNER,
			name: `${SHOWCASE_OWNER.firstName} ${SHOWCASE_OWNER.lastName}`,
			emailVerified: true,
			isAnonymous: false,
		})
		.returning({ id: user.id });
	if (!row) throw new Error("showcase: user insert returned no row");
	return row.id;
}

export async function seedShowcase(): Promise<{
	tripId: string;
	slug: string;
}> {
	if (process.env.NODE_ENV === "production")
		throw new Error("refusing to seed with NODE_ENV=production");
	const main = mainTargets(process.env);
	if (main.length)
		throw new Error(`refusing the main stack: ${main.join("; ")}`);
	const db = getDb();
	const g = buildGraph();

	const photos = new Map<
		string,
		{ node: string; caption: string; p: ProcessedPhoto }
	>();
	for (const [node, file, caption] of PHOTOS)
		photos.set(uuidv7(), {
			node,
			caption,
			p: await processPhoto(path.join(ROOT, "seed/media", file), "image/jpeg"),
		});

	const old = await db
		.select({ id: trips.id })
		.from(trips)
		.where(eq(trips.slug, SHOWCASE_SLUG));
	const res = await db.transaction(async (tx) => {
		await hardDeleteTripsWhere(tx, { slug: SHOWCASE_SLUG });
		const [maya] = await tx
			.select({ id: user.id })
			.from(user)
			.where(eq(user.email, DEMO_USERS.maya.email));
		if (!maya)
			throw new Error(
				"run the dev seed first (pnpm db:seed): maya@example.com",
			);
		// Alex, the owner in the screenshots, is a user of their own: the demo
		// seed's users stay as the e2e specs expect them.
		const owner = await ownerUser(tx);
		const w = await writeTripGraph(tx, g, {
			slug: SHOWCASE_SLUG,
			name: SHOWCASE_NAME,
			ownerUserId: owner,
			memberUsers: { [M.maya]: maya.id },
			remapIds: true,
		});
		await writeExtras(tx, w.tripId, w.id, g, owner, photos);
		return { tripId: w.tripId };
	});
	for (const o of old) await deleteTripObjects(o.id).catch(() => 0);
	for (const [attId, { p }] of photos) await uploadPhoto(res.tripId, attId, p);
	return { tripId: res.tripId, slug: SHOWCASE_SLUG };
}

if (process.argv[1]?.endsWith("showcase.ts"))
	run("landing:showcase", async () => {
		const r = await seedShowcase();
		console.log(
			`[landing:showcase] trip "${SHOWCASE_NAME}" at /t/${r.slug} (${r.tripId})`,
		);
	});
