/** A bottom sheet clears the toasts, so an earlier Undo never sits on its Save. */
import { render } from "@testing-library/react";
import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";
import { Drawer, DrawerContent, DrawerTitle } from "./drawer";

describe("Drawer", () => {
	it("dismisses the toasts when it opens", () => {
		const dismiss = vi.spyOn(toast, "dismiss");
		const sheet = (open: boolean) => (
			<Drawer open={open}>
				<DrawerContent>
					<DrawerTitle>Add an expense</DrawerTitle>
				</DrawerContent>
			</Drawer>
		);
		const { rerender } = render(sheet(false));
		expect(dismiss).not.toHaveBeenCalled();
		rerender(sheet(true));
		expect(dismiss).toHaveBeenCalledTimes(1);
		dismiss.mockRestore();
	});
});
