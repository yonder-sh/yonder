/**
 * FEEDBACK-4 client pieces that don't need a server: form presence texts and
 * matching, drag drop targets, menu reading, and the
 * layer's ghosts (drag, menu, form chip) drawn from anchors.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	bundleAnchor,
	formBannerText,
	formChipText,
} from "@/lib/realtime/form-presence";
import { dropTargetOf } from "./cursors/drag-presence";
import { Ghosts } from "./cursors/ghosts";
import { readMenu } from "./cursors/menu-presence";
import { formTargetsSel } from "./form-presence-ui";

const ITEM = "0192f5a0-0000-7000-8000-0000000000c1";
const DAY = "0192f5a0-0000-7000-8000-0000000000d1";

afterEach(() => {
	document.body.innerHTML = "";
});

describe("form presence (FB-24)", () => {
	it("says who edits what, with the field; adds never name anything", () => {
		expect(
			formChipText(
				"Dennis Kim",
				{ k: "flight", m: "edit", f: "Seats" },
				"NH 744",
			),
		).toBe("Dennis is editing NH 744 · Seats");
		expect(
			formChipText("Dennis Kim", { k: "expense", m: "add" }, "Ramen"),
		).toBe("Dennis is adding an expense…");
		expect(formChipText("Maya", { k: "list", m: "edit" }, null)).toBe(
			"Maya is editing a to-do",
		);
		expect(formBannerText("Dennis Kim", { k: "expense", m: "add" })).toBe(
			"Dennis opened ‘Add expense’",
		);
	});
	it("lands on the selected thing's inspector", () => {
		expect(formTargetsSel(`item:${ITEM}`, { kind: "item", id: ITEM })).toBe(
			true,
		);
		expect(formTargetsSel(`dayh:${DAY}`, { kind: "day", id: DAY })).toBe(true);
		expect(
			formTargetsSel(`leg:l.${ITEM}.${DAY}`, {
				kind: "leg",
				target: { kind: "pair", fromItemId: ITEM, toItemId: DAY },
			}),
		).toBe(true);
		expect(formTargetsSel(`item:${ITEM}`, { kind: "day", id: ITEM })).toBe(
			false,
		);
		expect(formTargetsSel(null, { kind: "item", id: ITEM })).toBe(false);
		expect(bundleAnchor({ kind: "item", itemId: ITEM })).toBe(`item:${ITEM}`);
		expect(bundleAnchor({ kind: "trip" })).toBeNull();
	});
});

describe("drag drop targets (FB-23)", () => {
	const over = (data: Record<string, unknown>, id = "x") => ({
		id,
		data: { current: data },
	});
	it("maps the drop data of each panel to an anchor", () => {
		expect(
			dropTargetOf(over({ panel: "plan", itemId: ITEM, dayId: DAY }), "a"),
		).toEqual({
			id: `item:${ITEM}`,
			w: "before",
		});
		expect(dropTargetOf(over({ panel: "plan", dayId: DAY }), "a")).toEqual({
			id: `day:${DAY}`,
			w: "end",
		});
		expect(
			dropTargetOf(over({ panel: "plan", unscheduled: true }), "a"),
		).toEqual({
			id: "pane:unscheduled",
			w: "end",
		});
		expect(dropTargetOf(over({ type: "list", listItemId: ITEM }), "a")).toEqual(
			{
				id: `list:${ITEM}`,
				w: "before",
			},
		);
		expect(
			dropTargetOf(over({ panel: "plan", itemId: ITEM }, "same"), "same"),
		).toBeNull();
		expect(dropTargetOf(null, "a")).toBeNull();
	});
});

describe("menus (FB-25)", () => {
	it("reads plain labels, separators and the highlighted entry; never shortcuts", () => {
		document.body.innerHTML = `
			<div role="menu" data-state="open" id="m1">
				<div role="menuitem">Open details<span data-slot="dropdown-menu-shortcut">⌘O</span></div>
				<div role="separator"></div>
				<div role="separator"></div>
				<div role="menuitemcheckbox" aria-checked="true">Booked</div>
				<div role="menuitem" data-highlighted="">Delete</div>
			</div>`;
		const menu = document.getElementById("m1") as Element;
		expect(readMenu(menu)).toEqual({
			items: ["Open details", "", "✓ Booked", "Delete"],
			hi: 3,
		});
	});
});

describe("ghosts on the cursor layer", () => {
	function card(id: string) {
		const el = document.createElement("div");
		el.setAttribute("data-cursor-anchor", id);
		el.getBoundingClientRect = () =>
			({
				left: 100,
				top: 200,
				right: 400,
				bottom: 260,
				width: 300,
				height: 60,
			}) as DOMRect;
		document.body.appendChild(el);
		return el;
	}
	it("draws a drag ghost with the local name, a drop line, a menu and a form chip", () => {
		card(`item:${ITEM}`);
		const layer = document.createElement("div");
		document.body.appendChild(layer);
		const g = new Ghosts(layer, (id) =>
			id === `item:${ITEM}` ? "Shibuya Sky" : null,
		);
		const now = 1_000;
		const peer = {
			userId: "u1",
			name: "Dennis Kim",
			color: 2,
			here: true,
			drag: {
				a: `item:${ITEM}`,
				o: { id: `item:${ITEM}`, w: "before" as const },
				v: "all" as const,
			},
			dragAt: now,
			menu: {
				a: `item:${ITEM}`,
				fx: 0.5,
				fy: 1,
				items: ["Open", "", "Delete"],
				hi: 2,
				v: "all" as const,
			},
			form: {
				k: "item" as const,
				m: "edit" as const,
				t: `item:${ITEM}`,
				v: "all" as const,
			},
			cursor: { x: 150, y: 220 },
		};
		g.update([peer], now, { hideMenus: false });
		expect(
			layer.querySelector('[data-testid="remote-drag-label"]')?.textContent,
		).toBe("Dennis is moving Shibuya Sky");
		expect(
			layer
				.querySelector('[data-testid="remote-drop"]')
				?.hasAttribute("hidden"),
		).toBe(false);
		const items = [
			...layer.querySelectorAll('[data-testid="remote-menu-item"]'),
		];
		expect(items.map((i) => i.textContent)).toEqual(["Open", "Delete"]);
		expect(items[1]?.hasAttribute("data-hi")).toBe(true);
		expect(
			layer.querySelector('[data-testid="remote-form-chip"]')?.textContent,
		).toBe("Dennis is editing Shibuya Sky");
		expect(g.styleRules([peer], now).join("")).toContain("opacity:.45");
		// Idle (no news for 20 s): the drag goes, the rest stays.
		g.update([peer], now + 21_000, { hideMenus: true });
		expect(
			layer
				.querySelector('[data-testid="remote-drag"]')
				?.hasAttribute("hidden"),
		).toBe(true);
		expect(
			layer
				.querySelector('[data-testid="remote-menu"]')
				?.hasAttribute("hidden"),
		).toBe(true);
		expect(g.styleRules([peer], now + 21_000)).toEqual([]);
		// They left: everything of theirs goes.
		g.update([], now, { hideMenus: false });
		expect(layer.children).toHaveLength(0);
	});
});
