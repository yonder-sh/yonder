/**
 * The notes inside a place or the trip (the details' Notes section, below
 * its own note; the Notes tab until One Yonder): descendant places, visits
 * ("This visit · Day 4 · Itoya"), days ("Day 5 · Thu 7 Oct") and transit, as
 * collapsible static sections. "Edit" swaps a section into a live editor,
 * one at a time. The viewer's own private notes show too, marked "Only you".
 */
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Lock, PencilLine } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { anchorKey } from "@/lib/realtime/cursor-protocol";
import { noteDocName } from "@/lib/realtime/protocol";
import {
	idOrNone,
	useFollowToggle,
	useFollowValue,
} from "@/lib/realtime/view-ui";
import type { BundleTarget } from "@/lib/schemas/targets";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { dayLabel, itemName, legLabel, rollupRows } from "../lists/list-model";
import { useNoteAccess } from "./NoteBlock";
import { NoteEditor } from "./NoteEditor";
import type { NoteDto } from "./notes.functions";
import { hasText, noteTarget, tripNotesQuery } from "./queries";
import { StaticNote } from "./StaticNote";
import { NOTES_TESTID } from "./testids";

export type NoteSectionData = Section;

type Section = {
	note: NoteDto;
	target: BundleTarget;
	title: string;
	crumb: string | null;
};

/**
 * The notes inside a scope, not its own (null = the trip): its places, their
 * visits, days and transit, and the viewer's private ones, in trip order.
 */
export function useNotesInside(
	scopeId: string | null | undefined,
	dayRange: ReturnType<typeof useWorkspace>["days"] = null,
): Section[] {
	const { graph, ix, mode, lens, model } = useWorkspace();
	const q = useQuery({
		...tripNotesQuery(graph.trip.id),
		enabled: mode === "live",
	});
	return useMemo<Section[]>(() => {
		if (scopeId === undefined || !q.data) return [];
		const scope = scopeId ? ix.node(scopeId) : undefined;
		const own: BundleTarget = scope
			? { kind: "node", nodeId: scope.id }
			: { kind: "trip" };
		const notes = q.data.filter((n) => hasText(n));
		const groups = rollupRows(
			ix,
			notes.map((n) => ({ id: n.name, target: noteTarget(n) })),
			{ scopeId: scope?.id ?? null, lens, dayRange, model },
		);
		const out: Section[] = [];
		for (const g of groups)
			for (const s of g.subs)
				for (const row of s.rows) {
					const note = notes.find((n) => n.name === row.id);
					if (!note) continue;
					const target = noteTarget(note);
					// The scope's own note is the live editor above.
					if (JSON.stringify(target) === JSON.stringify(own)) continue;
					out.push(sectionOf(note, target));
				}
		return out;

		function sectionOf(note: NoteDto, target: BundleTarget): Section {
			switch (target.kind) {
				case "node": {
					const path = ix.path(target.nodeId);
					const cut = scope ? path.findIndex((n) => n.id === scope.id) : -1;
					const between = path.slice(cut + 1, -1).map((n) => n.name);
					return {
						note,
						target,
						title: ix.node(target.nodeId)?.name ?? "A place",
						crumb: between.length ? between.join(" › ") : null,
					};
				}
				case "item": {
					const it = ix.item(target.itemId);
					return {
						note,
						target,
						title: `This visit · ${it?.dayId ? `Day ${ix.dayNumber(it.dayId)} · ` : ""}${itemName(ix, target.itemId)}`,
						crumb: it?.nodeId
							? ix
									.path(it.nodeId)
									.slice(0, -1)
									.slice(-2)
									.map((n) => n.name)
									.join(" › ") || null
							: null,
					};
				}
				case "day":
					return {
						note,
						target,
						title: dayLabel(ix, target.dayId),
						crumb: null,
					};
				case "leg":
					return {
						note,
						target,
						title: legLabel(ix, target.legId),
						crumb: null,
					};
				default:
					return { note, target, title: graph.trip.name, crumb: null };
			}
		}
	}, [q.data, scopeId, dayRange, ix, lens, model, graph.trip.name]);
}

/**
 * The notes inside, as collapsible static sections; "Edit" swaps one into a
 * live editor, one at a time. `limit` shows the first few, then "Show all".
 */
export function NotesInside({
	sections,
	limit,
	dense = false,
}: {
	sections: Section[];
	limit?: number;
	/** Smaller titles (the details pane). */
	dense?: boolean;
}) {
	const { sharedWrite, canPrivate } = useNoteAccess();
	const [editing, setEditing] = useState<string | null>(null);
	// Opened by the one I follow: no focus grab.
	const [followed, setFollowed] = useState(false);
	const [all, setAll] = useState(false);
	// Which shared note is open live (their carets show) travels with my view.
	const live = sections.find(
		(s) => s.note.name === editing && !s.note.ownerUserId,
	);
	useFollowValue(
		"notes.live",
		live ? anchorKey(live.note.name) : "",
		(v) => {
			const s = sections.find(
				(x) => !x.note.ownerUserId && anchorKey(x.note.name) === v,
			);
			setEditing(s ? s.note.name : null);
			setFollowed(true);
		},
		idOrNone,
	);
	const shown =
		limit && !all && sections.length > limit
			? sections.filter((s, i) => i < limit || s.note.name === editing)
			: sections;
	return (
		<div className="space-y-1">
			{shown.map((s) => (
				<NoteSection
					key={s.note.name}
					section={s}
					dense={dense}
					editing={editing === s.note.name}
					focus={!followed}
					onEdit={() => {
						setEditing(s.note.name);
						setFollowed(false);
					}}
					onDone={() => setEditing(null)}
					canEdit={s.note.ownerUserId ? canPrivate : sharedWrite}
				/>
			))}
			{shown.length < sections.length ? (
				<Button
					variant="ghost"
					size="sm"
					data-testid={NOTES_TESTID.showAll}
					onClick={() => setAll(true)}
				>
					Show all {sections.length}
				</Button>
			) : null}
		</div>
	);
}

function NoteSection({
	section,
	dense,
	editing,
	focus,
	onEdit,
	onDone,
	canEdit,
}: {
	section: Section;
	dense: boolean;
	editing: boolean;
	/** Focus the editor when it opens (not when a leader opened it). */
	focus: boolean;
	onEdit: () => void;
	onDone: () => void;
	canEdit: boolean;
}) {
	const { graph } = useWorkspace();
	const priv = !!section.note.ownerUserId;
	// Folded sections travel with my view (never my private ones).
	const [closed, setClosed] = useFollowToggle(
		"notes.closed",
		anchorKey(section.note.name),
		false,
		{ enabled: !priv },
	);
	const open = !closed;
	const setOpen = (v: boolean) => setClosed(!v);
	const docName = noteDocName(
		graph.trip.id,
		section.target,
		priv ? section.note.ownerUserId : null,
	);
	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<section
				data-testid={NOTES_TESTID.section}
				data-target={docName}
				data-cursor-vis={priv ? "private" : undefined}
				data-cursor-anchor={
					priv ? undefined : `note:${anchorKey(section.note.name)}`
				}
				className="group/section rounded-lg py-2"
			>
				<div className="flex items-center gap-2">
					<CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
						<ChevronDown
							className={cn(
								"size-4 shrink-0 text-muted-foreground transition-transform",
								!open && "-rotate-90",
							)}
						/>
						<span
							className={cn(
								"truncate font-semibold",
								dense ? "text-sm" : "text-lg leading-6",
							)}
						>
							{section.title}
						</span>
						{section.crumb ? (
							<span className="truncate text-xs text-muted-foreground">
								{section.crumb}
							</span>
						) : null}
						{priv ? (
							<span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
								<Lock className="size-3" strokeWidth={1.5} /> Only you
							</span>
						) : null}
					</CollapsibleTrigger>
					{canEdit && !editing ? (
						<Button
							variant="ghost"
							size="sm"
							data-testid={NOTES_TESTID.sectionEdit}
							onClick={() => {
								setOpen(true);
								onEdit();
							}}
							className="h-7 opacity-0 transition-opacity group-hover/section:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
						>
							<PencilLine /> Edit
						</Button>
					) : editing ? (
						<Button variant="ghost" size="sm" className="h-7" onClick={onDone}>
							Done
						</Button>
					) : null}
				</div>
				<CollapsibleContent className="pt-2 pl-6 animate-in fade-in-0 duration-150">
					{editing ? (
						<NoteEditor
							docName={docName}
							savedJson={section.note.json}
							allowWrite={canEdit}
							label={`Notes for ${section.title}`}
							autoFocus={focus}
						/>
					) : (
						<StaticNote json={section.note.json} />
					)}
				</CollapsibleContent>
			</section>
		</Collapsible>
	);
}
