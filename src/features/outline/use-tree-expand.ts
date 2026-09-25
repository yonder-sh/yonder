/**
 * The Outline's expand state (ADDENDUM §7.2 "tree expand state per trip"):
 * which rows the viewer opened, kept in localStorage as the fast cache and
 * synced to the account's `user_prefs.treeExpanded[tripId]` (debounced) so it
 * follows them to another device. Link guests keep it in this browser only.
 *
 * A row is open when the viewer opened it, or when it leads to the current
 * scope or selection (auto-open), unless they closed it by hand this session.
 * With nothing stored yet, the top level (countries) starts open.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setUserPrefs } from "@/functions/prefs.functions";
import { meKeys } from "@/lib/query/keys";
import { userPrefsQuery } from "@/lib/query/trip-queries";
import { mergeUserPrefs, type UserPrefs } from "@/lib/schemas/misc";
import { useWorkspace } from "@/lib/workspace/use-workspace";

const MAX_IDS = 500;
const SYNC_MS = 1500;
const localKey = (tripId: string) => `yonder:outline:open:${tripId}`;

function readLocal(tripId: string): string[] | null {
	try {
		const raw = globalThis.localStorage?.getItem(localKey(tripId));
		const v = raw ? (JSON.parse(raw) as unknown) : null;
		return Array.isArray(v) ? v.filter((x) => typeof x === "string") : null;
	} catch {
		return null;
	}
}

function writeLocal(tripId: string, ids: string[]) {
	try {
		globalThis.localStorage?.setItem(localKey(tripId), JSON.stringify(ids));
	} catch {
		// private mode / quota: the session state still works
	}
}

export function useTreeExpand(autoOpen: ReadonlySet<string>) {
	const { graph, ix, mode, access } = useWorkspace();
	const tripId = graph.trip.id;
	const qc = useQueryClient();
	const sync = mode === "live" && !access.isGuest;
	const prefs = useQuery({ ...userPrefsQuery(), enabled: sync });

	const [opened, setOpened] = useState<Set<string> | null>(() => {
		const local = readLocal(tripId);
		return local ? new Set(local) : null;
	});
	const [closed, setClosed] = useState<Set<string>>(() => new Set());
	const touched = useRef(false);

	// The account copy wins until the viewer changes something here.
	const remote = prefs.data?.treeExpanded?.[tripId];
	useEffect(() => {
		if (!remote || touched.current) return;
		setOpened(new Set(remote));
	}, [remote]);

	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pending = useRef<string[] | null>(null);
	const flush = useCallback(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		const ids = pending.current;
		pending.current = null;
		if (!ids) return;
		// Only this trip: the server merges `treeExpanded` per trip, so another
		// device's trips are never overwritten.
		const patch: UserPrefs = { treeExpanded: { [tripId]: ids } };
		qc.setQueryData<UserPrefs>(meKeys.prefs, (p) =>
			mergeUserPrefs(p ?? {}, patch),
		);
		setUserPrefs({ data: patch })
			.then((saved) => qc.setQueryData(meKeys.prefs, saved))
			.catch(() => {
				// best effort: localStorage already has it
			});
	}, [tripId, qc]);
	const persist = useCallback(
		(next: Set<string>) => {
			const ids = [...next].filter((id) => ix.node(id)).slice(0, MAX_IDS);
			writeLocal(tripId, ids);
			if (!sync) return;
			pending.current = ids;
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(flush, SYNC_MS);
		},
		[ix, tripId, sync, flush],
	);
	// Unmounting (the mobile drawer closing) sends what is still pending.
	const flushRef = useRef(flush);
	flushRef.current = flush;
	useEffect(() => () => flushRef.current(), []);

	const defaults = useMemo(
		() => new Set(ix.children(null).map((n) => n.id)),
		[ix],
	);
	const base = opened ?? defaults;

	const isOpen = useCallback(
		(id: string) => !closed.has(id) && (base.has(id) || autoOpen.has(id)),
		[base, closed, autoOpen],
	);
	/** Closed by hand this session (a filtered tree opens everything else). */
	const isClosed = useCallback((id: string) => closed.has(id), [closed]);

	const setOpen = useCallback(
		(id: string, open: boolean) => {
			touched.current = true;
			const next = new Set(base);
			if (open) next.add(id);
			else next.delete(id);
			setOpened(next);
			setClosed((c) => {
				const s = new Set(c);
				if (open) s.delete(id);
				else s.add(id);
				return s;
			});
			persist(next);
		},
		[base, persist],
	);

	const setMany = useCallback(
		(ids: Iterable<string>, open: boolean) => {
			touched.current = true;
			const list = [...ids];
			const next = open ? new Set([...base, ...list]) : new Set<string>();
			setOpened(next);
			setClosed(open ? new Set() : new Set(list));
			persist(next);
		},
		[base, persist],
	);

	return useMemo(
		() => ({ isOpen, isClosed, setOpen, setMany }),
		[isOpen, isClosed, setOpen, setMany],
	);
}
