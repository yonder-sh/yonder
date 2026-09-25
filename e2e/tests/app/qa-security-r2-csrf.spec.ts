/**
 * QA security verifier (I2 round 2): CSRF and CORS on server functions.
 * Captures a real GET (getTripGraph) and a real POST (createItem) the app
 * sends as Audrey, then replays them with her cookies but cross-site
 * headers (what a hostile page's form/fetch/navigation would carry).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { call, EMAIL, MOD, memberPage, T } from "./qa-security-helpers";

test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");
const DIR = process.env.QA_SEC_DIR ?? "/tmp";

test("server functions refuse cross-site calls", async ({ browser }) => {
	test.setTimeout(180_000);
	const out: Record<string, unknown> = {};
	const { ctx, page } = await memberPage(browser, EMAIL.audrey);
	const seen: { method: string; url: string; body: string | null; headers: Record<string, string> }[] = [];
	page.on("request", (r) => {
		if (r.url().includes("/_serverFn/")) seen.push({ method: r.method(), url: r.url(), body: r.postData(), headers: r.headers() });
	});
	await call(page, MOD.graph, "getTripGraph", { tripId: T });
	await call(page, MOD.items, "createItem", { tripId: T, dayId: null, title: "CSRF control" });
	const get = seen.find((s) => s.method === "GET");
	const post = seen.find((s) => s.method === "POST");
	expect(get && post, JSON.stringify(seen.map((s) => s.method))).toBeTruthy();
	if (!get || !post) return;
	out.getUrlSample = get.url.slice(0, 160);
	out.postContentType = post.headers["content-type"];
	const req = ctx.request;
	const variants: [string, Record<string, string>][] = [
		["same-origin (control)", { Origin: new URL(get.url).origin, "Sec-Fetch-Site": "same-origin" }],
		["cross-site fetch", { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }],
		["cross-site, no Sec-Fetch", { Origin: "https://evil.example" }],
		["null origin", { Origin: "null" }],
		["same-site other port", { Origin: "http://localhost:9999", "Sec-Fetch-Site": "same-site" }],
		["no origin, evil referer", { Referer: "https://evil.example/x" }],
		["no origin, no referer", {}],
		["top-level navigation", { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" }],
	];
	for (const [label, h] of variants) {
		const g = await req.get(get.url, { headers: { ...h } });
		const gb = await g.text();
		const p = await req.post(post.url, {
			headers: { ...h, "content-type": post.headers["content-type"] ?? "application/json" },
			data: (post.body ?? "").replace("CSRF control", `CSRF ${label}`),
		});
		out[label] = {
			get: g.status(),
			getLeaks: /Golden Gai|Asia 2027/.test(gb),
			getACAO: g.headers()["access-control-allow-origin"] ?? null,
			getACAC: g.headers()["access-control-allow-credentials"] ?? null,
			post: p.status(),
			postBody: (await p.text()).slice(0, 100),
		};
	}
	// A plain HTML form can only send urlencoded/multipart/text-plain.
	const form = await req.post(post.url, {
		headers: { Origin: "https://evil.example", "content-type": "text/plain" },
		data: post.body ?? "",
	});
	out["text/plain form"] = { status: form.status(), body: (await form.text()).slice(0, 100) };
	// Preflight from an evil origin.
	const pre = await req.fetch(post.url, {
		method: "OPTIONS",
		headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
	});
	out.preflight = { status: pre.status(), acao: pre.headers()["access-control-allow-origin"] ?? null };
	// Better Auth endpoints from an evil origin (sign-out / update-user are state changing).
	const ua = await req.post("/api/auth/update-user", {
		headers: { Origin: "https://evil.example", "content-type": "application/json" },
		data: { firstName: "Pwned" },
	});
	out.betterAuthUpdateUserEvilOrigin = { status: ua.status(), body: (await ua.text()).slice(0, 120) };
	const me = await (await req.get("/api/auth/get-session")).json();
	out.firstNameAfter = (me as { user?: { firstName?: string } })?.user?.firstName;
	writeFileSync(path.join(DIR, "r2-csrf.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	await ctx.close();
});
