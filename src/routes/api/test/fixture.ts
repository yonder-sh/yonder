import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { db } from "@/db/db.server";
import { loadSession } from "@/server/authz/session.server";
import { testRouteGuard } from "@/server/env.server";
import { cloneDemoTrip } from "@/server/fixture.server";

/**
 * `POST /api/test/fixture` (SPEC §12.1, §18.5): clones the fixed-UUID demo
 * trip under a random slug for one e2e test, owned by the caller (cookie or
 * bearer session) → `{ slug, tripId, shareTokens, ids, members }`.
 *
 * Optional JSON body: `{ mayaRole?: 'editor' | 'suggester' | 'viewer',
 * proposals?: boolean }`: Maya's role in the clone, and the demo's suggestions
 * proposed by her through the real gate (the answer then carries
 * `proposals: { ids, skipped }`).
 *
 * 404 unless `ENABLE_TEST_ROUTES=1` and APP_URL is localhost (never in
 * production); 403 when the server runs on the main stack (database `trip`,
 * bucket `trip-media`, Redis prefix `yonder`: `testRouteGuard`). 401
 * without a session.
 */
const FixtureBody = z
	.object({
		mayaRole: z.enum(["editor", "suggester", "viewer"]).optional(),
		proposals: z.boolean().optional(),
	})
	.strict();

export const Route = createFileRoute("/api/test/fixture")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				// 404 when off; 403 on the main stack (the owner's real trips).
				const refused = testRouteGuard();
				if (refused) return refused;
				const session = await loadSession(request.headers);
				if (!session || session.user.isAnonymous)
					return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
				const raw = await request.text();
				const opts = FixtureBody.safeParse(raw.trim() ? JSON.parse(raw) : {});
				if (!opts.success)
					return Response.json({ error: "VALIDATION" }, { status: 400 });
				const clone = await cloneDemoTrip(db, session.user.id, opts.data);
				return Response.json(clone, {
					headers: { "Cache-Control": "no-store" },
				});
			},
		},
	},
});
