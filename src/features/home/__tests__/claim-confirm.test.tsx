/**
 * FB-15: "This is me" / "That's me" never claims on the first click. The
 * confirmation says what merges and that it can't be undone; only "Yes, I'm
 * Audrey" calls `claimPlaceholder`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const claim = vi.hoisted(() => vi.fn(async () => ({ memberId: "me" })));
vi.mock("../sharing.functions", () => ({ claimPlaceholder: claim }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

const { ClaimConfirmDialog } = await import("../ClaimConfirm");

function Harness({ onClaimed }: { onClaimed?: () => void }) {
	const [open, setOpen] = useState(false);
	return (
		<QueryClientProvider client={new QueryClient()}>
			<button type="button" onClick={() => setOpen(true)}>
				This is me
			</button>
			<ClaimConfirmDialog
				tripId="t1"
				placeholder={{ id: "ph1", name: "Audrey" }}
				open={open}
				onOpenChange={setOpen}
				onClaimed={onClaimed}
			/>
		</QueryClientProvider>
	);
}

beforeEach(() => claim.mockClear());

describe("ClaimConfirmDialog (FB-15)", () => {
	it("explains the merge, and Cancel claims nothing", async () => {
		render(<Harness />);
		fireEvent.click(screen.getByText("This is me"));
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent("Are you Audrey?");
		expect(dialog).toHaveTextContent(
			"Everything tagged “Audrey” becomes yours",
		);
		expect(dialog).toHaveTextContent("This can't be undone.");
		expect(claim).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
		);
		expect(claim).not.toHaveBeenCalled();
	});

	it("claims only after 'Yes, I'm Audrey', then closes", async () => {
		const onClaimed = vi.fn();
		render(<Harness onClaimed={onClaimed} />);
		fireEvent.click(screen.getByText("This is me"));
		fireEvent.click(
			await screen.findByRole("button", { name: "Yes, I'm Audrey" }),
		);
		await waitFor(() => expect(onClaimed).toHaveBeenCalledTimes(1));
		expect(claim).toHaveBeenCalledWith({
			data: { tripId: "t1", memberId: "ph1" },
		});
		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
	});
});
