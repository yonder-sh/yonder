/**
 * FB-24 form presence: while I have an editor or dialog open (add / edit
 * flight, the expense editor, set stay, a budget, a list item, add place…),
 * my awareness `form` says which (`k`, add or edit), what it is about (`t`,
 * an FB-17 anchor id) and, when cheap, the label of the field I'm in
 * ("Seats"). Never a field's value. Others show a chip on that thing and in
 * its inspector ("Dennis is editing NH 744"); followers a banner ("Dennis
 * opened 'Add expense'").
 *
 * A private thing (a private expense, a private list item, my own private
 * budget) publishes nothing: pass `private: true`. The server also drops a
 * form on a private anchor, and money forms never reach a link guest.
 */
import { type RefObject, useEffect } from "react";
import type { Awareness } from "y-protocols/awareness";
import { useTripAwareness } from "./presence";
import {
	type AwarenessForm,
	cleanLabel,
	FORM_FIELD_MAX,
	type FormKind,
	MONEY_FORMS,
} from "./view-protocol";

export type FormSpec = {
	k: FormKind;
	m: "add" | "edit";
	/** The thing it is about, as an anchor id (`item:<id>`, `exp:<id>`…). */
	t?: string | null;
	/** Private (a private expense / list item): nothing is published. */
	private?: boolean;
	/** The field, when the editor knows it (else the focused control's label). */
	f?: string | null;
};

/** The anchor of a bundle target (the chip lands there); null for the trip / a leg. */
export function bundleAnchor(
	t:
		| { kind: "trip" }
		| { kind: "node"; nodeId: string }
		| { kind: "item"; itemId: string }
		| { kind: "day"; dayId: string }
		| { kind: "leg"; legId: string }
		| null
		| undefined,
): string | null {
	switch (t?.kind) {
		case "item":
			return `item:${t.itemId}`;
		case "day":
			return `dayh:${t.dayId}`;
		case "node":
			return `tree:${t.nodeId}`;
		default:
			return null;
	}
}

let token = 0;
let current = 0;

/** The label of a form control (never its value), cleaned; null when it has none. */
export function fieldLabel(el: Element | null): string | null {
	if (!el || !(el instanceof HTMLElement)) return null;
	const marked = el.closest("[data-presence-field]");
	const own =
		marked?.getAttribute("data-presence-field") ??
		el.getAttribute("aria-label") ??
		(el.id
			? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent
			: null) ??
		(el.getAttribute("aria-labelledby")
			? document.getElementById(el.getAttribute("aria-labelledby") ?? "")
					?.textContent
			: null) ??
		null;
	const text = cleanLabel(own, FORM_FIELD_MAX);
	return text || null;
}

function write(awareness: Awareness, form: AwarenessForm | null) {
	awareness.setLocalStateField("form", form);
}

/**
 * Publishes `spec` as my open form while mounted (null or private: nothing),
 * with the field in focus inside `root` (or inside any dialog when omitted).
 * `whileFocused`: only while focus is inside `root` (inline editors).
 */
export function useFormPresence(
	spec: FormSpec | null,
	root?: RefObject<HTMLElement | null>,
	opts: { whileFocused?: boolean } = {},
): void {
	const { awareness } = useTripAwareness();
	const key =
		spec && !spec.private
			? JSON.stringify([spec.k, spec.m, spec.t ?? null, spec.f ?? null])
			: null;
	const whileFocused = !!opts.whileFocused;
	useEffect(() => {
		if (!awareness || !key) return;
		const [k, m, t, given] = JSON.parse(key) as [
			FormKind,
			"add" | "edit",
			string | null,
			string | null,
		];
		const base: AwarenessForm = {
			k,
			m,
			t,
			v: MONEY_FORMS.includes(k) ? "members" : "all",
		};
		const mine = ++token;
		let field: string | null = given ? cleanLabel(given, FORM_FIELD_MAX) : null;
		let shown = false;
		const inside = (el: EventTarget | null) =>
			el instanceof Element &&
			(root?.current
				? root.current.contains(el)
				: !!el.closest('[role="dialog"],[role="alertdialog"]'));
		const publish = () => {
			current = mine;
			shown = true;
			write(awareness, field ? { ...base, f: field } : base);
		};
		const clear = () => {
			if (shown && current === mine) write(awareness, null);
			shown = false;
		};
		const onFocus = (e: FocusEvent) => {
			if (given || !inside(e.target)) return;
			const next = fieldLabel(e.target as Element);
			if (next === field && shown) return;
			field = next;
			publish();
		};
		const onBlur = (e: FocusEvent) => {
			// Inline editors: focus left the editor altogether.
			if (whileFocused && !inside(e.relatedTarget)) {
				field = null;
				clear();
			}
		};
		document.addEventListener("focusin", onFocus, true);
		document.addEventListener("focusout", onBlur, true);
		if (!whileFocused) publish();
		else if (inside(document.activeElement)) {
			field = fieldLabel(document.activeElement);
			publish();
		}
		return () => {
			document.removeEventListener("focusin", onFocus, true);
			document.removeEventListener("focusout", onBlur, true);
			clear();
		};
	}, [awareness, key, root, whileFocused]);
}

// ---------------------------------------------------------------------------
// What others see
// ---------------------------------------------------------------------------

const NOUN: Record<FormKind, string> = {
	flight: "a flight",
	expense: "an expense",
	item: "a plan item",
	place: "a place",
	stay: "a stay",
	budget: "a budget",
	list: "a to-do",
	hours: "opening hours",
	shift: "the trip dates",
	transit: "transit",
	settings: "the trip settings",
};

const TITLE: Record<FormKind, { add: string; edit: string }> = {
	flight: { add: "Add flight", edit: "Edit flight" },
	expense: { add: "Add expense", edit: "Edit expense" },
	item: { add: "Add to the plan", edit: "Item details" },
	place: { add: "Add place", edit: "Set location" },
	stay: { add: "Set stay", edit: "Set stay" },
	budget: { add: "Add budget", edit: "Edit budget" },
	list: { add: "Add to-do", edit: "Edit to-do" },
	hours: { add: "Opening hours", edit: "Opening hours" },
	shift: { add: "Try other dates", edit: "Try other dates" },
	transit: { add: "Add transit", edit: "Edit transit" },
	settings: { add: "Trip settings", edit: "Trip settings" },
};

function first(name: string): string {
	return name.split(" ")[0] || name;
}

/**
 * The chip: "Dennis is editing NH 744 · Seats" / "Dennis is adding an
 * expense…". `title` is the thing's name from MY data (null = unknown).
 */
export function formChipText(
	name: string,
	form: Pick<AwarenessForm, "k" | "m" | "f">,
	title: string | null,
): string {
	const who = first(name);
	const field = form.f ? ` · ${form.f}` : "";
	if (form.m === "add") return `${who} is adding ${NOUN[form.k]}…${field}`;
	return `${who} is editing ${title ?? NOUN[form.k]}${field}`;
}

/** The follower's banner: "Dennis opened 'Add expense'". */
export function formBannerText(
	name: string,
	form: Pick<AwarenessForm, "k" | "m">,
): string {
	return `${first(name)} opened ‘${TITLE[form.k][form.m]}’`;
}
