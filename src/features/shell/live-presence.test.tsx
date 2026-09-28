/**
 * Where I am, as published (`LivePresence`): during the trip a bare trip link
 * opens Today or the Overview by role (flow 11), so the path names the tab
 * and whoever follows me lands where I am.
 */
import { describe, expect, it, vi } from "vitest";
import type { TripRole } from "@/lib/auth/roles";
import type { TripGraph } from "@/lib/engine/types";
import { demoGraph } from "@/lib/fixtures/demo";
import type { AwarenessView } from "@/lib/realtime/protocol";
import type { WorkspaceSearch } from "@/lib/workspace/search";
import { renderWithWorkspace } from "@/test/render-workspace";
import { LivePresence } from "./LivePresence";

const sent = vi.hoisted(() => ({ view: null as AwarenessView | null }));
vi.mock("@/lib/realtime/presence", () => ({
	useMyAwarenessSync: (view: AwarenessView | null) => {
		sent.view = view;
	},
}));

// The demo trip runs Sun 3 – Thu 7 Oct 2027.
const DURING = "2027-10-05T11:00";

function pathOf(role: TripRole, search: WorkspaceSearch) {
	const graph: TripGraph = { ...demoGraph, me: { ...demoGraph.me, role } };
	const { unmount } = renderWithWorkspace(<LivePresence />, { graph, search });
	unmount();
	const url = new URL(sent.view?.path ?? "", "https://yonder.test");
	return { tab: sent.view?.tab, param: url.searchParams.get("tab") };
}

describe("the published path names the tab a bare link opens by role", () => {
	it("during the trip: Today for the owner, the Overview for a follower", () => {
		expect(pathOf("owner", { asOf: DURING })).toEqual({
			tab: "today",
			param: "today",
		});
		expect(pathOf("viewer", { asOf: DURING })).toEqual({
			tab: "overview",
			param: "overview",
		});
		// A named tab stays as it is.
		expect(pathOf("owner", { asOf: DURING, tab: "overview" })).toEqual({
			tab: "overview",
			param: "overview",
		});
	});

	it("outside the trip the bare link is the Overview for everyone", () => {
		expect(pathOf("viewer", { asOf: "2027-09-30" })).toEqual({
			tab: "overview",
			param: null,
		});
	});
});
