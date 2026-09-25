/**
 * The due chip of a dashboard deadline (EXTENSIONS §7, QA DUE-05). Overdue and
 * open windows read exactly like the trip's Lists (`dueChipLabel`): "Overdue
 * 1h" under a day, "Overdue 3d", "Opened 5d ago", "Open now". Otherwise
 * "Due Wed 30 Sep · 23:59 EDT", "Opens …" or "On …".
 */
import { dueChipLabel } from "@/lib/engine/due";
import { normalizeTimeZone, tzLabel, zonedEpoch } from "@/lib/engine/time";
import { formatDayDate } from "@/lib/format";
import type { MyDeadline } from "./types";

export function deadlineLabel(d: MyDeadline, now: number): string {
	const kind = d.dueKind ?? "due";
	// FB-20: the zone label is for the due moment, never for "now".
	const at = d.at ?? dueInstant(d) ?? now;
	const date = formatDayDate(d.dueDate);
	const time = d.dueTime
		? ` · ${d.dueTime}${d.dueTz ? ` ${tzLabel(d.dueTz, at)}` : ""}`
		: "";
	const label =
		kind === "opens"
			? `Opens ${date}${time}`
			: kind === "on"
				? `On ${date}`
				: `Due ${date}${time}`;
	return dueChipLabel(
		{
			at,
			kind,
			label,
			allDay: !d.dueTime,
			tz: d.dueTz ?? "UTC",
			date: d.dueDate,
		},
		d.state ?? "later",
		now,
	);
}

/** The instant of a timed deadline from its own date, time and zone. */
function dueInstant(d: MyDeadline): number | null {
	const tz = normalizeTimeZone(d.dueTz);
	if (!d.dueTime || !tz || !/^\d{4}-\d{2}-\d{2}$/.test(d.dueDate)) return null;
	try {
		return zonedEpoch(d.dueDate, d.dueTime, tz);
	} catch {
		return null;
	}
}
