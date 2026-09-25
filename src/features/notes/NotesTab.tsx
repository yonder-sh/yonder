/**
 * The Notes tab (SPEC §12.5 `NotesTab()`, DESIGN §7.4): the scope's own note
 * live on top (the trip note at the root), then — unless "Only <scope>" — the
 * notes inside the scope as collapsible, static sections: descendant places,
 * this scope's visits ("This visit · Day 4 · Itoya"), days ("Day 5 · Thu 7
 * Oct") and transit. "Edit" swaps a section into a live editor, one at a time.
 * The viewer's own private notes show as sections too, marked "Only you".
 */
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { ChevronDown, Lock, PencilLine } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { TabPurpose } from "@/features/shell/TabPurpose";
import { noteDocName } from "@/lib/realtime/protocol";
import type { BundleTarget } from "@/lib/schemas/targets";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { dayLabel, itemName, legLabel, rollupRows } from "../lists/list-model";
import { NoteBlock, useNoteAccess } from "./NoteBlock";
import { NoteEditor } from "./NoteEditor";
import type { NoteDto } from "./notes.functions";
import { hasText, noteFor, noteTarget, tripNotesQuery } from "./queries";
import { StaticNote } from "./StaticNote";
import { NOTES_TESTID } from "./testids";

type Section = {
	note: NoteDto;
	target: BundleTarget;
	title: string;
	crumb: string | null;
};

export function NotesTab() {
	const ws = useWorkspace();
	const { graph, scope, ix, mode, only, days, lens, model } = ws;
	const q = useQuery({
		...tripNotesQuery(graph.trip.id),
		enabled: mode === "live",
	});
	const { sharedWrite, canPrivate } = useNoteAccess();
	const own: BundleTarget = scope
		? { kind: "node", nodeId: scope.id }
		: { kind: "trip" };
	const where = scope?.name ?? graph.trip.name;
	const [editing, setEditing] = useState<string | null>(null);
	const [writing, setWriting] = useState(false);

	const sections = useMemo<Section[]>(() => {
		if (only || !q.data) return [];
		const notes = q.data.filter((n) => hasText(n));
		const groups = rollupRows(
			ix,
			notes.map((n) => ({ id: n.name, target: noteTarget(n) })),
			{ scopeId: scope?.id ?? null, lens, dayRange: days, model },
		);
		const out: Section[] = [];
		for (const g of groups)
			for (const s of g.subs)
				for (const row of s.rows) {
					const note = notes.find((n) => n.name === row.id);
					if (!note) continue;
					const target = noteTarget(note);
					// The scope's own note is the live editor on top.
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
	}, [q.data, only, ix, scope, lens, days, model, graph.trip.name, own]);

	const ownShared = noteFor(q.data, own);
	const ownPrivate = canPrivate
		? noteFor(q.data, own, graph.me.userId)
		: undefined;
	const empty =
		mode === "live" &&
		q.isSuccess &&
		!hasText(ownShared) &&
		!hasText(ownPrivate) &&
		sections.length === 0;

	return (
		<div data-testid={TESTID.notesTab} className="px-4 pt-3 pb-16">
			{empty && !writing ? (
				<EmptyState
					lead={<TabPurpose tab="notes" />}
					line={`No notes for ${where}.`}
					action={
						sharedWrite || canPrivate ? (
							<Button size="sm" onClick={() => setWriting(true)}>
								<PencilLine /> Start writing
							</Button>
						) : undefined
					}
				/>
			) : (
				<NoteBlock
					key={JSON.stringify(own)}
					target={own}
					label={`Notes for ${where}`}
					autoFocus={writing}
				/>
			)}
			{sections.length ? (
				<div className="mt-8 space-y-1 border-t pt-2">
					{sections.map((s) => (
						<NoteSection
							key={s.note.name}
							section={s}
							editing={editing === s.note.name}
							onEdit={() => setEditing(s.note.name)}
							onDone={() => setEditing(null)}
							canEdit={s.note.ownerUserId ? canPrivate : sharedWrite}
						/>
					))}
				</div>
			) : null}
		</div>
	);
}

function NoteSection({
	section,
	editing,
	onEdit,
	onDone,
	canEdit,
}: {
	section: Section;
	editing: boolean;
	onEdit: () => void;
	onDone: () => void;
	canEdit: boolean;
}) {
	const { graph } = useWorkspace();
	const [open, setOpen] = useState(true);
	const priv = !!section.note.ownerUserId;
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
						<span className="truncate text-[17px] leading-6 font-semibold">
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
							autoFocus
						/>
					) : (
						<StaticNote json={section.note.json} />
					)}
				</CollapsibleContent>
			</section>
		</Collapsible>
	);
}
