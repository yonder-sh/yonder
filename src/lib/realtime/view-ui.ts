/**
 * FB-21: my ephemeral view state beyond the URL (`view.ui`, view-protocol.ts),
 * and the followed person's.
 *
 * - Each component that owns a piece of "what I'm looking at" publishes it
 *   while mounted: the Plan its folds (`usePublishViewUi("plan", …)`), a
 *   screen's switches one by one (`useMirror("lists.group", value, set)`).
 *   `LivePresence` sends the merged parts with my `view` (debounced).
 * - While I follow someone (or join a Spotlight), their value for the same
 *   part (validated again here) is applied when it changes: `useMirror`
 *   calls its setter, the Plan decodes its folds (`useFollowedUi("plan")`).
 *
 * Private per-user preferences that aren't about what I'm looking at (the
 * hide-cursors toggle, the display currency, the basemap style, private
 * notes) are never published.
 */
import { useEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import { useUi } from "@/lib/workspace/ui-store";
import { usePeers } from "./presence";
import type { Peer } from "./protocol";
import {
	cleanViewUi,
	type FlatPart,
	type FlatValue,
	type PlanFolds,
	type ViewUi,
} from "./view-protocol";

/** `plan`, or `<part>.<field>` for a flat part's field. */
export type UiPath = "plan" | `${FlatPart}.${string}`;

type ViewUiStore = {
	/** Path → value (a flat field's value, or the Plan's folds). */
	parts: Readonly<Record<string, unknown>>;
	set(path: UiPath, value: unknown): void;
};

export const useMyViewUi = create<ViewUiStore>()((set) => ({
	parts: {},
	set: (path, value) =>
		set((s) => {
			const cur = s.parts[path];
			if (value === undefined) {
				if (cur === undefined) return s;
				const { [path]: _gone, ...rest } = s.parts;
				return { parts: rest };
			}
			if (JSON.stringify(cur) === JSON.stringify(value)) return s;
			return { parts: { ...s.parts, [path]: value } };
		}),
}));

/** The store's paths as a `view.ui` object (not yet validated). */
export function composeViewUi(
	parts: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const out: Record<string, Record<string, unknown> | unknown> = {};
	for (const [path, value] of Object.entries(parts)) {
		const dot = path.indexOf(".");
		if (dot < 0) {
			out[path] = value;
			continue;
		}
		const part = path.slice(0, dot);
		const field = path.slice(dot + 1);
		const obj = (out[part] as Record<string, unknown> | undefined) ?? {};
		obj[field] = value;
		out[part] = obj;
	}
	return out;
}

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
	useEffect(() => () => set(path, undefined), [path, set]);
}

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

/** The followed person's validated `view.ui` (stable while unchanged), or null. */
function useFollowedViewUi(): ViewUi | null {
	const peer = useFollowedPeer();
	const raw = peer?.view?.ui;
	const json = raw ? JSON.stringify(raw) : null;
	return useMemo(() => (json ? cleanViewUi(JSON.parse(json)) : null), [json]);
}

/** The followed person's Plan folds, or null. */
export function useFollowedUi(part: "plan"): PlanFolds | null {
	const ui = useFollowedViewUi();
	return ui?.[part] ?? null;
}

/** The followed person's value at `path` (undefined: none / not following). */
export function useFollowedField(
	path: `${FlatPart}.${string}`,
): FlatValue | undefined {
	const ui = useFollowedViewUi();
	const dot = path.indexOf(".");
	const part = ui?.[path.slice(0, dot) as FlatPart];
	return part?.[path.slice(dot + 1)];
}

/**
 * One switch of a screen that travels with my view and follows the leader:
 * publishes `value` at `path`, and while I follow someone who publishes the
 * same path, calls `apply` with their value each time it changes (only when
 * `accept` says it is one of ours: a value from their screen we can't show
 * is ignored).
 */
export function useMirror<T extends FlatValue>(
	path: `${FlatPart}.${string}`,
	value: T | undefined,
	apply: (v: T) => void,
	accept: (v: FlatValue) => v is T,
	enabled = true,
): void {
	usePublishViewUi(path, value, enabled);
	const theirs = useFollowedField(path);
	const latest = useRef(apply);
	latest.current = apply;
	const applied = useRef<FlatValue | undefined>(undefined);
	useEffect(() => {
		if (!enabled || theirs === undefined) {
			applied.current = undefined;
			return;
		}
		if (applied.current === theirs) return;
		applied.current = theirs;
		if (accept(theirs)) latest.current(theirs);
	}, [theirs, enabled, accept]);
}

/** `accept` helpers for `useMirror`. */
export const isBool = (v: FlatValue): v is boolean => typeof v === "boolean";
export function oneOf<T extends string>(values: readonly T[]) {
	return (v: FlatValue): v is T =>
		typeof v === "string" && (values as readonly string[]).includes(v);
}
