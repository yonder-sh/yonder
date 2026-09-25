/**
 * I2 verifier "map-transit" helpers (QA MAP/GRAN/TR/FLT on the QA seed's
 * Asia 2027). Only runs with QA_MAP_TRANSIT=1 against its own app/db (agent 23).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { type APIRequestContext, type Browser, type Page, expect, request, test } from "@playwright/test";

export const APP = process.env.APP_URL ?? "http://localhost:5330";
export const OUT =
	process.env.QA_OUT ??
	"/tmp/nix-shell-11401-736022988/claude-1000/-home-dennis-chat-asia-2027/9feadd69-1626-421b-bfa4-9000f02f7e4f/scratchpad/qa-map-transit";
export const SHOTS = path.join(OUT, "shots");
mkdirSync(SHOTS, { recursive: true });
mkdirSync(path.join(OUT, "auth"), { recursive: true });
export const shot = (name: string) => path.join(SHOTS, `${name}.png`);

export function onlyHere() {
	test.skip(process.env.QA_MAP_TRANSIT !== "1", "qa-map-transit verifier only");
}

const json = (body: unknown) => ({
	data: body,
	headers: { Origin: APP, "Content-Type": "application/json" },
});

export async function login(email: string, first = "Q", last = "A"): Promise<string> {
	const file = path.join(OUT, "auth", `${email}.json`);
	const ctx: APIRequestContext = await request.newContext({ baseURL: APP });
	const send = await ctx.post("/api/auth/email-otp/send-verification-otp", json({ email, type: "sign-in" }));
	if (!send.ok()) throw new Error(`send ${send.status()} ${await send.text()}`);
	const sign = await ctx.post("/api/auth/sign-in/email-otp", json({ email, otp: "000000" }));
	if (!sign.ok()) throw new Error(`sign ${sign.status()} ${await sign.text()}`);
	const session = (await (await ctx.get("/api/auth/get-session")).json()) as {
		user?: { firstName?: string; lastName?: string };
	} | null;
	if (!session?.user?.firstName?.trim() || !session.user.lastName?.trim()) {
		await ctx.post("/api/auth/update-user", json({ firstName: first, lastName: last }));
	}
	await ctx.storageState({ path: file });
	await ctx.dispose();
	return file;
}

export async function asUser(browser: Browser, email: string, opts: { viewport?: { width: number; height: number } } = {}) {
	const state = await login(email);
	const ctx = await browser.newContext({
		storageState: state,
		viewport: opts.viewport ?? { width: 1440, height: 900 },
		timezoneId: "America/New_York",
	});
	const page = await ctx.newPage();
	const errors: string[] = [];
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});
	page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
	return { ctx, page, errors };
}

export type Drawn = {
	lens: string;
	scopeId: string | null;
	pins: { repId: string; hollow: boolean; number: number | null; opacity: number; lat?: number; lng?: number }[];
	visiblePins: string[];
	clusters: { id: number; count: number; repIds: string[] }[];
	edges: { features: { properties: Record<string, unknown>; geometry: { coordinates: number[][] } }[] };
	allEdges: { features: { properties: Record<string, unknown>; geometry: { coordinates: number[][] } }[] };
	ghosts: { features: { properties: Record<string, unknown>; geometry: { coordinates: number[][] } }[] };
};

export async function mapReady(page: Page, lens?: string) {
	await expect(page.locator(".maplibregl-map")).toBeVisible({ timeout: 45_000 });
	await expect
		.poll(
			() =>
				page.evaluate((lens) => {
					// biome-ignore lint/suspicious/noExplicitAny: introspection
					const m = (window as any).__tripMap;
					return !!m && m.loaded() && !!m.__yonder && (!lens || m.__yonder.lens === lens);
				}, lens),
			{ timeout: 45_000 },
		)
		.toBe(true);
}

export async function settle(page: Page) {
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					// biome-ignore lint/suspicious/noExplicitAny: introspection
					const m = (window as any).__tripMap;
					return !!m && m.loaded() && m.areTilesLoaded() && !m.isMoving();
				}),
			{ timeout: 30_000 },
		)
		.toBe(true);
	await page.waitForTimeout(500);
}

// biome-ignore lint/suspicious/noExplicitAny: introspection
export const drawn = (page: Page) => page.evaluate(() => (window as any).__tripMap?.__yonder as Drawn);
// biome-ignore lint/suspicious/noExplicitAny: introspection
export const model = (page: Page) => page.evaluate(() => (window as any).__yonder?.model);

/** Screen point of a coordinate. */
export async function screenPoint(page: Page, c: number[]) {
	return page.evaluate((c) => {
		// biome-ignore lint/suspicious/noExplicitAny: introspection
		const m = (window as any).__tripMap;
		const p = m.project(c);
		const r = m.getContainer().getBoundingClientRect();
		return { x: r.left + p.x, y: r.top + p.y };
	}, c);
}

/** id → "type:name" for nodes, "item:title" for items, from `__yonder.graph`. */
export async function names(page: Page): Promise<Record<string, string>> {
	return page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: introspection
		const g = (window as any).__yonder?.graph;
		const out: Record<string, string> = {};
		for (const n of g?.nodes ?? []) out[n.id] = `${n.type}:${n.name}`;
		for (const i of g?.items ?? []) out[i.id] = `item:${i.title ?? out[i.nodeId] ?? i.id}`;
		for (const d of g?.days ?? []) out[d.id] = `day:${d.date}`;
		return out;
	});
}
export const nm = (n: Record<string, string>, id: string) => n[id] ?? id.slice(-6);
export const edgeName = (n: Record<string, string>, key: string) =>
	key
		.split("#")[0]
		.split(">")
		.map((k) => nm(n, k))
		.join(" > ") + (key.includes("#") ? ` #${key.split("#")[1]}` : "");

export type G = {
	trip: { id: string; slug: string };
	nodes: { id: string; name: string; type: string; parentId: string | null; lat: number | null; lng: number | null }[];
	items: { id: string; title: string | null; nodeId: string | null; dayId: string | null; position: string; durationMin: number | null }[];
	days: { id: string; date: string }[];
	legs: {
		id: string;
		fromItemId: string | null;
		toItemId: string | null;
		mode: string | null;
		durationMin: number | null;
		details: Record<string, unknown> & { kind?: string };
		source?: string | null;
	}[];
};
// biome-ignore lint/suspicious/noExplicitAny: introspection
export const graph = (page: Page) => page.evaluate(() => (window as any).__yonder?.graph as G);

export function itemLabel(g: G, id: string | null) {
	const i = g.items.find((x) => x.id === id);
	if (!i) return id ?? "?";
	const n = g.nodes.find((x) => x.id === i.nodeId);
	return i.title ?? n?.name ?? i.id;
}
export function legBetween(g: G, from: string, to: string) {
	return g.legs.find((l) => itemLabel(g, l.fromItemId) === from && itemLabel(g, l.toItemId) === to);
}
