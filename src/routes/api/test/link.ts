import { createFileRoute } from "@tanstack/react-router";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/db.server";
import { SHARE_ROLE_VALUES } from "@/lib/schemas/enums";
import { isTripSlug } from "@/lib/trip-slug";
import { testRouteGuard } from "@/server/env.server";
import { pinTestLink } from "@/server/fixture.server";

/**
 * `POST /api/test/link` (e2e only): sets what "Anyone with the link" gives on
 * the trip at `slug`, so a test's next visitor who opens `/t/<slug>` gets
 * `role` (the trip's address is its share link, like Google Drive). Body
 * `{ slug, role }`, or `{ slug, role: null }` to turn link sharing off (as
 * in the app: every live link row off, its guests out at once).
 *
 * Unlike the Share dialog it never gives the address a tail (the QA seed's
 * fixed `/t/asia-2027` stays, so the specs that open it keep working), and
 * a guest who came in earlier keeps the role they came in with, as the old
 * per-role share links did (`pinTestLink`). Needs no session: a test's fresh
 * browser calls it right before it opens the trip.
 *
 * 404 unless `ENABLE_TEST_ROUTES=1` and APP_URL is localhost (never in
 * production); 403 when the server runs on the main stack
 * (`testRouteGuard`).
 */
const Body = z
	.object({
		slug: z.string().refine(isTripSlug),
		role: z.enum(SHARE_ROLE_VALUES).nullable(),
	})
	.strict();

export const Route = createFileRoute("/api/test/link")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const refused = testRouteGuard();
				if (refused) return refused;
				let body: z.infer<typeof Body>;
				try {
					body = Body.parse(JSON.parse(await request.text()));
				} catch {
					return Response.json({ error: "VALIDATION" }, { status: 400 });
				}
				const res = await db.execute(sql`
					select id::text as id, created_by as "createdBy" from trips
					 where slug = ${body.slug} and deleted_at is null`);
				const trip = res.rows[0] as
					| { id: string; createdBy: string | null }
					| undefined;
				if (!trip)
					return Response.json({ error: "NOT_FOUND" }, { status: 404 });
				const [{ withTripTx }, { setLinkEnabled }] = await Promise.all([
					import("@/server/tx.server"),
					import("@/server/sharing.server"),
				]);
				await withTripTx(trip.id, async (tx, out) => {
					if (body.role === null)
						// Off, as in the app: its guests lose access at once.
						await setLinkEnabled(
							tx,
							out,
							trip.id,
							null,
							false,
							trip.createdBy ?? "",
						);
					else await pinTestLink(tx, trip.id, body.role, trip.createdBy);
					out.emit({ keys: ["sharing", "graph"] });
				});
				return Response.json(
					{ tripId: trip.id, slug: body.slug, role: body.role },
					{ headers: { "Cache-Control": "no-store" } },
				);
			},
		},
	},
});
