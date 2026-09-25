/**
 * E5 Add expense (EXTENSIONS §8.6, ADDENDUM §6 "fast mobile entry"): opened
 * with `useUi().openAddExpense(prefill)` from anywhere (item/day ⋯, leg ⋯, the
 * FAB, "Bought" on a shopping item, the Money tab), on an existing expense
 * (`{ expenseId }`: its row, inbox links) or as a refund (`{ refundOfId }`).
 * A Dialog (480) on desktop, a bottom Drawer on phones. Mounted once: extra
 * mounts (the shell mounts it globally; the Money tab and panel mount it too
 * so they work on their own) render nothing.
 */
import { useSyncExternalStore } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Drawer,
	DrawerContent,
	DrawerDescription,
	DrawerTitle,
} from "@/components/ui/drawer";
import { TESTID } from "@/lib/testids";
import { useWorkspaceOptional } from "@/lib/workspace/model-context";
import { useUi } from "@/lib/workspace/ui-store";
import { type EditorMode, ExpenseEditor } from "./ExpenseEditor";
import { usePrimaryMount } from "./single-mount";
import { useMoneyData } from "./use-money";

const PHONE = "(max-width: 767px)";
function usePhone(): boolean {
	return useSyncExternalStore(
		(cb) => {
			const m = window.matchMedia(PHONE);
			m.addEventListener("change", cb);
			return () => m.removeEventListener("change", cb);
		},
		() => window.matchMedia(PHONE).matches,
		() => false,
	);
}

export function AddExpenseDialog() {
	const primary = usePrimaryMount("add-expense");
	const ws = useWorkspaceOptional();
	if (!primary || !ws) return null;
	return <AddExpenseDialogInner />;
}

function AddExpenseDialogInner() {
	const req = useUi((s) => s.addExpense);
	const openReq = useUi((s) => s.openAddExpense);
	const { data, guest } = useMoneyData();
	const phone = usePhone();
	const close = () => openReq(null);
	let mode: EditorMode | null = null;
	let key = "none";
	if (req?.expenseId) {
		// An id that isn't visible (deleted, someone's private row) opens nothing.
		const e = data?.expenses.find((x) => x.id === req.expenseId);
		if (e) {
			mode = { kind: "edit", expense: e };
			key = `edit:${e.id}`;
		}
	} else if (req?.refundOfId) {
		const e = data?.expenses.find((x) => x.id === req.refundOfId);
		if (e) {
			mode = { kind: "refund", original: e };
			key = `refund:${e.id}`;
		}
	} else if (req) {
		mode = { kind: "new", request: req };
		key = `new:${JSON.stringify(req)}`;
	}
	const open = mode !== null && !guest;
	const body = mode ? (
		<ExpenseEditor key={key} mode={mode} onClose={close} />
	) : null;
	if (phone)
		return (
			<Drawer
				open={open}
				onOpenChange={(v) => !v && close()}
				repositionInputs={false}
			>
				<DrawerContent
					data-testid={TESTID.addExpenseDialog}
					className="max-h-[92dvh]"
				>
					<DrawerTitle className="sr-only">Expense</DrawerTitle>
					<DrawerDescription className="sr-only">
						Amount, currency, who paid and who shares it.
					</DrawerDescription>
					{body}
				</DrawerContent>
			</Drawer>
		);
	return (
		<Dialog open={open} onOpenChange={(v) => !v && close()}>
			<DialogContent
				className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[480px]"
				data-testid={TESTID.addExpenseDialog}
			>
				<DialogTitle className="sr-only">Expense</DialogTitle>
				<DialogDescription className="sr-only">
					Amount, currency, who paid and who shares it.
				</DialogDescription>
				{body}
			</DialogContent>
		</Dialog>
	);
}
