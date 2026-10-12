/**
 * A082: a pending invite's menu offers "Change email…" and "Cancel invite".
 * Cancelling never asks for a former placeholder (she stays, with Undo); a
 * plain invite with splits or tags asks first, and only "Cancel invite" in
 * that dialog retires it.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithWorkspace } from "@/test/render-workspace";

const fns = vi.hoisted(() => ({
	cancelInvite: vi.fn(),
	changeInviteEmail: vi.fn(async () => ({ status: "invited" })),
	linkPlaceholder: vi.fn(async () => ({ ok: true })),
	removeMember: vi.fn(async () => ({ ok: true })),
	updateMemberRole: vi.fn(),
}));
vi.mock("../sharing.functions", () => fns);
const toasts = vi.hoisted(() => ({
	success: vi.fn(),
	message: vi.fn(),
	undo: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: Object.assign(toasts.undo, {
		success: toasts.success,
		message: toasts.message,
	}),
}));

const { MemberRow } = await import("../ShareDialog");
const { refsSummary } = await import("../PendingInvite");
const { HOME_TESTID } = await import("../testids");

const sam = {
	id: "00000000-0000-4000-8000-0000000000a1",
	userId: null,
	status: "invited" as const,
	role: "viewer" as const,
	name: "sam",
	email: "sam@typo.test",
	color: 3,
};

async function openMenu() {
	renderWithWorkspace(
		<MemberRow
			m={sam}
			me={null}
			owner
			linker
			canClaim={false}
			members={[sam]}
			tripId="t1"
		/>,
	);
	const trigger = screen.getByRole("button", { name: "More for sam" });
	trigger.focus();
	fireEvent.keyDown(trigger, { key: "Enter" });
	await screen.findByRole("menu");
}

beforeEach(() => {
	for (const f of [...Object.values(fns), ...Object.values(toasts)])
		f.mockClear();
});

describe("a pending invite's menu (A082)", () => {
	it("offers Change email… and Cancel invite, never Remove from trip", async () => {
		await openMenu();
		expect(screen.getByRole("menuitem", { name: /Change email/ })).toBeTruthy();
		expect(
			screen.getByRole("menuitem", { name: "Cancel invite" }),
		).toBeTruthy();
		expect(screen.queryByRole("menuitem", { name: "Remove from trip" })).toBe(
			null,
		);
	});

	it("a former placeholder is cancelled at once, with Undo that sends no email", async () => {
		fns.cancelInvite.mockResolvedValueOnce({
			kind: "reverted",
			name: "Audrey",
			email: "audrey@typo.test",
		});
		await openMenu();
		fireEvent.click(screen.getByRole("menuitem", { name: "Cancel invite" }));
		await waitFor(() => expect(toasts.undo).toHaveBeenCalledTimes(1));
		expect(fns.cancelInvite).toHaveBeenCalledWith({
			data: { memberId: sam.id, confirmed: false },
		});
		expect(screen.queryByRole("alertdialog")).toBe(null);
		const opts = toasts.undo.mock.calls[0]?.[1] as {
			action: { onClick: () => void };
		};
		await act(async () => opts.action.onClick());
		expect(fns.linkPlaceholder).toHaveBeenCalledWith({
			data: { memberId: sam.id, email: "audrey@typo.test", notify: false },
		});
	});

	it("a plain invite with splits asks first; only the dialog's Cancel invite retires it", async () => {
		fns.cancelInvite.mockResolvedValueOnce({
			kind: "confirm",
			name: "sam",
			refs: { splits: 3, payments: 0, ratings: 1, tags: 0 },
		});
		await openMenu();
		fireEvent.click(screen.getByRole("menuitem", { name: "Cancel invite" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent(
			"sam has 3 splits and 1 rating; they'll stay with a former member.",
		);
		fns.cancelInvite.mockResolvedValueOnce({ kind: "cancelled", name: "sam" });
		fireEvent.click(screen.getByTestId(HOME_TESTID.cancelInviteYes));
		await waitFor(() =>
			expect(toasts.success).toHaveBeenCalledWith("Invite cancelled"),
		);
		expect(fns.cancelInvite).toHaveBeenLastCalledWith({
			data: { memberId: sam.id, confirmed: true },
		});
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBe(null));
	});

	it("Change email… checks the address like the invite form, then sends", async () => {
		await openMenu();
		fireEvent.click(screen.getByRole("menuitem", { name: /Change email/ }));
		const input = await screen.findByLabelText("New email for sam");
		fireEvent.change(input, { target: { value: "sam@example" } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Enter an email address like name@example.com.",
		);
		expect(fns.changeInviteEmail).not.toHaveBeenCalled();
		fireEvent.change(input, { target: { value: "sam@example.com" } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() =>
			expect(fns.changeInviteEmail).toHaveBeenCalledWith({
				data: { memberId: sam.id, email: "sam@example.com" },
			}),
		);
		await waitFor(() =>
			expect(screen.queryByLabelText("New email for sam")).toBe(null),
		);
	});
});

describe("refsSummary", () => {
	it("lists what points at them", () => {
		const none = { splits: 0, payments: 0, ratings: 0, tags: 0 };
		expect(refsSummary("Sam", { ...none, splits: 1 })).toBe("Sam has 1 split");
		expect(
			refsSummary("Sam", { splits: 2, payments: 1, ratings: 0, tags: 4 }),
		).toBe("Sam has 2 splits, 1 payment and 4 tags");
	});
});
