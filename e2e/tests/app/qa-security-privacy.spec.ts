/**
 * QA security verifier (I2 round 1): private items, private costs,
 * members-only media ("Hide from guests") and booking details must not leak
 * through any read (counts, activity, digest, inbox, mentions, lists, media,
 * money, CSV, proposals, the graph, SSR HTML, /media URLs) to anyone who may
 * not see them (ADDENDUM §6, §7.2, §9; EXTENSIONS §3.1; QA SEC/LINK/SHARE).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	call,
	EMAIL,
	FLIGHT_LEG,
	GG,
	guestPage,
	MEMBER,
	MOD,
	memberPage,
	T,
	TOKEN,
	IDS,
} from "./qa-security-helpers";

// Probes against the isolated QA-security stack (fixed QA-seed ids, own ports): opt-in only.
test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");

const DIR = process.env.QA_SEC_DIR ?? "/tmp";
const SECRET = `SECRETGIFT${Date.now().toString(36)}`;
const PDF_NAME = `passport-scan-${SECRET}.pdf`;
const HIDDEN_PHOTO: string = IDS.HIDDEN_PHOTO ?? "01a0cf13-e76d-7683-9c36-ec028a4e8144"; // Shibuya crossing

/** A one-page PDF (enough for the magic-byte check). */
const PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000052 00000 n
0000000101 00000 n
trailer<</Size 4/Root 1 0 R>>
startxref
160
%%EOF
`;

async function uploadPdf(page: Page): Promise<string> {
	const size = Buffer.byteLength(PDF);
	const up = await call(page, MOD.media, "createUpload", {
		tripId: T,
		target: { kind: "leg", legId: FLIGHT_LEG },
		type: "application/pdf",
		size,
		name: PDF_NAME,
	});
	if (!up.ok) throw new Error(`createUpload: ${up.err}`);
	const { id, url } = up.r as { id: string; url: string };
	const put = await page.evaluate(
		async ({ url, body }) => {
			const r = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body });
			return r.status;
		},
		{ url, body: PDF },
	);
	expect(put).toBe(200);
	const done = await call(page, MOD.media, "completeUpload", { id, hasPoster: false });
	if (!done.ok) throw new Error(`completeUpload: ${done.err}`);
	return id;
}

const leaks = (json: string, needles: string[]) => needles.filter((n) => json.includes(n));

test("private items, costs and members-only media never leak", async ({ browser }) => {
	test.setTimeout(600_000);
	const report: Record<string, unknown> = { secret: SECRET };

	// ---- Dennis (owner) sets up the private data -------------------------
	const dennis = await memberPage(browser, EMAIL.dennis, "Dennis", "Tester");
	const priv = await call(dennis.page, MOD.lists, "createListItem", {
		tripId: T,
		target: { kind: "node", nodeId: GG },
		list: "shopping",
		text: `${SECRET} fountain pen`,
		note: `for [@Audrey](mention:${MEMBER.audrey}) ${SECRET}-note`,
		isPrivate: true,
	});
	expect(priv.ok, JSON.stringify(priv)).toBe(true);
	const pdfId = await uploadPdf(dennis.page);
	const vis = await call(dennis.page, MOD.media, "setAttachmentVisibility", { id: HIDDEN_PHOTO, visibility: "members" });
	expect(vis.ok, JSON.stringify(vis)).toBe(true);
	const dennisCounts = await call(dennis.page, MOD.graph, "getTripCounts", { tripId: T });
	const dennisMedia = await call(dennis.page, MOD.media, "listTripMedia", { tripId: T });
	report.dennisSeesPdf = JSON.stringify(dennisMedia).includes(pdfId);
	report.pdfId = pdfId;
	report.dennisGG = (dennisCounts as { r: { byNode: Record<string, unknown> } }).r.byNode[GG];
	const pdfRow = ((dennisMedia as { r: { id: string; visibility: string }[] }).r ?? []).find((m) => m.id === pdfId);
	report.pdfVisibility = pdfRow?.visibility;

	// ---- Readers -----------------------------------------------------------
	const actors: [string, () => ReturnType<typeof memberPage>][] = [
		["audrey", () => memberPage(browser, EMAIL.audrey)],
		["kai", () => memberPage(browser, EMAIL.kai)],
		["maya", () => memberPage(browser, EMAIL.maya)],
		["guestViewer", () => guestPage(browser, TOKEN.viewer)],
		["guestEditor", () => guestPage(browser, TOKEN.editor)],
		["guestSuggester", () => guestPage(browser, TOKEN.suggester)],
	];
	const needlesAll = [SECRET, "Fountain pen (gift)"];
	const needlesGuest = [...needlesAll, "ZK4P7Q", "asia2027.test", PDF_NAME, pdfId, HIDDEN_PHOTO, "Fuji Excursion 7 seats"];
	for (const [name, open] of actors) {
		const { ctx, page } = await open();
		const guest = name.startsWith("guest");
		const needles = guest ? needlesGuest : needlesAll;
		const row: Record<string, unknown> = {};
		const probes: [string, string, string, unknown][] = [
			["graph", MOD.graph, "getTripGraph", { tripId: T }],
			["counts", MOD.graph, "getTripCounts", { tripId: T }],
			["activity", MOD.graph, "listActivity", { tripId: T, limit: 100 }],
			["digest", MOD.activity, "getDigest", { tripId: T }],
			["proposals", MOD.proposals, "listProposals", { tripId: T }],
			["media", MOD.media, "listTripMedia", { tripId: T }],
			["lists", MOD.lists, "listTripListItems", { tripId: T }],
			["notes", MOD.notes, "listTripNotes", { tripId: T }],
			["money", MOD.money, "listMoney", { tripId: T }],
			["csv", MOD.money, "exportMoneyCsv", { tripId: T }],
			["sharing", MOD.sharing, "getSharing", { tripId: T }],
			["inbox", MOD.inbox, "listInbox", { tripId: T }],
			["mentions", MOD.mentions, "listMyMentions", undefined],
			["myTrips", MOD.dashboard, "listMyTrips", undefined],
			["deadlines", MOD.dashboard, "listMyDeadlines", { everyone: true }],
			["leg", MOD.legs, "getLeg", { target: { kind: "pair", fromItemId: IDS.PAIR_FROM ?? "01a0cf13-e770-7057-a38f-3eb150fa3a66", toItemId: IDS.PAIR_TO ?? "01a0cf13-e770-7057-a38f-40bc39e6cd97" } }],
		];
		for (const [key, mod, fn, data] of probes) {
			const r = await call(page, mod, fn, data);
			const s = JSON.stringify(r);
			row[key] = r.ok ? { bytes: s.length, leaks: leaks(s, needles) } : r.err.slice(0, 80);
			if (key === "counts" && r.ok) row.GG = (r.r as { byNode: Record<string, unknown> }).byNode[GG];
			if (key === "sharing" && r.ok) row.sharingEmails = (s.match(/[\w.+-]+@[\w.-]+/g) ?? []).slice(0, 6);
		}
		// /media routes for the members-only rows.
		for (const v of ["original", "page-1", "thumb"]) {
			const res = await page.request.get(`/media/${pdfId}/${v}`, { maxRedirects: 0 });
			row[`pdf:${v}`] = res.status();
		}
		for (const v of ["thumb", "display"]) {
			const res = await page.request.get(`/media/${HIDDEN_PHOTO}/${v}`, { maxRedirects: 0 });
			row[`hiddenPhoto:${v}`] = res.status();
		}
		// Network + SSR HTML of the workspace as this actor.
		const bodies: string[] = [];
		page.on("response", async (res) => {
			const ct = res.headers()["content-type"] ?? "";
			if (/json|html|text|javascript/.test(ct) && !res.url().includes("/node_modules/") && !res.url().includes("/@"))
				bodies.push(await res.text().catch(() => ""));
		});
		await page.goto("/t/asia-2027?tab=plan");
		await page.waitForTimeout(6000);
		const html = await (await page.request.get("/t/asia-2027")).text();
		row.ssrLeaks = leaks(html, needles.filter((n) => n !== "asia2027.test" || guest));
		row.netLeaks = leaks(bodies.filter((b) => !b.includes("sourceMappingURL")).join("\n"), needles);
		await page.screenshot({ path: path.join(DIR, `privacy-${name}.png`) });
		report[name] = row;
		await ctx.close();
	}
	writeFileSync(path.join(DIR, "privacy.json"), JSON.stringify(report, null, 1));
	await dennis.ctx.close();
});
