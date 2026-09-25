/**
 * `useWorkspace()` (SPEC §12.4): everything a workspace component needs —
 * the graph and its index, access, the URL state (scope, lens, tab, days,
 * sel, only, who), the memoized model and schedule, and `nav`.
 *
 *   const { model, sel, nav, access } = useWorkspace()
 *   <button onClick={() => nav.select({ kind: "node", id })} disabled={!access.canEdit}>
 *
 * Must be used inside `<WorkspaceModelProvider>` (the trip route and
 * `/dev/fixture` mount it; tests use `renderWithWorkspace`).
 */
import { useWorkspaceContext } from "./model-context";

export type {
	ConnectionState,
	EditBlockReason,
	Workspace,
	WorkspaceAccess,
	WorkspaceMode,
	WorkspaceNav,
} from "./model-context";
export type { BundleTarget, LegTarget, Sel, Tab } from "./search";

export function useWorkspace() {
	return useWorkspaceContext();
}
