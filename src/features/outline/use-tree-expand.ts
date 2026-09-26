/**
 * The Outline's expand state (ADDENDUM §7.2 "tree expand state per trip"):
 * which rows the viewer opened, kept in localStorage as the fast cache and
 * synced to the account's `user_prefs.treeExpanded[tripId]` (debounced) so it
 * follows them to another device. Link guests keep it in this browser only.
 *
 * A row is open when the viewer opened it, or when it leads to the current
 * scope or selection (auto-open), unless they closed it by hand this session.
 * With nothing stored yet, the top level (countries) starts open.
 *
 * Which rows are open travels with my view (`outline.open`, the last 12
 * characters of each id, the top of the tree first). While I follow someone
 * their rows show instead, and my own clicks change that copy; neither is
 * saved as mine, which comes back when I stop.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setUserPrefs } from "@/functions/prefs.functions";
import { meKeys } from "@/lib/query/keys";
import { userPrefsQuery } from "@/lib/query/trip-queries";
import { MAX_UI_KEYS } from "@/lib/realtime/view-protocol";
import {
	ids as idList,
	useFollowedValue,
	usePublishViewUi,
} from "@/lib/realtime/view-ui";
import { mergeUserPrefs, type UserPrefs } from "@/lib/schemas/misc";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";

const MAX_IDS = 500;
/** An id as it travels (uuids differ in their random tail). */
const short = (id: string) => id.slice(-12);
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

	// Follow: the leader's open rows, as a copy of my own that isn't saved.
	const following = useUi((s) => s.following);
	const theirs = useFollowedValue("outline.open", idList);
	const theirsKey = theirs ? theirs.join(",") : null;
	const [shown, setShown] = useState<Set<string> | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `theirsKey` stands for `theirs`
	useEffect(() => {
		if (!following) return setShown(null);
		if (!theirs) return;
		const wanted = new Set(theirs);
		setShown(
			new Set(
				ix.outline.filter((n) => wanted.has(short(n.id))).map((n) => n.id),
			),
		);
	}, [following, theirsKey, ix]);

	const isOpen = useCallback(
		(id: string) =>
			shown
				? shown.has(id) || autoOpen.has(id)
				: !closed.has(id) && (base.has(id) || autoOpen.has(id)),
		[shown, base, closed, autoOpen],
	);
	/** Closed by hand this session (a filtered tree opens everything else). */
	const isClosed = useCallback(
		(id: string) => (shown ? !shown.has(id) : closed.has(id)),
		[shown, closed],
	);

	// Mine travel: the open rows that have children, the top of the tree first.
	const mine = useMemo(() => {
		const out: string[] = [];
		const depth = (id: string) => ix.path(id).length;
		const open = ix.outline
			.filter((n) => ix.children(n.id).length > 0)
			.filter((n) =>
				shown ? shown.has(n.id) : !closed.has(n.id) && base.has(n.id),
			)
			.sort((a, b) => depth(a.id) - depth(b.id));
		for (const n of open.slice(0, MAX_UI_KEYS)) out.push(short(n.id));
		return out.sort();
	}, [ix, shown, closed, base]);
	usePublishViewUi("outline.open", mine, mode === "live");

	const setOpen = useCallback(
		(id: string, open: boolean) => {
			if (shown) {
				const next = new Set(shown);
				if (open) next.add(id);
				else next.delete(id);
				return setShown(next);
			}
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
		[shown, base, persist],
	);

	const setMany = useCallback(
		(ids: Iterable<string>, open: boolean) => {
			if (shown)
				return setShown(open ? new Set([...shown, ...ids]) : new Set());
			touched.current = true;
			const list = [...ids];
			const next = open ? new Set([...base, ...list]) : new Set<string>();
			setOpened(next);
			setClosed(open ? new Set() : new Set(list));
			persist(next);
		},
		[shown, base, persist],
	);

	return useMemo(
		() => ({ isOpen, isClosed, setOpen, setMany }),
		[isOpen, isClosed, setOpen, setMany],
	);
}
