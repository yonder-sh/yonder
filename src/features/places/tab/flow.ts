/**
 * The planning flow (owner, 2026-09-25): **rate places → review them →
 * add the shortlist to days**. Adding is an action on every step ("Add a
 * place"), not a step. The Places tab leads with the three steps, each with
 * its count ("12 to rate", "48 places", "9 shortlisted · 4 not on a day");
 * the step with work waiting for you gets a dot, and the phone's Rate pill
 * reads the same numbers. Pure.
 *
 * The step lives in the URL as the view (`pv`): table / board / map are
 * Review, `rate` is Rate, `schedule` is Schedule, so every old `pv` link
 * still lands where it did. Without `pv` the tab picks the most useful
 * step (`pickStep`).
 */
import type { PlacesView } from "@/lib/workspace/search";
import type { PlaceStatus } from "./lifecycle";

export const FLOW_STEPS = ["rate", "review", "schedule"] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

/** The Review step's own views (its switcher). */
export const REVIEW_VIEWS = ["table", "board", "map"] as const;
export type ReviewView = (typeof REVIEW_VIEWS)[number];

export const STEP_LABEL: Record<FlowStep, string> = {
	rate: "Rate",
	review: "Review",
	schedule: "Schedule",
};

/** The step a `pv` names (null: none, the tab picks one). */
export function stepOfView(pv: PlacesView | null | undefined): FlowStep | null {
	if (!pv) return null;
	if (pv === "rate") return "rate";
	if (pv === "schedule") return "schedule";
	return "review";
}

/** The Review view a `pv` names, else `fallback` (the last one used). */
export function reviewViewOf(
	pv: PlacesView | null | undefined,
	fallback: ReviewView = "table",
): ReviewView {
	return pv === "table" || pv === "board" || pv === "map" ? pv : fallback;
}

/** The `pv` that opens a step. */
export function viewOfStep(
	step: FlowStep,
	reviewView: ReviewView = "table",
): PlacesView {
	return step === "review" ? reviewView : step;
}

export type FlowTally = {
	/** Every place collected (not dropped). */
	ideas: number;
	/** Places you haven't rated (not dropped); null when you can't rate. */
	toRate: number | null;
	/** On the shortlist, scheduled or not. */
	shortlisted: number;
	/** Shortlisted and not on a day yet. */
	notOnDay: number;
};

export function flowTally(
	rows: readonly {
		status: PlaceStatus;
		node: { priorities: Readonly<Record<string, unknown>> };
	}[],
	opts: { me: string | null; canRate: boolean },
): FlowTally {
	const out: FlowTally = {
		ideas: 0,
		toRate: opts.canRate && opts.me ? 0 : null,
		shortlisted: 0,
		notOnDay: 0,
	};
	for (const r of rows) {
		if (r.status === "dropped") continue;
		out.ideas += 1;
		if (out.toRate !== null && opts.me && r.node.priorities[opts.me] == null)
			out.toRate += 1;
		if (r.status === "shortlist" || r.status === "scheduled")
			out.shortlisted += 1;
		if (r.status === "shortlist") out.notOnDay += 1;
	}
	return out;
}

export type FlowContext = {
	/** You can add places and put them on days (edit, or suggest). */
	canEdit: boolean;
	/** The trip has days to schedule onto. */
	hasDays: boolean;
};

/**
 * The step with work waiting for you, most pressing first: places to rate,
 * then shortlisted places not on a day. Review never waits: the shortlist
 * fills itself from the ratings. Null: nothing waiting.
 */
export function nextStep(t: FlowTally, c: FlowContext): FlowStep | null {
	if (t.toRate) return "rate";
	if (t.notOnDay && c.hasDays && c.canEdit) return "schedule";
	return null;
}

/**
 * The step Places opens on when the URL names none. A link to one place or
 * a status filter wants the list (Review). On a phone the Rate feed is full
 * screen, so it never opens by itself (the Rate pill is one tap away).
 */
export function pickStep(
	t: FlowTally,
	c: FlowContext & { phone: boolean; focus: boolean },
): FlowStep {
	if (c.focus) return "review";
	if (t.toRate && t.ideas && !c.phone) return "rate";
	if (t.notOnDay && c.hasDays && c.canEdit) return "schedule";
	return "review";
}

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

/** Each step's count line ("12 to rate", "48 places", "9 shortlisted · 4 not on a day"). */
export function stepCounts(
	t: FlowTally,
	opts: { short?: boolean } = {},
): Record<FlowStep, string> {
	const review = t.ideas ? plural(t.ideas, "place") : "No places yet";
	const rate =
		t.toRate === null
			? "View only"
			: t.toRate
				? `${t.toRate} to rate`
				: t.ideas
					? "All rated"
					: "Nothing to rate";
	let schedule: string;
	if (!t.shortlisted) schedule = "Nothing shortlisted";
	else if (opts.short)
		schedule = t.notOnDay
			? `${t.notOnDay} not on a day`
			: `${t.shortlisted} shortlisted`;
	else
		schedule = t.notOnDay
			? `${t.shortlisted} shortlisted · ${t.notOnDay} not on a day`
			: `${t.shortlisted} shortlisted · all on a day`;
	return { rate, review, schedule };
}
