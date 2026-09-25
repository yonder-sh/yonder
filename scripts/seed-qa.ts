/**
 * The QA seed (SPEC §17.2; qa/SCENARIOS §1 and TI-3): the Asia 2027 import
 * (`--replace`) for dennis@asia2027.test (Dennis Tester) with the fixture
 * dates Sat 2 Oct → Fri 5 Nov 2027, plus in the SAME transaction:
 *   - Audrey (audrey@asia2027.test) linked to the imported placeholder (editor),
 *     Kai (kai@asia2027.test, viewer) and Eve (eve@asia2027.test, no access);
 *   - the F2 trips "Phu Quoc detour" (Audrey's, Dennis views) and "Delete me"
 *     (Dennis's, Audrey edits);
 *   - the F3 ★ nodes and the F4 timeline fixtures (`scripts/sheet/lib/qa.ts`);
 *   - no link sharing: the trip keeps its fixed address `/t/asia-2027` (no
 *     random tail), and e2e specs let guests in with `POST /api/test/link`
 *     (`pinTestLink`) before they open it;
 *   - EXTENSIONS §2.1: Maya (maya@asia2027.test) as a suggester member and
 *     three expenses (one private, Dennis's), home currency USD.
 * After the commit, Maya's two suggestions go through the real propose path
 * (dry run, base, summary). Then, when the app answers on APP_URL, it signs
 * every handle in through the API and writes a Playwright storageState to
 * `e2e/.auth/qa-<handle>.json` (the `qa-` prefix keeps them apart from the e2e global setup's `dev.json`/`maya.json`).
 *
 *   N pnpm db:seed:qa [--no-media] [--no-autofill] [--no-auth] [--slug asia-2027]
 *
 * It refuses to replace a trip at the slug that another owner holds: once the
 * real import (`pnpm sheet:import`, same slug) is in a database, seed the QA
 * copy next to it with `--slug asia-2027-qa`.
 *
 * Refuses NODE_ENV=production. Re-running replaces everything it made.
 */
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { and, eq, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { getDb, type Tx } from "../src/db/db.server";
import {
	expensePaymentPayers,
	expensePayments,
	expenseShares,
	expenses,
	nodes,
	tripDays,
	tripMembers,
	trips,
	user,
} from "../src/db/schema";
import { slugify } from "../src/lib/engine/tree";
import { closeQueues } from "../src/server/live/jobs.server";
import { run } from "./lib/lifecycle";
import { DEFAULTS } from "./sheet/lib/args";
import { freshKeysPure } from "./sheet/lib/keys";
import {
	applyQaFixtures,
	loadAirports,
	QA_DATES,
	QA_USERS,
	type QaHandle,
	qaMoney,
	qaProposals,
} from "./sheet/lib/qa";
import { proposeAs } from "./sheet/lib/qa-propose";
import { runImport } from "./sheet/lib/run";
import {
	findOrCreateUser,
	hardDeleteTrip,
	type Person,
} from "./sheet/lib/write";

const USAGE =
	"usage: pnpm db:seed:qa [--no-media] [--no-autofill] [--no-auth] [--slug asia-2027]";
const rawArgs = process.argv.slice(2).filter((a) => a !== "--");
const argv = new Set<string>();
/** The QA trip's slug. The real import (`pnpm sheet:import`) also uses `asia-2027`,
 * so a database that holds the owner's real trip needs another slug here. */
let qaSlug = DEFAULTS.slug;
for (let i = 0; i < rawArgs.length; i++) {
	const a = rawArgs[i] as string;
	if (a === "--slug") {
		const v = rawArgs[++i];
		if (!v || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(v)) {
			console.error(`[db:seed:qa] --slug needs a slug\n${USAGE}`);
			process.exit(2);
		}
		qaSlug = v;
	} else if (["--no-media", "--no-autofill", "--no-auth"].includes(a))
		argv.add(a);
	else {
		console.error(`[db:seed:qa] unknown flag ${a}\n${USAGE}`);
		process.exit(2);
	}
}

/**
 * Never replace a trip at the QA slug that belongs to someone other than the
 * QA owner: after `pnpm sheet:import`, `asia-2027` is the owner's REAL trip.
 */
async function assertSlugIsQa(slug: string): Promise<void> {
	const rows = await getDb()
		.select({ email: user.email })
		.from(trips)
		.innerJoin(
			tripMembers,
			and(eq(tripMembers.tripId, trips.id), eq(tripMembers.role, "owner")),
		)
		.innerJoin(user, eq(user.id, tripMembers.userId))
		.where(and(eq(trips.slug, slug), isNull(trips.deletedAt)));
	const other = rows.find((r) => r.email !== QA_USERS.dennis.email);
	if (other)
		throw new Error(
			`the trip "${slug}" belongs to ${other.email}, not the QA owner; refusing to replace it. Use --slug asia-2027-qa (or another free slug) for the QA copy`,
		);
}

const REPORT = ".data/seed-qa-report.md";
const AUTH_DIR = "e2e/.auth";

/** A QA user with the fixture's names (kept in sync on every run). */
async function qaUser(tx: Tx, p: Person): Promise<string> {
	const { id } = await findOrCreateUser(tx, p);
	await tx
		.update(user)
		.set({
			firstName: p.firstName,
			lastName: p.lastName,
			name: `${p.firstName} ${p.lastName}`,
			emailVerified: true,
		})
		.where(eq(user.id, id));
	return id;
}

/** A small side trip with members (qa/SCENARIOS F2). */
async function sideTrip(
	tx: Tx,
	o: {
		slug: string;
		name: string;
		owner: string;
		members: { userId: string; role: "editor" | "viewer" }[];
		days: string[];
		place?: {
			country: string;
			countryCode: string;
			city: string;
			at: [number, number];
			tz: string;
		};
	},
): Promise<string> {
	const old = await tx
		.select({ id: trips.id })
		.from(trips)
		.where(and(eq(trips.slug, o.slug), isNull(trips.deletedAt)));
	for (const t of old) await hardDeleteTrip(tx, t.id);
	const tripId = uuidv7();
	await tx.insert(trips).values({
		id: tripId,
		slug: o.slug,
		name: o.name,
		startDate: o.days[0] ?? null,
		endDate: o.days.at(-1) ?? null,
		defaultTz: o.place?.tz ?? "UTC",
		settings: {},
		createdBy: o.owner,
	});
	await tx.insert(tripMembers).values([
		{
			id: uuidv7(),
			tripId,
			userId: o.owner,
			status: "active",
			role: "owner",
			color: 0,
			joinedAt: new Date(),
		},
		...o.members.map((m, i) => ({
			id: uuidv7(),
			tripId,
			userId: m.userId,
			status: "active" as const,
			role: m.role,
			color: i + 1,
			joinedAt: new Date(),
			invitedBy: o.owner,
		})),
	]);
	if (o.days.length)
		await tx
			.insert(tripDays)
			.values(o.days.map((date) => ({ id: uuidv7(), tripId, date })));
	if (o.place) {
		const countryId = uuidv7();
		const [k1] = freshKeysPure(1);
		await tx.insert(nodes).values({
			id: countryId,
			tripId,
			type: "country",
			name: o.place.country,
			slug: slugify(o.place.country, countryId),
			position: k1 as string,
			countryCode: o.place.countryCode,
			createdBy: o.owner,
		});
		const cityId = uuidv7();
		await tx.insert(nodes).values({
			id: cityId,
			tripId,
			parentId: countryId,
			type: "city",
			name: o.place.city,
			slug: slugify(o.place.city, cityId),
			position: k1 as string,
			lat: o.place.at[0],
			lng: o.place.at[1],
			tz: o.place.tz,
			createdBy: o.owner,
		});
	}
	return tripId;
}

// ---------------------------------------------------------------------------
// storageStates (SPEC §18.5: API login, never the UI)
// ---------------------------------------------------------------------------

type Cookie = {
	name: string;
	value: string;
	domain: string;
	path: string;
	expires: number;
	httpOnly: boolean;
	secure: boolean;
	sameSite: "Strict" | "Lax" | "None";
};

function parseSetCookie(header: string, host: string): Cookie {
	const [pair = "", ...attrs] = header.split(";").map((s) => s.trim());
	const eq = pair.indexOf("=");
	const c: Cookie = {
		name: pair.slice(0, eq),
		value: pair.slice(eq + 1),
		domain: host,
		path: "/",
		expires: -1,
		httpOnly: false,
		secure: false,
		sameSite: "Lax",
	};
	for (const a of attrs) {
		const [k = "", v = ""] = a.split("=");
		const key = k.toLowerCase();
		if (key === "path") c.path = v || "/";
		else if (key === "max-age")
			c.expires = Math.floor(Date.now() / 1000) + Number(v);
		else if (key === "expires" && c.expires === -1)
			c.expires = Math.floor(Date.parse(v) / 1000);
		else if (key === "httponly") c.httpOnly = true;
		else if (key === "secure") c.secure = true;
		else if (key === "samesite")
			c.sameSite = (v.charAt(0).toUpperCase() +
				v.slice(1).toLowerCase()) as Cookie["sameSite"];
	}
	return c;
}

/** The newest sign-in code for `email` in EMAIL_OUTBOX_DIR (when DEV_FIXED_OTP is off). */
function otpFromOutbox(email: string, since = 0): string | null {
	const dir = process.env.EMAIL_OUTBOX_DIR;
	if (!dir) return null;
	try {
		// Only mail written after this send: an older code is already spent.
		const files = readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => path.join(dir, f))
			.filter((f) => statSync(f).mtimeMs >= since)
			.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
		for (const f of files) {
			const mail = JSON.parse(readFileSync(f, "utf8")) as {
				to?: string;
				subject?: string;
			};
			if (mail.to === email)
				return /\b(\d{6})\b/.exec(mail.subject ?? "")?.[1] ?? null;
		}
	} catch {
		// no outbox
	}
	return null;
}

async function storageStates(handles: readonly QaHandle[]): Promise<string[]> {
	const base = process.env.APP_URL ?? "http://localhost:3000";
	const host = new URL(base).hostname;
	try {
		const h = await fetch(`${base}/api/health`, {
			signal: AbortSignal.timeout(3000),
		});
		if (!h.ok) throw new Error(String(h.status));
	} catch {
		console.log(
			`[db:seed:qa] no app on ${base}: storageStates skipped (start \`pnpm dev\` and run again, or let the e2e global setup log in)`,
		);
		return [];
	}
	mkdirSync(AUTH_DIR, { recursive: true });
	const headers = { Origin: base, "Content-Type": "application/json" };
	const written: string[] = [];
	for (const handle of handles) {
		const email = QA_USERS[handle].email;
		const since = Date.now() - 1000;
		const send = await fetch(
			`${base}/api/auth/email-otp/send-verification-otp`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({ email, type: "sign-in" }),
			},
		);
		if (!send.ok) {
			console.log(
				`[db:seed:qa] ${handle}: sending the code failed (${send.status}); skipped`,
			);
			continue;
		}
		let otp = process.env.DEV_FIXED_OTP || null;
		for (let i = 0; !otp && i < 20; i++) {
			otp = otpFromOutbox(email, since);
			if (!otp) await new Promise((r) => setTimeout(r, 200));
		}
		if (!otp) {
			console.log(
				`[db:seed:qa] ${handle}: no code (set DEV_FIXED_OTP or EMAIL_OUTBOX_DIR); skipped`,
			);
			continue;
		}
		const sign = await fetch(`${base}/api/auth/sign-in/email-otp`, {
			method: "POST",
			headers,
			body: JSON.stringify({ email, otp }),
		});
		if (!sign.ok) {
			console.log(
				`[db:seed:qa] ${handle}: sign-in failed (${sign.status}); skipped`,
			);
			continue;
		}
		const cookies = sign.headers
			.getSetCookie()
			.map((c) => parseSetCookie(c, host));
		// `qa-` prefix: e2e global setup owns `dev.json`/`maya.json` (maya@example.com),
		// and the QA Maya must not overwrite it mid-suite.
		const file = path.join(AUTH_DIR, `qa-${handle}.json`);
		writeFileSync(
			file,
			`${JSON.stringify({ cookies, origins: [] }, null, 2)}\n`,
		);
		written.push(file);
	}
	return written;
}

run("db:seed:qa", async () => {
	if (process.env.NODE_ENV === "production")
		throw new Error("refusing to seed with NODE_ENV=production");
	const airports = loadAirports("seed/airports/airports.json");
	const ids: Partial<Record<QaHandle, string>> = {};
	await assertSlugIsQa(qaSlug);
	const r = await runImport(
		{
			...DEFAULTS,
			slug: qaSlug,
			name: qaSlug === DEFAULTS.slug ? DEFAULTS.name : `${DEFAULTS.name} (QA)`,
			owner: QA_USERS.dennis.email,
			ownerFirst: QA_USERS.dennis.firstName,
			ownerLast: QA_USERS.dennis.lastName,
			...QA_DATES,
			replace: true,
			geocodeFallback: false,
			media: !argv.has("--no-media"),
			autofill: !argv.has("--no-autofill"),
			report: REPORT,
		},
		{
			// The fixed `asia-2027` (no random tail): the e2e specs open it.
			fixedSlug: true,
			patchPlan: (plan) => applyQaFixtures(plan, airports),
			memberUsers: async (tx) => {
				ids.dennis = await qaUser(tx, QA_USERS.dennis);
				ids.audrey = await qaUser(tx, QA_USERS.audrey);
				ids.kai = await qaUser(tx, QA_USERS.kai);
				ids.eve = await qaUser(tx, QA_USERS.eve);
				ids.maya = await qaUser(tx, QA_USERS.maya);
				return { audrey: ids.audrey };
			},
			extend: async (tx, { plan }) => {
				const tripId = plan.trip.id;
				const dennis = ids.dennis as string;
				await tx.insert(tripMembers).values([
					{
						id: uuidv7(),
						tripId,
						userId: ids.kai as string,
						status: "active",
						role: "viewer",
						color: 2,
						joinedAt: new Date(),
						invitedBy: dennis,
					},
					{
						// EXTENSIONS §2.1: the suggester member.
						id: uuidv7(),
						tripId,
						userId: ids.maya as string,
						status: "active",
						role: "suggester",
						color: 3,
						joinedAt: new Date(),
						invitedBy: dennis,
					},
				]);
				// Three expenses, one private (EXTENSIONS §2.1).
				const money = qaMoney(plan, { createdBy: dennis });
				await tx.insert(expenses).values(money.expenses);
				await tx.insert(expensePayments).values(money.payments);
				await tx.insert(expensePaymentPayers).values(money.payers);
				await tx.insert(expenseShares).values(money.shares);
				await sideTrip(tx, {
					slug: "phu-quoc-detour",
					name: "Phu Quoc detour",
					owner: ids.audrey as string,
					members: [{ userId: dennis, role: "viewer" }],
					days: ["2027-10-22", "2027-10-23", "2027-10-24"],
					place: {
						country: "Vietnam",
						countryCode: "VN",
						city: "Phu Quoc",
						at: [10.2899, 103.984],
						tz: "Asia/Ho_Chi_Minh",
					},
				});
				await sideTrip(tx, {
					slug: "delete-me",
					name: "Delete me",
					owner: dennis,
					members: [{ userId: ids.audrey as string, role: "editor" }],
					days: ["2027-12-01"],
				});
				// Sanity: Audrey's placeholder is now her membership.
				const [aud] = await tx
					.select({ status: tripMembers.status })
					.from(tripMembers)
					.where(
						sql`${tripMembers.tripId} = ${tripId} and ${tripMembers.userId} = ${ids.audrey as string}`,
					);
				if (aud?.status !== "active")
					throw new Error("Audrey is not linked to her placeholder");
			},
		},
	).finally(() => closeQueues());
	const suggestions = qaProposals(r.plan);
	const proposalIds = await proposeAs(
		r.tripId,
		ids.maya as string,
		suggestions,
	);
	const auth = argv.has("--no-auth")
		? []
		: await storageStates(["dennis", "audrey", "kai", "eve", "maya"]);
	const c = r.plan.report.counts;
	console.log(
		`[db:seed:qa] trip ${r.slug} (${r.tripId}): ${c.nodes} imported nodes + QA fixtures, ${r.plan.items.length} items, ${r.plan.legs.length} legs, ${r.facts.photosUploaded} photos`,
	);
	console.log(
		`[db:seed:qa] users: ${Object.values(QA_USERS)
			.map((u) => u.email)
			.join(", ")}; link sharing off (e2e: POST /api/test/link)`,
	);
	console.log(
		`[db:seed:qa] money: 3 expenses (1 private) in USD; Maya's suggestions: ${suggestions
			.map((p, i) => `${p.about} (${proposalIds[i]})`)
			.join("; ")}`,
	);
	console.log(
		`[db:seed:qa] F2 trips: phu-quoc-detour (Audrey's), delete-me; report ${REPORT}`,
	);
	if (auth.length)
		console.log(`[db:seed:qa] storageStates: ${auth.join(", ")}`);
});
