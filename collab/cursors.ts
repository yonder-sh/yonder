import {
	AwarenessCursor,
	AwarenessFollowing,
	AwarenessReact,
	AwarenessSpotlight,
	anchorKind,
	anchorPolicy,
	CHAT_PER_MIN,
	CURSOR_BURST,
	CURSOR_REFILL_PER_S,
	type CursorAnchor,
	type CursorVis,
	cleanChatText,
	REACT_PER_10S,
	REACT_PER_MIN,
	stricterVis,
} from "@/lib/realtime/cursor-protocol";
import { isUuid } from "@/lib/realtime/protocol";
import {
	AwarenessCam,
	AwarenessDrag,
	AwarenessForm,
	AwarenessLook,
	AwarenessMedia,
	AwarenessMenu,
	cleanLabel,
	cleanMenuItems,
	dropMoneyParams,
	FORM_FIELD_MAX,
	isMembersPath,
	MONEY_FORMS,
	RATES,
	type RateField,
} from "@/lib/realtime/view-protocol";
import type { CollabContext } from "./auth";

/**
 * Live cursors on the collab server (FB-17, 17a–d): the channel document's
 * `cursor`, `react`, `following` and `spotlight` awareness fields.
 *
 * Inbound (`CursorGuard.sanitize`, from `beforeHandleAwareness`):
 * - every field must validate (`cursor-protocol.ts`), else it is dropped;
 * - cursor updates are rate-limited per connection (a token bucket: a burst of
 *   CURSOR_BURST, refilled at CURSOR_REFILL_PER_S; over it, the previous cursor
 *   stays), new chat messages to CHAT_PER_MIN, reactions to REACT_PER_10S and
 *   REACT_PER_MIN (over it, the previous one stays: nothing new floats);
 * - chat text is cleaned (`cleanChatText`: no controls or bidi marks, ≤ 80);
 * - anchors: an unknown kind is dropped; money kinds are forced members-only;
 *   list rows, media tiles and expenses are looked up (cached): a PRIVATE
 *   to-do or expense never travels (the anchor, its chat and a reaction on it
 *   are dropped: nobody else can see that element), receipts and "Hide from
 *   guests" media are members-only. The same goes for `look` ranges and for
 *   `view.ui` keys whose values name such a thing (`list:<id>`): a private
 *   one drops the key, a members-only one too unless the key is `money.*`.
 *
 * Outbound (`installGuestAwarenessFilter`): every awareness message a LINK
 * GUEST's channel connection is about to receive is rewritten without
 * members-only cursors and reactions (and without "on the Money tab"), so a
 * guest never receives the anchor of anything it cannot see. This hooks
 * `Connection.prototype.send`, the one path every outgoing message takes
 * (the broadcast, the initial state on connect, other instances' updates
 * relayed by @hocuspocus/extension-redis).
 */

export type AnchorVerdict = "all" | "members" | "private";
/** Who may see the row behind a `lookup` anchor (`list`, `media`, `exp`). */
export type AnchorLookup = (
	tripId: string,
	kind: "list" | "media" | "exp",
	id: string,
) => Promise<AnchorVerdict>;

type Pool = {
	query<R extends Record<string, unknown>>(
		sql: string,
		params: unknown[],
	): Promise<{ rows: R[] }>;
};

/** The database lookup (no row = private: never sent). */
export function dbAnchorLookup(pool: Pool): AnchorLookup {
	return async (tripId, kind, id) => {
		if (!isUuid(id)) return "private";
		if (kind === "list") {
			const { rows } = await pool.query<{ is_private: boolean }>(
				"select is_private from list_items where trip_id = $1 and id = $2",
				[tripId, id],
			);
			const r = rows[0];
			return !r || r.is_private ? "private" : "all";
		}
		if (kind === "exp") {
			const { rows } = await pool.query<{ is_private: boolean }>(
				"select is_private from expenses where trip_id = $1 and id = $2",
				[tripId, id],
			);
			const r = rows[0];
			return !r || r.is_private ? "private" : "members";
		}
		const { rows } = await pool.query<{
			visibility: string;
			expense_id: string | null;
		}>(
			"select visibility::text as visibility, expense_id from attachments where trip_id = $1 and id = $2",
			[tripId, id],
		);
		const r = rows[0];
		if (!r) return "private";
		// Receipts are money (guests never see money); "Hide from guests" is members-only.
		return r.expense_id || r.visibility !== "everyone" ? "members" : "all";
	};
}

type Bucket = {
	tokens: number;
	at: number;
	chats: number[];
	reacts: number[];
	/** FB-21…25: one token bucket per field (`RATES`). */
	fields: Partial<Record<RateField, { tokens: number; at: number }>>;
};

type State = Record<string, unknown>;

export type CursorGuardOptions = {
	lookup: AnchorLookup;
	now?: () => number;
	/** How long a lookup verdict is reused. */
	cacheMs?: number;
	maxCache?: number;
};

export class CursorGuard {
	private readonly buckets = new WeakMap<object, Bucket>();
	private readonly cache = new Map<string, { v: AnchorVerdict; at: number }>();
	private readonly pending = new Map<string, Promise<AnchorVerdict>>();
	private readonly now: () => number;
	private readonly cacheMs: number;
	private readonly maxCache: number;

	constructor(private readonly opts: CursorGuardOptions) {
		this.now = opts.now ?? Date.now;
		this.cacheMs = opts.cacheMs ?? 15_000;
		this.maxCache = opts.maxCache ?? 5_000;
	}

	/**
	 * Who may see `anchor`: `all`, `members`, or null (drop it: private, or a
	 * kind we don't know). Map anchors are public (the map shows the plan).
	 */
	async visOf(tripId: string, anchor: CursorAnchor): Promise<CursorVis | null> {
		if (anchor.k === "map") return "all";
		const own = await this.idVis(tripId, anchor.id);
		if (own === null || !anchor.p) return own;
		// The enclosing anchor travels too: it must be visible to the same people.
		const up = await this.idVis(tripId, anchor.p.id);
		return up === null ? null : stricterVis(own, up);
	}

	private async idVis(
		tripId: string,
		anchorId: string,
	): Promise<CursorVis | null> {
		const policy = anchorPolicy(anchorId);
		if (policy === null) return null;
		if (policy !== "lookup") return policy;
		const [kind, id = ""] = anchorId.split(":") as [
			"list" | "media" | "exp",
			string,
		];
		const v = await this.lookup(tripId, kind, id);
		return v === "private" ? null : v;
	}

	private async lookup(
		tripId: string,
		kind: "list" | "media" | "exp",
		id: string,
	): Promise<AnchorVerdict> {
		const key = `${tripId}|${kind}|${id}`;
		const t = this.now();
		const hit = this.cache.get(key);
		if (hit && t - hit.at < this.cacheMs) return hit.v;
		const inflight = this.pending.get(key);
		if (inflight) return inflight;
		const p = this.opts
			.lookup(tripId, kind, id)
			.then((v) => {
				this.cache.delete(key);
				this.cache.set(key, { v, at: this.now() });
				while (this.cache.size > this.maxCache) {
					const oldest = this.cache.keys().next().value;
					if (oldest === undefined) break;
					this.cache.delete(oldest);
				}
				return v;
			})
			.catch((e: unknown) => {
				// Fail closed, and don't remember it: the next update asks again.
				console.error(
					"[collab] cursor anchor lookup failed:",
					e instanceof Error ? e.message : e,
				);
				return "private" as const;
			})
			.finally(() => this.pending.delete(key));
		this.pending.set(key, p);
		return p;
	}

	private bucket(key: object): Bucket {
		let b = this.buckets.get(key);
		if (!b) {
			b = {
				tokens: CURSOR_BURST,
				at: this.now(),
				chats: [],
				reacts: [],
				fields: {},
			};
			this.buckets.set(key, b);
		}
		return b;
	}

	/** One cursor update: false when this connection is over its rate. */
	takeCursor(key: object): boolean {
		const b = this.bucket(key);
		const t = this.now();
		b.tokens = Math.min(
			CURSOR_BURST,
			b.tokens + ((t - b.at) / 1000) * CURSOR_REFILL_PER_S,
		);
		b.at = t;
		if (b.tokens < 1) return false;
		b.tokens -= 1;
		return true;
	}

	/** One update of a FB-21…25 field: false when this connection is over its rate. */
	takeField(key: object, field: RateField): boolean {
		const b = this.bucket(key);
		const t = this.now();
		const rate = RATES[field];
		const f = b.fields[field] ?? { tokens: rate.burst, at: t };
		f.tokens = Math.min(rate.burst, f.tokens + ((t - f.at) / 1000) * rate.perS);
		f.at = t;
		b.fields[field] = f;
		if (f.tokens < 1) return false;
		f.tokens -= 1;
		return true;
	}

	/** One new chat message: false over CHAT_PER_MIN. */
	takeChat(key: object): boolean {
		const b = this.bucket(key);
		const t = this.now();
		b.chats = b.chats.filter((x) => t - x < 60_000);
		if (b.chats.length >= CHAT_PER_MIN) return false;
		b.chats.push(t);
		return true;
	}

	/** One reaction: false over REACT_PER_10S or REACT_PER_MIN. */
	takeReact(key: object): boolean {
		const b = this.bucket(key);
		const t = this.now();
		b.reacts = b.reacts.filter((x) => t - x < 60_000);
		const recent = b.reacts.filter((x) => t - x < 10_000).length;
		if (recent >= REACT_PER_10S || b.reacts.length >= REACT_PER_MIN)
			return false;
		b.reacts.push(t);
		return true;
	}

	/**
	 * The channel-only fields of one inbound state, cleaned (`clean` already
	 * holds `user`, `view` and `editing`). `prev` is this client's current,
	 * already-sanitized state (what stays when an update is over its rate).
	 */
	async sanitize(
		state: State,
		prev: State | undefined,
		ctx: Pick<CollabContext, "tripId">,
		key: object,
		clean: State,
	): Promise<void> {
		// y-protocols sends the whole local state each time: a missing field is gone.
		if ("cursor" in state) {
			const c = await this.cleanCursor(state.cursor, prev?.cursor, ctx, key);
			if (c !== undefined) clean.cursor = c;
		}
		if ("react" in state) {
			const r = await this.cleanReact(state.react, prev?.react, ctx, key);
			if (r !== undefined) clean.react = r;
		}
		if ("following" in state) {
			const f = AwarenessFollowing.safeParse(state.following);
			if (f.success) clean.following = f.data;
		}
		if ("spotlight" in state) {
			const s = AwarenessSpotlight.safeParse(state.spotlight);
			if (s.success) clean.spotlight = s.data;
		}
		// `view.ui` keys that name something private (or members-only outside `money.*`).
		if (clean.view && typeof clean.view === "object") {
			const v = clean.view as { ui?: Record<string, unknown> };
			if (v.ui) {
				const ui = await this.cleanUiAnchors(ctx.tripId, v.ui);
				if (Object.keys(ui).length) clean.view = { ...v, ui };
				else {
					const { ui: _drop, ...rest } = v;
					clean.view = rest;
				}
			}
		}
		// FB-21: a view that changes faster than RATES.view keeps the previous one.
		if (clean.view !== undefined && prev?.view !== undefined) {
			const changed = JSON.stringify(clean.view) !== JSON.stringify(prev.view);
			if (changed && !this.takeField(key, "view")) clean.view = prev.view;
		}
		for (const field of [
			"cam",
			"media",
			"drag",
			"form",
			"menu",
			"look",
		] as const) {
			if (!(field in state)) continue;
			const v = await this.cleanField(
				field,
				state[field],
				prev?.[field],
				ctx,
				key,
			);
			if (v !== undefined) clean[field] = v;
		}
	}

	/**
	 * `view.ui` without the keys that name something a viewer of my view may
	 * not see: a private row drops its key; a members-only thing does too,
	 * unless the key is a members-only one (`money.*`).
	 */
	private async cleanUiAnchors(
		tripId: string,
		ui: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const out: Record<string, unknown> = {};
		for (const [path, value] of Object.entries(ui)) {
			if (path === "plan") {
				out[path] = value;
				continue;
			}
			const strs = Array.isArray(value)
				? value
				: typeof value === "string"
					? [value]
					: [];
			let ok = true;
			for (const s of strs) {
				if (typeof s !== "string" || anchorKind(s) === null) continue;
				const vis = await this.idVis(tripId, s);
				if (vis === null || (vis === "members" && !isMembersPath(path))) {
					ok = false;
					break;
				}
			}
			if (ok) out[path] = value;
		}
		return out;
	}

	/**
	 * FB-21c…25: one of `cam`, `media`, `drag`, `form`, `menu`, `look`. Null
	 * clears it; a malformed value clears it; an unchanged one passes (no token);
	 * over the field's rate the previous value stays; anything anchored on a
	 * private thing is dropped whole (the FB-17a lookups), members-only
	 * anchors and money forms are marked `v: "members"` (guests never get them).
	 */
	private async cleanField(
		field: "cam" | "media" | "drag" | "form" | "menu" | "look",
		raw: unknown,
		prevRaw: unknown,
		ctx: Pick<CollabContext, "tripId">,
		key: object,
	): Promise<unknown> {
		if (raw === null) return null;
		const next = await this.parseField(field, raw, ctx);
		if (next === null) return null;
		if (
			prevRaw !== undefined &&
			JSON.stringify(prevRaw) === JSON.stringify(next)
		)
			return next;
		if (!this.takeField(key, field))
			return prevRaw === undefined ? undefined : prevRaw;
		return next;
	}

	private async parseField(
		field: "cam" | "media" | "drag" | "form" | "menu" | "look",
		raw: unknown,
		ctx: Pick<CollabContext, "tripId">,
	): Promise<Record<string, unknown> | null> {
		switch (field) {
			case "cam": {
				const c = AwarenessCam.safeParse(raw);
				return c.success ? c.data : null;
			}
			case "media": {
				const m = AwarenessMedia.safeParse(raw);
				if (!m.success) return null;
				const vis = await this.idVis(ctx.tripId, `media:${m.data.id}`);
				if (vis === null) return null;
				return { ...m.data, v: stricterVis(m.data.v, vis) };
			}
			case "drag": {
				const d = AwarenessDrag.safeParse(raw);
				if (!d.success) return null;
				let vis = await this.idVis(ctx.tripId, d.data.a);
				if (vis === null) return null;
				if (d.data.o) {
					const o = await this.idVis(ctx.tripId, d.data.o.id);
					if (o === null) return null;
					vis = stricterVis(vis, o);
				}
				return { ...d.data, v: stricterVis(d.data.v, vis) };
			}
			case "form": {
				const f = AwarenessForm.safeParse(raw);
				if (!f.success) return null;
				let vis: CursorVis = MONEY_FORMS.includes(f.data.k) ? "members" : "all";
				if (f.data.t) {
					const t = await this.idVis(ctx.tripId, f.data.t);
					if (t === null) return null; // a private expense / list item: invisible
					vis = stricterVis(vis, t);
				}
				const label = cleanLabel(f.data.f, FORM_FIELD_MAX);
				return {
					k: f.data.k,
					m: f.data.m,
					t: f.data.t ?? null,
					...(label ? { f: label } : {}),
					v: stricterVis(f.data.v, vis),
				};
			}
			case "look": {
				const l = AwarenessLook.safeParse(raw);
				if (!l.success) return null;
				// Each range stands alone: one on a private row is left out.
				const r = [];
				for (const range of l.data.r) {
					const t = await this.idVis(ctx.tripId, range.t.id);
					const b =
						t === null ? null : await this.idVis(ctx.tripId, range.b.id);
					if (t === null || b === null) continue;
					r.push({
						t: range.t,
						b: range.b,
						v: stricterVis(range.v ?? "all", stricterVis(t, b)),
					});
				}
				return { f: l.data.f, r };
			}
			case "menu": {
				const m = AwarenessMenu.safeParse(raw);
				if (!m.success) return null;
				const vis = await this.idVis(ctx.tripId, m.data.a);
				if (vis === null) return null;
				const items = cleanMenuItems(m.data.items);
				return {
					...m.data,
					items,
					hi: m.data.hi < items.length ? m.data.hi : -1,
					v: stricterVis(m.data.v, vis),
				};
			}
		}
	}

	private async cleanCursor(
		raw: unknown,
		prevRaw: unknown,
		ctx: Pick<CollabContext, "tripId">,
		key: object,
	): Promise<unknown> {
		const prev = AwarenessCursor.safeParse(prevRaw);
		if (raw === null) return null;
		const parsed = AwarenessCursor.safeParse(raw);
		if (!parsed.success) return null; // malformed: hidden
		if (!this.takeCursor(key)) return prev.success ? prev.data : undefined;
		const c = parsed.data;
		let vis: CursorVis = c.v;
		let anchor = c.a;
		if (anchor) {
			const allowed = await this.visOf(ctx.tripId, anchor);
			if (allowed === null) anchor = null;
			else vis = stricterVis(vis, allowed);
		}
		let chat: AwarenessCursor["chat"] = null;
		if (c.chat && anchor) {
			const text = cleanChatText(c.chat.text);
			const prevChat = prev.success ? prev.data.chat : null;
			if (text) {
				if (prevChat && prevChat.n === c.chat.n) chat = { n: c.chat.n, text };
				else if (this.takeChat(key)) chat = { n: c.chat.n, text };
				else chat = null; // over the chat rate: the message doesn't show
			}
		}
		return {
			a: anchor,
			v: anchor ? vis : "all",
			m: c.m,
			...(c.tap !== undefined ? { tap: c.tap } : {}),
			...(chat ? { chat } : {}),
		} satisfies AwarenessCursor;
	}

	private async cleanReact(
		raw: unknown,
		prevRaw: unknown,
		ctx: Pick<CollabContext, "tripId">,
		key: object,
	): Promise<unknown> {
		const prev = AwarenessReact.safeParse(prevRaw);
		const keep = prev.success ? prev.data : undefined;
		if (raw === null) return null;
		const parsed = AwarenessReact.safeParse(raw);
		if (!parsed.success) return keep;
		const r = parsed.data;
		if (keep && keep.n === r.n) return keep; // not a new reaction
		const allowed = await this.visOf(ctx.tripId, r.a);
		if (allowed === null) return keep; // on something private: never sent
		if (!this.takeReact(key)) return keep;
		return { ...r, v: stricterVis(r.v, allowed) };
	}
}

// ---------------------------------------------------------------------------
// Outbound: what a link guest receives
// ---------------------------------------------------------------------------

/**
 * A state as a link guest may see it: no members-only cursor, reaction,
 * media, drag, form or menu (FB-21…25), no members-only `look` range, no
 * Money tab or money view keys.
 */
export function guestView(state: State): State {
	let out = state;
	const cursor = state.cursor as { v?: unknown } | null | undefined;
	if (cursor && typeof cursor === "object" && cursor.v !== "all") {
		out = { ...out, cursor: null };
	}
	const react = state.react as { v?: unknown } | null | undefined;
	if (react && typeof react === "object" && react.v !== "all") {
		out = { ...out };
		delete out.react;
	}
	for (const field of ["media", "drag", "form", "menu"] as const) {
		const f = state[field] as { v?: unknown } | null | undefined;
		if (f && typeof f === "object" && f.v !== "all") {
			out = { ...out };
			delete out[field];
		}
	}
	const view = state.view as
		| { tab?: unknown; path?: unknown; ui?: unknown }
		| undefined;
	if (view && typeof view === "object") {
		let v = view;
		if (view.tab === "money") v = { ...v, tab: "plan" };
		if (typeof view.path === "string" && /[?&]i?tab=money/.test(view.path))
			v = { ...v, path: dropMoneyParams(view.path) };
		const ui = view.ui as Record<string, unknown> | undefined;
		if (ui && typeof ui === "object") {
			const keys = Object.keys(ui);
			if (keys.some(isMembersPath)) {
				const rest: Record<string, unknown> = {};
				for (const k of keys) if (!isMembersPath(k)) rest[k] = ui[k];
				v = { ...v, ui: rest };
			}
		}
		if (v !== view) out = { ...out, view: v };
	}
	const look = state.look as { r?: unknown } | null | undefined;
	if (look && typeof look === "object" && Array.isArray(look.r)) {
		const r = look.r.filter(
			(x) => x && typeof x === "object" && (x as { v?: unknown }).v === "all",
		);
		if (r.length !== look.r.length) out = { ...out, look: { ...look, r } };
	}
	return out;
}

// Minimal lib0-compatible varint codec (the y-protocols / Hocuspocus wire format).
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

class Reader {
	pos = 0;
	constructor(private readonly buf: Uint8Array) {}
	uint(): number {
		let num = 0;
		let mult = 1;
		for (;;) {
			const r = this.buf[this.pos++];
			if (r === undefined) throw new Error("unexpected end of buffer");
			num += (r & 0x7f) * mult;
			if (r < 0x80) return num;
			mult *= 128;
			if (mult > 2 ** 53) throw new Error("varint too long");
		}
	}
	bytes(): Uint8Array {
		const len = this.uint();
		if (this.pos + len > this.buf.length)
			throw new Error("unexpected end of buffer");
		const out = this.buf.subarray(this.pos, this.pos + len);
		this.pos += len;
		return out;
	}
	string(): string {
		return fromUtf8.decode(this.bytes());
	}
	get done(): boolean {
		return this.pos >= this.buf.length;
	}
}

class Writer {
	private readonly parts: number[] = [];
	private chunks: Uint8Array[] = [];
	uint(n: number): void {
		let num = n;
		while (num > 0x7f) {
			this.parts.push(0x80 | (num & 0x7f));
			num = Math.floor(num / 128);
		}
		this.parts.push(num & 0x7f);
	}
	bytes(b: Uint8Array): void {
		this.uint(b.length);
		this.flush();
		this.chunks.push(b);
	}
	string(s: string): void {
		this.bytes(utf8.encode(s));
	}
	private flush() {
		if (this.parts.length) {
			this.chunks.push(Uint8Array.from(this.parts));
			this.parts.length = 0;
		}
	}
	toBytes(): Uint8Array {
		this.flush();
		const len = this.chunks.reduce((n, c) => n + c.length, 0);
		const out = new Uint8Array(len);
		let at = 0;
		for (const c of this.chunks) {
			out.set(c, at);
			at += c.length;
		}
		this.chunks = [];
		return out;
	}
}

/** Rewrites every state of a y-protocols awareness update with `fn` (clocks kept). */
export function mapAwarenessUpdate(
	update: Uint8Array,
	fn: (state: State) => State,
): Uint8Array {
	const r = new Reader(update);
	const w = new Writer();
	const n = r.uint();
	w.uint(n);
	for (let i = 0; i < n; i++) {
		w.uint(r.uint()); // clientID
		w.uint(r.uint()); // clock
		const json = r.string();
		const state = JSON.parse(json) as State | null;
		w.string(
			state && typeof state === "object" ? JSON.stringify(fn(state)) : json,
		);
	}
	return w.toBytes();
}

/** Hocuspocus MessageType.Awareness. */
const AWARENESS = 1;

/**
 * One outgoing Hocuspocus message as a link guest may receive it: awareness
 * messages are rewritten with `guestView`; anything else passes unchanged.
 * Null for an awareness message that doesn't parse (the caller drops it:
 * fail closed).
 */
export function guestMessage(message: Uint8Array): Uint8Array | null {
	let r: Reader;
	let address: string;
	try {
		r = new Reader(message);
		address = r.string();
		if (r.uint() !== AWARENESS) return message;
	} catch {
		return message; // not a framed Hocuspocus message: nothing of ours in it
	}
	try {
		const update = r.bytes();
		const w = new Writer();
		w.string(address);
		w.uint(AWARENESS);
		w.bytes(mapAwarenessUpdate(update, guestView));
		return w.toBytes();
	} catch {
		return null;
	}
}

const INSTALLED = Symbol.for("yonder.collab.guestAwarenessFilter");

type SendProto = {
	send(message: Uint8Array): void;
	[INSTALLED]?: boolean;
};

/**
 * Makes every Hocuspocus connection of a link guest on a trip channel receive
 * awareness through `guestMessage` (idempotent). Pass
 * `Connection.prototype` from `@hocuspocus/server`.
 */
export function installGuestAwarenessFilter(proto: SendProto): void {
	if (proto[INSTALLED]) return;
	proto[INSTALLED] = true;
	const send = proto.send;
	proto.send = function (
		this: { context?: CollabContext },
		message: Uint8Array,
	) {
		const ctx = this.context;
		if (ctx?.guest && ctx.docKind === "channel") {
			const out = guestMessage(message);
			if (!out) {
				console.error(
					"[collab] dropped a malformed awareness message for a guest",
				);
				return;
			}
			return send.call(this, out);
		}
		return send.call(this, message);
	};
}
