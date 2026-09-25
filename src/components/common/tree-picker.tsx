/**
 * The popover tree (SPEC §12.6) behind Outline "Move…", the places filing
 * chip, "Re-file" and the stay picker: a searchable, indented list of the
 * trip's nodes. `filter` hides nodes; `disabledReason` greys them with a tooltip.
 */
import { cn } from "cn";
import { Check, ChevronsUpDown } from "lucide-react";
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
import type { GraphNode } from "@/lib/engine/types";
import { useWorkspaceOptional } from "@/lib/workspace/model-context";
import { TypeGlyph } from "./glyphs";

export function TreePicker({
	value,
	onChange,
	filter,
	disabledReason,
	trigger,
	placeholder = "Choose a place…",
	allowRoot = false,
	open: openProp,
	onOpenChange,
}: {
	value: string | null;
	onChange: (nodeId: string | null) => void;
	filter?: (n: GraphNode) => boolean;
	disabledReason?: (n: GraphNode) => string | null;
	trigger?: ReactNode;
	placeholder?: string;
	/** Offer "Trip (top level)" as a choice (null). */
	allowRoot?: boolean;
	/** Controlled open state (e.g. a menu item that opens the picker directly). */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const ws = useWorkspaceOptional();
	const [openState, setOpenState] = useState(false);
	const open = openProp ?? openState;
	const setOpen = (v: boolean) => {
		if (openProp === undefined) setOpenState(v);
		onOpenChange?.(v);
	};
	const nodes = (ws?.ix.outline ?? []).filter((n) =>
		filter ? filter(n) : true,
	);
	const current = value ? ws?.ix.node(value) : null;
	const depth = (n: GraphNode) => (ws ? ws.ix.path(n.id).length - 1 : 0);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				{trigger ?? (
					<Button
						variant="outline"
						size="sm"
						className="max-w-full justify-between"
					>
						<span className="truncate">
							{current?.name ??
								(allowRoot && value === null ? "Top level" : placeholder)}
						</span>
						<ChevronsUpDown className="opacity-50" />
					</Button>
				)}
			</PopoverTrigger>
			<PopoverContent className="w-72 p-0" align="start">
				<Command>
					<CommandInput placeholder="Search places…" />
					<CommandList className="max-h-[50vh]">
						<CommandEmpty>No matches.</CommandEmpty>
						<CommandGroup>
							{allowRoot ? (
								<CommandItem
									value="__root"
									onSelect={() => {
										onChange(null);
										setOpen(false);
									}}
								>
									<span className="flex-1">Top level</span>
									{value === null ? <Check className="size-4" /> : null}
								</CommandItem>
							) : null}
							{nodes.map((n) => {
								const reason = disabledReason?.(n) ?? null;
								return (
									<CommandItem
										key={n.id}
										value={`${n.name} ${n.localName ?? ""} ${n.id}`}
										disabled={reason !== null}
										title={reason ?? undefined}
										onSelect={() => {
											onChange(n.id);
											setOpen(false);
										}}
										style={{ paddingLeft: 8 + depth(n) * 12 }}
									>
										<TypeGlyph type={n.type} category={n.category} />
										<span
											className={cn(
												"flex-1 truncate",
												n.status === "dropped" && "line-through opacity-60",
											)}
										>
											{n.name}
										</span>
										{value === n.id ? <Check className="size-4" /> : null}
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
