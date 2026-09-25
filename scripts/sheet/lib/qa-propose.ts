/**
 * Proposes the QA seed's suggestions through the REAL gate (EXTENSIONS §3.4:
 * dry run, base, summary, activity), each in its own trip transaction like a
 * request would. Server-side only (the seed script and DB tests).
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db/db.server";
import { user } from "@/db/schema";
import { can } from "@/lib/auth/roles";
import type { AuthUser } from "@/server/auth.server";
import { getTripAccess } from "@/server/authz/access.server";
import { loadDef, proposeChange } from "@/server/proposals/propose.server";
import { mutationMeta, withTripTx } from "@/server/tx.server";
import type { QaProposal } from "./qa";

export async function proposeAs(
	tripId: string,
	userId: string,
	list: readonly QaProposal[],
): Promise<string[]> {
	const [row] = await getDb().select().from(user).where(eq(user.id, userId));
	if (!row) throw new Error(`no user ${userId}`);
	const author = row as unknown as AuthUser;
	const access = await getTripAccess(tripId, author);
	if (!access || !can(access, "propose"))
		throw new Error(`${author.email} can't suggest in trip ${tripId}`);
	const ids: string[] = [];
	for (const p of list) {
		const def = await loadDef(p.op);
		const input = def.input.parse(p.input) as Record<string, unknown>;
		const res = await withTripTx(
			tripId,
			(tx, out) =>
				proposeChange(tx, out, {
					op: p.op,
					def,
					input,
					flag: { message: p.message },
					access,
					user: author,
					tripId,
				}),
			mutationMeta(access, author),
		);
		ids.push(res.proposed.id);
	}
	return ids;
}
