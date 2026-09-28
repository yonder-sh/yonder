/**
 * Decide (One Yonder D08): the places in three columns, **Shortlist** (from
 * the group's ratings), **Disagreements** (split ratings, with what people
 * said) and **Not going**. Each card shows everyone's rating; Keep pins it
 * on the shortlist, Not going drops it, Bring back undoes that. Above them:
 * who the rest are waiting on (Remind) and how the shortlist works.
 */
import { Check, CircleHelp, MessageSquare } from "lucide-react";
import { TypeGlyph } from "@/components/common/glyphs";
import { MemberAvatar, RatingPill } from "@/components/kit";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cardTone } from "@/features/plan/card-tone";
import { PRIORITIES, PRIORITY_ORDER } from "@/lib/domain/taxonomy";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { commentVisibleText } from "../lib/rate";
import type { PlaceRow } from "./model";
import { categoryLabel } from "./PlacesTable";
import { personName, RemindButton } from "./RatingPeople";
import { formatScore, RATING_WEIGHT } from "./score";
import { PLACES_TAB_TESTID } from "./testids";
import { usePlaceActions } from "./use-place-actions";
import type { PlacesData } from "./use-places";

type Column = "shortlist" | "talk" | "out";

/** Which column a place is in: a split rating is talked through first. */
export function decideColumn(row: PlaceRow): Column | null {
	if (row.status === "dropped") return "out";
	if (row.split) return "talk";
	if (row.status === "shortlist" || row.status === "scheduled")
		return "shortlist";
	return null;
}

const COLUMNS: { key: Column; title: string; note: string; dot: string }[] = [
	{
		key: "shortlist",
		title: "Shortlist",
		note: "from the group's ratings",
		dot: "bg-primary",
	},
	{
		key: "talk",
		title: "Disagreements",
		note: "talk these through",
		dot: "bg-warning",
	},
	{ key: "out", title: "Not going", note: "", dot: "bg-destructive" },
];

export function PlacesDecide({ data }: { data: PlacesData }) {
	const by: Record<Column, PlaceRow[]> = { shortlist: [], talk: [], out: [] };
	for (const r of data.visible) {
		const c = decideColumn(r);
		if (c) by[c].push(r);
	}
	return (
		<div
			data-testid={PLACES_TAB_TESTID.decide}
			className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-6 sm:px-6"
		>
			<DecideStrip data={data} />
			<div className="grid auto-rows-min grid-cols-1 items-start gap-4 lg:grid-cols-3">
				{COLUMNS.map((col) => (
					<section
						key={col.key}
						data-testid={PLACES_TAB_TESTID.decideColumn}
						data-column={col.key}
						aria-label={col.title}
						className="flex min-w-0 flex-col gap-2.5 rounded-xl bg-muted/60 p-3"
					>
						<h3 className="flex items-baseline gap-2 px-1">
							<span
								aria-hidden
								className={cn("size-2 self-center rounded-full", col.dot)}
							/>
							<span className="font-semibold">{col.title}</span>
							<span className="text-meta text-muted-foreground tnum">
								{by[col.key].length}
								{col.note ? ` · ${col.note}` : ""}
							</span>
						</h3>
						{by[col.key].length ? (
							by[col.key].map((r) => (
								<DecideCard key={r.id} row={r} data={data} column={col.key} />
							))
						) : (
							<p className="px-1 py-2 text-meta text-muted-foreground">
								{col.key === "talk"
									? "Nothing to talk about: everyone agrees."
									: col.key === "out"
										? "Nothing dropped."
										: "Nothing on the shortlist yet."}
							</p>
						)}
					</section>
				))}
			</div>
		</div>
	);
}

/** "12 more are waiting on Maya's rating · Remind" and "How the shortlist works". */
function DecideStrip({ data }: { data: PlacesData }) {
	const act = usePlaceActions();
	const waiting = data.progress
		.filter((p) => p.counted && p.member.id !== act.me && p.rated < p.total)
		.sort((a, b) => b.total - b.rated - (a.total - a.rated))
		.slice(0, 2);
	const { bar } = data;
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-meta text-muted-foreground">
			{waiting.map((p) => (
				<span
					key={p.member.id}
					data-testid={PLACES_TAB_TESTID.decideWaiting}
					className="inline-flex items-center gap-2"
				>
					<span>
						<span className="tnum">{p.total - p.rated}</span> more{" "}
						{p.total - p.rated === 1 ? "is" : "are"} waiting on{" "}
						{personName(p.member, act.me)}'s rating
					</span>
					<RemindButton member={p.member} left={p.total - p.rated} />
				</span>
			))}
			<Popover>
				<PopoverTrigger asChild>
					<button
						type="button"
						className="ml-auto inline-flex cursor-pointer items-center gap-1 hover:text-foreground"
					>
						<CircleHelp className="size-3.5" />
						How the shortlist works
					</button>
				</PopoverTrigger>
				<PopoverContent align="end" className="grid w-80 gap-2 text-sm">
					<p>
						A place joins the shortlist when the group's ratings add up to{" "}
						<b className="tnum">{formatScore(bar.bar)}</b> (with {bar.people}{" "}
						{bar.people === 1 ? "person" : "people"} rating).
					</p>
					<p className="text-muted-foreground">
						{PRIORITY_ORDER.map(
							(p) => `${PRIORITIES[p].label} ${formatScore(RATING_WEIGHT[p])}`,
						).join(" · ")}
						. Places people disagree on wait under Disagreements. Keep puts one
						on the shortlist whatever its score; Not going takes it out.
					</p>
				</PopoverContent>
			</Popover>
		</div>
	);
}

function DecideCard({
	row,
	data,
	column,
}: {
	row: PlaceRow;
	data: PlacesData;
	column: Column;
}) {
	const act = usePlaceActions();
	const node = row.node;
	const comments = data.memberIds
		.map((id) => ({ id, text: node.ratingComments[id] }))
		.filter((c): c is { id: string; text: string } => !!c.text);
	const meta = [
		categoryLabel(row),
		row.timeMin ? formatDuration(row.timeMin) : null,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<article
			data-testid={PLACES_TAB_TESTID.decideCard}
			data-place={node.id}
			data-cursor-anchor={`place:${node.id}`}
			className="plan-card flex flex-col gap-2.5 rounded-lg border bg-card p-3"
			data-family={cardTone(node)}
		>
			<div className="flex min-w-0 items-start gap-2.5">
				<span
					aria-hidden
					className="plan-icon flex size-8 shrink-0 items-center justify-center rounded-full"
				>
					<TypeGlyph
						type={node.type}
						category={node.category}
						tinted={false}
						className="size-4 text-current"
					/>
				</span>
				<div className="min-w-0">
					<h4 className="truncate font-semibold">{row.name}</h4>
					{meta ? (
						<p className="truncate text-meta text-muted-foreground">{meta}</p>
					) : null}
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
				{data.memberIds.map((id) => (
					<span key={id} className="inline-flex items-center gap-1">
						<MemberAvatar memberId={id} size={16} ring={false} />
						<RatingPill level={node.priorities[id] ?? null} size="sm" />
					</span>
				))}
			</div>
			{column === "talk" && comments.length ? (
				<ul className="grid gap-1 text-meta text-muted-foreground">
					{comments.slice(0, 2).map((c) => (
						<li key={c.id} className="flex min-w-0 items-start gap-1.5">
							<MessageSquare className="mt-0.5 size-3.5 shrink-0" aria-hidden />
							<span className="line-clamp-2 italic">
								{commentVisibleText(c.text)}
							</span>
						</li>
					))}
				</ul>
			) : null}
			<div className="flex flex-wrap items-center gap-2">
				{column === "out" ? (
					<Button
						size="sm"
						variant="outline"
						disabled={!act.canEdit}
						data-testid={PLACES_TAB_TESTID.decideBack}
						onClick={() => act.toggleDropped(row)}
					>
						Bring back
					</Button>
				) : (
					<>
						<Button
							size="sm"
							variant={row.info.pinned ? "secondary" : "outline"}
							aria-pressed={row.info.pinned}
							disabled={!act.canEdit}
							data-testid={PLACES_TAB_TESTID.decideKeep}
							onClick={() => act.togglePin(row, data.threshold)}
						>
							<Check />
							{row.info.pinned ? "Kept" : "Keep"}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							disabled={!act.canEdit}
							data-testid={PLACES_TAB_TESTID.decideDrop}
							onClick={() => act.toggleDropped(row)}
						>
							Not going
						</Button>
					</>
				)}
			</div>
		</article>
	);
}
