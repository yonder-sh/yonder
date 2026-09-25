/**
 * One live instance per key for the global dialogs (`ShiftTripDialog`,
 * `HoursEditorDialog`): the MOST RECENTLY mounted instance renders, the rest
 * render nothing. The workspace mounts each once; the dev harness mounts its
 * own over a live trip page, and both read the same `useUi` open flag, so
 * without this both would open (found at integration).
 */
import { useEffect, useRef, useSyncExternalStore } from "react";

const mounted = new Map<string, symbol[]>();
const listeners = new Set<() => void>();
const notify = () => {
	for (const l of listeners) l();
};

export function useLatestMount(key: string): boolean {
	const me = useRef(Symbol(key));
	useEffect(() => {
		const id = me.current;
		const list = mounted.get(key) ?? [];
		list.push(id);
		mounted.set(key, list);
		notify();
		return () => {
			const l = mounted.get(key) ?? [];
			const i = l.indexOf(id);
			if (i >= 0) l.splice(i, 1);
			notify();
		};
	}, [key]);
	return useSyncExternalStore(
		(cb) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		() => mounted.get(key)?.at(-1) === me.current,
		() => false,
	);
}
