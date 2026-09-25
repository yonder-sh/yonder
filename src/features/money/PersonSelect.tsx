/**
 * Pick ONE person (a payer, who received a refund): the trip's members and
 * placeholders, and, ADDENDUM §8 free-text people, typing a name nobody has
 * offers "Add “Audrey” as a new person" (a placeholder, claimable later; its
 * payments and balances carry over). Viewers and link guests never add people
 * (`useAddPerson()` is null for them).
 */
import { cn } from "cn";
import { Check, ChevronDown, UserPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	assignableMembers,
	PersonAvatar,
	resolveMember,
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
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { humanError } from "@/lib/errors";
import {
	normalizePersonName,
	PLACEHOLDER_NAME_MAX,
} from "@/lib/schemas/people";
import { useWorkspace } from "@/lib/workspace/use-workspace";

export function PersonSelect({
	value,
	onChange,
	label,
	testid,
	ariaLabel = "Paid by",
	disabled,
}: {
	value: string;
	onChange: (memberId: string) => void;
	/** A muted lead-in inside the trigger ("by", "to"). */
	label?: string;
	testid?: string;
	ariaLabel?: string;
	disabled?: boolean;
}) {
	const { graph } = useWorkspace();
	const people = assignableMembers(graph.members);
	const meId = graph.me.memberId;
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const addPerson = useAddPerson();
	const typed = normalizePersonName(query);
	const canCreate =
		addPerson !== null &&
		typed.length > 0 &&
		typed.length <= PLACEHOLDER_NAME_MAX &&
		!people.some((m) => m.name.toLowerCase() === typed.toLowerCase());
	const current = resolveMember(graph.members, value);
	const name = value === meId ? "You" : (current?.name ?? "Former member");
	const pick = (id: string) => {
		onChange(id);
		setQuery("");
		setOpen(false);
	};
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild disabled={disabled}>
				<button
					type="button"
					data-testid={testid}
					aria-label={`${ariaLabel}: ${name}`}
					className={cn(
						"inline-flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs shadow-xs transition-colors",
						"hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
						"disabled:pointer-events-none disabled:opacity-50",
					)}
				>
					{label ? (
						<span className="text-muted-foreground">{label}</span>
					) : null}
					{value ? <PersonAvatar memberId={value} size={16} /> : null}
					<span className="truncate">{name}</span>
					<ChevronDown className="size-3.5 shrink-0 opacity-50" />
				</button>
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
							{people.map((m) => (
								<CommandItem
									key={m.id}
									className="cursor-pointer"
									value={`${m.name} ${m.id}`}
									onSelect={() => pick(m.id)}
								>
									<PersonAvatar memberId={m.id} size={20} />
									<span className="flex-1 truncate">
										{m.id === meId ? "You" : m.name}
									</span>
									{m.id === value ? <Check className="size-4" /> : null}
								</CommandItem>
							))}
							{canCreate && addPerson ? (
								<CommandItem
									value={`add:${typed}`}
									className="cursor-pointer"
									data-testid="person-select-add"
									onSelect={async () => {
										try {
											pick(await addPerson(typed));
										} catch (e) {
											toast.error(humanError(e));
										}
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
