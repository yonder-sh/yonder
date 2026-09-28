/**
 * Fill a day (One Yonder D04): the day in view's ideas in the map's place,
 * where it sleeps (its city, else the whole scope): the shortlist first, then
 * more ideas, by the group's rating. + adds one to the day; tick a few and
 * "Add to Sat 9 Oct" adds them together. "Show map" puts the map back.
 */
import { Check, Map as MapIcon, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { TypeGlyph } from "@/components/common/glyphs";
import { RatingPill } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { PlaceRow } from "@/features/places/tab/model";
import { categoryLabel } from "@/features/places/tab/PlacesTable";
import {
	PlaceActionsProvider,
	usePlaceActions,
} from "@/features/places/tab/use-place-actions";
import { usePlaces } from "@/features/places/tab/use-places";
import { formatDayDate, formatDayShort, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ratingOf } from "@/lib/workspace/filter-match";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { cardTone } from "./card-tone";
import { PLAN_TESTID } from "./testids";

export function FillDay() {
	return (
		<PlaceActionsProvider>
			<FillDayBody />
		</PlaceActionsProvider>
	);
}

function FillDayBody() {
	const { ix, days, nav } = useWorkspace();
	const act = usePlaceActions();
	const data = usePlaces("");
	const day = days ? ix.days.find((d) => d.date === days.from) : undefined;
	const city = day?.nightNodeId
		? (ix.hierarchy.nearestOfType(day.nightNodeId, "city") ??
			ix.hierarchy.collapseTo(day.nightNodeId, "region"))
		: undefined;
	const onDay = useMemo(
		() =>
			new Set(
				(day ? (ix.itemsByDay.get(day.id) ?? []) : []).map((i) => i.nodeId),
			),
		[ix, day],
	);
	const rows = data.rows.filter(
		(r) =>
			r.status !== "dropped" &&
			r.node.type === "place" &&
			(!city || ix.isWithin(r.id, city.id)),
	);
	const shortlist = rows.filter(
		(r) => r.status === "shortlist" || r.status === "scheduled",
	);
	const more = rows.filter((r) => r.status === "idea");
	const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
	if (!day) return null;
	const short = formatDayShort(day.date);
	const where = city?.name ?? "the trip";
	const add = (r: PlaceRow) =>
		act.addToDay(
			r,
			day.id,
			`Added ${r.name} to Day ${ix.dayNumber(day.id)} · ${formatDayDate(day.date)}`,
		);
	const toggle = (id: string) =>
		setPicked((p) => {
			const next = new Set(p);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const chosen = rows.filter((r) => picked.has(r.id));
	const section = (title: string, list: PlaceRow[]) =>
		list.length ? (
			<section className="grid gap-2" aria-label={title}>
				<h3 className="eyebrow">
					{title} · <span className="tnum">{list.length}</span>
				</h3>
				{list.map((r) => (
					<IdeaLine
						key={r.id}
						row={r}
						on={onDay.has(r.id) ? short : null}
						picked={picked.has(r.id)}
						onPick={() => toggle(r.id)}
						onAdd={() => add(r)}
						canEdit={act.canEdit}
					/>
				))}
			</section>
		) : null;
	return (
		<div
			data-testid={PLAN_TESTID.fillDay}
			className="relative flex h-full min-h-0 flex-col bg-background"
		>
			<div className="flex flex-wrap items-start gap-3 px-6 pt-5 pb-3">
				<div className="min-w-0 flex-1">
					<h2 className="font-display text-2xl leading-8 font-semibold">
						Ideas in {where}
					</h2>
					<p className="text-meta text-muted-foreground">
						<span className="tnum">{rows.length}</span>{" "}
						{rows.length === 1 ? "place" : "places"} ·{" "}
						<span className="tnum">{shortlist.length}</span> on the shortlist ·
						sorted by the group's rating
					</p>
				</div>
				<Button variant="outline" size="sm" onClick={() => nav.fillDay(null)}>
					<MapIcon />
					Show map
				</Button>
			</div>
			<div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto px-6 pb-24">
				{section("Shortlist", shortlist)}
				{section("More ideas", more)}
				{rows.length ? null : (
					<p className="text-meta text-muted-foreground">
						No ideas in {where} yet: search for places with ⌘K.
					</p>
				)}
			</div>
			{chosen.length ? (
				<div
					data-testid={PLAN_TESTID.fillBar}
					className="absolute inset-x-6 bottom-5 flex items-center gap-3 rounded-xl bg-foreground px-4 py-2.5 text-background shadow-float"
				>
					<span className="shrink-0 font-semibold">
						{chosen.length} selected
					</span>
					<span className="min-w-0 flex-1 truncate text-meta opacity-80">
						{chosen.map((r) => r.name).join(", ")}
					</span>
					<Button
						size="sm"
						disabled={!act.canEdit}
						onClick={async () => {
							for (const r of chosen) if (!onDay.has(r.id)) await add(r);
							setPicked(new Set());
						}}
					>
						<Plus />
						Add to {formatDayDate(day.date)}
					</Button>
					<Button
						size="icon-sm"
						variant="ghost"
						aria-label="Clear the selection"
						className="text-background hover:bg-background/15"
						onClick={() => setPicked(new Set())}
					>
						<X />
					</Button>
				</div>
			) : null}
		</div>
	);
}

function IdeaLine({
	row,
	on,
	picked,
	onPick,
	onAdd,
	canEdit,
}: {
	row: PlaceRow;
	/** "Sat 9": already on the day. */
	on: string | null;
	picked: boolean;
	onPick: () => void;
	onAdd: () => void;
	canEdit: boolean;
}) {
	// The group's best, as the ideas list shows it.
	const top = ratingOf(row.node, "max");
	const meta = [
		row.timeMin ? formatDuration(row.timeMin) : null,
		row.where.split(" › ").at(-1),
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<div
			data-testid={PLAN_TESTID.fillIdea}
			data-place={row.id}
			data-family={cardTone(row.node)}
			className={cn(
				"plan-card flex min-h-16 items-center gap-3 rounded-lg border bg-card px-3 py-2",
				picked && "border-primary bg-primary/5",
			)}
		>
			<Checkbox
				checked={picked}
				disabled={!!on}
				onCheckedChange={onPick}
				aria-label={`Pick ${row.name}`}
			/>
			<span
				aria-hidden
				className="plan-icon flex size-9 shrink-0 items-center justify-center rounded-full"
			>
				<TypeGlyph
					type={row.node.type}
					category={row.node.category}
					tinted={false}
					className="size-4 text-current"
				/>
			</span>
			<span className="grid min-w-0 flex-1 gap-0.5">
				<span className="truncate font-medium">{row.name}</span>
				<span className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
					{top ? <RatingPill level={top} size="sm" /> : null}
					<span className="truncate">{meta || categoryLabel(row)}</span>
				</span>
			</span>
			{on ? (
				<span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
					<Check className="size-3.5" />
					On {on}
				</span>
			) : (
				<Button
					size="sm"
					variant="outline"
					disabled={!canEdit}
					data-testid={PLAN_TESTID.fillAdd}
					onClick={onAdd}
				>
					<Plus />
					Add
				</Button>
			)}
		</div>
	);
}
