import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HANDOFF_FALLBACK_MS, useMenuHandoff } from "../menu-handoff";

/** A ⋯ menu whose "Set stay…" hands off to `open`, recording whether the menu was still there. */
function Menu({ open }: { open: (menuStillMounted: boolean) => void }) {
	const { handOff, onCloseAutoFocus } = useMenuHandoff();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger>More</DropdownMenuTrigger>
			<DropdownMenuContent onCloseAutoFocus={onCloseAutoFocus}>
				<DropdownMenuItem
					onSelect={handOff(() =>
						open(!!document.querySelector("[role=menu]")),
					)}
				>
					Set stay…
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

describe("useMenuHandoff (FB-07)", () => {
	it("runs a handed-off action only once the menu has unmounted, and keeps the focus off the trigger", async () => {
		const user = userEvent.setup();
		const open = vi.fn();
		render(<Menu open={open} />);
		await user.click(screen.getByRole("button", { name: "More" }));
		await user.click(
			await screen.findByRole("menuitem", { name: "Set stay…" }),
		);
		await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
		// The menu (which would take the focus back under a resting pointer) is gone.
		expect(open).toHaveBeenCalledWith(false);
		// Radix didn't hand the focus back to "More": the new surface keeps it.
		expect(document.activeElement).not.toBe(
			screen.getByRole("button", { name: "More" }),
		);
	});

	it("still runs the action if the menu never reports its unmount", () => {
		vi.useFakeTimers();
		try {
			const fn = vi.fn();
			let handOff: ReturnType<typeof useMenuHandoff>["handOff"] =
				() => () => {};
			function Probe() {
				handOff = useMenuHandoff().handOff;
				return null;
			}
			render(<Probe />);
			handOff(fn)();
			expect(fn).not.toHaveBeenCalled();
			act(() => {
				vi.advanceTimersByTime(HANDOFF_FALLBACK_MS);
			});
			expect(fn).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
