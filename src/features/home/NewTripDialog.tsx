/**
 * New trip (DESIGN §10.4): name and dates (a Calendar range, two months at
 * ≥ 768) → `createTrip` → the new trip, with the palette open in "Where to
 * first?" mode. Dates are optional; both or neither (QA TRIP-01: an empty
 * name or an end before the start is refused inline, nothing is created).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { createTrip } from "@/functions/trips.functions";
import { humanError } from "@/lib/errors";
import { meKeys } from "@/lib/query/keys";
import { useOnline } from "@/lib/realtime/connection";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { DateRangeField } from "./date-fields";
import { HOME_TESTID } from "./testids";

export function NewTripDialog({ trigger }: { trigger?: React.ReactNode }) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [start, setStart] = useState<string | null>(null);
	const [end, setEnd] = useState<string | null>(null);
	const ids = { name: useId(), dates: useId() };
	const navigate = useNavigate();
	const qc = useQueryClient();
	const openAddPlace = useUi((s) => s.openAddPlace);
	const online = useOnline();
	const create = useMutation({
		mutationFn: () =>
			createTrip({
				data: {
					name: name.trim(),
					...(start && end ? { startDate: start, endDate: end } : {}),
					defaultTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
				},
			}),
		meta: { silent: true },
		onSuccess: async ({ slug }) => {
			await qc.invalidateQueries({ queryKey: meKeys.trips });
			setOpen(false);
			await navigate({ to: "/t/$trip", params: { trip: slug } });
			openAddPlace({ mode: "first" });
		},
	});
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (name.trim() && !datesInvalid) create.mutate();
	};
	const datesInvalid = !!start !== !!end || (!!start && !!end && start > end);
	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				setOpen(v);
				if (!v) create.reset();
			}}
		>
			<DialogTrigger asChild>
				{trigger ?? (
					<Button data-testid={TESTID.newTripButton}>
						<Plus /> New trip
					</Button>
				)}
			</DialogTrigger>
			<DialogContent
				className="sm:max-w-[480px]"
				data-testid={TESTID.newTripDialog}
			>
				<form onSubmit={submit} className="grid gap-5">
					<DialogHeader>
						<DialogTitle>New trip</DialogTitle>
						<DialogDescription>
							You can change the name and dates later.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-2">
						<Label htmlFor={ids.name}>Name</Label>
						<Input
							id={ids.name}
							autoFocus
							required
							maxLength={120}
							placeholder="Asia 2027"
							value={name}
							onChange={(e) => setName(e.target.value)}
							data-testid={TESTID.newTripName}
						/>
					</div>
					<div className="grid gap-2">
						<Label htmlFor={ids.dates}>
							Dates{" "}
							<span className="font-normal text-muted-foreground">
								(optional)
							</span>
						</Label>
						<DateRangeField
							id={ids.dates}
							from={start}
							to={end}
							testId={HOME_TESTID.newTripDates}
							onChange={(a, b) => {
								setStart(a);
								setEnd(b);
							}}
						/>
						{start && !end ? (
							<p className="text-xs text-muted-foreground">
								Pick the last day too.
							</p>
						) : null}
					</div>
					{create.error ? (
						<p className="text-[13px] text-destructive" role="alert">
							{humanError(create.error)}
						</p>
					) : null}
					<DialogFooter className="items-center">
						{!online ? (
							<span className="mr-auto text-[13px] text-muted-foreground">
								Reconnect to create a trip.
							</span>
						) : null}
						<Button
							type="submit"
							disabled={
								!name.trim() || datesInvalid || create.isPending || !online
							}
							data-testid={TESTID.newTripSubmit}
						>
							{create.isPending ? <Spinner /> : null}
							Create trip
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
