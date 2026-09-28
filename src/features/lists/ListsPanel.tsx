/**
 * The inspector's Lists tab (SPEC §12.5 `ListsPanel({ target })`), following
 * the inspector rules (SPEC §8.4, DESIGN §4.4):
 * - a place or area: "Everything inside Tokyo" by default, or "Only Tokyo";
 * - a located visit: its place's bundle, with "This visit only";
 * - a day: "This day", or "Everything that day";
 * - the trip: everything (the MAIN list), or "Only the trip";
 * - a leg or an unlocated block: its own rows.
 * New rows attach to what's shown ("This visit only" → the visit).
 */

import { useMemo, useState } from "react";
import { z } from "zod";
import { Segmented } from "@/components/kit";
import { offersRollupChoice } from "@/features/shell/bundle-target";
import type { Lens } from "@/lib/engine/types";
import { bool, oneOf, useFollowValue, uuid } from "@/lib/realtime/view-ui";
import type { ListKind } from "@/lib/schemas/enums";
import type { BundleTarget } from "@/lib/schemas/targets";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { ListBoard } from "./ListBoard";
import { rollupRows, type ScopeOptions, targetLabel } from "./list-model";
import { sameTarget, useListItems } from "./queries";
import { LISTS_TESTID } from "./testids";

const LENSES: Lens[] = ["country", "region", "city", "area", "place"];
const isListKind = oneOf<ListKind>(["todo", "shopping"]);
const isWho = z.union([z.literal("all"), uuid]);
const finer = (l: Lens): Lens =>
	LENSES[Math.min(LENSES.indexOf(l) + 1, LENSES.length - 1)] ?? "place";

export function ListsPanel({ target }: { target: BundleTarget }) {
	const { ix, sel, graph } = useWorkspace();
	const { items, loading } = useListItems();
	const [wide, setWide] = useState(true);
	const [kind, setKind] = useState<ListKind>("todo");
	const [who, setWho] = useState<string | null>(null);

	// A located item shows its place's bundle; "This visit only" narrows to the item.
	const visitId =
		sel?.kind === "item" && target.kind === "node" ? sel.id : null;
	const node = target.kind === "node" ? ix.node(target.nodeId) : undefined;
	const day = target.kind === "day" ? ix.day(target.dayId) : undefined;

	const toggle: { on: string; off: string } | null = visitId
		? {
				on: `Everything at ${node?.name ?? "this place"}`,
				off: "This visit only",
			}
		: // FB-12: a node (or a trip) with no children has nothing to choose between.
			node && offersRollupChoice(ix, target)
			? { on: `Everything inside ${node.name}`, off: `Only ${node.name}` }
			: day
				? { on: "Everything that day", off: "This day" }
				: target.kind === "trip" && offersRollupChoice(ix, target)
					? { on: "Everything", off: `Only ${graph.trip.name}` }
					: null;
	// Days default to "This day"; the others to "Everything".
	const [dayWide, setDayWide] = useState(false);
	const isWide = day ? dayWide : wide;
	const setIsWide = day ? setDayWide : setWide;
	// FB-21d: the inspector's list, scope and person travel with my view.
	useFollowValue("lists.pkind", kind, setKind, isListKind);
	useFollowValue("lists.pwide", isWide, setIsWide, bool);
	useFollowValue(
		"lists.pwho",
		who ?? "all",
		(v) => setWho(v === "all" ? null : v),
		isWho,
	);

	const effectiveTarget: BundleTarget =
		visitId && !isWide ? { kind: "item", itemId: visitId } : target;

	const { scope, rows } = useMemo(() => {
		if (node && isWide)
			return {
				scope: {
					scopeId: node.id,
					lens: finer(node.type),
					includeDescendants: true,
				} satisfies ScopeOptions,
				rows: items,
			};
		if (day && isWide)
			return {
				scope: {
					scopeId: null,
					lens: "place",
					includeDescendants: true,
					dayRange: { from: day.date, to: day.date },
				} satisfies ScopeOptions,
				rows: items,
			};
		if (target.kind === "trip" && isWide)
			return {
				scope: {
					scopeId: null,
					lens: "city",
					includeDescendants: true,
				} satisfies ScopeOptions,
				rows: items,
			};
		// Own rows only: everything is "in view" at the root, so filter by target.
		return {
			scope: {
				scopeId: null,
				lens: "place",
				includeDescendants: true,
			} satisfies ScopeOptions,
			rows: items.filter((r) => sameTarget(r.target, effectiveTarget)),
		};
	}, [node, day, isWide, target.kind, items, effectiveTarget]);

	const counts = useMemo(() => {
		const c: Record<ListKind, number> = { todo: 0, shopping: 0, packing: 0 };
		const seen = new Set<string>();
		for (const g of rollupRows(ix, rows, scope))
			for (const s of g.subs)
				for (const r of s.rows) {
					if (seen.has(r.id) || r.status !== "open") continue;
					seen.add(r.id);
					c[r.list] += 1;
				}
		return c;
	}, [ix, rows, scope]);

	const where =
		target.kind === "trip" ? graph.trip.name : targetLabel(ix, effectiveTarget);

	const switcher = (
		<Segmented
			label="Which list"
			size="sm"
			value={kind}
			onValueChange={setKind}
			options={(["todo", "shopping"] as const).map((k) => ({
				value: k,
				label: k === "todo" ? "To-dos" : "Shopping",
				count: counts[k] || null,
				testId:
					k === "todo" ? LISTS_TESTID.kindTodo : LISTS_TESTID.kindShopping,
			}))}
		/>
	);

	return (
		<div data-testid={TESTID.listsPanel} className="-mx-4 flex flex-col gap-1">
			{/* Nothing inside to narrow to: no switch. */}
			{toggle &&
			!(isWide && !loading && counts.todo + counts.shopping === 0) ? (
				<div className="px-4">
					{/* The same Everything / Only switch as the center tabs (DESIGN §4.4). */}
					<Segmented
						label="What to include"
						testId={LISTS_TESTID.panelScope}
						size="sm"
						className="max-w-full"
						value={isWide ? "all" : "only"}
						onValueChange={(v) => v && setIsWide(v === "all")}
						options={[
							{
								value: "all",
								label: <span className="truncate">{toggle.on}</span>,
							},
							{
								value: "only",
								label: <span className="truncate">{toggle.off}</span>,
							},
						]}
					/>
				</div>
			) : null}
			<ListBoard
				key={`${kind}:${JSON.stringify(effectiveTarget)}:${isWide}`}
				kind={kind}
				items={rows}
				scope={scope}
				addTarget={effectiveTarget}
				storageScope={`panel:${target.kind}`}
				who={who}
				setWho={setWho}
				where={where}
				loading={loading}
				headerStart={switcher}
				compact
			/>
		</div>
	);
}
