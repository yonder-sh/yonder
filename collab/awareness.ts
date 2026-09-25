import {
	AwarenessEditing,
	type AwarenessUser,
	AwarenessView,
	VIEW_PATH_RE,
} from "@/lib/realtime/protocol";
import { cleanViewUi } from "@/lib/realtime/view-protocol";
import type { CollabContext } from "./auth";
import type { CursorGuard } from "./cursors";

/**
 * Server-side awareness sanitizer (SPEC §10.4, SECURITY §4 "awareness is
 * untrusted"). Runs in Hocuspocus' `beforeHandleAwareness` for every inbound
 * update, before it is applied or relayed:
 *
 * - `user` is replaced by the identity from the authenticated connection, so a
 *   client can't show up as someone else (or with an email, or a fake colour).
 * - `view` (channel doc) must validate and its `path` must stay inside `/t/<slug>`
 *   of THIS trip; otherwise it is dropped (Follow navigates to it).
 * - `editing` must validate; `cursor` (TipTap caret, note docs) must be a small
 *   plain object. Every other field is dropped.
 * - A client may not overwrite or remove the state of a clientId that currently
 *   belongs to another user.
 * - Channel doc only (FB-17, `sanitizeAwarenessUpdateLive`): the live
 *   `cursor`, `react`, `following` and `spotlight` fields, and FB-21…25's
 *   `cam`, `media`, `drag`, `form` and `menu` (plus a rate limit on `view`)
 *   go through the CursorGuard (validated, rate-limited, private anchors
 *   dropped; see `cursors.ts`). The synchronous `sanitizeAwarenessUpdate`
 *   drops them.
 */

const MAX_CURSOR_JSON = 2_048;

type States = Map<number, Record<string, unknown> | null | undefined>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function viewInTrip(path: string, slug: string): boolean {
	const base = `/t/${slug}`;
	return (
		VIEW_PATH_RE.test(path) &&
		(path === base ||
			path.startsWith(`${base}/`) ||
			path.startsWith(`${base}?`))
	);
}

export function awarenessUser(ctx: CollabContext): AwarenessUser {
	return {
		id: ctx.userId,
		memberId: ctx.memberId,
		name: ctx.name,
		color: ctx.color,
		guest: ctx.guest,
		...(ctx.image ? { image: ctx.image } : {}),
	};
}

/** Rewrites one client state; null means "drop it". */
export function sanitizeState(
	state: Record<string, unknown>,
	ctx: CollabContext,
): Record<string, unknown> {
	const clean: Record<string, unknown> = { user: awarenessUser(ctx) };
	if (ctx.docKind === "channel" && "view" in state) {
		const raw = state.view as { ui?: unknown } | null | undefined;
		// FB-21: `view.ui` is validated on its own (and capped in size): a bad
		// or oversized one is dropped without losing the path.
		const ui =
			raw && typeof raw === "object" && "ui" in raw
				? cleanViewUi(raw.ui)
				: null;
		const view = AwarenessView.safeParse(
			raw && typeof raw === "object" ? { ...raw, ui: undefined } : raw,
		);
		if (view.success && viewInTrip(view.data.path, ctx.slug)) {
			const { ui: _drop, ...rest } = view.data;
			clean.view = ui ? { ...rest, ui } : rest;
		}
	}
	if ("editing" in state) {
		const editing = AwarenessEditing.safeParse(state.editing);
		if (editing.success) clean.editing = editing.data;
	}
	if (ctx.docKind === "note" && isPlainObject(state.cursor)) {
		try {
			if (JSON.stringify(state.cursor).length <= MAX_CURSOR_JSON)
				clean.cursor = state.cursor;
		} catch {
			// cyclic or otherwise unserialisable: drop
		}
	}
	return clean;
}

/**
 * Mutates `states` in place (the Hocuspocus 4.7 contract). `current` is the
 * document's awareness before the update (`document.awareness.getStates()`).
 */
export function sanitizeAwarenessUpdate(
	states: States,
	current: Map<number, Record<string, unknown>>,
	ctx: CollabContext,
): void {
	for (const [clientId, state] of [...states]) {
		const owner = (current.get(clientId)?.user as { id?: unknown } | undefined)
			?.id;
		if (typeof owner === "string" && owner !== ctx.userId) {
			states.delete(clientId);
			continue;
		}
		if (!isPlainObject(state)) continue; // a removal of the client's own state
		states.set(clientId, sanitizeState(state, ctx));
	}
}

/**
 * The live sanitizer (`beforeHandleAwareness`): `sanitizeAwarenessUpdate`,
 * plus the channel document's cursor fields through `guard` (FB-17). `key`
 * is the connection (the rate limits are per connection).
 */
export async function sanitizeAwarenessUpdateLive(
	states: States,
	current: Map<number, Record<string, unknown>>,
	ctx: CollabContext,
	guard: CursorGuard,
	key: object,
): Promise<void> {
	const raw = new Map(states);
	sanitizeAwarenessUpdate(states, current, ctx);
	if (ctx.docKind !== "channel") return;
	for (const [clientId, clean] of states) {
		const state = raw.get(clientId);
		if (!clean || !isPlainObject(state)) continue;
		await guard.sanitize(state, current.get(clientId), ctx, key, clean);
	}
}
