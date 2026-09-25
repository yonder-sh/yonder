/**
 * "Duplicate…" (ADDENDUM §9), from a dashboard card's ⋯ menu and from Trip
 * settings: a new name, a new start date (every day shifts with it; pinned
 * local times stay) and what to copy. The structure always comes along;
 * notes, lists (reset to open), media (re-referenced), trip-default budgets
 * and people without an account are checkboxes. Members, link sharing, money,
 * suggestions and activity never are. Opens the copy when it's ready.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Copy } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { humanError } from "@/lib/errors";
import { formatDayDate } from "@/lib/format";
import { meKeys } from "@/lib/query/keys";
import { useOnline } from "@/lib/realtime/connection";
import { duplicateTrip } from "./dashboard.functions";
import { DateField, dayCount } from "./date-fields";
import { HOME_TESTID } from "./testids";

type Include = {
	notes: boolean;
	lists: boolean;
	media: boolean;
	budgets: boolean;
	placeholders: boolean;
};

const OPTIONS: { key: keyof Include; label: string; hint: string }[] = [
	{ key: "notes", label: "Notes", hint: "Shared notes and your private ones" },
	{
		key: "lists",
		label: "To-dos and shopping",
		hint: "Everything starts open again",
	},
	{
		key: "media",
		label: "Photos, videos, links and PDFs",
		hint: "Shared, not uploaded again",
	},
	{ key: "budgets", label: "Budgets", hint: "The trip defaults only" },
	{
		key: "placeholders",
		label: "People without an account",
		hint: "With their tags and ratings",
	},
];

export type DuplicateSource = {
	id: string;
	name: string;
	startDate: string | null;
	endDate: string | null;
};

export function DuplicateTripDialog({
	trip,
	open,
	onOpenChange,
}: {
	trip: DuplicateSource;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const ids = { name: useId(), start: useId() };
	const [name, setName] = useState(`${trip.name} (copy)`);
	const [start, setStart] = useState<string | null>(trip.startDate);
	const [include, setInclude] = useState<Include>({
		notes: true,
		lists: true,
		media: true,
		budgets: true,
		placeholders: true,
	});
	useEffect(() => {
		if (open) {
			setName(`${trip.name} (copy)`.slice(0, 120));
			setStart(trip.startDate ?? new Date().toISOString().slice(0, 10));
		}
	}, [open, trip.name, trip.startDate]);
	const qc = useQueryClient();
	const navigate = useNavigate();
	const online = useOnline();
	const dup = useMutation({
		mutationFn: () =>
			duplicateTrip({
				data: {
					tripId: trip.id,
					name: name.trim(),
					startDate: start ?? new Date().toISOString().slice(0, 10),
					include,
				},
			}),
		meta: { silent: true },
		onSuccess: async ({ slug }) => {
			await qc.invalidateQueries({ queryKey: meKeys.trips });
			onOpenChange(false);
			toast.success(`Made “${name.trim()}”`);
			await navigate({ to: "/t/$trip", params: { trip: slug } });
		},
	});
	const days = dayCount(trip.startDate, trip.endDate);
	const shiftedEnd =
		start && days
			? new Date(Date.parse(`${start}T00:00:00Z`) + (days - 1) * 86_400_000)
					.toISOString()
					.slice(0, 10)
			: null;
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (name.trim() && start) dup.mutate();
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				onOpenChange(v);
				if (!v) dup.reset();
			}}
		>
			<DialogContent
				className="sm:max-w-[480px]"
				data-testid={HOME_TESTID.duplicateDialog}
			>
				<form onSubmit={submit} className="grid gap-5">
					<DialogHeader>
						<DialogTitle>Duplicate “{trip.name}”</DialogTitle>
						<DialogDescription>
							The places, days, plan and travel legs always come along. Only you
							are on the copy.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-2">
						<Label htmlFor={ids.name}>Name</Label>
						<Input
							id={ids.name}
							value={name}
							maxLength={120}
							onChange={(e) => setName(e.target.value)}
							data-testid={HOME_TESTID.duplicateName}
						/>
					</div>
					{trip.startDate ? (
						<div className="grid gap-2">
							<Label htmlFor={ids.start}>Starts</Label>
							<DateField
								id={ids.start}
								value={start}
								onChange={setStart}
								testId={HOME_TESTID.duplicateStart}
							/>
							{start && shiftedEnd ? (
								<p className="text-xs text-muted-foreground">
									Every day moves with it, through{" "}
									{formatDayDate(shiftedEnd, { year: true })}. Pinned times stay
									the same.
								</p>
							) : null}
						</div>
					) : null}
					<fieldset className="grid gap-2">
						<legend className="mb-2 text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
							Also copy
						</legend>
						{OPTIONS.map((o) => {
							const id = `${ids.name}-${o.key}`;
							return (
								<div
									key={o.key}
									className="flex items-start gap-3 rounded-md py-1"
								>
									<Checkbox
										id={id}
										checked={include[o.key]}
										data-testid={HOME_TESTID.duplicateOption}
										data-option={o.key}
										onCheckedChange={(v) =>
											setInclude((s) => ({ ...s, [o.key]: v === true }))
										}
										className="mt-0.5"
									/>
									<Label htmlFor={id} className="grid gap-0.5 font-normal">
										<span className="text-sm">{o.label}</span>
										<span className="text-xs text-muted-foreground">
											{o.hint}
										</span>
									</Label>
								</div>
							);
						})}
						<p className="pt-1 text-xs text-muted-foreground">
							Never copied: members, link sharing, expenses, suggestions and
							activity. The copy gets its own address.
						</p>
					</fieldset>
					{dup.error ? (
						<p className="text-[13px] text-destructive" role="alert">
							{humanError(dup.error)}
						</p>
					) : null}
					<DialogFooter className="items-center">
						{!online ? (
							<span className="mr-auto text-[13px] text-muted-foreground">
								Reconnect to duplicate.
							</span>
						) : null}
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={!name.trim() || !start || dup.isPending || !online}
							data-testid={HOME_TESTID.duplicateSubmit}
						>
							{dup.isPending ? <Spinner /> : <Copy />}
							Duplicate
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
