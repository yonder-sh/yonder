/**
 * QA security verifier (I2 round 1): can a share-link guest turn themselves
 * into a trip MEMBER (money, booking refs, a membership that survives a link
 * reset — SPEC R25) by claiming a placeholder (ADDENDUM §8/§10)?
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { setTestLink } from "./_helpers/link";
import { call, EMAIL, guestPage, MOD, memberPage, T, TOKEN } from "./qa-security-helpers";

// Probes against the isolated QA-security stack (fixed QA-seed ids, own ports): opt-in only.
test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");

const DIR = process.env.QA_SEC_DIR ?? "/tmp";

test("a viewer-link guest with an account claims a placeholder", async ({ browser }) => {
	test.setTimeout(300_000);
	const out: Record<string, unknown> = {};
	const dennis = await memberPage(browser, EMAIL.dennis, "Dennis", "Tester");
	const ph = await call(dennis.page, MOD.sharing, "addPlaceholder", { tripId: T, displayName: `Kenji ${Date.now() % 1000}` });
	expect(ph.ok, JSON.stringify(ph)).toBe(true);
	const kenji = (ph.r as { memberId: string }).memberId;
	out.placeholder = kenji;

	// A brand-new account that only holds the forwarded VIEWER link.
	const email = `mallory-${Date.now().toString(36)}@example.com`;
	const m = await guestPage(browser, TOKEN.viewer, email);
	const before = {
		money: await call(m.page, MOD.money, "listMoney", { tripId: T }),
		graph: await call(m.page, MOD.graph, "getTripGraph", { tripId: T }),
	};
	out.before = {
		money: before.money.ok ? "OK" : before.money.err,
		bookingRefVisible: JSON.stringify(before.graph).includes("ZK4P7Q"),
		me: before.graph.ok ? (before.graph.r as { me: unknown }).me : before.graph.err,
	};
	const claim = await call(m.page, MOD.sharing, "claimPlaceholder", { tripId: T, memberId: kenji });
	out.claim = claim.ok ? claim.r : claim.err;
	const after = {
		money: await call(m.page, MOD.money, "listMoney", { tripId: T }),
		graph: await call(m.page, MOD.graph, "getTripGraph", { tripId: T }),
		csv: await call(m.page, MOD.money, "exportMoneyCsv", { tripId: T }),
	};
	out.after = {
		money: after.money.ok ? `OK ${JSON.stringify(after.money.r).length}b` : after.money.err,
		csvHasRyokan: JSON.stringify(after.csv).includes("Kawaguchiko Ryokan"),
		bookingRefVisible: JSON.stringify(after.graph).includes("ZK4P7Q"),
		me: after.graph.ok ? (after.graph.r as { me: unknown }).me : after.graph.err,
	};
	// Does the membership outlive the link? (Owner turns the viewer link off, then on again.)
	const off = await call(dennis.page, MOD.sharing, "setShareLink", { tripId: T, role: "viewer", enabled: false });
	out.linkOff = off.ok ? "OK" : off.err;
	out.afterLinkOff = {
		graph: (await call(m.page, MOD.graph, "getTripGraph", { tripId: T })).ok ? "still has access" : "cut off",
	};
	const sharing = await call(dennis.page, MOD.sharing, "getSharing", { tripId: T });
	out.ownerSees = sharing.ok
		? (sharing.r as { members: { id: string; name: string; role: string; status: string; email?: string }[] }).members.find((x) => x.id === kenji)
		: sharing.err;
	// On again through the test route: the app would give the seeded address a tail.
	await setTestLink(dennis.page.request, "asia-2027", "viewer");
	out.linkOnAgain = "OK";
	await m.page.goto("/t/asia-2027/money");
	await m.page.waitForTimeout(4000);
	await m.page.screenshot({ path: path.join(DIR, "claim-mallory-money.png") });
	writeFileSync(path.join(DIR, "claim.json"), JSON.stringify(out, null, 1));
	await m.ctx.close();
	await dennis.ctx.close();
});
