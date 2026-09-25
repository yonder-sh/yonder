/**
 * Minimal dev seed: one named user who owns one empty trip. This is the
 * skeleton the full demo seed (`scripts/seed-dev.ts`, F1s, from
 * `src/lib/fixtures/demo.ts`) and the Asia 2027 import (F1i) build on.
 *
 * Idempotent in the SPEC §17.1 sense: in one transaction it hard-deletes the
 * trip with this slug and the user with this email (cascading), then recreates
 * them. Never run it against production data.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { hardDeleteTripsWhere } from "@/server/trip-delete.server";
import type { Db } from "./db.server";
import { tripMembers, trips, user } from "./schema";

export type SeedDemoOptions = {
	email?: string;
	firstName?: string;
	lastName?: string;
	tripSlug?: string;
	tripName?: string;
};

export type SeedDemoResult = {
	userId: string;
	email: string;
	tripId: string;
	tripSlug: string;
	memberId: string;
};

export const SEED_DEMO_DEFAULTS = {
	email: "dev@example.com",
	firstName: "Dev",
	lastName: "User",
	tripSlug: "demo",
	tripName: "Demo · Japan & Korea",
} as const satisfies Required<SeedDemoOptions>;

export async function seedDemoSkeleton(
	db: Db,
	options: SeedDemoOptions = {},
): Promise<SeedDemoResult> {
	// `??`, not a spread: CLI flags that weren't given arrive as explicit undefined.
	const d = SEED_DEMO_DEFAULTS;
	const o = {
		firstName: options.firstName ?? d.firstName,
		lastName: options.lastName ?? d.lastName,
		tripSlug: options.tripSlug ?? d.tripSlug,
		tripName: options.tripName ?? d.tripName,
	};
	const email = (options.email ?? d.email).trim().toLowerCase();

	return db.transaction(async (tx) => {
		await hardDeleteTripsWhere(tx, { slug: o.tripSlug });
		await tx.delete(user).where(eq(user.email, email));

		const [owner] = await tx
			.insert(user)
			.values({
				id: randomUUID(),
				email,
				emailVerified: true,
				firstName: o.firstName,
				lastName: o.lastName,
				name: `${o.firstName} ${o.lastName}`,
				isAnonymous: false,
			})
			.returning({ id: user.id });
		if (!owner) throw new Error("seed: user insert returned no row");

		const [trip] = await tx
			.insert(trips)
			.values({ slug: o.tripSlug, name: o.tripName, createdBy: owner.id })
			.returning({ id: trips.id });
		if (!trip) throw new Error("seed: trip insert returned no row");

		const [member] = await tx
			.insert(tripMembers)
			.values({
				tripId: trip.id,
				userId: owner.id,
				status: "active",
				role: "owner",
				color: 0,
				joinedAt: new Date(),
			})
			.returning({ id: tripMembers.id });
		if (!member) throw new Error("seed: member insert returned no row");

		return {
			userId: owner.id,
			email,
			tripId: trip.id,
			tripSlug: o.tripSlug,
			memberId: member.id,
		};
	});
}
