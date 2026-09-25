/**
 * FB-13a: the trip link's "Created …" and "Works until …" read the viewer's
 * own calendar date of the instant. Slicing the ISO string took its UTC date,
 * so an owner in Los Angeles switching the link on at 17:15 on Wed 23 Sep saw
 * "Created Thu 24 Sep".
 */
import { localDateOf, safeTimeZone } from "@/lib/engine/time";
import { formatDayDate } from "@/lib/format";

/** The browser's zone (the runtime's own on the server). */
function viewerZone(): string {
	try {
		return safeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
	} catch {
		return "UTC";
	}
}

/** An ISO instant as its local day in `tz` (the viewer's by default): "Wed 23 Sep". */
export function formatLocalDay(iso: string, tz?: string): string {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) return iso;
	return formatDayDate(localDateOf(ms, safeTimeZone(tz, viewerZone())));
}
