/**
 * One live instance per key, however many places mount a global dialog (the
 * shell mounts `AddExpenseDialog` once; the Money tab and the inspector's
 * Money panel mount it and `SettleUpDialog` too, so they work on their own).
 * The first mounted instance renders; the rest render nothing.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";

const mounted = new Map<string, symbol[]>();
const listeners = new Set<() => void>();
const notify = () => {
	for (const l of listeners) l();
};

export function usePrimaryMount(key: string): boolean {
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
		() => mounted.get(key)?.[0] === me.current,
		() => false,
	);
}
