/**
 * My view state beyond the URL (`view.ui`, view-protocol.ts), and the
 * followed person's.
 *
 * - `useFollowState(path, initial, schema)` is `useState` that travels: it
 *   publishes its value and, while I follow someone (or join a Spotlight),
 *   takes theirs each time it changes. `useFollowValue` does the same for a
 *   value kept elsewhere (a store, localStorage); `useFollowToggle` for one
 *   row's open / closed among many (they travel as one list of ids).
 * - `LivePresence` sends the merged keys with my `view` (debounced), the most
 *   recently changed first; the least recently changed go when it's too big.
 * - The Plan's folds travel whole (`usePublishViewUi("plan", …)`,
 *   `useFollowedUi("plan")`).
 *
 * Typed values (forms, the search box), personal settings (theme, hidden
 * cursors, the display currency) and anything private (private notes and
 * lists) never use these.
 */
import {
	type Dispatch,
	type SetStateAction,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { z } from "zod";
import { create } from "zustand";
import { useUi } from "@/lib/workspace/ui-store";
import { usePeers } from "./presence";
import type { Peer } from "./protocol";
import {
	AwarenessLook,
	cleanViewUi,
	type LookFocus,
	MAX_UI_KEYS,
	type PlanFolds,
	UI_STR_RE,
	type UiValue,
	type ViewUi,
} from "./view-protocol";

/** `plan`, or a `<part>.<name>` key (view-protocol.ts `UI_PATH_RE`). */
export type UiPath = "plan" | `${string}.${string}`;

type ViewUiStore = {
	/** Path → value (a key's value, or the Plan's folds). */
	values: Readonly<Record<string, unknown>>;
	/** Path → when its value last changed (the wire puts the latest first). */
	at: Readonly<Record<string, number>>;
	set(path: UiPath, value: unknown): void;
};

/** A strictly increasing change stamp (two changes in one ms still order). */
let lastAt = 0;
const stamp = () => {
	lastAt = Math.max(Date.now(), lastAt + 1);
	return lastAt;
};

export const useMyViewUi = create<ViewUiStore>()((set) => ({
	values: {},
	at: {},
	set: (path, value) =>
		set((s) => {
			const cur = s.values[path];
			if (value === undefined) {
				if (cur === undefined) return s;
				const { [path]: _gone, ...rest } = s.values;
				const { [path]: _t, ...at } = s.at;
				return { values: rest, at };
			}
			if (JSON.stringify(cur) === JSON.stringify(value)) return s;
			return {
				values: { ...s.values, [path]: value },
				at: { ...s.at, [path]: stamp() },
			};
		}),
}));

/** How many mounted components publish each path (the last one out clears it). */
const owners = new Map<string, number>();

/** Publishes `value` at `path` of my `view.ui` while mounted (undefined = nothing). */
export function usePublishViewUi(
	path: UiPath,
	value: unknown,
	enabled = true,
): void {
	const set = useMyViewUi((s) => s.set);
	const json = enabled && value !== undefined ? JSON.stringify(value) : null;
	useEffect(() => {
		set(path, json === null ? undefined : JSON.parse(json));
	}, [path, json, set]);
	useEffect(() => {
		if (!enabled) return;
		owners.set(path, (owners.get(path) ?? 0) + 1);
		return () => {
			const n = (owners.get(path) ?? 1) - 1;
			if (n > 0) owners.set(path, n);
			else {
				owners.delete(path);
				set(path, undefined);
			}
		};
	}, [path, enabled, set]);
}

/** Schemas for followed values (a value from their screen must pass one). */
export const bool = z.boolean();
/** One of `values`. */
export function oneOf<T extends string>(values: readonly T[]): z.ZodType<T> {
	return z.custom<T>(
		(v) => typeof v === "string" && (values as readonly string[]).includes(v),
	);
}
/** An id (a uuid, a word, an anchor id). */
export const anId = z.string().min(1).regex(UI_STR_RE);
/** An id or "" (none). */
export const idOrNone = z.string().regex(UI_STR_RE);
/** A short list of ids. */
export const ids = z.array(anId).max(MAX_UI_KEYS);
/** A uuid. */
export const uuid = z
	.string()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
/** A whole number in [min, max]. */
export function int(min: number, max: number): z.ZodType<number> {
	return z.number().int().min(min).max(max);
}

// ---------------------------------------------------------------------------
// The followed person's
// ---------------------------------------------------------------------------

type FollowedStore = {
	/** Their validated `view.ui`, or null (not following, or nothing). */
	ui: ViewUi | null;
	/** Where their attention is (`look.f`), or null. */
	focus: LookFocus | null;
};

export const useFollowedStore = create<FollowedStore>()(() => ({
	ui: null,
	focus: null,
}));

/** The person I follow (while they are here), else null. */
export function useFollowedPeer(): Peer | null {
	const following = useUi((s) => s.following);
	const peers = usePeers();
	return useMemo(
		() =>
			following ? (peers.find((p) => p.user.id === following) ?? null) : null,
		[following, peers],
	);
}

/**
 * Keeps `useFollowedStore` on the followed person's `view.ui` and focus
 * (validated again here). Mounted once (live mode), so screens re-render
 * only when a key they read changes, not on every cursor move.
 */
export function useFollowedSync(): void {
	const peer = useFollowedPeer();
	const raw = peer?.view?.ui;
	const json = raw ? JSON.stringify(raw) : null;
	const look = AwarenessLook.safeParse(peer?.look);
	const focus = look.success ? look.data.f : null;
	useEffect(() => {
		useFollowedStore.setState({
			ui: json ? cleanViewUi(JSON.parse(json)) : null,
		});
	}, [json]);
	useEffect(() => {
		useFollowedStore.setState({ focus });
	}, [focus]);
	useEffect(
		() => () => useFollowedStore.setState({ ui: null, focus: null }),
		[],
	);
}

/** The followed person's Plan folds, or null. */
export function useFollowedUi(_part: "plan"): PlanFolds | null {
	return useFollowedStore((s) => s.ui?.plan ?? null);
}

/** Their value at `path` as JSON (stable), or undefined. */
function useFollowedJson(path: string): string | undefined {
	return useFollowedStore((s) => {
		const v = s.ui?.[path];
		return v === undefined ? undefined : JSON.stringify(v);
	});
}

/** The followed person's value at `path` when it passes `schema`, else undefined. */
export function useFollowedValue<T>(
	path: `${string}.${string}`,
	schema: z.ZodType<T>,
): T | undefined {
	const json = useFollowedJson(path);
	return useMemo(() => {
		if (json === undefined) return undefined;
		const r = schema.safeParse(JSON.parse(json));
		return r.success ? r.data : undefined;
	}, [json, schema]);
}

/**
 * A value kept elsewhere that travels with my view: publishes `value` at
 * `path`, and while I follow someone who publishes the same path, calls
 * `apply` with their value each time it changes (only when `schema` says
 * it's one of ours: a value from their screen I can't show is ignored).
 */
export function useFollowValue<T>(
	path: `${string}.${string}`,
	value: T | undefined,
	apply: (v: T) => void,
	schema: z.ZodType<T>,
	enabled = true,
): void {
	usePublishViewUi(path, value, enabled);
	const json = useFollowedJson(path);
	const latest = useRef({ apply, schema });
	latest.current = { apply, schema };
	const applied = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (!enabled || json === undefined) {
			applied.current = undefined;
			return;
		}
		if (applied.current === json) return;
		applied.current = json;
		const r = latest.current.schema.safeParse(JSON.parse(json));
		if (r.success) latest.current.apply(r.data);
	}, [json, enabled]);
}

/**
 * `useState` for a piece of what I'm looking at (a sub-tab, an open section,
 * a sort): it publishes its value at `path` and, while I follow someone,
 * takes theirs each time it changes. `enabled: false` keeps it to myself
 * (a private list, a screen that isn't mine to share).
 */
export function useFollowState<T extends UiValue>(
	path: `${string}.${string}`,
	initial: T | (() => T),
	schema: z.ZodType<T>,
	opts: { enabled?: boolean } = {},
): [T, Dispatch<SetStateAction<T>>] {
	const [value, setValue] = useState<T>(initial);
	useFollowValue(path, value, setValue, schema, opts.enabled ?? true);
	return [value, setValue];
}

// ---------------------------------------------------------------------------
// One row among many (`useFollowToggle`)
// ---------------------------------------------------------------------------

type ToggleStore = {
	/** Path → the ids that are on. */
	on: Readonly<Record<string, Readonly<Record<string, true>>>>;
	flip(path: string, id: string, on: boolean): void;
};

const useToggles = create<ToggleStore>()((set) => ({
	on: {},
	flip: (path, id, v) =>
		set((s) => {
			const cur = s.on[path] ?? {};
			if (!!cur[id] === v) return s;
			const next = { ...cur };
			if (v) next[id] = true;
			else delete next[id];
			return { on: { ...s.on, [path]: next } };
		}),
}));

/** The list a toggle path travels as (sorted, capped). */
function onIds(path: string): string[] | undefined {
	const on = useToggles.getState().on[path];
	return on ? Object.keys(on).sort().slice(0, MAX_UI_KEYS) : undefined;
}

/**
 * One row's open / closed among many (expanded rows, cities, cards): every
 * row with the same `path` travels as one list of the ids that are open, and
 * a follower's row opens or closes with the leader's list. `id` must be a
 * plain id or an anchor id (`list:<id>`: the server drops private ones).
 */
export function useFollowToggle(
	path: `${string}.${string}`,
	id: string,
	initial = false,
	opts: { enabled?: boolean } = {},
): [boolean, Dispatch<SetStateAction<boolean>>] {
	const enabled = (opts.enabled ?? true) && UI_STR_RE.test(id) && id !== "";
	const [open, setOpen] = useState(initial);
	const flip = useToggles((s) => s.flip);
	const setPath = useMyViewUi((s) => s.set);
	useEffect(() => {
		if (!enabled) return;
		flip(path, id, open);
		setPath(path, onIds(path) ?? []);
	}, [path, id, open, enabled, flip, setPath]);
	useEffect(() => {
		if (!enabled) return;
		owners.set(path, (owners.get(path) ?? 0) + 1);
		return () => {
			flip(path, id, false);
			const n = (owners.get(path) ?? 1) - 1;
			if (n > 0) {
				owners.set(path, n);
				setPath(path, onIds(path) ?? []);
			} else {
				owners.delete(path);
				setPath(path, undefined);
			}
		};
	}, [path, id, enabled, flip, setPath]);
	const json = useFollowedJson(path);
	const applied = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (!enabled || json === undefined) {
			applied.current = undefined;
			return;
		}
		if (applied.current === json) return;
		applied.current = json;
		const theirs: unknown = JSON.parse(json);
		if (Array.isArray(theirs)) setOpen(theirs.includes(id));
	}, [json, enabled, id]);
	return [open, setOpen];
}
