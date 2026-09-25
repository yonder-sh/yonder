/**
 * The notification a person sees (pure): the trip name as the title prefix,
 * one short body line, the deep link and a tag. One item reads as itself
 * ("Asia 2027 · Maya mentioned you in Kyoto"); several of one group coalesce
 * into a summary ("Asia 2027 · Maya made 5 suggestions").
 */
import { tripUrl } from "./links";
import {
	PUSH_BODY_MAX,
	PUSH_TITLE_MAX,
	type PushGroup,
	type PushItem,
	type PushPayload,
} from "./types";

export type PayloadTrip = { id: string; name: string; slug: string };

/** Groups where only the newest item matters (a state, not a pile of events). */
const LATEST_ONLY = new Set<PushGroup>(["membership", "countdown", "today"]);
/** Groups whose notification replaces the trip's previous one of that group. */
const REPLACING = new Set<PushGroup>([
	"membership",
	"countdown",
	"today",
	"review",
]);

export function clip(s: string, max: number): string {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** The one actor behind every item, or null (reminders, mixed, unknown). */
function soleActor(items: readonly PushItem[]): string | null {
	const first = items[0]?.actor ?? null;
	if (!first) return null;
	return items.every((i) => i.actor === first) ? first : null;
}

/** "Fushimi Inari, Book JR pass and 2 more" from the items' labels. */
function listLabels(items: readonly PushItem[]): string {
	const labels = [...items]
		.reverse()
		.map((i) => String(i.meta?.label ?? i.body ?? i.headline))
		.filter(Boolean);
	const shown = labels.slice(0, 3);
	const more = labels.length - shown.length;
	if (more > 0) return `${shown.join(", ")} and ${more} more`;
	if (shown.length <= 1) return shown[0] ?? "";
	return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

function summary(
	group: PushGroup,
	items: readonly PushItem[],
): { headline: string; body: string } {
	const n = items.length;
	const actor = soleActor(items);
	switch (group) {
		case "mention":
			return {
				headline: actor
					? `${actor} mentioned you ${n} times`
					: `${plural(n, "new mention")}`,
				body: items.at(-1)?.body ?? listLabels(items),
			};
		case "review":
			return {
				headline: actor
					? `${actor} made ${plural(n, "suggestion")}`
					: `${plural(n, "suggestion")} to review`,
				body: listLabels(items),
			};
		case "result": {
			const accepted = items.filter(
				(i) => i.meta?.decision === "accepted",
			).length;
			const rejected = n - accepted;
			return {
				headline: actor
					? `${actor} reviewed ${plural(n, "suggestion")} of yours`
					: `${plural(n, "suggestion")} of yours reviewed`,
				body: [
					accepted ? `${accepted} accepted` : "",
					rejected ? `${rejected} rejected` : "",
				]
					.filter(Boolean)
					.join(", "),
			};
		}
		case "assigned":
			return {
				headline: actor
					? `${actor} assigned you ${plural(n, "thing")}`
					: `${plural(n, "thing")} assigned to you`,
				body: listLabels(items),
			};
		case "due":
			return {
				headline: `${plural(n, "to-do")} of yours due`,
				body: listLabels(items),
			};
		case "booking":
			return {
				headline: `${plural(n, "booking window")} opening soon`,
				body: listLabels(items),
			};
		case "changes":
			return {
				headline: `${plural(n, "plan")} of yours changed`,
				body: listLabels(items),
			};
		default:
			return { headline: items.at(-1)?.headline ?? "", body: "" };
	}
}

/** Where a summary opens: the shared link, else the group's natural place. */
function summaryUrl(
	group: PushGroup,
	items: readonly PushItem[],
	trip: PayloadTrip,
): string {
	const urls = new Set(items.map((i) => i.url));
	if (urls.size === 1) return items[0]?.url ?? tripUrl(trip.slug);
	switch (group) {
		case "due":
		case "booking":
			return tripUrl(trip.slug, { tab: "lists", list: "todo" });
		case "mention":
		case "review":
			// The newest one (the rest are one click away in the inbox / review drawer).
			return items.at(-1)?.url ?? tripUrl(trip.slug);
		default:
			return tripUrl(trip.slug);
	}
}

/**
 * The payload for one person, one trip and one group; null when there is
 * nothing to say. Items may come in any order.
 */
export function buildPayload(
	group: PushGroup,
	items: readonly PushItem[],
	trip: PayloadTrip,
): PushPayload | null {
	if (!items.length) return null;
	const sorted = [...items].sort((a, b) => a.at - b.at);
	const newest = sorted.at(-1) as PushItem;
	const lone = sorted.length === 1 || LATEST_ONLY.has(group);
	const { headline, body } = lone
		? { headline: newest.headline, body: newest.body ?? "" }
		: summary(group, sorted);
	const url = lone ? newest.url : summaryUrl(group, sorted, trip);
	// "Asia 2027 starts in 7 days" reads as one sentence; the rest take a separator.
	const title =
		group === "countdown"
			? `${trip.name} ${headline}`
			: `${trip.name} · ${headline}`;
	const tag = REPLACING.has(group)
		? `${group}:${trip.id}`
		: lone
			? `${group}:${trip.id}:${newest.key}`
			: `${group}:${trip.id}:${newest.key}+${sorted.length}`;
	return {
		title: clip(title, PUSH_TITLE_MAX),
		body: clip(body, PUSH_BODY_MAX),
		url,
		tag: tag.slice(0, 200),
		ts: newest.at,
	};
}
