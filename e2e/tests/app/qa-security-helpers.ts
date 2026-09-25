/**
 * QA security verifier (I2 round 1) helpers: actors signed in through the API
 * or through a share link, and a generic "call a server function from the
 * page" probe. Fixture ids are the QA seed's (`pnpm db:seed:qa`).
 */
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { loginViaApi } from "./_helpers/auth";

/** Round 3: ids of a re-seeded QA database (`QA_SEC_IDS` = a JSON file), else the round-1 seed's. */
export const IDS: Record<string, string> & { MEMBER?: Record<string, string> } = process.env.QA_SEC_IDS
	? JSON.parse(readFileSync(process.env.QA_SEC_IDS, "utf8"))
	: {};

export const T: string = IDS.T ?? "01a0cf13-e76f-70dc-bad2-e9004b586415"; // Asia 2027 (Dennis owns)
export const PQ: string = IDS.PQ ?? "01a0cf13-fed1-7580-b56b-c8e8135814c8"; // Phu Quoc detour (Audrey owns; Dennis views)
export const DEMO: string = IDS.DEMO ?? "00000000-0000-7000-8000-000000000001";
export const GG: string = IDS.GG ?? "01a0cf13-e765-70f2-9b1e-a67a433af2ac"; // Golden Gai node
export const GG_ITEM: string = IDS.GG_ITEM ?? "01a0cf13-e769-75b4-a2e2-f1ed710858bd";
export const DAY1: string = IDS.DAY1 ?? "01a0cf13-e767-7497-89b7-51a4d67f9330";
export const FLIGHT_LEG: string = IDS.FLIGHT_LEG ?? "01a0cf13-e771-720a-9d60-52f291b0ecde";
export const PRIVATE_EXPENSE: string = IDS.PRIVATE_EXPENSE ?? "01a0cf13-fec8-7089-b46e-1aaf2e502998";
export const EXPENSE: string = IDS.EXPENSE ?? "01a0cf13-fec8-7089-b46e-1331078d3edc";
export const LIST_ITEM: string = IDS.LIST_ITEM ?? "01a0cf13-e768-74fb-bbd2-60351e174d08";
export const PHOTO: string = IDS.PHOTO ?? "01a0cf13-e76d-7683-9c36-f643a9647ff6";
export const PQ_NODE: string = IDS.PQ_NODE ?? "01a0cf13-fed3-7489-a68c-8a53287afd27";
export const MEMBER = {
	dennis: IDS.MEMBER?.dennis ?? "01a0cf13-e762-7326-8e9a-4d39490bd847",
	audrey: IDS.MEMBER?.audrey ?? "01a0cf13-e763-7519-9ffa-8d667e2c7852",
	kai: IDS.MEMBER?.kai ?? "01a0cf13-fec7-770d-83d2-81162526e869",
	maya: IDS.MEMBER?.maya ?? "01a0cf13-fec7-770d-83d2-86dbdcf78d14",
};
export const TOKEN = {
	editor: "qa-share-token-editor-asia-2027",
	viewer: "qa-share-token-viewer-asia-2027",
	suggester: "qa-share-token-suggester-asia-2027",
};
export const EMAIL = {
	dennis: "dennis@asia2027.test",
	audrey: "audrey@asia2027.test",
	kai: "kai@asia2027.test",
	eve: "eve@asia2027.test",
	maya: "maya@asia2027.test",
};

export const MOD = {
	graph: "/src/functions/graph.functions.ts",
	activity: "/src/functions/activity.functions.ts",
	items: "/src/functions/items.functions.ts",
	nodes: "/src/functions/nodes.functions.ts",
	days: "/src/functions/days.functions.ts",
	legs: "/src/functions/legs.functions.ts",
	trips: "/src/functions/trips.functions.ts",
	proposals: "/src/functions/proposals.functions.ts",
	inbox: "/src/functions/inbox.functions.ts",
	prefs: "/src/functions/prefs.functions.ts",
	sharing: "/src/features/home/sharing.functions.ts",
	dashboard: "/src/features/home/dashboard.functions.ts",
	insights: "/src/features/insights/insights.functions.ts",
	lists: "/src/features/lists/lists.functions.ts",
	media: "/src/features/media/media.functions.ts",
	money: "/src/features/money/money.functions.ts",
	mentions: "/src/features/notes/mentions.functions.ts",
	notes: "/src/features/notes/notes.functions.ts",
	places: "/src/features/places/places.functions.ts",
	suggest: "/src/features/suggest/suggest.functions.ts",
	transit: "/src/features/transit/transit.functions.ts",
	share: "/src/lib/auth/share.functions.ts",
} as const;

export type CallResult = { ok: true; r: unknown } | { ok: false; err: string };

/** Calls `fn` from `mod` in the page (the real client stub, real cookies). */
export async function call(
	page: Page,
	mod: string,
	fn: string,
	data: unknown,
	headers?: Record<string, string>,
): Promise<CallResult> {
	const timeout = new Promise<CallResult>((r) =>
		setTimeout(() => r({ ok: false, err: "PROBE_TIMEOUT" }), 45_000),
	);
	return Promise.race([timeout, page.evaluate(
		async ({ mod, fn, data, headers }) => {
			try {
				const m = await import(/* @vite-ignore */ mod);
				const r = await m[fn](headers ? { data, headers } : { data });
				return { ok: true as const, r };
			} catch (e) {
				return { ok: false as const, err: String((e as Error)?.message ?? e).slice(0, 300) };
			}
		},
		{ mod, fn, data, headers },
	)]);
}

/** "NOT_FOUND" / "FORBIDDEN" / … or "OK". */
export const code = (r: CallResult) => (r.ok ? "OK" : (/^([A-Z_]+)/.exec(r.err)?.[1] ?? r.err));

export async function memberPage(
	browser: Browser,
	email: string,
	first = "QA",
	last = "Tester",
): Promise<{ ctx: BrowserContext; page: Page }> {
	const ctx = await browser.newContext();
	await loginViaApi(ctx.request, email, { first, last });
	const page = await ctx.newPage();
	await page.goto("/login");
	return { ctx, page };
}

/** A fresh browser (anonymous guest) or a signed-in account that opens a share link. */
export async function guestPage(
	browser: Browser,
	token: string,
	signedInEmail?: string,
): Promise<{ ctx: BrowserContext; page: Page }> {
	const ctx = await browser.newContext();
	if (signedInEmail) await loginViaApi(ctx.request, signedInEmail);
	const page = await ctx.newPage();
	await page.goto(`/join#t=${token}`);
	await page.waitForURL(/\/t\/asia-2027/, { timeout: 30_000 });
	return { ctx, page };
}
