import { createFileRoute } from "@tanstack/react-router";
import { sql } from "drizzle-orm";
import { db } from "@/db/db.server";

/**
 * `GET /api/health` (SPEC §12.1): `select 1` against Postgres. 200 when the
 * app can reach its database, 503 otherwise. No details leak.
 */
export const Route = createFileRoute("/api/health")({
	server: {
		handlers: {
			GET: async () => {
				try {
					await db.execute(sql`select 1`);
					return Response.json(
						{ ok: true },
						{ headers: { "Cache-Control": "no-store" } },
					);
				} catch {
					return Response.json(
						{ ok: false },
						{ status: 503, headers: { "Cache-Control": "no-store" } },
					);
				}
			},
		},
	},
});
