/**
 * Controlled pickers the list rows open from their ⋯ menu (the common
 * `MemberPicker`/`TreePicker` own their trigger, which a menu item can't
 * open): people (members only, never guests; a typed name adds a person,
 * ADDENDUM §8 via `useAddPerson`) and places (Move to…, candidate shops).
 */
import { cn } from "cn";
import { Check, House, UserPlus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { TypeGlyph } from "@/components/common/glyphs";
import {
	assignableMembers,
	MemberAvatar,
	useAddPerson,
} from "@/components/common/member";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	normalizePersonName,
	PLACEHOLDER_NAME_MAX,
} from "@/lib/schemas/people";
import { useWorkspace } from "@/lib/workspace/use-workspace";

type Controlled = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The element the popover hangs from (a trigger, or an anchor). */
	children: ReactNode;
	/**
	 * `children` is the trigger (default), only an anchor, or (`"wrap"`) a
	 * trigger that may be hidden (`display: none` on narrow boards, where the
	 * ⋯ menu opens the picker instead): a wrapper span that is always laid out
	 * is the anchor, so the popover never falls back to the viewport's
	 * top-left corner (FB-06).
	 */
	asAnchor?: boolean | "wrap";
};

function Shell({
	open,
	onOpenChange,
	children,
	asAnchor,
	content,
	label,
}: Controlled & { content: ReactNode; label: string }) {
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			{asAnchor === "wrap" ? (
				<PopoverAnchor asChild>
					<span className="inline-flex">
						<PopoverTrigger asChild>{children}</PopoverTrigger>
					</span>
				</PopoverAnchor>
			) : asAnchor ? (
				<PopoverAnchor asChild>{children}</PopoverAnchor>
			) : (
				<PopoverTrigger asChild>{children}</PopoverTrigger>
			)}
			<PopoverContent className="w-64 p-0" align="end" aria-label={label}>
				{content}
			</PopoverContent>
		</Popover>
	);
}

/** "For" / assignees: toggles members; "Add “Name”" creates a placeholder person. */
export function AssignPicker({
	value,
	onChange,
	...shell
}: Controlled & {
	value: string[];
	onChange: (memberIds: string[]) => void;
}) {
	const { graph } = useWorkspace();
	const members = assignableMembers(graph.members).filter(
		(m) => !m.mergedIntoId,
	);
	const addPerson = useAddPerson();
	const [query, setQuery] = useState("");
	const typed = normalizePersonName(query);
	const canCreate =
		addPerson !== null &&
		typed.length > 0 &&
		typed.length <= PLACEHOLDER_NAME_MAX &&
		!members.some((m) => m.name.toLowerCase() === typed.toLowerCase());
	const toggle = (id: string) =>
		onChange(
			value.includes(id) ? value.filter((v) => v !== id) : [...value, id],
		);
	return (
		<Shell
			{...shell}
			label="Who is this for"
			content={
				<Command>
					<CommandInput
						placeholder={addPerson ? "Search or add a name…" : "Search people…"}
						value={query}
						onValueChange={setQuery}
					/>
					<CommandList>
						{canCreate ? null : <CommandEmpty>No matches.</CommandEmpty>}
						<CommandGroup>
							{members.map((m) => (
								<CommandItem
									key={m.id}
									value={m.name}
									onSelect={() => toggle(m.id)}
								>
									<MemberAvatar user={m} size={20} />
									<span className="flex-1 truncate">{m.name}</span>
									{value.includes(m.id) ? <Check className="size-4" /> : null}
								</CommandItem>
							))}
							{canCreate && addPerson ? (
								<CommandItem
									value={`add:${typed}`}
									onSelect={async () => {
										const id = await addPerson(typed);
										setQuery("");
										if (!value.includes(id)) onChange([...value, id]);
									}}
								>
									<UserPlus className="size-4" />
									<span className="flex-1 truncate">
										Add “{typed}” as a new person
									</span>
								</CommandItem>
							) : null}
						</CommandGroup>
					</CommandList>
				</Command>
			}
		/>
	);
}

/** One place (or the trip itself): Move to…, a candidate shop. */
export function PlacePicker({
	value,
	onPick,
	allowRoot,
	exclude,
	placeholder = "Search places…",
	...shell
}: Controlled & {
	value: string | null;
	onPick: (nodeId: string | null) => void;
	allowRoot?: boolean;
	exclude?: readonly string[];
	placeholder?: string;
}) {
	const { ix, graph } = useWorkspace();
	const nodes = ix.outline.filter((n) => !exclude?.includes(n.id));
	return (
		<Shell
			{...shell}
			label="Choose a place"
			content={
				<Command>
					<CommandInput placeholder={placeholder} />
					<CommandList className="max-h-[50vh]">
						<CommandEmpty>No matches.</CommandEmpty>
						<CommandGroup>
							{allowRoot ? (
								<CommandItem
									value={`__trip ${graph.trip.name}`}
									onSelect={() => onPick(null)}
								>
									<House className="size-4 text-muted-foreground" />
									<span className="flex-1 truncate">
										{graph.trip.name} (the whole trip)
									</span>
									{value === null ? <Check className="size-4" /> : null}
								</CommandItem>
							) : null}
							{nodes.map((n) => {
								const depth = ix.path(n.id).length - 1;
								return (
									<CommandItem
										key={n.id}
										value={`${n.name} ${n.id}`}
										onSelect={() => onPick(n.id)}
										className={cn(ix.isDropped(n.id) && "opacity-60")}
									>
										<span style={{ width: depth * 12 }} className="shrink-0" />
										<TypeGlyph type={n.type} category={n.category} />
										<span className="flex-1 truncate">{n.name}</span>
										{value === n.id ? <Check className="size-4" /> : null}
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
				</Command>
			}
		/>
	);
}
