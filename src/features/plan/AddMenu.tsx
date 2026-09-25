/**
 * The "+" between cards (DESIGN §7.1): Place… (the add-place palette), Flight…
 * (the flight dialog), and a Block (Breakfast, Lunch, Dinner, Rest, Custom…),
 * inserted at that point of the day.
 */
import { cn } from "cn";
import { Plane, Plus, Search, Utensils } from "lucide-react";
import { useState } from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@/components/ui/popover";
import { useUi } from "@/lib/workspace/ui-store";
import { useMenuHandoff } from "./menu-handoff";
import { PLAN_TESTID } from "./testids";
import { usePlanActions } from "./use-plan-actions";

const BLOCKS: { title: string; min: number }[] = [
	{ title: "Breakfast", min: 30 },
	{ title: "Lunch", min: 60 },
	{ title: "Dinner", min: 90 },
	{ title: "Rest", min: 60 },
];

export function AddMenu({
	dayId,
	afterItemId,
	beforeItemId,
	className,
	label = "Add here",
	variant = "dot",
}: {
	dayId: string;
	afterItemId?: string;
	beforeItemId?: string;
	className?: string;
	label?: string;
	/** `dot`: the 20px round "+" on the rail; `row`: an "Add to this day" row. */
	variant?: "dot" | "row";
}) {
	const guard = useEditGuard();
	const actions = usePlanActions();
	const openAddPlace = useUi((s) => s.openAddPlace);
	const openAddFlight = useUi((s) => s.openAddFlight);
	const [custom, setCustom] = useState(false);
	const [title, setTitle] = useState("");
	// The menu mounts on first open: every card has a "+" (QA PERF-05).
	const [armed, setArmed] = useState(false);
	const [open, setOpen] = useState(false);
	// "Custom…" opens a popover once the menu has gone, and the menu doesn't
	// hand the focus back to "+" (FB-07).
	const menu = useMenuHandoff();
	if (guard.disabled) return null;
	const where = {
		...(afterItemId ? { afterItemId } : {}),
		...(beforeItemId ? { beforeItemId } : {}),
	};
	const addBlock = (t: string, min: number) =>
		actions.create.mutate({ dayId, title: t, durationMin: min, ...where });
	return (
		<Popover open={custom} onOpenChange={setCustom}>
			<DropdownMenu
				open={open}
				onOpenChange={(v) => {
					if (v) setArmed(true);
					setOpen(v);
				}}
			>
				<PopoverAnchor asChild>
					<DropdownMenuTrigger asChild>
						{variant === "dot" ? (
							<button
								type="button"
								aria-label={label}
								data-testid={PLAN_TESTID.addBetween}
								onClick={(e) => e.stopPropagation()}
								onPointerDown={(e) => e.stopPropagation()}
								className={cn(
									"flex size-5 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
									className,
								)}
							>
								<Plus className="size-3" strokeWidth={2} />
							</button>
						) : (
							<Button
								variant="ghost"
								size="sm"
								data-testid={PLAN_TESTID.addBetween}
								className={cn(
									"h-8 justify-start gap-2 px-2 text-xs font-normal text-muted-foreground",
									className,
								)}
							>
								<Plus className="size-3.5" strokeWidth={1.75} />
								{label}
							</Button>
						)}
					</DropdownMenuTrigger>
				</PopoverAnchor>
				{armed ? (
					<DropdownMenuContent
						onCloseAutoFocus={menu.onCloseAutoFocus}
						align="start"
						className="w-52"
						onClick={(e) => e.stopPropagation()}
					>
						<DropdownMenuItem
							onSelect={() =>
								openAddPlace({ mode: "schedule", dayId, ...where })
							}
						>
							<Search className="size-4" strokeWidth={1.5} /> Place…
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={() => openAddFlight({ dayId, ...where })}
						>
							<Plane className="size-4" strokeWidth={1.5} /> Flight…
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
							Block
						</DropdownMenuLabel>
						{BLOCKS.map((b) => (
							<DropdownMenuItem
								key={b.title}
								onSelect={() => addBlock(b.title, b.min)}
							>
								<Utensils className="size-4 opacity-0" aria-hidden />
								{b.title}
							</DropdownMenuItem>
						))}
						<DropdownMenuItem onSelect={menu.handOff(() => setCustom(true))}>
							<Utensils className="size-4 opacity-0" aria-hidden />
							Custom…
						</DropdownMenuItem>
					</DropdownMenuContent>
				) : null}
			</DropdownMenu>
			{custom ? (
				<PopoverContent
					align="start"
					className="w-64 p-3"
					onClick={(e) => e.stopPropagation()}
				>
					<form
						className="flex gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							const t = title.trim();
							if (!t) return;
							addBlock(t.slice(0, 200), 60);
							setTitle("");
							setCustom(false);
						}}
					>
						<Input
							autoFocus
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="Laundry, Check-in…"
							aria-label="Block title"
							maxLength={200}
							className="h-8"
						/>
						<Button type="submit" size="sm">
							Add
						</Button>
					</form>
				</PopoverContent>
			) : null}
		</Popover>
	);
}
