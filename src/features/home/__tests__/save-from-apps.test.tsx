/**
 * Account → Save from other apps: this device's way first, and on iPhone the
 * Shortcut's address (`/share?url=`, followed by the encoded shared link).
 */
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaveFromAppsDialog, thisDevice } from "../SaveFromAppsDialog";
import { HOME_TESTID } from "../testids";

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

	it("on an iPhone, leads with the Shortcut and its address", () => {
		ua("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
		render(<SaveFromAppsDialog open onOpenChange={() => {}} />);
		const dialog = screen.getByTestId(HOME_TESTID.saveFromAppsDialog);
		const first = within(dialog).getAllByRole("heading", { level: 3 })[0];
		expect(first).toHaveTextContent("iPhone and iPad");
		expect(first).toHaveTextContent("This device");
		expect(
			screen.getByTestId(HOME_TESTID.saveFromAppsAddress),
		).toHaveTextContent(`${window.location.origin}/share?url=`);
	});
});
