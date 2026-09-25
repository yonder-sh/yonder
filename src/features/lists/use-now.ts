/** `Date.now()`, refreshed every minute (due chips age while the tab is open). */
import { useEffect, useState } from "react";

export function useNow(everyMs = 60_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), everyMs);
		return () => clearInterval(t);
	}, [everyMs]);
	return now;
}
