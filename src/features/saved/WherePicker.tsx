/**
 * "Where is this?": one tap on a chip (the places I file under most
 * recently, else my trips' cities and countries; all from the device, no
 * waiting), or a search for any city (Photon) or country (the app's own
 * list). `WhereAsk` asks it when something new arrives (Skip: Unsorted);
 * `WhereDialog` changes an item's place later.
 */
import { useQuery } from "@tanstack/react-query";
import { Check, Search, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { FlagEmoji } from "@/components/common/glyphs";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { myTripsQuery } from "@/features/home/queries";
import { cn } from "@/lib/utils";
import { savedQuery } from "./queries";
import { type CityHit, searchSavedPlaces } from "./saved.functions";
import { SAVED_TESTID } from "./testids";
import {
	choiceKey,
	countryName,
	matchCountries,
	type WhereChoice,
	whereChips,
	whereLabel,
} from "./where";

/** The chips, from what's on the device already. */
export function useWhereChips(): WhereChoice[] {
	const saved = useQuery(savedQuery());
	const trips = useQuery(myTripsQuery());
	return useMemo(
		() => whereChips(saved.data ?? [], trips.data ?? []),
		[saved.data, trips.data],
	);
}

function useDebounced<T>(v: T, ms: number): T {
	const [d, setD] = useState(v);
	useEffect(() => {
		const t = window.setTimeout(() => setD(v), ms);
		return () => window.clearTimeout(t);
	}, [v, ms]);
	return d;
}

function Chip({
	choice,
	selected,
	onPick,
}: {
	choice: WhereChoice;
	selected: boolean;
	onPick: () => void;
}) {
	return (
		<button
			type="button"
			data-testid={SAVED_TESTID.whereChip}
			data-where={choiceKey(choice)}
			aria-pressed={selected}
			aria-label={whereLabel(choice)}
			onClick={onPick}
			className={cn(
				"inline-flex h-9 max-w-full cursor-pointer items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
				selected
					? "border-primary bg-primary/10 ring-1 ring-primary"
					: "bg-background hover:border-foreground/25 hover:bg-accent/50",
			)}
		>
			<FlagEmoji code={choice.countryCode} className="text-base" />
			<span className="truncate">
				{choice.city?.name ?? countryName(choice.countryCode)}
			</span>
			{selected ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
		</button>
	);
}

function ResultRow({
	code,
	title,
	subtitle,
	onPick,
}: {
	code: string;
	title: string;
	subtitle: string;
	onPick: () => void;
}) {
	return (
		<button
			type="button"
			data-testid={SAVED_TESTID.whereResult}
			onClick={onPick}
			className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent"
		>
			<FlagEmoji code={code} className="text-lg" />
			<span className="min-w-0 flex-1">
				<span className="block truncate text-sm font-medium">{title}</span>
				<span className="block truncate text-xs text-muted-foreground">
					{subtitle}
				</span>
			</span>
		</button>
	);
}

/** Chips, then search. `selected`: the chip already chosen (a Maps place's, or the current one). */
export function WherePicker({
	selected,
	onPick,
	onSearching,
	className,
}: {
	selected?: WhereChoice | null;
	onPick: (c: WhereChoice) => void;
	/** Search has the focus or words (the sheet grows for its results). */
	onSearching?: (on: boolean) => void;
	className?: string;
}) {
	const chips = useWhereChips();
	const shown = useMemo(() => {
		if (!selected) return chips;
		const k = choiceKey(selected);
		return [selected, ...chips.filter((c) => choiceKey(c) !== k)];
	}, [chips, selected]);
	const [q, setQ] = useState("");
	const [focused, setFocused] = useState(false);
	const term = useDebounced(q.trim(), 250);
	const online = typeof navigator === "undefined" || navigator.onLine;
	const cities = useQuery({
		queryKey: ["saved-where", term.toLowerCase()],
		queryFn: (): Promise<CityHit[]> => searchSavedPlaces({ data: { q: term } }),
		enabled: term.length >= 2 && online,
		staleTime: 10 * 60_000,
		retry: false,
	});
	const lands = useMemo(() => matchCountries(q.trim()), [q]);
	const searching = focused || !!q.trim();
	useEffect(() => onSearching?.(searching), [searching, onSearching]);
	const selectedKey = selected ? choiceKey(selected) : null;
	return (
		<div className={cn("grid content-start gap-3", className)}>
			{shown.length && !q.trim() ? (
				<div
					className="flex flex-wrap gap-2"
					data-testid={SAVED_TESTID.whereChips}
				>
					{shown.map((c) => (
						<Chip
							key={choiceKey(c)}
							choice={c}
							selected={choiceKey(c) === selectedKey}
							onPick={() => onPick(c)}
						/>
					))}
				</div>
			) : null}
			<div className="relative">
				<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input
					data-testid={SAVED_TESTID.whereSearch}
					value={q}
					onChange={(e) => setQ(e.target.value)}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					placeholder="Search a city or country"
					aria-label="Search a city or country"
					className="h-10 pr-9 pl-9 text-base sm:text-sm"
				/>
				{q ? (
					<button
						type="button"
						aria-label="Clear"
						onClick={() => setQ("")}
						className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-full text-muted-foreground hover:text-foreground"
					>
						<X className="size-4" />
					</button>
				) : null}
			</div>
			{q.trim() ? (
				<div className="grid gap-0.5">
					{lands.map((c) => (
						<ResultRow
							key={`c-${c.code}`}
							code={c.code}
							title={c.name}
							subtitle="Country"
							onPick={() => onPick({ countryCode: c.code, city: null })}
						/>
					))}
					{(cities.data ?? []).map((h) => (
						<ResultRow
							key={`${h.countryCode}-${h.name}-${h.lat}`}
							code={h.countryCode}
							title={h.name}
							subtitle={h.subtitle || countryName(h.countryCode)}
							onPick={() =>
								onPick({
									countryCode: h.countryCode,
									city: { name: h.name, lat: h.lat, lng: h.lng },
								})
							}
						/>
					))}
					{cities.isFetching ? (
						<span className="flex items-center gap-2 px-2 py-2 text-meta text-muted-foreground">
							<Spinner className="size-3.5" /> Searching…
						</span>
					) : !lands.length && !cities.data?.length && term.length >= 2 ? (
						<p className="px-2 py-2 text-meta text-muted-foreground">
							{online
								? "No city or country called that."
								: "You're offline: pick a country, or try again later."}
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}

/** Asked when something new arrives: a chip files it and you're done. */
export function WhereAsk({
	suggested,
	onPick,
	onSkip,
	onAddNow,
	onSearching,
	className,
}: {
	suggested: WhereChoice | null;
	onPick: (c: WhereChoice) => void;
	onSkip: () => void;
	onAddNow: () => void;
	onSearching?: (on: boolean) => void;
	className?: string;
}) {
	return (
		<section
			data-testid={SAVED_TESTID.whereAsk}
			aria-label="Where is this?"
			className={cn("flex min-h-0 flex-col gap-3", className)}
		>
			<h2 className="font-display text-xl leading-tight font-semibold">
				Where is this?
			</h2>
			<WherePicker
				selected={suggested}
				onPick={onPick}
				onSearching={onSearching}
				className="min-h-0 overflow-y-auto"
			/>
			<div className="flex items-center justify-between gap-2 pt-1">
				<Button
					type="button"
					variant="ghost"
					data-testid={SAVED_TESTID.whereSkip}
					onClick={onSkip}
				>
					Skip
				</Button>
				<Button
					type="button"
					variant="outline"
					data-testid={SAVED_TESTID.whereAddNow}
					onClick={onAddNow}
				>
					Add to a trip now
				</Button>
			</div>
		</section>
	);
}

/** Changes an item's place (or takes it out to Unsorted). */
export function WhereDialog({
	open,
	onOpenChange,
	current,
	onPick,
	footer,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	current: WhereChoice | null;
	onPick: (c: WhereChoice | null) => void;
	footer?: ReactNode;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				data-testid={SAVED_TESTID.whereDialog}
				onOpenAutoFocus={(e) => e.preventDefault()}
				className="top-[12svh] translate-y-0 sm:max-w-md"
			>
				<DialogHeader>
					<DialogTitle>Where is this?</DialogTitle>
					<DialogDescription>
						{current ? `Now in ${whereLabel(current)}.` : "Not sorted yet."}
					</DialogDescription>
				</DialogHeader>
				<WherePicker
					selected={current}
					onPick={onPick}
					className="max-h-[50svh] overflow-y-auto"
				/>
				<div className="flex justify-between gap-2">
					{current ? (
						<Button
							type="button"
							variant="ghost"
							data-testid={SAVED_TESTID.whereClear}
							onClick={() => onPick(null)}
						>
							Move to Unsorted
						</Button>
					) : (
						<span />
					)}
					{footer}
				</div>
			</DialogContent>
		</Dialog>
	);
}
