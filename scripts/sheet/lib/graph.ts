/**
 * An `ImportPlan` as the engine's `TripGraph` (pure), so tests can run the
 * real schedule and model on exactly what the importer would write — the
 * same shape `loadTripGraph` returns after the commit.
 */
import type { GraphLeg, TripGraph } from "@/lib/engine/types";
import type { ImportPlan, MemberKey } from "./plan";

const T0 = "2026-09-23T00:00:00.000Z";

export function planToGraph(plan: ImportPlan, ownerName = "Dennis"): TripGraph {
	const memberId = new Map(plan.members.map((m) => [m.key, m.id]));
	const mid = (k: MemberKey) => memberId.get(k) as string;
	const owner = plan.members.find((m) => m.key === "owner");
	const content = new Set<string>();
	for (const li of plan.listItems)
		if (li.target.kind === "leg") content.add(li.target.legId);
	for (const a of plan.attachments)
		if (a.target.kind === "leg") content.add(a.target.legId);
	for (const n of plan.notes)
		if (n.target.kind === "leg") content.add(n.target.legId);
	return {
		trip: {
			id: plan.trip.id,
			slug: plan.trip.slug,
			name: plan.trip.name,
			startDate: plan.trip.startDate,
			endDate: plan.trip.endDate,
			defaultTz: plan.trip.defaultTz,
			coverAttachmentId: plan.trip.coverAttachmentId,
			settings: plan.trip.settings,
			version: 1,
			updatedAt: T0,
		},
		me: {
			userId: "owner",
			memberId: owner?.id ?? null,
			role: "owner",
			isGuest: false,
			name: ownerName,
			color: 0,
		},
		members: plan.members.map((m) => ({
			id: m.id,
			userId: m.key === "owner" ? "owner" : null,
			status: m.key === "owner" ? "active" : "placeholder",
			role: m.role,
			name: m.key === "owner" ? ownerName : (m.displayName ?? m.key),
			color: m.color,
		})),
		days: plan.days.map((d) => ({
			id: d.id,
			date: d.date,
			startTime: d.startTime,
			title: d.title,
			nightNodeId: d.nightNodeId,
			updatedAt: T0,
		})),
		nodes: plan.nodes.map((n) => ({
			id: n.id,
			parentId: n.parentId,
			type: n.type,
			category: n.category,
			status: n.status,
			name: n.name,
			localName: null,
			slug: n.slug,
			description: n.description,
			position: n.position,
			lat: n.lat,
			lng: n.lng,
			tz: n.tz,
			countryCode: n.countryCode,
			address: null,
			googlePlaceId: null,
			bbox: null,
			timeNeededMin: n.timeNeededMin,
			details: n.details,
			priorities: Object.fromEntries(
				Object.entries(n.priorities).map(([k, p]) => [mid(k as MemberKey), p]),
			),
			ratingComments: {},
			updatedAt: T0,
		})),
		items: plan.items.map((i) => ({
			id: i.id,
			dayId: i.dayId,
			nodeId: i.nodeId,
			title: i.title,
			note: i.note,
			position: i.position,
			durationMin: i.durationMin,
			pinnedStart: i.pinnedStart,
			assigneeIds: i.assignees.map(mid),
			updatedAt: T0,
		})),
		legs: plan.legs.map(
			(l): GraphLeg => ({
				id: l.id,
				kind: "pair",
				fromItemId: l.fromItemId,
				toItemId: l.toItemId,
				stayDayId: null,
				anchorItemId: null,
				mode: l.mode,
				durationMin: l.mode === "flight" ? null : l.durationMin,
				distanceM: null,
				source: "manual",
				estimateMin: null,
				isEdited: true,
				depAt: l.depAt,
				arrAt: l.arrAt,
				details: l.details.kind === "none" ? {} : l.details,
				queriedFor: null,
				assigneeIds: l.assignees.map(mid),
				hasContent: content.has(l.id) || l.assignees.length > 0,
				updatedAt: T0,
			}),
		),
	};
}
