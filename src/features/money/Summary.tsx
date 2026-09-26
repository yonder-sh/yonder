/**
 * The Money tab's summary (EXTENSIONS §8.6, ADDENDUM §6 "totals and true-ups
 * at EVERY scope"): planned · paid · still to pay, the delta vs plan, my
 * share, points per programme with cents per point, the per-person table,
 * the scope's net positions, and the trip-wide balances with settle-up.
 */
import { cn } from "cn";
import { ArrowRight, Lock } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import {
	MemberName,
	PersonAvatar,
	resolveMember,
} from "@/components/common/member";
import { Button } from "@/components/ui/button";
import {
	formatCpp,
	formatMoney,
	formatMoneyShort,
	type ScopeSummary,
} from "@/lib/engine/money";
import type { GraphMember } from "@/lib/engine/types";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import type { MoneyDto } from "./money.functions";
import { Num, Overline, signed } from "./money-ui";
import { MONEY_TESTID } from "./testids";
import type { Display, MoneyView } from "./use-money";
import { useMoneyUi } from "./use-money";

/**
 * One summary tile. The full amount when it fits; on a narrow phone a
 * 7-figure total ("¥12,345,678") switches to its compact form ("¥12.3M")
 * instead of being cut off, with the full amount in the tooltip and for
 * screen readers (polish, FB round 2).
 */
function Stat({
	label,
	value,
	short,
	testid,
	muted,
}: {
	label: string;
	value: string;
	/** The compact form, used when `value` doesn't fit. */
	short?: string;
	testid: string;
	muted?: boolean;
}) {
	const box = useRef<HTMLDivElement>(null);
	const probe = useRef<HTMLSpanElement>(null);
	const [compact, setCompact] = useState(false);
	useLayoutEffect(() => {
		const el = box.current;
		const full = probe.current;
		if (!el || !full || !short || short === value) {
			setCompact(false);
			return;
		}
		const check = () => setCompact(full.offsetWidth > el.clientWidth + 0.5);
		check();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(check);
		ro.observe(el);
		return () => ro.disconnect();
	}, [value, short]);
	const shown = compact && short ? short : value;
	return (
		<div className="min-w-0">
			<div className="text-[11px] leading-[14px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
				{label}
			</div>
			<div ref={box} className="relative mt-1 min-w-0">
				{/* The full amount, measured in a zero-size clip (it never widens the
				    tile or the page): does it fit this tile? */}
				<span
					aria-hidden="true"
					className="pointer-events-none invisible absolute top-0 left-0 size-0 overflow-hidden"
				>
					<span
						ref={probe}
						className="inline-block font-mono text-lg leading-6 font-semibold whitespace-nowrap tnum sm:text-xl"
					>
						{value}
					</span>
				</span>
				<Num
					className={cn(
						"block text-lg leading-6 font-semibold whitespace-nowrap sm:text-xl",
						// Even the compact form never cuts: it wraps.
						compact && "whitespace-normal [overflow-wrap:anywhere]",
						muted && "text-muted-foreground",
					)}
				>
					<span
						data-testid={testid}
						data-compact={compact || undefined}
						title={compact ? value : undefined}
					>
						{shown}
					</span>
					{compact ? <span className="sr-only">({value})</span> : null}
				</Num>
			</div>
		</div>
	);
}

const firstName = (members: readonly GraphMember[], id: string) => {
	const m = resolveMember(members, id);
	return m?.firstName || m?.name?.split(" ")[0] || "Someone";
};

export function SummaryStrip({
	summary: s,
	display: d,
	meId,
}: {
	summary: ScopeSummary;
	display: Display;
	meId: string | null;
}) {
	const mine = meId ? s.perPerson[meId] : undefined;
	const hasPaidPlan = s.deltaHome !== 0;
	/** Every cost in one currency: its exact total (a "Local" display shows it as is). */
	const exact = (k: "planned" | "actual" | "remaining") =>
		s.original ? { currency: s.original.currency, minor: s.original[k] } : null;
	/** My share, exact in the display currency when every cost is in it (QA MONEY-19). */
	const ex = d.exactOf(s);
	const myExact = ex && meId ? ex.perPerson[meId] : undefined;
	const share = (k: "planned" | "actual") =>
		myExact
			? formatMoney(myExact[k], d.code)
			: d.fmt(mine?.[k] ?? 0, { approx: false });
	return (
		<section
			data-testid={MONEY_TESTID.summary}
			data-cursor-anchor="money:summary"
			className="px-4 pt-3 pb-4"
		>
			<div className="grid grid-cols-3 gap-3">
				<Stat
					label="Planned"
					value={d.fmtTotal(s.plannedHome, exact("planned"))}
					short={d.fmtTotal(s.plannedHome, exact("planned"), { short: true })}
					testid={MONEY_TESTID.summaryPlanned}
				/>
				<Stat
					label="Paid"
					value={d.fmtTotal(s.actualHome, exact("actual"))}
					short={d.fmtTotal(s.actualHome, exact("actual"), { short: true })}
					testid={MONEY_TESTID.summaryActual}
				/>
				<Stat
					label="Still to pay"
					value={d.fmtTotal(s.remainingHome, exact("remaining"))}
					short={d.fmtTotal(s.remainingHome, exact("remaining"), {
						short: true,
					})}
					testid={MONEY_TESTID.summaryRemaining}
					muted={s.remainingHome === 0}
				/>
			</div>
			<div className="mt-3 space-y-1 text-[13px] leading-[18px] text-muted-foreground">
				{mine ? (
					<p>
						Your share{" "}
						<Num className="text-foreground">
							<span data-testid={MONEY_TESTID.summaryMyShare}>
								{share("planned")}
							</span>
						</Num>{" "}
						planned · <Num className="text-foreground">{share("actual")}</Num>{" "}
						paid
						{s.privateCount ? (
							<>
								{" · "}
								<span className="inline-flex items-center gap-1 whitespace-nowrap">
									<Lock className="size-3" aria-hidden="true" />
									<Num>{d.fmt(s.privatePlannedHome, { approx: false })}</Num>{" "}
									private
								</span>
							</>
						) : null}
					</p>
				) : null}
				{hasPaidPlan ? (
					<p>
						Paid costs came in{" "}
						<Num className="text-foreground">
							{d.fmt(Math.abs(s.deltaHome), { approx: false })}
						</Num>{" "}
						{s.deltaHome > 0 ? "over" : "under"} plan.
					</p>
				) : null}
				{s.unconverted ? (
					<p>
						{s.unconverted === 1 ? "1 cost is" : `${s.unconverted} costs are`}{" "}
						waiting for an exchange rate.
					</p>
				) : null}
			</div>
			{s.programs.length ? (
				<ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Points">
					{s.programs.map((p) => (
						<li
							key={p.program}
							className="inline-flex h-[22px] items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs"
						>
							<span className="font-medium">{p.program}</span>
							{p.points ? <Num>{p.points.toLocaleString("en")} pts</Num> : null}
							{p.cpp !== null ? (
								<Num className="text-muted-foreground">
									{formatCpp(p.cpp, d.home)}
								</Num>
							) : null}
							{p.sourcePoints ? (
								<span className="text-muted-foreground">
									source <Num>{p.sourcePoints.toLocaleString("en")}</Num>
									{p.sourceCpp !== null ? (
										<Num> · {formatCpp(p.sourceCpp, d.home)}</Num>
									) : null}
								</span>
							) : null}
						</li>
					))}
				</ul>
			) : null}
		</section>
	);
}

/** An amount column of the Per person table: right-aligned, one line, a gap before it. */
const AMOUNT = "pl-3 text-right whitespace-nowrap sm:pl-4";

/** Per person in this scope: planned share, paid share, and net (paid − share). */
export function PeopleTable({
	summary: s,
	display: d,
	meId,
}: {
	summary: ScopeSummary;
	display: Display;
	meId: string | null;
}) {
	const { graph } = useWorkspace();
	const order = graph.members.map((m) => m.id);
	/** "30,000 Aeroplan" — points per programme for one person. */
	const pointsOf = (id: string) =>
		s.programs
			.filter((p) => p.perMember[id])
			.map((p) => `${(p.perMember[id] ?? 0).toLocaleString("en")} ${p.program}`)
			.join(" · ");
	const ids = Object.keys(s.perPerson).sort(
		(a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99),
	);
	/** Exact in the display currency when every cost is in it (QA MONEY-19). */
	const ex = d.exactOf(s);
	if (!ids.length) return null;
	return (
		<section
			data-testid={MONEY_TESTID.people}
			data-cursor-anchor="money:people"
			className="px-4 pb-4"
		>
			<Overline>Per person</Overline>
			{/*
			 * Phones (owner, 390 px: "$7.2K$0.00$0.0…"): the name column takes
			 * what the amounts leave (`w-full max-w-0`, so a long points line
			 * truncates instead of widening the table), every amount keeps a gap
			 * and never wraps, and at the very narrowest the table scrolls
			 * sideways in its own box rather than clip Net.
			 */}
			<div className="-mx-1 overflow-x-auto px-1">
				<table className="w-full text-[13px] leading-[18px]">
					<thead>
						<tr className="text-xs whitespace-nowrap text-muted-foreground">
							<th className="w-full max-w-0 py-1 text-left font-normal">
								<span className="sr-only">Person</span>
							</th>
							<th className={cn(AMOUNT, "py-1 font-normal")}>Planned</th>
							<th className={cn(AMOUNT, "py-1 font-normal")}>
								<span className="sm:hidden">Paid</span>
								<span className="max-sm:hidden">Paid share</span>
							</th>
							<th className={cn(AMOUNT, "py-1 font-normal")}>Net</th>
						</tr>
					</thead>
					<tbody>
						{ids.map((id) => {
							const p = s.perPerson[id];
							if (!p) return null;
							const o = ex?.perPerson[id];
							const amount = (k: "planned" | "actual") =>
								o
									? formatMoneyShort(o[k], d.code)
									: d.fmt(p[k], { short: true, approx: false });
							const net = o ? o.net : d.toDisplay(p.net);
							return (
								<tr
									key={id}
									data-testid={MONEY_TESTID.personRow}
									data-member-id={id}
									data-cursor-anchor={`money:p.${id}`}
									className="border-t"
								>
									<td className="w-full max-w-0 py-1.5">
										<span className="flex min-w-0 items-center gap-2">
											<PersonAvatar memberId={id} size={20} />
											<span className="min-w-0">
												<span className="block truncate">
													<MemberName memberId={id} />
													{id === meId ? (
														<span className="text-muted-foreground">
															{" "}
															(you)
														</span>
													) : null}
												</span>
												{pointsOf(id) ? (
													<span
														className="block truncate text-xs text-muted-foreground"
														title={pointsOf(id)}
													>
														{pointsOf(id)}
													</span>
												) : null}
											</span>
										</span>
									</td>
									<td className={cn(AMOUNT, "py-1.5")}>
										<Num>{amount("planned")}</Num>
									</td>
									<td className={cn(AMOUNT, "py-1.5")}>
										<Num>{amount("actual")}</Num>
									</td>
									<td
										className={cn(
											AMOUNT,
											"py-1.5",
											net === 0 && "text-muted-foreground",
										)}
									>
										<Num>{signed(net, d.code)}</Num>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			{d.converted && !ex ? (
				<p className="mt-1 text-xs text-muted-foreground">
					Shown in {d.code}, converted from {d.home} at today's rate.
				</p>
			) : null}
		</section>
	);
}

/**
 * "Within Japan: Dennis paid ¥52k more than his share · Audrey ¥52k less",
 * as information; settling is trip-wide.
 */
export function NetPositions({
	summary: s,
	display: d,
	meId,
	scopeName,
}: {
	summary: ScopeSummary;
	display: Display;
	meId: string | null;
	scopeName: string;
}) {
	const { graph } = useWorkspace();
	const openSettle = useMoneyUi((x) => x.openSettle);
	// In the display currency: exact when every cost is in it (QA MONEY-19),
	// else converted from home.
	const ex = d.exactOf(s);
	const nets = Object.entries(s.perPerson)
		.map(([id, p]) => ({
			id,
			net: ex ? (ex.perPerson[id]?.net ?? 0) : d.toDisplay(p.net),
		}))
		.filter((x) => x.net !== 0)
		.sort((a, b) => b.net - a.net);
	if (!nets.length) return null;
	const phrase = (id: string, net: number, i: number) => {
		const amt = <Num>{formatMoney(Math.abs(net), d.code)}</Num>;
		const who = id === meId ? "You" : firstName(graph.members, id);
		const more = net > 0 ? "more" : "less";
		return (
			<span key={id}>
				{i > 0 ? " · " : null}
				{i === 0 ? (
					<>
						{who} paid {amt} {more} than {id === meId ? "your" : "their"} share
					</>
				) : (
					<>
						{who} {amt} {more}
					</>
				)}
			</span>
		);
	};
	return (
		<section
			data-testid={MONEY_TESTID.netPositions}
			data-cursor-anchor="money:net"
			className="px-4 pb-4"
		>
			<p className="text-[13px] leading-[18px] text-muted-foreground">
				<span className="text-foreground">Within {scopeName}:</span>{" "}
				{nets.map((x, i) => phrase(x.id, x.net, i))}.
			</p>
			<Button
				variant="link"
				size="sm"
				className="h-7 px-0 text-[13px] has-[>svg]:px-0"
				onClick={() => openSettle(true)}
			>
				Settle up for the whole trip <ArrowRight />
			</Button>
		</section>
	);
}

const VERB: Record<string, string> = {
	"expense.add": "added",
	"expense.update": "edited",
	"expense.paid": "marked paid",
	"expense.delete": "deleted",
	"expense.restore": "restored",
};

/**
 * Trip-wide balances in the first person ("You owe Maya $45 · Audrey owes
 * you $120"; others muted), the "balance changed since your last
 * settlement" line, and Settle up.
 */
export function Balances({
	view,
	display: d,
	meId,
	data,
	canSettle,
}: {
	view: MoneyView;
	display: Display;
	meId: string | null;
	data: MoneyDto;
	canSettle: boolean;
}) {
	const { graph } = useWorkspace();
	const openSettle = useMoneyUi((x) => x.openSettle);
	const name = (id: string) => firstName(graph.members, id);
	const both = (m: number) => (
		<Num>
			{formatMoney(m, d.home)}
			{d.converted ? (
				<span className="text-muted-foreground"> ({d.fmt(m)})</span>
			) : null}
		</Num>
	);
	const joined = (parts: ReactNode[]) =>
		parts.map((p, i) => (
			// biome-ignore lint/suspicious/noArrayIndexKey: transfers are positional
			<span key={i}>
				{i > 0 ? " · " : null}
				{p}
			</span>
		));
	const mine = view.transfers.filter((t) => t.from === meId || t.to === meId);
	const others = view.transfers.filter((t) => t.from !== meId && t.to !== meId);
	// "Balance changed since your last settlement" (ADDENDUM §7.3).
	const last = meId
		? data.settlements
				.filter((s) => s.fromMemberId === meId || s.toMemberId === meId)
				.at(-1)
		: undefined;
	const after = meId ? last?.netAfter?.[meId] : undefined;
	const delta = meId && after !== undefined ? (view.net[meId] ?? 0) - after : 0;
	const cause = data.recentEdits?.[0];
	return (
		<section
			data-testid={MONEY_TESTID.balances}
			data-cursor-anchor="money:balances"
			className="px-4 pb-4"
		>
			<Overline
				right={
					canSettle || view.transfers.length ? (
						<Button
							size="sm"
							variant="outline"
							className="h-7"
							data-testid={MONEY_TESTID.settleUpButton}
							onClick={() => openSettle(true)}
						>
							Settle up
						</Button>
					) : null
				}
			>
				Balances · whole trip
			</Overline>
			{view.transfers.length === 0 ? (
				<p className="text-[13px] text-muted-foreground">Everyone is square.</p>
			) : (
				<div className="space-y-1 text-[13px] leading-[18px]">
					{mine.length ? (
						<p>
							{joined(
								mine.map((t) =>
									t.from === meId ? (
										<>
											You owe {name(t.to)} {both(t.amountMinor)}
										</>
									) : (
										<>
											{name(t.from)} owes you {both(t.amountMinor)}
										</>
									),
								),
							)}
						</p>
					) : null}
					{others.length ? (
						<p className="text-muted-foreground">
							{joined(
								others.map((t) => (
									<>
										{name(t.from)} owes {name(t.to)} {both(t.amountMinor)}
									</>
								)),
							)}
						</p>
					) : null}
				</div>
			)}
			{meId && after !== undefined && Math.abs(delta) >= 1 ? (
				<p
					data-testid={MONEY_TESTID.balanceNotice}
					className="mt-2 rounded-md bg-muted px-3 py-2 text-[13px] leading-[18px]"
				>
					Balance changed since your last settlement:{" "}
					<Num>{signed(delta, d.home)}</Num>
					{cause ? (
						<span className="text-muted-foreground">
							{" "}
							(
							{cause.cause ??
								`${cause.actorName.split(" ")[0]} ${VERB[cause.verb] ?? "changed"}${cause.title ? ` ${cause.title}` : " an expense"}`}
							)
						</span>
					) : null}
				</p>
			) : null}
		</section>
	);
}
