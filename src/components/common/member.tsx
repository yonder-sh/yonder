/**
 * People (SPEC §12.6, §7.5; DESIGN §2.2, §4.1): avatars (`PersonAvatar`, FB-16) with a presence-colour
 * ring, stacks, pickers and names. Names always come from the CURRENT
 * `graph.members`. A removed member (`status: 'removed'`, their row kept so
 * tags and money still resolve; QA TAG-04, A-26) renders greyed as
 * "Kai Viewer (former member)" and is never offered in pickers or filters; an
 * id that is gone entirely renders as "former member". A placeholder MERGED
 * into a member (ADDENDUM §10, `mergedIntoId`) renders as that member.
 *
 * ADDENDUM §8 free-text people: `MemberPicker` (and `useAddPerson` for other
 * pickers, e.g. `MentionInput`, split and payer editors) turn a typed name
 * that isn't a member yet into a placeholder via `addPlaceholder`.
 */
import { cn } from "cn";
import { Check, UserPlus, Users } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
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
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { addPlaceholder } from "@/features/home/sharing.functions";
import { can } from "@/lib/auth/roles";
import type { GraphMember } from "@/lib/engine/types";
import { tripKeys } from "@/lib/query/keys";
import {
	normalizePersonName,
	PLACEHOLDER_NAME_MAX,
} from "@/lib/schemas/people";
import { useWorkspaceOptional } from "@/lib/workspace/model-context";
import {
	AVATAR_PX,
	type AvatarPerson,
	type AvatarPx,
	PersonAvatar,
	resolveMember,
} from "./person-avatar";
import { useTripMutation } from "./use-trip-mutation";

export {
	type AvatarPerson,
	type AvatarPx,
	PersonAvatar,
	presenceColor,
	presenceFill,
	resolveMember,
} from "./person-avatar";

/**
 * One person (the name every package already uses for `PersonAvatar`,
 * owner FB-16: their picture, else initials; always a circle). Pass
 * `memberId` inside a workspace, or `user` anywhere; a `user` with
 * `memberId`/`userId` picks up the member's current picture.
 */
export function MemberAvatar({
	memberId,
	user,
	size = 28,
	ring = true,
	className,
	title,
}: {
	memberId?: string;
	user?: AvatarPerson;
	size?: AvatarPx;
	ring?: boolean;
	className?: string;
	title?: string;
}) {
	return (
		<PersonAvatar
			memberId={memberId}
			person={user}
			size={size}
			ring={ring}
			className={className}
			title={title}
		/>
	);
}

/** Up to `max` avatars overlapping by 6px, then "+N". */
export function AvatarStack({
	people,
	max = 3,
	size = 28,
	className,
	renderAvatar,
}: {
	people: (AvatarPerson & { id: string })[];
	max?: number;
	size?: AvatarPx;
	className?: string;
	/** Wrap each avatar (hover cards, test ids). */
	renderAvatar?: (
		p: AvatarPerson & { id: string },
		avatar: ReactNode,
	) => ReactNode;
}) {
	const shown = people.slice(0, max);
	const extra = people.length - shown.length;
	return (
		<div className={cn("flex items-center -space-x-1.5", className)}>
			{shown.map((p) => {
				const avatar = <MemberAvatar key={p.id} user={p} size={size} />;
				return renderAvatar ? (
					<span key={p.id}>{renderAvatar(p, avatar)}</span>
				) : (
					avatar
				);
			})}
			{extra > 0 ? (
				<span
					className={cn(
						"z-10 inline-flex items-center justify-center rounded-full bg-muted font-mono text-[11px] text-muted-foreground ring-2 ring-background",
						AVATAR_PX[size],
					)}
				>
					+{extra}
				</span>
			) : null}
		</div>
	);
}

/** The member's current name; removed members greyed as "Name (former member)". */
export function MemberName({
	memberId,
	className,
}: {
	memberId: string;
	className?: string;
}) {
	const ws = useWorkspaceOptional();
	const m = resolveMember(ws?.graph.members ?? [], memberId);
	if (!m || m.status === "removed")
		return (
			<span
				data-former-member=""
				className={cn("text-muted-foreground italic", className)}
			>
				{m ? `${m.name} (former member)` : "former member"}
			</span>
		);
	return <span className={className}>{m.name}</span>;
}

/**
 * Who can be assigned, mentioned or filtered by: every member row that is
 * active, invited or a placeholder. Removed members are kept in the graph
 * (their tags still resolve) but never offered. Guests are never in
 * `graph.members` (§11.3).
 */
export function assignableMembers(
	members: readonly GraphMember[],
): GraphMember[] {
	return members.filter((m) => m.status !== "removed");
}

/**
 * ADDENDUM §8: turn a typed name into a trip person (a placeholder, or the
 * live placeholder/invite with that name). `null` when this viewer may not
 * add people (viewers, link guests, fixture mode). Refreshes graph + sharing.
 */
export function useAddPerson(): ((name: string) => Promise<string>) | null {
	const ws = useWorkspaceOptional();
	const tripId = ws?.graph.trip.id ?? "";
	const m = useTripMutation(
		(displayName: string) => addPlaceholder({ data: { tripId, displayName } }),
		{ keys: [tripKeys.graph(tripId), tripKeys.sharing(tripId)] },
	);
	if (ws?.mode !== "live" || !can(ws.access, "addPeople")) return null;
	return async (name: string) => (await m.mutateAsync(name)).memberId;
}

/**
 * Pick members (assignees, travellers). Guests are never listed. Typing a
 * name nobody has offers "Add “Audrey” as a new person" (ADDENDUM §8) unless
 * `allowCreate` is false.
 */
export function MemberPicker({
	value,
	onChange,
	trigger,
	disabled,
	allowCreate = true,
}: {
	value: string[];
	onChange: (memberIds: string[]) => void;
	trigger?: ReactNode;
	disabled?: boolean;
	allowCreate?: boolean;
}) {
	const ws = useWorkspaceOptional();
	const members = assignableMembers(ws?.graph.members ?? []);
	const [query, setQuery] = useState("");
	const addPerson = useAddPerson();
	const typed = normalizePersonName(query);
	const canCreate =
		allowCreate &&
		addPerson !== null &&
		typed.length > 0 &&
		typed.length <= PLACEHOLDER_NAME_MAX &&
		!members.some((m) => m.name.toLowerCase() === typed.toLowerCase());
	const toggle = (id: string) =>
		onChange(
			value.includes(id) ? value.filter((v) => v !== id) : [...value, id],
		);
	return (
		<Popover>
			<PopoverTrigger asChild disabled={disabled}>
				{trigger ?? (
					<Button variant="ghost" size="sm" aria-label="Choose people">
						<Users /> {value.length || "Everyone"}
					</Button>
				)}
			</PopoverTrigger>
			<PopoverContent className="w-60 p-0" align="start">
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
									data-testid="member-picker-add"
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
			</PopoverContent>
		</Popover>
	);
}
