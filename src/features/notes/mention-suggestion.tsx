/**
 * The @-mention popup shared by the note editor and `MentionInput` (DESIGN
 * §7.4 "The mention popup"; spikes/collab `mentionSuggestion.ts`). Members
 * only (guests are never in `graph.members`; removed members are skipped),
 * current names, and ADDENDUM §8 free text: typing a name nobody has offers
 * "Add “Name” as a new person" (a placeholder via `useAddPerson`). In a field
 * that saves later (`MentionInput`) the person is only PENDING until a save
 * carries the chip (`pending-people.ts`), so cancelling leaves nobody behind.
 *
 * Suggestion 3.x positions the popup itself (`props.mount(el)`), so no tippy.
 * Emails don't open it: the default `allowedPrefixes` needs a space (or the
 * line start) before `@` (QA MENT-04).
 */
import type { Editor, Range } from "@tiptap/core";
import type { MentionNodeAttrs } from "@tiptap/extension-mention";
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import { cn } from "cn";
import { UserPlus } from "lucide-react";
import { type Ref, useEffect, useImperativeHandle, useState } from "react";
import { MemberAvatar } from "@/components/common/member";
import type { GraphMember } from "@/lib/engine/types";
import {
	normalizePersonName,
	PLACEHOLDER_NAME_MAX,
} from "@/lib/schemas/people";
import { NOTES_TESTID } from "./testids";

export type MentionCandidate =
	| { kind: "member"; id: string; label: string; color: number }
	| { kind: "add"; name: string };

export type MentionCtx = {
	members: readonly GraphMember[];
	/** Null when this viewer may not add people (viewers, guests, fixture). */
	addPerson: ((name: string) => Promise<string>) | null;
	/**
	 * Fields that save later (`MentionInput`): a pending id for a new person,
	 * created when a save carries it (QA PLAN-R2-08). Without it, `addPerson`
	 * creates the person at once (the live note, which saves as you type).
	 */
	pendPerson?: ((name: string) => string) | null;
};

/** Candidates for a query: matching members (8 max), then "Add “Name”". */
export function mentionCandidates(
	query: string,
	ctx: MentionCtx,
): MentionCandidate[] {
	const q = query.trim().toLowerCase();
	const members = ctx.members
		.filter((m) => m.status !== "removed" && !m.mergedIntoId)
		.filter((m) => !q || m.name.toLowerCase().includes(q))
		.sort((a, b) => {
			// Prefix matches first ("Au" → Audrey before Laura).
			const pa = a.name.toLowerCase().startsWith(q) ? 0 : 1;
			const pb = b.name.toLowerCase().startsWith(q) ? 0 : 1;
			return pa - pb || a.name.localeCompare(b.name);
		})
		.slice(0, 8)
		.map(
			(m): MentionCandidate => ({
				kind: "member",
				id: m.id,
				label: m.name,
				color: m.color,
			}),
		);
	const typed = normalizePersonName(query);
	const words = typed.split(" ").filter(Boolean).length;
	// Offer a new person only when nobody on the trip matches what was typed.
	if (
		ctx.addPerson &&
		members.length === 0 &&
		typed.length > 0 &&
		typed.length <= PLACEHOLDER_NAME_MAX &&
		words <= 3 &&
		!ctx.members.some((m) => m.name.toLowerCase() === typed.toLowerCase())
	)
		members.push({ kind: "add", name: typed });
	return members;
}

export type MentionListHandle = { onKeyDown: (e: KeyboardEvent) => boolean };

type ListProps = SuggestionProps<MentionCandidate, MentionNodeAttrs> & {
	ref?: Ref<MentionListHandle>;
};

export function MentionList({ items, command, query, ref }: ListProps) {
	const [active, setActive] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset the highlight when the list changes.
	useEffect(() => setActive(0), [items]);
	const pick = (i: number) => {
		const c = items[i];
		if (!c) return;
		command(
			c.kind === "member"
				? { id: c.id, label: c.label }
				: ({ id: `add:${c.name}`, label: c.name } as MentionNodeAttrs),
		);
	};
	useImperativeHandle(ref, () => ({
		onKeyDown: (e) => {
			if (!items.length) return false;
			if (e.key === "ArrowUp") {
				setActive((a) => (a + items.length - 1) % items.length);
				return true;
			}
			if (e.key === "ArrowDown") {
				setActive((a) => (a + 1) % items.length);
				return true;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				pick(active);
				return true;
			}
			return false;
		},
	}));
	if (!items.length) return null;
	return (
		<div
			role="listbox"
			aria-label="Mention someone on this trip"
			data-testid={NOTES_TESTID.mentionPopup}
			className="z-50 w-60 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-float"
		>
			{items.map((c, i) => (
				<button
					type="button"
					role="option"
					key={c.kind === "member" ? c.id : `add:${c.name}`}
					aria-selected={i === active}
					data-testid={
						c.kind === "add"
							? NOTES_TESTID.mentionAdd
							: NOTES_TESTID.mentionOption
					}
					onMouseEnter={() => setActive(i)}
					onMouseDown={(e) => {
						e.preventDefault(); // keep the editor's focus
						pick(i);
					}}
					className={cn(
						"flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm",
						i === active ? "bg-accent text-accent-foreground" : "",
					)}
				>
					{c.kind === "member" ? (
						<>
							<MemberAvatar
								user={{ name: c.label, color: c.color, memberId: c.id }}
								size={20}
								ring={false}
							/>
							<span className="truncate">{c.label}</span>
						</>
					) : (
						<>
							<UserPlus className="size-4 text-muted-foreground" />
							<span className="truncate">Add “{c.name}” as a new person</span>
						</>
					)}
				</button>
			))}
			{query && !items.some((c) => c.kind === "member") ? (
				<p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">
					No one on this trip matches “{query.trim()}”.
				</p>
			) : null}
		</div>
	);
}

/**
 * The Mention `suggestion` options. `getCtx` is read on every keystroke, so
 * the members and permissions stay current without rebuilding the editor.
 */
export function mentionSuggestion(
	getCtx: () => MentionCtx,
): Omit<SuggestionOptions<MentionCandidate, MentionNodeAttrs>, "editor"> {
	return {
		char: "@",
		allowSpaces: true,
		items: ({ query }) => mentionCandidates(query, getCtx()),
		command: ({
			editor,
			range,
			props,
		}: {
			editor: Editor;
			range: Range;
			props: MentionNodeAttrs;
		}) => {
			const id = String(props.id ?? "");
			const insert = (memberId: string, label: string) =>
				editor
					.chain()
					.focus()
					.insertContentAt(range, [
						{ type: "mention", attrs: { id: memberId, label } },
						{ type: "text", text: " " },
					])
					.run();
			if (id.startsWith("add:")) {
				const { addPerson: add, pendPerson } = getCtx();
				const name = id.slice(4);
				if (!add) return;
				if (pendPerson) {
					insert(pendPerson(name), name);
					return;
				}
				void add(name).then(
					(memberId) => insert(memberId, name),
					() => {},
				);
				return;
			}
			insert(id, String(props.label ?? ""));
		},
		render: () => {
			let renderer: ReactRenderer<MentionListHandle, ListProps> | null = null;
			let unmount: (() => void) | null = null;
			return {
				onStart: (props) => {
					renderer = new ReactRenderer(MentionList, {
						props,
						editor: props.editor,
					});
					const el = renderer.element as HTMLElement;
					// The positioned element is this wrapper (appended to <body>), so it
					// carries the popover layer: without it, a sticky or z-indexed
					// footer (the Rate card's) paints over the list (PLAN-I2-08).
					el.style.zIndex = "50";
					unmount = props.mount(el);
				},
				onUpdate: (props) => renderer?.updateProps(props),
				onKeyDown: ({ event }) => {
					if (event.key === "Escape") return false;
					return renderer?.ref?.onKeyDown(event) ?? false;
				},
				onExit: () => {
					unmount?.();
					renderer?.destroy();
					unmount = null;
					renderer = null;
				},
			};
		},
	};
}
