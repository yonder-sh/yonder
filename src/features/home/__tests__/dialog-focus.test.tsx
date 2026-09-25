/**
 * QA A11Y-02: Share and Trip settings open from the UI store (no Radix
 * trigger). Opened from the keyboard, focus moves into the dialog (the dialog
 * itself, so no phone keyboard), and closing goes back to the opener.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDialogFocus } from "../dialog-focus";

function Harness() {
	const [open, setOpen] = useState(false);
	const focus = useDialogFocus();
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Share
			</button>
			<input aria-label="Behind" />
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent data-testid="dlg" {...focus}>
					<DialogTitle>Share</DialogTitle>
					<DialogDescription>People</DialogDescription>
					<input aria-label="Email" />
				</DialogContent>
			</Dialog>
		</>
	);
}

function MenuHarness() {
	const [open, setOpen] = useState(false);
	const focus = useDialogFocus();
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger>Asia 2027</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuItem onSelect={() => setOpen(true)}>
						Trip settings
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent data-testid="dlg" {...focus}>
					<DialogTitle>Trip settings</DialogTitle>
					<DialogDescription>Saved for everyone</DialogDescription>
					<input aria-label="Name" />
				</DialogContent>
			</Dialog>
		</>
	);
}

describe("useDialogFocus", () => {
	it("focuses the dialog on open (not a field) and returns to the opener on close", async () => {
		render(<Harness />);
		const opener = screen.getByRole("button", { name: "Share" });
		opener.focus();
		fireEvent.click(opener);
		const dialog = await screen.findByTestId("dlg");
		await act(async () => {});
		expect(document.activeElement).toBe(dialog);
		expect(document.activeElement).not.toBe(screen.getByLabelText("Email"));
		fireEvent.keyDown(dialog, { key: "Escape" });
		await act(async () => {});
		expect(screen.queryByTestId("dlg")).toBeNull();
		// Radix restores focus a tick after unmount.
		await vi.waitFor(() => expect(document.activeElement).toBe(opener));
	});

	it("opened from a menu item, closing goes back to the menu's button", async () => {
		render(<MenuHarness />);
		const trigger = screen.getByRole("button", { name: "Asia 2027" });
		trigger.focus();
		fireEvent.keyDown(trigger, { key: "Enter" });
		const item = await screen.findByRole("menuitem", { name: "Trip settings" });
		item.focus();
		fireEvent.keyDown(item, { key: "Enter" });
		const dialog = await screen.findByTestId("dlg");
		await vi.waitFor(() => expect(document.activeElement).toBe(dialog));
		fireEvent.keyDown(dialog, { key: "Escape" });
		await act(async () => {});
		await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
	});
});
