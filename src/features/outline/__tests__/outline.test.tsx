import {
	act,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { GraphNode, TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, demoGraph, N, scenario } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { renderWithWorkspace } from "@/test/render-workspace";
import { IdeasBin } from "../IdeasBin";
import { Outline } from "../Outline";
import { OUTLINE_TESTID } from "../testids";

const { dennis: D, audrey: A } = DEMO_MEMBERS;

const rowOf = (name: string) =>
	screen
		.getAllByTestId(TESTID.outlineRow)
		.find((el) =>
			el.getAttribute("aria-label")?.startsWith(`${name},`),
		) as HTMLElement;

function withIdeas(): TripGraph {
	const itoya = demoGraph.nodes.find((n) => n.id === N.itoya) as GraphNode;
	const make = (
		i: number,
		name: string,
		priorities: GraphNode["priorities"],
		category: GraphNode["category"] = "shopping",
	) => ({
		...itoya,
		id: `00000000-0000-7000-8000-00000000f10${i}`,
		name,
		slug: name.toLowerCase().replace(/\W+/g, "-"),
		position: `z${i}`,
		category,
		priorities,
	});
	return {
		...demoGraph,
		nodes: [
			...demoGraph.nodes,
			make(0, "Ameyoko", { [A]: "want" }, "market"),
			make(1, "Golden Gai", { [D]: "must" }, "bar"),
			make(2, "Don Quijote", {}),
		],
	};
}

beforeEach(() => {
	localStorage.clear();
});

const IMPLICIT: Record<string, string> = {
	BUTTON: "button",
	INPUT: "textbox",
	SELECT: "combobox",
	TEXTAREA: "textbox",
};
/**
 * The roles a listbox or tree owns, walked like axe's
 * `aria-required-children`: through elements with no role, no `aria-*` and
 * no tabindex; subtrees hidden at rest (`aria-hidden`, or the `hidden` class
 * until hover/focus) are skipped. Anything else is reported by role or, for
 * a bare element with ARIA, as `div[aria-…]`.
 */
function ownedRoles(el: Element): string[] {
	const out: string[] = [];
	for (const c of Array.from(el.children)) {
		if (c.getAttribute("aria-hidden") === "true") continue;
		if (c.classList.contains("hidden")) continue;
		const explicit = c.getAttribute("role");
		const role =
			explicit === "none" || explicit === "presentation"
				? null
				: (explicit ?? IMPLICIT[c.tagName] ?? null);
		const aria = c.getAttributeNames().find((a) => a.startsWith("aria-"));
		if (!role && !aria && !c.hasAttribute("tabindex"))
			out.push(...ownedRoles(c));
		else if (role === "group") out.push(role, ...ownedRoles(c));
		else out.push(role ?? `${c.tagName.toLowerCase()}[${aria ?? "tabindex"}]`);
	}
	return out;
}

/** Lets Radix close its menu and run its deferred focus return. */
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 30)));

describe("Outline", () => {
	it("is an ARIA tree with levels, expansion and the current scope", () => {
		renderWithWorkspace(<Outline />, { splat: "japan/tokyo" });
		const tree = screen.getByRole("tree", { name: "Places" });
		const tokyo = rowOf("Tokyo");
		expect(within(tree).getAllByRole("treeitem").length).toBeGreaterThan(5);
		expect(tokyo).toHaveAttribute("aria-level", "2");
		expect(tokyo).toHaveAttribute("aria-expanded", "true");
		expect(tokyo).toHaveAttribute("aria-current", "location");
		// Only one row is in the tab order (roving focus): the scope.
		expect(tokyo).toHaveAttribute("tabindex", "0");
	});

	it("the Cities level counts hidden places with the right plural (HIER-07)", () => {
		localStorage.setItem("yonder:outline:level", "city");
		renderWithWorkspace(<Outline />, { splat: "japan/tokyo" });
		expect(rowOf("Shibuya")).toBeUndefined();
		const count = (name: string) =>
			within(rowOf(name)).getByTestId(OUTLINE_TESTID.hiddenCount);
		// Kyoto holds one place (Kiyomizu-dera); Tokyo seven.
		expect(count("Kyoto")).toHaveTextContent(/^· 1 place$/);
		expect(count("Kyoto")).toHaveAttribute("title", "1 place");
		expect(count("Tokyo")).toHaveTextContent(/^· 7 places$/);
		expect(count("Tokyo")).toHaveAttribute("title", "7 places");
	});

	it("arrows move focus and open/close rows; Enter zooms in", () => {
		const { ws } = renderWithWorkspace(<Outline />, { splat: "japan/tokyo" });
		const tokyo = rowOf("Tokyo");
		act(() => tokyo.focus());
		fireEvent.keyDown(tokyo, { key: "ArrowDown" });
		expect(document.activeElement).toBe(rowOf("Shibuya"));
		const shibuya = rowOf("Shibuya");
		expect(shibuya).toHaveAttribute("aria-expanded", "false");
		fireEvent.keyDown(shibuya, { key: "ArrowRight" });
		expect(rowOf("Shibuya")).toHaveAttribute("aria-expanded", "true");
		expect(rowOf("Hands Shibuya")).toBeTruthy();
		fireEvent.keyDown(rowOf("Shibuya"), { key: "ArrowLeft" });
		expect(rowOf("Shibuya")).toHaveAttribute("aria-expanded", "false");
		fireEvent.keyDown(rowOf("Shibuya"), { key: "ArrowLeft" });
		expect(document.activeElement).toBe(rowOf("Tokyo"));
		fireEvent.keyDown(rowOf("Tokyo"), { key: "ArrowDown" });
		fireEvent.keyDown(rowOf("Shibuya"), { key: "Enter" });
		expect(ws().scope?.id).toBe(N.shibuya);
	});

	it("typeahead jumps to the next row starting with the typed letters", () => {
		renderWithWorkspace(<Outline />, { splat: "japan/tokyo" });
		const tokyo = rowOf("Tokyo");
		act(() => tokyo.focus());
		fireEvent.keyDown(tokyo, { key: "k" });
		expect(document.activeElement).toBe(rowOf("Kyoto"));
	});

	it("the shared filter keeps matches and their ancestors, with a summary", () => {
		const { ws } = renderWithWorkspace(<Outline />, {
			graph: withIdeas(),
			splat: "japan",
			search: { f: "g:bar" },
		});
		const names = screen
			.getAllByTestId(TESTID.outlineRow)
			.map((el) => el.getAttribute("aria-label")?.split(",")[0]);
		expect(names).toEqual(["Japan", "Tokyo", "Golden Gai"]);
		expect(screen.getByTestId(OUTLINE_TESTID.filterSummary)).toHaveTextContent(
			"Bar",
		);
		fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
		expect(ws().search.f).toBeUndefined();
		expect(screen.queryByTestId(OUTLINE_TESTID.filterSummary)).toBeNull();
		expect(rowOf("Kyoto")).toBeTruthy();
	});

	it("the filter panel writes the filter to the URL (category chip)", async () => {
		const { ws } = renderWithWorkspace(<Outline />, {
			graph: withIdeas(),
			splat: "japan",
			search: { sel: `n.${N.tokyo}` },
		});
		fireEvent.click(screen.getByTestId(OUTLINE_TESTID.filterButton));
		const chip = await screen.findByRole("button", { name: "Bar" });
		fireEvent.click(chip);
		expect(chip).toHaveAttribute("aria-pressed", "true");
		// `nav.setFilter`: the canonical `f`, the scope and the selection kept.
		expect(ws().search.f).toBe("g:bar");
		expect(ws().filter.groups).toEqual(["bar"]);
		expect(ws().scope?.id).toBe(N.japan);
		expect(ws().sel).toEqual({ kind: "node", id: N.tokyo });
		expect(
			screen.getByTestId(OUTLINE_TESTID.filterSummary),
		).toBeInTheDocument();
	});

	it("dropped places sit in a collapsed group at the bottom", () => {
		const g: TripGraph = {
			...demoGraph,
			nodes: demoGraph.nodes.map((n) =>
				n.id === N.osaka ? { ...n, status: "dropped" as const } : n,
			),
		};
		renderWithWorkspace(<Outline />, { graph: g });
		const group = screen.getByTestId(OUTLINE_TESTID.droppedGroup);
		expect(group).toHaveTextContent("Dropped · 1");
		expect(rowOf("Osaka")).toBeUndefined();
		fireEvent.click(group);
		expect(rowOf("Osaka")).toHaveAttribute(
			"aria-label",
			"Osaka, city, dropped",
		);
	});

	it("edit affordances are disabled for viewers", () => {
		const viewer: TripGraph = {
			...demoGraph,
			me: { ...demoGraph.me, role: "viewer" },
		};
		renderWithWorkspace(<Outline />, { graph: viewer });
		expect(screen.getByRole("button", { name: "Add a place" })).toBeDisabled();
	});
});

describe("Outline: Add inside… keeps the caret (PLAN-I2-12)", () => {
	it("from the row's ⋯ menu, focus lands in the new field and stays there", async () => {
		renderWithWorkspace(<Outline />, { splat: "japan" });
		const kyoto = rowOf("Kyoto");
		const more = within(kyoto).getByTestId(OUTLINE_TESTID.rowMenu);
		act(() => more.focus());
		fireEvent.keyDown(more, { key: "Enter" });
		fireEvent.click(
			await screen.findByRole("menuitem", { name: /Add inside/ }),
		);
		const input = await screen.findByTestId(OUTLINE_TESTID.inlineInput);
		await settle();
		// Not handed back to "More for Kyoto" when the menu closes.
		expect(document.activeElement).toBe(input);
		expect(input).toHaveAttribute("placeholder", "Inside Kyoto…");
		fireEvent.change(input, { target: { value: "Zz" } });
		expect(input).toHaveValue("Zz");
	});

	it("from the right-click menu, focus lands in the field, not back on the row", async () => {
		renderWithWorkspace(<Outline />, { splat: "japan" });
		const kyoto = rowOf("Kyoto");
		act(() => kyoto.focus());
		fireEvent.contextMenu(kyoto, { clientX: 20, clientY: 20 });
		fireEvent.click(
			await screen.findByRole("menuitem", { name: /Add inside/ }),
		);
		const input = await screen.findByTestId(OUTLINE_TESTID.inlineInput);
		await settle();
		expect(document.activeElement).toBe(input);
		expect(document.activeElement).not.toBe(rowOf("Kyoto"));
	});

	it("Rename from the right-click menu keeps its input open and focused", async () => {
		renderWithWorkspace(<Outline />, { splat: "japan" });
		const kyoto = rowOf("Kyoto");
		act(() => kyoto.focus());
		fireEvent.contextMenu(kyoto, { clientX: 20, clientY: 20 });
		fireEvent.click(await screen.findByRole("menuitem", { name: /Rename/ }));
		const input = await screen.findByLabelText("Rename Kyoto");
		await settle();
		expect(document.activeElement).toBe(input);
	});

	it("the header's New place item focuses the new field too", async () => {
		renderWithWorkspace(<Outline />, { splat: "japan" });
		const header = screen.getByTestId(OUTLINE_TESTID.headerMenu);
		act(() => header.focus());
		fireEvent.keyDown(header, { key: "Enter" });
		fireEvent.click(
			await screen.findByRole("menuitem", { name: /New place in Japan/ }),
		);
		const input = await screen.findByTestId(OUTLINE_TESTID.inlineInput);
		await settle();
		await waitFor(() => expect(document.activeElement).toBe(input));
	});
});

describe("E7 ghosts in the Outline's composites (VIS-09)", () => {
	it("a suggested idea is described on its option; the listbox owns options only", () => {
		renderWithWorkspace(<IdeasBin />, {
			splat: "japan/kyoto",
			proposals: scenario.proposals,
		});
		const list = screen.getByRole("listbox");
		const nishiki = within(list).getByRole("option", {
			name: /^Nishiki Market/,
		});
		expect(nishiki.getAttribute("aria-description")).toMatch(/^Suggested by /);
		const ghost = nishiki.parentElement as HTMLElement;
		expect(ghost).toHaveAttribute("data-proposed", "create");
		expect(ghost).not.toHaveAttribute("aria-description");
		expect(new Set(ownedRoles(list))).toEqual(new Set(["option"]));
	});

	it("a suggested place in the tree is described on its treeitem; the tree owns items only", () => {
		renderWithWorkspace(<Outline />, {
			splat: "japan/kyoto",
			proposals: scenario.proposals,
		});
		const tree = screen.getByRole("tree");
		const nishiki = rowOf("Nishiki Market");
		expect(nishiki.getAttribute("aria-description")).toMatch(/^Suggested by /);
		expect(nishiki.parentElement).toHaveAttribute("data-proposed", "create");
		expect(nishiki.parentElement).not.toHaveAttribute("aria-description");
		const roles = new Set(ownedRoles(tree));
		for (const r of roles) expect(["treeitem", "group"]).toContain(r);
	});
});

describe("IdeasBin", () => {
	it("lists the scope's ideas by priority, with one badge each", () => {
		renderWithWorkspace(<IdeasBin />, {
			graph: withIdeas(),
			splat: "japan/tokyo",
		});
		const rows = screen.getAllByTestId(OUTLINE_TESTID.ideaRow);
		expect(rows.map((r) => r.textContent)).toEqual([
			expect.stringContaining("Golden Gai"),
			expect.stringContaining("Ameyoko"),
			expect.stringContaining("Don Quijote"),
		]);
		expect(rows[0]).toHaveTextContent("Must");
		expect(screen.getByTestId(OUTLINE_TESTID.ideasCount)).toHaveTextContent(
			"3",
		);
	});

	it("applies the shared filter and says how many of how many", () => {
		renderWithWorkspace(<IdeasBin />, {
			graph: withIdeas(),
			splat: "japan/tokyo",
			search: { f: "u:me" },
		});
		expect(screen.getAllByTestId(OUTLINE_TESTID.ideaRow)).toHaveLength(2);
		expect(screen.getByTestId(OUTLINE_TESTID.ideasCount)).toHaveTextContent(
			"2 of 3",
		);
	});

	it("clicking an idea selects it", () => {
		const { ws } = renderWithWorkspace(<IdeasBin />, {
			graph: withIdeas(),
			splat: "japan/tokyo",
		});
		fireEvent.click(
			screen.getAllByTestId(OUTLINE_TESTID.ideaRow)[0] as HTMLElement,
		);
		expect(ws().sel).toEqual({
			kind: "node",
			id: "00000000-0000-7000-8000-00000000f101",
		});
	});

	it("says so when a scope has no ideas", () => {
		renderWithWorkspace(<IdeasBin />, { splat: "japan/kyoto" });
		expect(screen.getByText("No saved ideas here.")).toBeInTheDocument();
	});
});
