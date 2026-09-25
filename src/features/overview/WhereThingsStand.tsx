/**
 * "Where things stand" (owner, 2026-09-25): the trip's progress in five
 * plain lines, each opening where it gets done. The first open line is
 * what's next: it stands out and, when you can do it, carries the action
 * ("Rate 12 places", "Schedule"). The rating line offers "Remind" for
 * people with places left. Viewers get the lines only. On the Overview's
 * dark hero (`tone="hero"`) and in the welcome (`compact`).
 */
import { cn } from "cn";
import { ChevronRight, Circle, CircleCheck } from "lucide-react";
import { useId } from "react";
import { RemindButton } from "@/features/places/tab/RatingPeople";
import { lastReviewView } from "@/features/places/tab/use-places";
import {
	remindable,
	useCanRemind,
} from "@/features/places/tab/use-rating-people";
import { canRateOwn } from "@/lib/auth/roles";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import type { Standing, StandingKey, StandingLine } from "./lib/standing";
import { STANDING_TESTID } from "./testids-standing";

type Action = { label: string; run: () => void };

/** Where each line opens, and the next line's action (null when you can't). */
function useStandingNav(standing: Standing) {
	const { nav, access, ix } = useWorkspace();
	const openAddPlace = useUi((s) => s.openAddPlace);
	const setSettingsOpen = useUi((s) => s.setSettingsOpen);
	const canEdit = access.mode !== "read";
	const places = (pv: "rate" | "schedule" | null) =>
		nav.openPlaces({
			scopeId: null,
			patch: {
				pv: pv ?? lastReviewView.current,
				pst: undefined,
				talk: undefined,
			},
		});
	const open: Record<StandingKey, () => void> = {
		places: () => places(null),
		rating: () => places("rate"),
		cities: () => nav.setTab("plan"),
		days: () => places("schedule"),
		stays: () => nav.setTab("plan"),
	};
	const hasDays = ix.days.length > 0;
	const action = (key: StandingKey): Action | null => {
		switch (key) {
			case "places":
				return canEdit
					? {
							label: "Add a place",
							run: () => {
								places(null);
								openAddPlace({ mode: "search" });
							},
						}
					: null;
			case "rating":
				return canRateOwn(access) && standing.myLeft
					? {
							label: `Rate ${standing.myLeft} ${standing.myLeft === 1 ? "place" : "places"}`,
							run: open.rating,
						}
					: null;
			case "cities":
				if (!canEdit) return null;
				return hasDays
					? { label: "Open the plan", run: open.cities }
					: { label: "Pick dates", run: () => setSettingsOpen(true) };
			case "days":
				return canEdit && hasDays && standing.favourites
					? { label: "Schedule", run: open.days }
					: null;
			case "stays":
				return canEdit && hasDays
					? { label: "Open the plan", run: open.stays }
					: null;
		}
	};
	return { open, action };
}

export function WhereThingsStand({
	standing,
	tone = "plain",
	compact = false,
	actions = true,
	onNavigate,
	className,
}: {
	standing: Standing;
	tone?: "hero" | "plain";
	compact?: boolean;
	/** False in the welcome: a quiet list (it has its own button). */
	actions?: boolean;
	/** Called after a line opens somewhere (the welcome closes). */
	onNavigate?: () => void;
	className?: string;
}) {
	const { open, action } = useStandingNav(standing);
	const { access } = useWorkspace();
	const canRemind = useCanRemind();
	const titleId = useId();
	const hero = tone === "hero";
	const remind =
		canRemind && !compact
			? standing.people.filter((p) =>
					remindable(p.member, access.memberId, p.left),
				)
			: [];
	return (
		<section
			data-testid={STANDING_TESTID.card}
			data-next={standing.next ?? "none"}
			aria-labelledby={titleId}
			className={cn(
				"rounded-xl border",
				hero ? "border-white/10 bg-white/[.04]" : "bg-card",
				compact ? "px-3 py-2.5" : "px-3.5 py-3",
				className,
			)}
		>
			<h2
				id={titleId}
				className={cn(
					"mb-1.5 text-[11px] font-semibold tracking-[.06em] uppercase",
					hero ? "text-white/55" : "text-muted-foreground",
				)}
			>
				Where things stand
			</h2>
			<ul className="grid gap-0.5">
				{standing.lines.map((l) => (
					<Line
						key={l.key}
						line={l}
						next={l.key === standing.next}
						hero={hero}
						action={actions && l.key === standing.next ? action(l.key) : null}
						onOpen={() => {
							open[l.key]();
							onNavigate?.();
						}}
						onAction={onNavigate}
						remind={l.key === "rating" ? remind : []}
					/>
				))}
			</ul>
		</section>
	);
}

function Line({
	line,
	next,
	hero,
	action,
	onOpen,
	onAction,
	remind,
}: {
	line: StandingLine;
	next: boolean;
	hero: boolean;
	action: Action | null;
	onOpen: () => void;
	onAction?: () => void;
	remind: Standing["people"];
}) {
	const Icon = line.done ? CircleCheck : Circle;
	return (
		<li
			data-testid={STANDING_TESTID.line}
			data-key={line.key}
			data-done={line.done}
			data-next={next || undefined}
			className={cn(
				"-mx-1.5 grid gap-1 rounded-lg px-1.5 py-1",
				next && (hero ? "bg-white/[.06]" : "bg-primary/5"),
			)}
		>
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={onOpen}
					className={cn(
						"group flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
						hero ? "text-white/85" : "text-foreground",
					)}
				>
					<Icon
						aria-hidden
						strokeWidth={1.75}
						className={cn(
							"mt-0.5 size-4 shrink-0",
							line.done
								? "text-emerald-500 dark:text-emerald-400"
								: hero
									? "text-white/40"
									: "text-muted-foreground/60",
						)}
					/>
					<span className="sr-only">{line.done ? "Done: " : "To do: "}</span>
					<span className="min-w-0 flex-1">
						{line.label ? (
							<span
								className={cn(
									"font-medium",
									next && !hero && "text-foreground",
								)}
							>
								{line.label}:{" "}
							</span>
						) : null}
						<span
							className={cn(
								hero ? "text-white/70" : "text-muted-foreground",
								!line.label && (hero ? "text-white/85" : "text-foreground"),
							)}
						>
							{line.detail}
						</span>
					</span>
					{action ? null : (
						<ChevronRight
							aria-hidden
							className={cn(
								"mt-0.5 size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
								hero ? "text-white/50" : "text-muted-foreground",
							)}
						/>
					)}
				</button>
				{action ? (
					<button
						type="button"
						data-testid={STANDING_TESTID.action}
						onClick={() => {
							action.run();
							onAction?.();
						}}
						className={cn(
							"inline-flex h-8 shrink-0 cursor-pointer items-center rounded-lg px-3 text-[13px] font-medium transition-colors",
							hero
								? "border border-white/20 text-white hover:bg-white/10"
								: "bg-primary text-primary-foreground hover:bg-primary/90",
						)}
					>
						{action.label}
					</button>
				) : null}
			</div>
			{remind.length ? (
				<div className="flex flex-wrap gap-x-3 gap-y-1 pl-6 text-xs">
					{remind.map((p) => (
						<RemindButton
							key={p.member.id}
							member={p.member}
							left={p.left}
							named
						/>
					))}
				</div>
			) : null}
		</li>
	);
}
