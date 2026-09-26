/**
 * The inspector's Notes tab (SPEC §12.5 `NotesPanel({ target })`): the
 * target's live note (shared, or the viewer's private one), with suggested
 * additions from WP-Suggest under it. A located visit shows its place's note
 * with "This visit only" for the visit's own note (DESIGN §4.4; QA NOTE-02:
 * the Bar Benfiddich ITEM has its own note, separate from the place's).
 */
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { bool, useFollowState } from "@/lib/realtime/view-ui";
import type { BundleTarget } from "@/lib/schemas/targets";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { targetLabel } from "../lists/list-model";
import { NoteBlock } from "./NoteBlock";
import { NOTES_TESTID } from "./testids";

export function NotesPanel({ target }: { target: BundleTarget }) {
	const { ix, graph, sel } = useWorkspace();
	const visitId =
		sel?.kind === "item" && target.kind === "node" ? sel.id : null;
	// FB-21d: "This visit only" travels with my view.
	const [visitOnly, setVisitOnly] = useFollowState("notes.visit", false, bool);
	const shown: BundleTarget =
		visitId && visitOnly ? { kind: "item", itemId: visitId } : target;
	const name = shown.kind === "trip" ? graph.trip.name : targetLabel(ix, shown);
	const placeName =
		target.kind === "node"
			? (ix.node(target.nodeId)?.name ?? "The place")
			: "The place";
	const visitSwitch = visitId ? (
		<ToggleGroup
			type="single"
			size="sm"
			variant="outline"
			value={visitOnly ? "visit" : "place"}
			onValueChange={(v) => v && setVisitOnly(v === "visit")}
			className="h-7 max-w-full"
			aria-label="Whose note"
			data-testid={NOTES_TESTID.visitScope}
		>
			<ToggleGroupItem value="place" className="h-7 min-w-0 px-2.5 text-xs">
				<span className="truncate">{placeName}</span>
			</ToggleGroupItem>
			<ToggleGroupItem value="visit" className="h-7 min-w-0 px-2.5 text-xs">
				This visit only
			</ToggleGroupItem>
		</ToggleGroup>
	) : null;
	return (
		<div data-testid={TESTID.notesPanel} className="text-sm">
			<NoteBlock
				key={JSON.stringify(shown)}
				target={shown}
				label={`Notes for ${name}`}
				toolbar={visitSwitch}
			/>
		</div>
	);
}
