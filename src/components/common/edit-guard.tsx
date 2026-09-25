/**
 * Edit affordances stay VISIBLE but disabled when editing isn't possible,
 * with the reason as a tooltip (SPEC §0 rule 17, DESIGN §6 "Offline").
 *
 *   const { disabled, reason } = useEditGuard()
 *   <EditGuard><Button onClick={save}>Save</Button></EditGuard>
 *
 * EXTENSIONS §2.3: `useEditGuard('propose-ok')` (the default) stays enabled in
 * suggest mode (the change becomes a proposal); `useEditGuard('edit-only', why)`
 * is disabled in suggest mode with `why` ("Photos need edit access", "Suggesters
 * can't fetch routes") — uploads, provider fetches, restores
 * (`MUTATION_POLICY` "edit-only"). PLACES §1c: `useEditGuard('rate')` guards
 * YOUR OWN rating controls: enabled for anyone who may rate (raters too, who
 * are otherwise read-only), else like `propose-ok`.
 */
import {
	Children,
	cloneElement,
	isValidElement,
	type ReactElement,
} from "react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { canRateOwn } from "@/lib/auth/roles";
import type { EditBlockReason } from "@/lib/workspace/model-context";
import { useWorkspaceOptional } from "@/lib/workspace/model-context";

export type EditGuardKind = "propose-ok" | "edit-only" | "rate";

export function useEditGuard(
	kind: EditGuardKind = "propose-ok",
	editOnlyReason = "Needs edit access",
): {
	disabled: boolean;
	reason: EditBlockReason | null;
} {
	const ws = useWorkspaceOptional();
	if (!ws) return { disabled: false, reason: null };
	if (kind === "rate" && canRateOwn(ws.access))
		return ws.access.canRate
			? { disabled: false, reason: null }
			: { disabled: true, reason: "Offline — rating paused" };
	if (!ws.access.canEdit) return { disabled: true, reason: ws.access.reason };
	if (kind === "edit-only" && ws.access.mode === "suggest")
		return { disabled: true, reason: editOnlyReason };
	return { disabled: false, reason: null };
}

/** Disables its single child element and explains why in a tooltip. */
export function EditGuard({
	children,
	kind = "propose-ok",
	reason: editOnlyReason,
}: {
	children: ReactElement<{ disabled?: boolean }>;
	kind?: EditGuardKind;
	/** The tooltip for `edit-only` in suggest mode. */
	reason?: string;
}) {
	const { disabled, reason } = useEditGuard(kind, editOnlyReason);
	const child = Children.only(children);
	if (!disabled || !isValidElement(child)) return child;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				{/* A wrapper keeps the tooltip working on a disabled control. */}
				<span className="inline-flex">
					{cloneElement(child, { disabled: true })}
				</span>
			</TooltipTrigger>
			<TooltipContent>{reason}</TooltipContent>
		</Tooltip>
	);
}
