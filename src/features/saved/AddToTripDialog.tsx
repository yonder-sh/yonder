/**
 * Many saved items into a trip (Select's "Add to trip", a group's menu):
 * pick a trip you can edit or suggest to, and each goes in as an idea under
 * its city, or as a suggestion (Undo in the toast); or "Plan a new trip": a
 * name (from the cities) and dates, then the trip's Plan with those cities on
 * its route. Ones already in that trip stay as they are.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Plus } from "lucide-react";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { DateRangeField } from "@/features/home/date-fields";
import { myTripsQuery } from "@/features/home/queries";
import type { MyTrip } from "@/features/home/types";
import { startRoute } from "@/features/plan/day-split/split-draft";
import { createTrip } from "@/functions/trips.functions";
import { humanError } from "@/lib/errors";
import { meKeys, tripKeys } from "@/lib/query/keys";
import { useOnline } from "@/lib/realtime/connection";
import {
	type AddedToTrip,
	addSavedToTrip,
	undoSavedToTrip,
} from "./saved.functions";
import { SAVED_TESTID } from "./testids";
import type { SavedLink } from "./types";
import { tripNameFor } from "./where";

/** Per call (the server's `BULK_MAX`). */
const CHUNK = 50;

/** Trips I can add many to: owners and editors, and suggesters (as suggestions). */
export const canAddMany = (t: Pick<MyTrip, "role" | "viaLink">) =>
	!t.viaLink &&
	(t.role === "owner" || t.role === "editor" || t.role === "suggester");

const items = (n: number) => (n === 1 ? "1 item" : `${n} items`);

/** Adds them in turns of `CHUNK`; one result for all. */
export function useAddToTrip() {
	const qc = useQueryClient();
	return async (
		tripId: string,
		ids: readonly string[],
	): Promise<AddedToTrip> => {
		const all: AddedToTrip = {
			added: [],
			already: 0,
			made: [],
			cities: [],
			proposals: [],
		};
		try {
			for (let i = 0; i < ids.length; i += CHUNK) {
				const r = await addSavedToTrip({
					data: { tripId, ids: ids.slice(i, i + CHUNK) },
				});
				all.added.push(...r.added);
				all.already += r.already;
				all.made.push(...r.made);
				all.proposals.push(...r.proposals);
				for (const c of r.cities)
					if (!all.cities.includes(c)) all.cities.push(c);
			}
		} finally {
			void qc.invalidateQueries({ queryKey: meKeys.saved });
			void qc.invalidateQueries({ queryKey: meKeys.trips });
			void qc.invalidateQueries({ queryKey: tripKeys.graph(tripId) });
		}
		return all;
	};
}

export function AddToTripDialog({
	open,
	onOpenChange,
	links,
	label,
	plan: planFirst = false,
	onDone,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	links: readonly SavedLink[];
	/** "Kyoto", "3 items". */
	label: string;
	/** Open on "Plan a new trip". */
	plan?: boolean;
	onDone?: () => void;
}) {
	const trips = useQuery(myTripsQuery());
	const qc = useQueryClient();
	const navigate = useNavigate();
	const online = useOnline();
	const add = useAddToTrip();
	const [planning, setPlanning] = useState(planFirst);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [start, setStart] = useState<string | null>(null);
	const [end, setEnd] = useState<string | null>(null);
	const ids = useMemo(() => links.map((l) => l.id), [links]);
	const fields = { name: useId(), dates: useId() };
	useEffect(() => {
		if (!open) return;
		setPlanning(planFirst);
		setBusy(null);
		setError(null);
		setName(tripNameFor(links));
		setStart(null);
		setEnd(null);
	}, [open, planFirst, links]);
	// Trips that go where these are first.
	const options = useMemo(() => {
		const cc = new Set(links.flatMap((l) => l.where?.countryCode ?? []));
		const mine = (trips.data ?? []).filter(canAddMany);
		const near = (t: MyTrip) => t.countryCodes.some((c) => cc.has(c));
		return [...mine.filter(near), ...mine.filter((t) => !near(t))];
	}, [trips.data, links]);
	const inTrip = (t: MyTrip) =>
		links.filter((l) => l.trips.some((x) => x.id === t.id)).length;

	const toExisting = async (t: MyTrip) => {
		setBusy(t.id);
		setError(null);
		try {
			const r = await add(t.id, ids);
			onOpenChange(false);
			onDone?.();
			const n = r.added.length;
			if (!n) {
				toast(`Already in ${t.name}`, { position: "top-center" });
				return;
			}
			const did = r.proposals.length ? "Suggested" : "Added";
			toast.success(
				`${did} ${items(n)} to ${t.name}${r.already ? ` (${r.already} in it already)` : ""}`,
				{
					duration: 6000,
					position: "top-center",
					action: {
						label: "Undo",
						onClick: () =>
							void undoSavedToTrip({
								data: {
									tripId: t.id,
									added: r.added,
									made: r.made,
									proposals: r.proposals,
								},
							})
								.then(() =>
									Promise.all([
										qc.invalidateQueries({ queryKey: meKeys.saved }),
										qc.invalidateQueries({ queryKey: tripKeys.graph(t.id) }),
									]),
								)
								.catch((e) => toast.error(humanError(e))),
					},
				},
			);
		} catch (e) {
			setError(humanError(e));
		} finally {
			setBusy(null);
		}
	};

	const datesInvalid = !!start !== !!end || (!!start && !!end && start > end);
	const planTrip = async (e: FormEvent) => {
		e.preventDefault();
		if (!name.trim() || datesInvalid) return;
		setBusy("new");
		setError(null);
		try {
			const trip = await createTrip({
				data: {
					name: name.trim(),
					...(start && end ? { startDate: start, endDate: end } : {}),
					defaultTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
				},
			});
			const r = await add(trip.tripId, ids);
			// The trip opens on its route: these cities, in this order.
			if (r.cities.length) startRoute(trip.tripId, r.cities);
			onOpenChange(false);
			onDone?.();
			toast.success(`Added ${items(r.added.length)} to ${name.trim()}`, {
				position: "top-center",
			});
			await navigate({
				to: "/t/$trip",
				params: { trip: trip.slug },
				search: { tab: "plan" },
			});
		} catch (err) {
			setError(humanError(err));
		} finally {
			setBusy(null);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
			<DialogContent
				data-testid={SAVED_TESTID.addDialog}
				onOpenAutoFocus={(e) => e.preventDefault()}
				className="top-[12svh] translate-y-0 sm:max-w-md"
			>
				{planning ? (
					<form onSubmit={planTrip} className="grid gap-5">
						<DialogHeader>
							<DialogTitle>Plan a trip</DialogTitle>
							<DialogDescription>
								With {label}. Each goes in as an idea.
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-2">
							<Label htmlFor={fields.name}>Name</Label>
							<Input
								id={fields.name}
								required
								maxLength={120}
								value={name}
								onChange={(e) => setName(e.target.value)}
								data-testid={SAVED_TESTID.planName}
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor={fields.dates}>
								Dates{" "}
								<span className="font-normal text-muted-foreground">
									(optional)
								</span>
							</Label>
							<DateRangeField
								id={fields.dates}
								from={start}
								to={end}
								onChange={(a, b) => {
									setStart(a);
									setEnd(b);
								}}
							/>
						</div>
						{error ? (
							<p className="text-meta text-destructive" role="alert">
								{error}
							</p>
						) : null}
						<DialogFooter className="flex-row items-center justify-end gap-2">
							{!planFirst ? (
								<Button
									type="button"
									variant="ghost"
									className="mr-auto"
									disabled={!!busy}
									onClick={() => setPlanning(false)}
								>
									<ArrowLeft />
									Back
								</Button>
							) : null}
							<Button
								type="submit"
								data-testid={SAVED_TESTID.planCreate}
								disabled={!name.trim() || datesInvalid || !!busy || !online}
							>
								{busy ? <Spinner /> : null}
								Create trip
							</Button>
						</DialogFooter>
					</form>
				) : (
					<div className="grid gap-4">
						<DialogHeader>
							<DialogTitle>Add {label} to a trip</DialogTitle>
							<DialogDescription>
								Each goes in as an idea, under its city.
							</DialogDescription>
						</DialogHeader>
						{trips.isPending ? (
							<Spinner className="mx-auto" />
						) : options.length ? (
							<ul className="-mx-2 grid max-h-[45svh] gap-0.5 overflow-y-auto">
								{options.map((t) => {
									const n = inTrip(t);
									return (
										<li key={t.id}>
											<button
												type="button"
												data-testid={SAVED_TESTID.addTrip}
												data-trip={t.id}
												disabled={!!busy || !online}
												onClick={() => void toExisting(t)}
												className="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/60 disabled:cursor-default disabled:opacity-60"
											>
												<span className="min-w-0 flex-1">
													<span className="block truncate text-sm font-medium">
														{t.name}
													</span>
													{n || t.role === "suggester" ? (
														<span className="block text-xs text-muted-foreground">
															{n === links.length
																? "All in it already"
																: n
																	? `${n} in it already`
																	: "As suggestions"}
														</span>
													) : null}
												</span>
												{busy === t.id ? <Spinner /> : null}
											</button>
										</li>
									);
								})}
							</ul>
						) : (
							<p className="text-sm text-muted-foreground">
								No trip you can add to yet.
							</p>
						)}
						{error ? (
							<p className="text-meta text-destructive" role="alert">
								{error}
							</p>
						) : null}
						{!online ? (
							<p className="text-meta text-muted-foreground">
								Reconnect to add to a trip.
							</p>
						) : null}
						<Button
							variant="outline"
							data-testid={SAVED_TESTID.planTrip}
							disabled={!!busy}
							onClick={() => setPlanning(true)}
						>
							<Plus />
							Plan a new trip
						</Button>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
