/**
 * Ghosts on the live-cursor layer (no React, like the cursors):
 * - FB-23 live drags: while someone drags a card / place / row, the original
 *   is dimmed (a style rule), a ghost of it rides at their cursor with
 *   "Dennis is moving Shibuya Sky", and a line in their colour shows where it
 *   would land. Gone on drop, cancel, disconnect, or after DRAG_IDLE_MS
 *   without a change.
 * - FB-25 open menus: a non-interactive copy of someone's open context / ⋯
 *   menu, anchored to the same element, their hovered entry highlighted (the
 *   overlay puts their cursor on it).
 * Everything is anchored with the FB-17 anchors (`findAnchor`), so it lands
 * on the same thing on any screen; the server already dropped anything on a
 * private thing, and names come from MY data (`labelOf`), never the wire.
 */
import { presenceColor } from "@/components/common/person-avatar";
import { formChipText } from "@/lib/realtime/form-presence";
import type {
	AwarenessDrag,
	AwarenessForm,
	AwarenessMenu,
} from "@/lib/realtime/view-protocol";
import { DRAG_IDLE_MS } from "@/lib/realtime/view-protocol";
import { anchorSelector, clipOf, findAnchor } from "./anchors";
import { intersect, isEmpty } from "./geometry";

export type GhostPeer = {
	userId: string;
	name: string;
	color: number;
	/** On my scope (ghosts show only there, like cursors). */
	here: boolean;
	drag: AwarenessDrag | null;
	/** When their drag last changed (my clock). */
	dragAt: number;
	menu: AwarenessMenu | null;
	/** FB-24: the editor / dialog they have open. */
	form: AwarenessForm | null;
	/** Their cursor as drawn now (null when it isn't). */
	cursor: { x: number; y: number } | null;
};

/** What a ghost says about an anchor (a card's title), from MY data; null = unknown. */
export type LabelOf = (anchorId: string) => string | null;

type Els = {
	drag: HTMLDivElement | null;
	dragKey: string;
	drop: HTMLDivElement | null;
	menu: HTMLDivElement | null;
	menuKey: string;
	form: HTMLDivElement | null;
	formKey: string;
};

function firstName(name: string): string {
	return name.split(" ")[0] || name;
}

export class Ghosts {
	private readonly els = new Map<string, Els>();

	constructor(
		private readonly layer: HTMLElement,
		private labelOf: LabelOf,
	) {}

	setLabelOf(fn: LabelOf): void {
		this.labelOf = fn;
		for (const e of this.els.values()) e.dragKey = ""; // re-label
	}

	/** Is this peer's drag still live (not idle)? */
	static live(p: GhostPeer, now: number): boolean {
		return !!p.drag && now - p.dragAt < DRAG_IDLE_MS;
	}

	/** Style rules: each live drag's original, dimmed with a dashed rule. */
	styleRules(peers: readonly GhostPeer[], now: number): string[] {
		const out: string[] = [];
		for (const p of peers) {
			if (!p.here || !Ghosts.live(p, now) || !p.drag) continue;
			const c = presenceColor(p.color);
			out.push(
				`${anchorSelector(p.drag.a)}{opacity:.45;outline:2px dashed ${c};outline-offset:-2px}`,
			);
		}
		return out;
	}

	/** The ghost menu of `userId` on screen now (their cursor over it lands there). */
	menuElOf(userId: string): HTMLElement | null {
		const m = this.els.get(userId)?.menu;
		return m && !m.hidden ? m : null;
	}

	/** One frame: places every ghost; returns whether any is showing. */
	update(
		peers: readonly GhostPeer[],
		now: number,
		opts: { hideMenus: boolean },
	): boolean {
		let any = false;
		const seen = new Set<string>();
		for (const p of peers) {
			seen.add(p.userId);
			const e = this.slot(p.userId);
			const dragOn = p.here && Ghosts.live(p, now);
			if (dragOn && p.drag) any = this.drawDrag(p, e) || any;
			else this.hideDrag(e);
			if (p.here && p.menu && !opts.hideMenus)
				any = this.drawMenu(p, p.menu, e) || any;
			else if (e.menu) e.menu.hidden = true;
			if (p.form?.t) any = this.drawForm(p, p.form, p.form.t, e) || any;
			else if (e.form) e.form.hidden = true;
		}
		for (const [id, e] of this.els) {
			if (seen.has(id)) continue;
			for (const el of [e.drag, e.drop, e.menu, e.form]) el?.remove();
			this.els.delete(id);
		}
		return any;
	}

	destroy(): void {
		for (const e of this.els.values())
			for (const el of [e.drag, e.drop, e.menu, e.form]) el?.remove();
		this.els.clear();
	}

	// ---- forms (FB-24) --------------------------------------------------------------

	/** "Dennis is editing NH 744 · Seats" on the thing's own card / row. */
	private drawForm(p: GhostPeer, f: AwarenessForm, t: string, e: Els): boolean {
		const el = findAnchor(t);
		const r = el?.getBoundingClientRect();
		const clip = el ? clipOf(el) : null;
		if (!el || !r || !clip || r.width < 1 || isEmpty(intersect(clip, r))) {
			if (e.form) e.form.hidden = true;
			return false;
		}
		if (!e.form) {
			e.form = document.createElement("div");
			e.form.className = "yc-form";
			e.form.dataset.testid = "remote-form-chip";
			this.layer.appendChild(e.form);
		}
		const text = formChipText(p.name, f, this.labelOf(t));
		const key = `${text}|${p.color}|${t}`;
		if (e.formKey !== key) {
			e.formKey = key;
			e.form.dataset.userId = p.userId;
			e.form.dataset.anchor = t;
			e.form.style.setProperty("--yc-color", presenceColor(p.color));
			e.form.textContent = text;
		}
		e.form.hidden = false;
		const w = e.form.offsetWidth || 180;
		const x = Math.max(
			clip.left + 2,
			Math.min(r.right - w - 8, clip.right - w - 2),
		);
		const y = Math.max(clip.top + 2, Math.min(r.top - 9, clip.bottom - 20));
		e.form.style.transform = `translate3d(${x}px, ${y}px, 0)`;
		return true;
	}

	// ---- drags ------------------------------------------------------------------

	private slot(userId: string): Els {
		let e = this.els.get(userId);
		if (!e) {
			e = {
				drag: null,
				dragKey: "",
				drop: null,
				menu: null,
				menuKey: "",
				form: null,
				formKey: "",
			};
			this.els.set(userId, e);
		}
		return e;
	}

	private hideDrag(e: Els): void {
		if (e.drag) e.drag.hidden = true;
		if (e.drop) e.drop.hidden = true;
	}

	private drawDrag(p: GhostPeer, e: Els): boolean {
		const d = p.drag;
		if (!d) return false;
		const color = presenceColor(p.color);
		const title = this.labelOf(d.a);
		const key = `${d.a}|${title}|${p.name}|${p.color}`;
		if (!e.drag) {
			e.drag = document.createElement("div");
			e.drag.className = "yc-drag";
			e.drag.dataset.testid = "remote-drag";
			this.layer.appendChild(e.drag);
		}
		if (e.dragKey !== key) {
			e.dragKey = key;
			e.drag.dataset.userId = p.userId;
			e.drag.dataset.anchor = d.a;
			e.drag.style.setProperty("--yc-color", color);
			e.drag.replaceChildren();
			const tag = document.createElement("span");
			tag.className = "yc-label";
			tag.dataset.testid = "remote-drag-label";
			tag.textContent = title
				? `${firstName(p.name)} is moving ${title}`
				: `${firstName(p.name)} is moving something`;
			const card = document.createElement("span");
			card.className = "yc-drag-card";
			card.textContent = title ?? "…";
			e.drag.append(tag, card);
		}
		// Where it would land: a line in their colour.
		let dropAt: { x: number; y: number } | null = null;
		const o = d.o;
		const target = o ? findAnchor(o.id) : null;
		if (o && target) {
			if (!e.drop) {
				e.drop = document.createElement("div");
				e.drop.className = "yc-drop";
				e.drop.dataset.testid = "remote-drop";
				this.layer.appendChild(e.drop);
			}
			const r = target.getBoundingClientRect();
			const clip = clipOf(target);
			const y = o.w === "before" ? r.top : r.bottom - 2;
			const box = intersect(clip, {
				left: r.left,
				top: y - 1,
				right: r.right,
				bottom: y + 1,
			});
			if (isEmpty(box)) {
				e.drop.hidden = true;
			} else {
				e.drop.hidden = false;
				e.drop.dataset.userId = p.userId;
				e.drop.dataset.target = o.id;
				e.drop.style.setProperty("--yc-color", color);
				e.drop.style.width = `${Math.max(0, box.right - box.left)}px`;
				e.drop.style.transform = `translate3d(${box.left}px, ${y - 1}px, 0)`;
				dropAt = { x: box.left + 12, y };
			}
		} else if (e.drop) e.drop.hidden = true;
		// The ghost rides at their cursor, below the cursor's own name tag (at
		// +13/+16, cursors.css); a touch drag (no cursor) sits by the line.
		const at = p.cursor
			? { x: p.cursor.x + 14, y: p.cursor.y + 40 }
			: dropAt
				? { x: dropAt.x, y: dropAt.y + 4 }
				: null;
		if (!at) {
			e.drag.hidden = true;
			return !!dropAt;
		}
		const w = e.drag.offsetWidth || 220;
		const h = e.drag.offsetHeight || 56;
		const x = Math.max(4, Math.min(at.x, window.innerWidth - w - 4));
		const y = Math.max(4, Math.min(at.y, window.innerHeight - h - 4));
		e.drag.hidden = false;
		e.drag.style.transform = `translate3d(${x}px, ${y}px, 0)`;
		return true;
	}

	// ---- menus ------------------------------------------------------------------

	private drawMenu(p: GhostPeer, m: AwarenessMenu, e: Els): boolean {
		const el = findAnchor(m.a);
		const r = el?.getBoundingClientRect();
		if (!el || !r || r.width < 1 || r.height < 1 || isEmpty(clipOf(el))) {
			if (e.menu) e.menu.hidden = true;
			return false;
		}
		if (!e.menu) {
			e.menu = document.createElement("div");
			e.menu.className = "yc-menu";
			e.menu.dataset.testid = "remote-menu";
			e.menu.setAttribute("aria-hidden", "true");
			this.layer.appendChild(e.menu);
		}
		const key = JSON.stringify([m.items, m.hi, p.name, p.color, m.a]);
		if (e.menuKey !== key) {
			e.menuKey = key;
			e.menu.dataset.userId = p.userId;
			e.menu.dataset.anchor = m.a;
			e.menu.style.setProperty("--yc-color", presenceColor(p.color));
			e.menu.replaceChildren();
			const tag = document.createElement("span");
			tag.className = "yc-menu-tag";
			tag.textContent = firstName(p.name);
			e.menu.appendChild(tag);
			m.items.forEach((label, i) => {
				if (!label) {
					const sep = document.createElement("div");
					sep.className = "yc-menu-sep";
					e.menu?.appendChild(sep);
					return;
				}
				const row = document.createElement("div");
				row.className = "yc-menu-item";
				row.dataset.testid = "remote-menu-item";
				if (i === m.hi) row.dataset.hi = "";
				row.textContent = label;
				e.menu?.appendChild(row);
			});
		}
		e.menu.hidden = false;
		const w = e.menu.offsetWidth || 200;
		const h = e.menu.offsetHeight || 120;
		const x = Math.max(
			4,
			Math.min(r.left + m.fx * r.width, window.innerWidth - w - 4),
		);
		const y = Math.max(
			4,
			Math.min(r.top + m.fy * r.height, window.innerHeight - h - 4),
		);
		e.menu.style.transform = `translate3d(${x}px, ${y}px, 0)`;
		return true;
	}
}
