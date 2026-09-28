/**
 * Decide (One Yonder D08): the places in three columns, **Shortlist** (from
 * the group's ratings), **Disagreements** (split ratings, with what people
 * said) and **Not going**. Each card shows everyone's rating; Keep pins it
 * on the shortlist, Not going drops it, Bring back undoes that. Above them:
 * who the rest are waiting on (Remind), how the shortlist works, and "Mark
 * Kyoto decided" (the Where picker's scope; `lib/decided.ts`): decided
 * places stop asking, so a split one leaves Disagreements for a quiet note.
 */
import { Check, CircleCheck, CircleHelp, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { EditGuard, useEditGuard } from "@/components/common/edit-guard";
import { TypeGlyph } from "@/components/common/glyphs";
import { undoToast } from "@/components/common/undo-toast";
import { MemberAvatar, RatingPill } from "@/components/kit";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cardTone } from "@/features/plan/card-tone";
import { PRIORITIES, PRIORITY_ORDER } from "@/lib/domain/taxonomy";
import { humanError } from "@/lib/errors";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import {
	addedSince,
	type DecidedMark,
	scopeDecision,
	whereName,
} from "../lib/decided";
import { commentVisibleText } from "../lib/rate";
import { useSetDecided } from "../mutations";
import type { PlaceRow } from "./model";
import { categoryLabel } from "./PlacesTable";
import { personName, RemindButton } from "./RatingPeople";
import { formatScore, RATING_WEIGHT } from "./score";
import { PLACES_TAB_TESTID } from "./testids";
import { usePlaceActions } from "./use-place-actions";
import type { PlacesData } from "./use-places";

type Column = "shortlist" | "talk" | "out";

/** Which column a place is in: a split rating is talked through first, unless it's decided. */
export function decideColumn(
	row: Pick<PlaceRow, "status" | "split"> & { decided?: boolean },
): Column | null {
	if (row.status === "dropped") return "out";
	if (row.split && !row.decided) return "talk";
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
	// Split, but decided: no longer to talk through (a quiet note instead).
	const settled = data.visible.filter(
		(r) => r.split && r.decided && r.status !== "dropped",
	);
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
						) : col.key === "talk" && settled.length ? null : (
							<p className="px-1 py-2 text-meta text-muted-foreground">
								{col.key === "talk"
									? "Nothing to talk about: everyone agrees."
									: col.key === "out"
										? "Nothing dropped."
										: "Nothing on the shortlist yet."}
							</p>
						)}
						{col.key === "talk" && settled.length ? (
							<p
								data-testid={PLACES_TAB_TESTID.decideSettled}
								className="px-1 py-1 text-meta text-muted-foreground"
							>
								Split, but decided:{" "}
								{settled
									.slice(0, 5)
									.map((r) => r.name)
									.join(", ")}
								{settled.length > 5 ? ` and ${settled.length - 5} more` : ""}
							</p>
						) : null}
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
					<p className="text-muted-foreground">
						Mark a place, a city or the trip decided when you're done: its
						places stop asking for ratings. Places added later still ask.
					</p>
				</PopoverContent>
			</Popover>
			<DecidedControl data={data} />
		</div>
	);
}

/** The header's text buttons (Undo, Mark them decided). */
const TEXT_BUTTON =
	"cursor-pointer text-primary hover:underline disabled:cursor-default disabled:opacity-50 disabled:no-underline";

/**
 * "Mark Kyoto decided" (editors); once marked, "Decided · Undo"; inside a
 * decided scope, "Decided with Japan", which goes there (the undo lives there).
 * Places added since the mark still ask: "Mark them decided" moves the mark
 * to now (inside Japan, "Mark Japan's new places decided": the same mark).
 */
export function DecidedControl({ data }: { data: PlacesData }) {
	const { ix, scope, graph, nav } = useWorkspace();
	const guard = useEditGuard("edit-only");
	const set = useSetDecided(graph.trip.id);
	const state = scopeDecision(ix, scope);
	const nodeId = scope?.id ?? null;
	const where = whereName(scope);
	const mark = (decided: boolean) => {
		if (guard.disabled) return;
		const vars = { nodeId, decided, by: graph.me.userId };
		set.mutate(vars, {
			onError: (e) => toast.error(humanError(e)),
			onSuccess: () => {
				if (decided)
					undoToast(`Marked ${where} decided`, () =>
						set.mutate({ ...vars, decided: false }),
					);
			},
		});
	};
	// The mark moves to now; Undo puts its old stamp back.
	const remark = (m: DecidedMark) => {
		if (guard.disabled) return;
		const vars = { nodeId: m.scopeId, decided: true, by: graph.me.userId };
		set.mutate(vars, {
			onError: (e) => toast.error(humanError(e)),
			onSuccess: () =>
				undoToast(`Marked ${m.name}'s new places decided`, () =>
					set.mutate({ ...vars, at: m.at }),
				),
		});
	};
	// Added since the mark: they still ask.
	const since = addedSince(data.rows);
	const remarkButton =
		state.kind !== "open" && since ? (
			<>
				<span className="tnum">· {since} added since</span>
				<span aria-hidden>·</span>
				<EditGuard kind="edit-only">
					<button
						type="button"
						data-testid={PLACES_TAB_TESTID.decideRemark}
						onClick={() => remark(state.mark)}
						className={TEXT_BUTTON}
					>
						{state.remark}
					</button>
				</EditGuard>
			</>
		) : null;
	if (state.kind === "decided") {
		const who = graph.members.find(
			(m) => m.userId && m.userId === state.mark.by,
		);
		return (
			<span
				data-testid={PLACES_TAB_TESTID.decideDecided}
				title={who ? `Marked decided by ${who.name}` : undefined}
				className="inline-flex flex-wrap items-center gap-1.5"
			>
				<CircleCheck className="size-3.5 text-primary" aria-hidden />
				<span className="font-medium text-foreground">Decided</span>
				{remarkButton}
				<span aria-hidden>·</span>
				<EditGuard kind="edit-only">
					<button
						type="button"
						data-testid={PLACES_TAB_TESTID.decideUndo}
						onClick={() => mark(false)}
						className={TEXT_BUTTON}
					>
						Undo
					</button>
				</EditGuard>
			</span>
		);
	}
	if (state.kind === "inherited")
		return (
			<span className="inline-flex flex-wrap items-center gap-1.5">
				<Button
					size="sm"
					variant="outline"
					data-testid={PLACES_TAB_TESTID.decideDecidedWith}
					title={`Marked in ${state.mark.name}: undo it there`}
					onClick={() =>
						nav.openPlaces({
							scopeId: state.mark.scopeId,
							patch: { pv: "decide" },
						})
					}
				>
					<CircleCheck className="text-primary" />
					{state.label}
				</Button>
				{remarkButton}
			</span>
		);
	return (
		<EditGuard kind="edit-only">
			<Button
				size="sm"
				data-testid={PLACES_TAB_TESTID.decideMark}
				onClick={() => mark(true)}
			>
				<Check />
				{state.label}
			</Button>
		</EditGuard>
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
	const { sel, nav } = useWorkspace();
	const node = row.node;
	const selected = sel?.kind === "node" && sel.id === node.id;
	const open = () => nav.select({ kind: "node", id: node.id });
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
		// biome-ignore lint/a11y/useKeyWithClickEvents: the name is the card's keyboard way in
		<article
			data-testid={PLACES_TAB_TESTID.decideCard}
			data-place={node.id}
			data-cursor-anchor={`place:${node.id}`}
			aria-current={selected || undefined}
			// A click anywhere but its buttons opens the place (its details).
			onClick={(e) => {
				if (!(e.target as HTMLElement).closest("button,a,input")) open();
			}}
			className={cn(
				"plan-card flex cursor-pointer flex-col gap-2.5 rounded-lg border bg-card p-3 transition-colors hover:border-foreground/20",
				selected && "border-primary ring-1 ring-primary",
			)}
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
					<h4 className="truncate font-semibold">
						<button
							type="button"
							data-testid={PLACES_TAB_TESTID.decideOpen}
							onClick={open}
							className="max-w-full cursor-pointer truncate rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
						>
							{row.name}
						</button>
					</h4>
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
