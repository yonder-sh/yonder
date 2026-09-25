/**
 * The `?` sheet (DESIGN §13): every workspace shortcut in one list.
 */
import { Kbd } from "@/components/common/glyphs";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useShell } from "./shell-store";
import { SHELL_TESTID } from "./testids";

const IS_MAC =
	typeof navigator !== "undefined" &&
	/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl";

export const SHORTCUTS: { keys: string[]; label: string }[] = [
	{ keys: [MOD, "K"], label: "Search, add or jump" },
	{ keys: [MOD, "\\"], label: "Show or hide the Outline" },
	{ keys: ["["], label: "Coarser lens" },
	{ keys: ["]"], label: "Finer lens" },
	{ keys: ["Enter"], label: "Zoom into the selection" },
	{ keys: ["Esc"], label: "Clear the selection, then the days, then zoom out" },
	{ keys: ["J"], label: "Next stop in the plan" },
	{ keys: ["K"], label: "Previous stop in the plan" },
	{ keys: ["D"], label: "Show the day of the selection" },
	{ keys: ["A"], label: "Add the focused Outline place to the focused day" },
	{ keys: [MOD, "Z"], label: "Undo the last delete or move" },
	{ keys: ["/"], label: "Say something next to your cursor" },
	{ keys: ["E"], label: "React with an emoji where you point" },
	{ keys: ["?"], label: "This list" },
];

export function ShortcutsDialog() {
	const open = useShell((s) => s.shortcutsOpen);
	const setOpen = useShell((s) => s.setShortcutsOpen);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				data-testid={SHELL_TESTID.shortcutsDialog}
				className="sm:max-w-[440px]"
			>
				<DialogHeader>
					<DialogTitle>Keyboard shortcuts</DialogTitle>
					<DialogDescription>
						They work anywhere in the trip except while typing.
					</DialogDescription>
				</DialogHeader>
				<dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
					{SHORTCUTS.map((s) => (
						<div key={s.label} className="contents">
							<dt className="text-foreground">{s.label}</dt>
							<dd className="flex items-center justify-end gap-1">
								{s.keys.map((k) => (
									<Kbd key={k}>{k}</Kbd>
								))}
							</dd>
						</div>
					))}
				</dl>
			</DialogContent>
		</Dialog>
	);
}
