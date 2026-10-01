/**
 * Account → Save from other apps: this device's way first; on iPhone the
 * server's Shortcut (Add the Shortcut, the connected phones) when it offers
 * one, else the Shortcut's address (`/share?url=` + the encoded link).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const setup = vi.hoisted(() => ({
	value: {
		icloudUrl: null as string | null,
		devices: [] as {
			id: string;
			label: string;
			createdAt: string;
			lastUsedAt: string | null;
		}[],
	},
}));
vi.mock("@/functions/shortcut.functions", () => ({
	getShortcutSetup: async () => setup.value,
	removeShortcutDevice: async () => ({ ok: true }),
	startShortcutPairing: async () => ({ code: "yonder-pair_x", expiresAt: 0 }),
}));

import { SaveFromAppsDialog, thisDevice } from "../SaveFromAppsDialog";
import { HOME_TESTID } from "../testids";

const renderDialog = () =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<SaveFromAppsDialog open onOpenChange={() => {}} />
		</QueryClientProvider>,
	);

afterEach(() => vi.restoreAllMocks());

const ua = (s: string, touch = 0) => {
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue(s);
	vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(touch);
};

describe("Save from other apps", () => {
	it("knows iPhone, iPad (which says Mac), Android and computers", () => {
		ua("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
		expect(thisDevice()).toBe("iphone");
		ua("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5);
		expect(thisDevice()).toBe("iphone");
		ua("Mozilla/5.0 (Linux; Android 14; Pixel 8)");
		expect(thisDevice()).toBe("android");
		ua("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
		expect(thisDevice()).toBe("computer");
	});

	it("on an iPhone, opens only the iPhone section, with the Shortcut's address", () => {
		ua("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
		setup.value = { icloudUrl: null, devices: [] };
		renderDialog();
		const dialog = screen.getByTestId(HOME_TESTID.saveFromAppsDialog);
		const sections = within(dialog).getAllByRole("button", { expanded: true });
		expect(sections).toHaveLength(1);
		expect(sections[0]).toHaveTextContent("iPhone and iPad");
		expect(sections[0]).toHaveTextContent("This device");
		expect(
			within(dialog).getAllByRole("button", { expanded: false }),
		).toHaveLength(2);
		expect(
			screen.getByTestId(HOME_TESTID.saveFromAppsAddress),
		).toHaveTextContent(`${window.location.origin}/share?url=`);
	});

	it("offers the server's Shortcut and lists the connected phones", async () => {
		ua("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
		setup.value = {
			icloudUrl: "https://www.icloud.com/shortcuts/abc",
			devices: [
				{
					id: "k1",
					label: "Dennis's iPhone",
					createdAt: new Date().toISOString(),
					lastUsedAt: null,
				},
			],
		};
		renderDialog();
		expect(
			await screen.findByTestId(HOME_TESTID.shortcutAdd),
		).toHaveTextContent("Add the Shortcut");
		expect(screen.getByTestId(HOME_TESTID.shortcutDevices)).toHaveTextContent(
			"Dennis's iPhone · not used yet",
		);
		expect(screen.getByTestId(HOME_TESTID.shortcutReconnect)).toBeVisible();
		expect(screen.queryByTestId(HOME_TESTID.saveFromAppsAddress)).toBeNull();
	});
});
