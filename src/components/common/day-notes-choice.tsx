/**
 * A removed day's shared note (owner, 2026-09-28): it never blocks the removal.
 * The person removing the day, who can see the note, chooses: into the
 * trip's notes (the default, headed "From Tue 5 Oct (removed day)") or
 * deleted. Private notes always move to their author's trip note, so they
 * never come up here.
 */
import { useId } from "react";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { formatDayDate } from "@/lib/format";
import { TESTID } from "@/lib/testids";

export type DayNotesChoice = "keep" | "delete";

export function DayNotesChoiceField({
	dates,
	value,
	onChange,
}: {
	/** The removed days that have a shared note. */
	dates: readonly string[];
	value: DayNotesChoice;
	onChange: (v: DayNotesChoice) => void;
}) {
	const id = useId();
	if (!dates.length) return null;
	const which =
		dates.length === 1
			? `${formatDayDate(dates[0] as string)} has a note.`
			: `${dates.length} of these days have notes.`;
	return (
		<div className="grid gap-1.5" data-testid={TESTID.dayNotesChoice}>
			<p>{which}</p>
			<RadioGroup
				value={value}
				onValueChange={(v) => onChange(v as DayNotesChoice)}
				className="gap-1.5"
			>
				<div className="flex items-center gap-2">
					<RadioGroupItem value="keep" id={`${id}-keep`} />
					<Label htmlFor={`${id}-keep`} className="font-normal">
						{dates.length === 1 ? "Keep it" : "Keep them"} in the trip's notes
					</Label>
				</div>
				<div className="flex items-center gap-2">
					<RadioGroupItem value="delete" id={`${id}-delete`} />
					<Label htmlFor={`${id}-delete`} className="font-normal">
						{dates.length === 1 ? "Delete it" : "Delete them"}
					</Label>
				</div>
			</RadioGroup>
		</div>
	);
}
