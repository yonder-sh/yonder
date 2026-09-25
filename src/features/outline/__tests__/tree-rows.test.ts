import { describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import type { TripGraph } from "@/lib/engine/types";
import { demoGraph, N } from "@/lib/fixtures/demo";
import {
	buildRows,
	foldText,
	INDENT,
	moveBlocker,
	type NodeRow,
	type OutlineRow,
	projectDrop,
	ROOT_ORIGIN,
	rankReason,
	typeahead,
} from "../tree-rows";

const ix = indexGraph(demoGraph);
const all = () => true;
const names = (rows: OutlineRow[]) =>
	rows.map((r) =>
		r.kind === "node" || r.kind === "ghost"
			? `${"  ".repeat(r.depth)}${r.node.name}`
			: r.kind,
	);
const tree = (rows: OutlineRow[]) =>
	rows.filter((r): r is NodeRow => r.kind === "node" && r.section === "tree");

describe("buildRows", () => {
	it("walks open rows depth-first, children by position", () => {
		const open = new Set([N.japan, N.tokyo, N.shibuya] as string[]);
		const rows = buildRows({
			ix,
			isOpen: (id) => open.has(id),
			level: "all",
			visible: null,
			droppedOpen: false,
		});
		expect(names(rows).slice(0, 8)).toEqual([
			"Japan",
			"  Tokyo",
			"    Shibuya",
			"      Hands Shibuya",
			"      Shibuya Loft",
			"      Shibuya Sky",
			"    Harajuku",
			"    Asakusa",
		]);
		const tokyo = rows.find((r) => r.id === N.tokyo) as NodeRow;
		expect(tokyo).toMatchObject({ depth: 1, hasChildren: true, open: true });
	});

	it("folds the dragged row's children", () => {
		const rows = buildRows({
			ix,
			isOpen: all,
			level: "all",
			visible: null,
			foldId: N.tokyo,
			droppedOpen: false,
		});
		expect(rows.some((r) => r.id === N.shibuya)).toBe(false);
		expect((rows.find((r) => r.id === N.tokyo) as NodeRow).open).toBe(false);
	});

	it("the level filter hides finer ranks and counts the hidden places (HIER-07)", () => {
		const rows = buildRows({
			ix,
			isOpen: all,
			level: "city",
			visible: null,
			droppedOpen: false,
		});
		expect(rows.some((r) => r.id === N.shibuya)).toBe(false);
		const tokyo = rows.find((r) => r.id === N.tokyo) as NodeRow;
		// Hands, Loft, Sky, Meiji, Kama-asa, Senso-ji, Itoya.
		expect(tokyo.hiddenPlaces).toBe(7);
		expect(tokyo.hasChildren).toBe(false);
	});

	it("dropped nodes leave the tree for a collapsed group", () => {
		const g: TripGraph = {
			...demoGraph,
			nodes: demoGraph.nodes.map((n) =>
				n.id === N.kyoto ? { ...n, status: "dropped" as const } : n,
			),
		};
		const dix = indexGraph(g);
		const closed = buildRows({
			ix: dix,
			isOpen: all,
			level: "all",
			visible: null,
			droppedOpen: false,
		});
		expect(tree(closed).some((r) => r.id === N.kyoto)).toBe(false);
		expect(closed.at(-1)).toMatchObject({ kind: "dropped-header", count: 1 });
		const open = buildRows({
			ix: dix,
			isOpen: all,
			level: "all",
			visible: null,
			droppedOpen: true,
		});
		const kyoto = open.find((r) => r.id === N.kyoto) as NodeRow;
		expect(kyoto).toMatchObject({ section: "dropped", depth: 1 });
		expect(open.find((r) => r.id === N.kiyomizu)).toMatchObject({
			section: "dropped",
			depth: 2,
		});
	});

	it("keeps only the visible set under a filter (and no dropped group)", () => {
		const visible = new Set([N.japan, N.tokyo, N.shibuya, N.hands] as string[]);
		const rows = buildRows({
			ix,
			isOpen: all,
			level: "all",
			visible,
			droppedOpen: false,
		});
		expect(names(rows)).toEqual([
			"Japan",
			"  Tokyo",
			"    Shibuya",
			"      Hands Shibuya",
		]);
	});

	it("slots ghosts and origin rows under their parent", () => {
		const ghost = {
			...(ix.node(N.itoya) as NonNullable<ReturnType<typeof ix.node>>),
			id: "ghost-1",
			name: "Nishiki Market",
			parentId: N.kyoto as string,
		};
		const mark = {
			proposalId: "p1",
			op: "node.move" as const,
			kind: "move" as const,
			author: { userId: "u", memberId: null, name: "Maya", color: 2 },
			origin: {
				entity: `node:${N.itoya}` as const,
				afterId: null,
				toLabel: "Kyoto",
			},
		};
		const rows = buildRows({
			ix,
			isOpen: all,
			level: "all",
			visible: null,
			droppedOpen: false,
			ghosts: [{ node: ghost, proposalId: "p0" }],
			origins: new Map([[N.tokyo as string, [mark]]]),
		});
		const kyotoAt = rows.findIndex((r) => r.id === N.kyoto);
		expect(rows[kyotoAt + 2]).toMatchObject({ kind: "ghost", depth: 2 });
		const origin = rows.find((r) => r.kind === "origin");
		expect(origin).toMatchObject({ parentId: N.tokyo, depth: 2 });
	});

	it("a move out of the top level leaves its origin row at the end of it", () => {
		const mark = {
			proposalId: "p2",
			op: "node.move" as const,
			kind: "move" as const,
			author: { userId: "u", memberId: null, name: "Maya", color: 2 },
			origin: {
				entity: `node:${N.japan}` as const,
				afterId: null,
				toLabel: "Asia",
			},
		};
		const input = {
			ix,
			isOpen: () => false,
			level: "all" as const,
			droppedOpen: false,
			origins: new Map([[ROOT_ORIGIN, [mark]]]),
		};
		const rows = buildRows({ ...input, visible: null });
		expect(rows.at(-1)).toMatchObject({
			kind: "origin",
			depth: 0,
			parentId: null,
			id: "origin:p2",
		});
		// A filtered tree shows matches only, never traces.
		const filtered = buildRows({
			...input,
			visible: new Set([N.japan as string]),
		});
		expect(filtered.some((r) => r.kind === "origin")).toBe(false);
	});
});

describe("projectDrop (the flattened tree projection)", () => {
	const rowsFolding = (activeId: string) =>
		tree(
			buildRows({
				ix,
				isOpen: all,
				level: "all",
				visible: null,
				foldId: activeId,
				droppedOpen: false,
			}),
		);

	it("dropping Harajuku straight onto Kyoto makes it Kyoto's first child", () => {
		const rows = rowsFolding(N.harajuku as string);
		const p = projectDrop(ix, rows, N.harajuku as string, N.kyoto as string, 0);
		expect(p).toMatchObject({
			parentId: N.kyoto,
			depth: 2,
			valid: true,
			beforeId: N.kiyomizu,
		});
	});

	it("dragging left outdents to the parent's level (when the neighbours allow it)", () => {
		// Kyoto closed: the row after it is Osaka (depth 1), so depth 1 is allowed.
		const rows = tree(
			buildRows({
				ix,
				isOpen: (id) => id !== N.kyoto,
				level: "all",
				visible: null,
				foldId: N.harajuku,
				droppedOpen: false,
			}),
		);
		const p = projectDrop(
			ix,
			rows,
			N.harajuku as string,
			N.kyoto as string,
			-INDENT,
		);
		expect(p).toMatchObject({ parentId: N.japan, depth: 1, afterId: N.kyoto });
		// With Kyoto open, its first child follows it: the row must go inside.
		const open = rowsFolding(N.harajuku as string);
		expect(
			projectDrop(ix, open, N.harajuku as string, N.kyoto as string, -INDENT)
				?.parentId,
		).toBe(N.kyoto);
	});

	it("a city under a place is refused with the rank rule's reason", () => {
		// Kyoto dragged up onto Itoya's slot, indented one level under Itoya.
		const rows = rowsFolding(N.kyoto as string);
		const itoyaAt = rows.findIndex((r) => r.id === N.itoya);
		const next = rows[itoyaAt + 1] as NodeRow;
		const p = projectDrop(ix, rows, N.kyoto as string, next.id, 2 * INDENT);
		expect(p?.parentId).toBe(N.itoya);
		expect(p?.valid).toBe(false);
		expect(p?.reason).toBe("A city can't go inside a place");
	});

	it("dropping where it already is is a no-op", () => {
		const rows = rowsFolding(N.shibuya as string);
		const p = projectDrop(
			ix,
			rows,
			N.shibuya as string,
			N.shibuya as string,
			0,
		);
		expect(p?.noop).toBe(true);
	});

	it("depth is clamped between the neighbours", () => {
		const rows = rowsFolding(N.itoya as string);
		const p = projectDrop(
			ix,
			rows,
			N.itoya as string,
			N.itoya as string,
			10 * INDENT,
		);
		// Itoya sits after Asakusa's last descendant (depth 3), so at most depth 4.
		expect(p?.depth).toBeLessThanOrEqual(4);
	});
});

describe("rank wording, blockers and typeahead", () => {
	it("says why a move is refused", () => {
		expect(rankReason("country", "area")).toBe(
			"A country can't go inside an area",
		);
		expect(moveBlocker(ix, N.tokyo as string, N.itoya as string)).toBe(
			"A place can't go inside itself",
		);
		expect(moveBlocker(ix, N.kyoto as string, N.itoya as string)).toBe(
			"A city can't go inside a place",
		);
		expect(moveBlocker(ix, N.harajuku as string, N.kyoto as string)).toBeNull();
	});

	it("typeahead folds diacritics and cycles on a repeated letter", () => {
		const list = [
			{ id: "1", name: "Shibuya" },
			{ id: "2", name: "Sensō-ji" },
			{ id: "3", name: "Kyoto" },
		];
		expect(foldText("glänta")).toBe("glanta");
		expect(typeahead(list, 0, "s")).toBe("2");
		expect(typeahead(list, 1, "s")).toBe("1");
		expect(typeahead(list, 0, "senso")).toBe("2");
		expect(typeahead(list, 0, "x")).toBeNull();
	});
});
