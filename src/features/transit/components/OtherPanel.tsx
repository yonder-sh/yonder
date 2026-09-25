/**
 * Other (DESIGN §8.2): kind chips (Taxi, Car, Ferry, Bike, Bus, Other), the
 * minutes and a label ("Drive · Home → JFK T7", QA TR-10), and "Open in
 * Google Maps" in the kind's travel mode (FB-03: driving for a taxi or car).
 */
import { cn } from "cn";
import {
	Bike,
	BusFront,
	Car,
	CarTaxiFront,
	CircleDashed,
	Ship,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { EditGuard, useEditGuard } from "@/components/common/edit-guard";
import { DurationInput } from "@/components/common/time";
import { Input } from "@/components/ui/input";
import type { OtherKind } from "@/lib/schemas/legs";
import { mapsTravelMode } from "../lib/endpoints";
import { TRANSIT_TESTID } from "../testids";
import type { LegEditor } from "../use-leg-editor";
import { GoogleMapsLink } from "./bits";

const KINDS: { kind: OtherKind; label: string; Icon: typeof Car }[] = [
	{ kind: "taxi", label: "Taxi", Icon: CarTaxiFront },
	{ kind: "car", label: "Car", Icon: Car },
	{ kind: "ferry", label: "Ferry", Icon: Ship },
	{ kind: "bike", label: "Bike", Icon: Bike },
	{ kind: "bus", label: "Bus", Icon: BusFront },
	{ kind: "other", label: "Other", Icon: CircleDashed },
];

export function OtherPanel({ ed }: { ed: LegEditor }) {
	const { leg, details, sched } = ed;
	const current = details?.kind === "other" ? details : null;
	const minutes = leg?.durationMin ?? sched?.minutes ?? 15;
	const [label, setLabel] = useState(current?.label ?? "");
	const labelId = useId();
	const guard = useEditGuard();
	useEffect(() => setLabel(current?.label ?? ""), [current?.label]);
	const mapsMode = mapsTravelMode({
		mode: "other",
		details: current ?? { kind: "other", otherKind: "taxi" },
	});
	const save = (next: {
		otherKind?: OtherKind;
		label?: string;
		minutes?: number;
	}) =>
		ed.patch.mutate({
			patch: {
				mode: "other",
				durationMin: next.minutes ?? minutes,
				source: "manual",
				isEdited: true,
				details: {
					kind: "other",
					otherKind: next.otherKind ?? current?.otherKind ?? "taxi",
					...((next.label ?? current?.label)?.trim()
						? {
								label: (next.label ?? current?.label ?? "").trim().slice(0, 80),
							}
						: {}),
					...(current?.geometry ? { geometry: current.geometry } : {}),
				},
			},
		});
	return (
		<div data-testid={TRANSIT_TESTID.otherPanel} className="grid gap-3">
			<fieldset className="flex flex-wrap gap-1.5">
				<legend className="sr-only">Kind</legend>
				{KINDS.map(({ kind, label: l, Icon }) => {
					// Right after "Other" is chosen the row is still on its way: taxi.
					const on =
						(current?.otherKind ?? (leg?.mode !== "other" ? "taxi" : null)) ===
						kind;
					return (
						<EditGuard key={kind}>
							<button
								type="button"
								aria-pressed={on}
								data-testid={TRANSIT_TESTID.otherKind}
								data-kind={kind}
								onClick={() => save({ otherKind: kind })}
								className={cn(
									"inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
									on
										? "border-primary bg-primary/10 text-foreground"
										: "border-border text-muted-foreground hover:border-foreground/20 hover:text-foreground",
								)}
							>
								<Icon className="size-3.5 text-mode-other" strokeWidth={1.5} />
								{l}
							</button>
						</EditGuard>
					);
				})}
			</fieldset>
			<div className="flex flex-wrap items-center gap-3">
				<span className="text-xs text-muted-foreground">Takes</span>
				<span data-testid={TRANSIT_TESTID.otherMinutes}>
					<DurationInput
						value={minutes}
						disabled={guard.disabled}
						onChange={(m) => save({ minutes: m })}
					/>
				</span>
				{mapsMode ? (
					<GoogleMapsLink ends={ed.ends} mode={mapsMode} className="ml-auto" />
				) : null}
			</div>
			<div className="grid gap-1.5">
				<label htmlFor={labelId} className="text-xs text-muted-foreground">
					Label
				</label>
				<EditGuard>
					<Input
						id={labelId}
						data-testid={TRANSIT_TESTID.otherLabel}
						value={label}
						maxLength={80}
						placeholder="e.g. MK Taxi, Drive to JFK"
						className="h-8"
						onChange={(e) => setLabel(e.target.value)}
						onBlur={() => {
							if (label.trim() !== (current?.label ?? "")) save({ label });
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") (e.target as HTMLInputElement).blur();
						}}
					/>
				</EditGuard>
			</div>
		</div>
	);
}
