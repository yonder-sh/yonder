/**
 * QA security verifier (I2 round 2): what a VIEWER takes away with
 * "Duplicate…" (ADDENDUM §9). Kai duplicates Asia 2027 with everything
 * ticked; the SQL below lists what of other people's private data (private
 * list items, private notes, private budget lines, members-only media,
 * booking refs, rating comments) landed in his copy.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { call, EMAIL, MOD, memberPage, T } from "./qa-security-helpers";

test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");
const DIR = process.env.QA_SEC_DIR ?? "/tmp";
const PSQL = process.env.QA_SEC_PSQL ?? "/nix/store/8zm2sma9jgvq101yy4x45za4y28yd164-postgresql-17.10/bin/psql";
const DB = process.env.DATABASE_URL ?? "postgres://trip:trip@localhost:5432/trip_a27";
const q = (s: string) => execFileSync(PSQL, ["-At", "-F", "|", DB, "-c", s], { encoding: "utf8" }).trim();

test("a viewer's duplicate carries no one else's private data", async ({ browser }) => {
	test.setTimeout(200_000);
	const { ctx, page } = await memberPage(browser, EMAIL.kai);
	const r = await call(page, MOD.dashboard, "duplicateTrip", {
		tripId: T,
		name: "Kai's copy",
		startDate: "2028-10-02",
		include: { notes: true, lists: true, media: true, budgets: true, placeholders: true },
	});
	expect(r.ok, JSON.stringify(r)).toBe(true);
	const copy = (r as { r: { tripId: string } }).r.tripId;
	const kaiId = q(`select id from "user" where email='${EMAIL.kai}'`);
	const out = {
		copy,
		privateListItemsInSource: q(`select count(*) from list_items where trip_id='${T}' and is_private and deleted_at is null`),
		privateListItemsInCopy: q(`select li.text || ' (by ' || coalesce(u.email, li.created_by) || ')' from list_items li left join "user" u on u.id=li.created_by where li.trip_id='${copy}' and (li.is_private or li.text like '%SECRET%')`),
		privateNotesInSource: q(`select count(*) from yjs_documents where trip_id='${T}' and owner_user_id is not null`),
		privateNotesInCopy: q(`select name || ' owner=' || owner_user_id || ' text=' || left(coalesce(plain_text,''),60) from yjs_documents where trip_id='${copy}' and owner_user_id is not null`),
		noteTextLeak: q(`select name from yjs_documents where trip_id='${copy}' and plain_text like '%PRIVNOTE%'`),
		membersOnlyMediaInCopy: q(`select visibility, count(*) from attachments where trip_id='${copy}' and deleted_at is null group by visibility`),
		receiptsInCopy: q(`select count(*) from attachments where trip_id='${copy}' and expense_id is not null`),
		budgetLinesInCopy: q(`select coalesce(member_id::text,'trip') || ':' || amount_minor from budget_lines where trip_id='${copy}'`).slice(0, 500),
		expensesInCopy: q(`select count(*) from expenses where trip_id='${copy}'`),
		ratingCommentsInCopy: q(`select count(*) from node_priorities where trip_id='${copy}' and rating_comment is not null`),
		prioritiesInCopy: q(`select count(*) from node_priorities where trip_id='${copy}'`),
		membersInCopy: q(`select role || ':' || status || ':' || coalesce(display_name, '') || ':' || coalesce(email,'') || ':' || (user_id = '${kaiId}')::text from trip_members where trip_id='${copy}'`),
		shareLinksInCopy: q(`select count(*) from share_links where trip_id='${copy}'`),
		bookingRefInCopy: q(`select count(*) from legs where trip_id='${copy}' and details::text like '%bookingRef%'`),
	};
	writeFileSync(path.join(DIR, "r2-dup.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	await ctx.close();
});
