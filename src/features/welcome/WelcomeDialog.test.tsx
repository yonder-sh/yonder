/**
 * The welcome dialog: the trip, who invited you and their note, where things
 * stand and one button by what you can do; "Look around" (and Escape)
 * close it for good; viewers can copy a request for edit access; guests
 * without an account name themselves first.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, demoGraph } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { WELCOME_TESTID as T } from "./testids";
import { WelcomeDialog } from "./WelcomeDialog";
import type { WelcomeInfo } from "./welcome.functions";
import { useWelcome } from "./welcome-store";

const calls = { seen: 0, rename: [] as string[] };
let session: { isAnonymous: boolean; name: string } | null = null;

vi.mock("./welcome.functions", () => ({
	getWelcome: async () => null,
	markWelcomeSeen: async () => {
		calls.seen += 1;
		return { ok: true };
	},
}));
vi.mock("@/lib/auth/share.functions", () => ({
	renameGuest: async (o: { data: { name: string } }) => {
		calls.rename.push(o.data.name);
		return { name: o.data.name };
	},
}));
vi.mock("@/lib/auth/session.functions", () => ({
	getSessionFn: async () => session,
}));
vi.mock("@/functions/push.functions", () => ({
	getPushSettings: async () => ({ publicKey: null }),
	savePushSubscription: async () => ({}),
	deletePushSubscription: async () => ({}),
}));
vi.mock("@tanstack/react-router", async (orig) => ({
	...(await orig<typeof import("@tanstack/react-router")>()),
	Link: ({ children, ...p }: { children: ReactNode }) => (
		<a href="/login" {...(p as object)}>
			{children}
		</a>
	),
	useLocation: () => ({ pathname: "/t/demo", searchStr: "" }),
}));

const invite: WelcomeInfo = {
	show: true,
	via: "invite",
	invitedBy: "Maya",
	inviterUserId: "user-maya",
	note: { text: "Rate the Kyoto places before Sunday!", by: "Maya" },
};

/** Maya invited Dennis (an editor) to Olga's trip. */
const asEditor: TripGraph = {
	...demoGraph,
	me: { ...demoGraph.me, role: "editor" },
	members: [
		...demoGraph.members.map((m) =>
			m.id === DEMO_MEMBERS.dennis ? { ...m, role: "editor" as const } : m,
		),
		{
			id: "00000000-0000-7000-8000-0000000000b1",
			userId: "user-olga",
			status: "active",
			role: "owner",
			name: "Olga Owner",
			firstName: "Olga",
			color: 3,
		},
		{
			id: "00000000-0000-7000-8000-0000000000b2",
			userId: "user-maya",
			status: "active",
			role: "editor",
			name: "Maya Chen",
			firstName: "Maya",
			color: 4,
		},
	],
};

beforeEach(() => {
	calls.seen = 0;
	calls.rename = [];
	session = { isAnonymous: false, name: "Dennis" };
	useWelcome.setState({ open: true, status: "open" });
});

describe("the welcome", () => {
	it("who, what, where things stand and Rate N places; Look around closes it", async () => {
		const user = userEvent.setup();
		renderWithWorkspace(<WelcomeDialog info={invite} />, {
			graph: asEditor,
			mode: "live",
		});
		const dialog = await screen.findByTestId(T.dialog);
		expect(dialog).toHaveAttribute("role", "dialog");
		expect(
			screen.getByRole("heading", { name: demoGraph.trip.name }),
		).toBeTruthy();
		expect(screen.getByTestId(T.note)).toHaveTextContent(
			"“Rate the Kyoto places before Sunday!”— Maya",
		);
		expect(screen.getByTestId(T.who)).toHaveTextContent(
			"Maya invited you · with Audrey and Olga",
		);
		expect(screen.getByTestId("standing")).toBeTruthy();
		const primary = screen.getByTestId(T.primary);
		expect(primary).toHaveAttribute("data-kind", "rate");
		expect(primary).toHaveTextContent(/^Rate \d+ places$/);
		// Focus starts on the button.
		expect(document.activeElement).toBe(primary);
		expect(screen.queryByTestId(T.askAccess)).toBeNull();
		await user.click(screen.getByTestId(T.lookAround));
		expect(useWelcome.getState()).toMatchObject({
			open: false,
			status: "done",
		});
		await waitFor(() => expect(calls.seen).toBe(1));
	});

	it("Escape is Look around", async () => {
		renderWithWorkspace(<WelcomeDialog info={invite} />, {
			graph: asEditor,
			mode: "live",
		});
		const dialog = await screen.findByTestId(T.dialog);
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(useWelcome.getState().open).toBe(false);
		await waitFor(() => expect(calls.seen).toBe(1));
	});

	it("a viewer: See the plan, and a message to ask for edit access", async () => {
		const user = userEvent.setup();
		const viewer: TripGraph = {
			...asEditor,
			me: { ...asEditor.me, role: "viewer" },
			members: asEditor.members.map((m) =>
				m.id === DEMO_MEMBERS.dennis ? { ...m, role: "viewer" as const } : m,
			),
		};
		const r = renderWithWorkspace(<WelcomeDialog info={invite} />, {
			graph: viewer,
			mode: "live",
		});
		expect(await screen.findByTestId(T.primary)).toHaveTextContent(
			"See the plan",
		);
		await user.click(screen.getByTestId(T.askAccess));
		expect(screen.getByTestId(T.askAccess)).toHaveTextContent(
			"Ask Olga for edit access",
		);
		expect(
			(screen.getByTestId(T.askText) as HTMLTextAreaElement).value,
		).toMatch(
			new RegExp(
				`^Hi Olga, could you give me edit access to ${demoGraph.trip.name}\\? .+/t/${demoGraph.trip.slug}$`,
			),
		);
		await user.click(screen.getByTestId(T.primary));
		expect(r.ws().tab).toBe("plan");
		expect(useWelcome.getState().open).toBe(false);
	});

	it("a guest without an account names themselves first", async () => {
		const user = userEvent.setup();
		session = { isAnonymous: true, name: "Guest Heron" };
		const guest: TripGraph = {
			...asEditor,
			me: {
				...asEditor.me,
				memberId: null,
				isGuest: true,
				role: "viewer",
				name: "Guest Heron",
			},
			members: asEditor.members.filter((m) => m.id !== DEMO_MEMBERS.dennis),
		};
		renderWithWorkspace(
			<WelcomeDialog
				info={{ ...invite, via: "link", invitedBy: null, inviterUserId: null }}
			/>,
			{ graph: guest, mode: "live" },
		);
		const step = await screen.findByTestId(T.nameStep);
		expect(step).toHaveTextContent("What should the group call you?");
		expect(screen.getByTestId(T.signIn)).toHaveTextContent("Sign in");
		expect(step).toHaveTextContent(
			"Sign in to keep this trip on your other devices.",
		);
		await user.type(screen.getByTestId(T.nameInput), "Sam");
		await user.click(screen.getByTestId(T.nameContinue));
		await waitFor(() => expect(calls.rename).toEqual(["Sam"]));
		expect(await screen.findByTestId(T.who)).toHaveTextContent(
			"You're joining through the trip link",
		);
		expect(screen.getByTestId(T.primary)).toHaveTextContent("See the plan");
	});
});
