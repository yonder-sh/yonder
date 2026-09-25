/**
 * The trip workspace (SPEC §12.5 `Workspace()`, DESIGN §4–§6): picks the
 * layout for the breakpoint and mounts the shared drag context, the keyboard
 * shortcuts, live presence and Follow, and the dialogs — WP-Shell's own
 * (activity, shortcuts, view settings) and the other packages' global ones
 * (EXTENSIONS §1.4: `ReviewDrawer`, `ShiftTripDialog`, `HoursEditorDialog`,
 * `AddExpenseDialog`, plus add place / flight, share, settings, profile).
 *
 * On open it applies the account's default lens when the link doesn't name
 * one (ADDENDUM §7.2 view settings). The digest snapshot is prefetched by the
 * `/t/$trip` loader with the trip bootstrap (EXTENSIONS §9).
 */
import { useEffect, useRef } from "react";
import { WorkspaceDnd } from "@/components/common/dnd/workspace-dnd";
import { ProfileDialog } from "@/features/home/ProfileDialog";
import { ShareDialog } from "@/features/home/ShareDialog";
import { TripSettingsDialog } from "@/features/home/TripSettingsDialog";
import { HoursEditorDialog } from "@/features/insights/HoursEditorDialog";
import { ShiftTripDialog } from "@/features/insights/ShiftTripDialog";
import { FollowedMedia } from "@/features/media/media-follow";
import { AddExpenseDialog } from "@/features/money/AddExpenseDialog";
import { AddPlaceDialog } from "@/features/places/AddPlaceDialog";
import { PushPromptCard } from "@/features/push/PushPromptCard";
import { ReviewDrawer } from "@/features/suggest/ReviewDrawer";
import { AddFlightDialog } from "@/features/transit/AddFlightDialog";
import { WelcomeGate } from "@/features/welcome/WelcomeDialog";
import { mustRedact } from "@/lib/auth/roles";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { ActivityDialog } from "./ActivityDialog";
import { DragPresence } from "./cursors/drag-presence";
import { LiveCursors } from "./cursors/LiveCursors";
import { useFollowAwareness, useSpotlight } from "./cursors/presence-ui";
import { DesktopWorkspace } from "./DesktopWorkspace";
import { useFollow } from "./follow";
import { LivePresence } from "./LivePresence";
import { MobileWorkspace } from "./MobileWorkspace";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { useBreakpoint } from "./use-breakpoint";
import { useWorkspaceHotkeys } from "./use-workspace-hotkeys";
import { ViewSettingsDialog } from "./ViewSettingsDialog";
import { useViewPrefs } from "./view-prefs";

/** Live-only behaviour: Follow, Spotlight, live cursors and publishing where I am. */
function LiveChrome() {
	useFollow();
	useFollowAwareness();
	useSpotlight();
	return (
		<>
			<LivePresence />
			<LiveCursors />
			{/* FB-21c: the followed person's open photo / video / PDF. */}
			<FollowedMedia />
			{/* FB-23: what I drag, for the others' ghosts. */}
			<DragPresence />
		</>
	);
}

/** The account's default lens, once per trip open, when the URL has none. */
function useDefaultLens() {
	const { mode, search, lensOptions, nav, graph } = useWorkspace();
	const { prefs, synced } = useViewPrefs({ enabled: mode === "live" });
	const applied = useRef<string | null>(null);
	const want = prefs.defaultLens;
	useEffect(() => {
		if (applied.current === graph.trip.id || !synced) return;
		applied.current = graph.trip.id;
		if (!want || search.lens) return;
		const ok = lensOptions.find(
			(o) => o.lens === want && o.enabled && o.visible,
		);
		if (ok) nav.setLens(want);
	}, [graph.trip.id, synced, want, search.lens, lensOptions, nav]);
}

export function Workspace() {
	const { mode, scopeResolved, graph } = useWorkspace();
	const bp = useBreakpoint();
	const live = mode === "live";
	useWorkspaceHotkeys();
	useDefaultLens();
	return (
		<WorkspaceDnd>
			<div
				data-testid={TESTID.workspace}
				data-breakpoint={bp}
				data-scope-resolved={scopeResolved}
			>
				{bp === "sm" ? <MobileWorkspace /> : <DesktopWorkspace bp={bp} />}
			</div>
			{live ? <LiveChrome /> : null}
			<AddPlaceDialog />
			<AddFlightDialog />
			<ShareDialog />
			<TripSettingsDialog />
			<ProfileDialog />
			<ReviewDrawer />
			<ShiftTripDialog />
			<HoursEditorDialog />
			{mustRedact(graph.me) ? null : <AddExpenseDialog />}
			<ActivityDialog />
			<ShortcutsDialog />
			<ViewSettingsDialog />
			{/* The welcome, the first time someone opens a trip they didn't create. */}
			{live ? <WelcomeGate /> : null}
			{/* Web Push: "Turn on notifications", the first time on a device. */}
			{live ? <PushPromptCard /> : null}
		</WorkspaceDnd>
	);
}
