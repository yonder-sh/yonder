/**
 * The trip route's error views (F's `src/routes/t/$trip.tsx`, QA PWA-08 /
 * LINK-04 / PWA-05): a visit that ends in "no access" drops the page shell
 * the service worker kept for that slug, even when the saved copy is already
 * gone; offline, a trip this device doesn't keep says "Not available
 * offline" (what offline.html says), not "We couldn't open this trip."
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRAND } from "@/lib/brand";

vi.mock("@/features/shell/Workspace", () => ({ Workspace: () => null }));
vi.mock("@tanstack/react-router", async (orig) => ({
	...(await orig<typeof import("@tanstack/react-router")>()),
	Link: ({
		to,
		className,
		children,
	}: {
		to: string;
		className?: string;
		children: ReactNode;
	}) => (
		<a href={to} className={className}>
			{children}
		</a>
	),
}));

const { Route } = await import("@/routes/t/$trip");
const TripNotFound = Route.options.notFoundComponent as ComponentType<{
	data?: unknown;
}>;
const TripError = Route.options.errorComponent as ComponentType<{
	error: unknown;
}>;

const save = (list: object[]) =>
	localStorage.setItem(BRAND.storage.savedTrips, JSON.stringify(list));

let pages: Set<string>;
function stubCaches(initial: string[]) {
	pages = new Set(initial);
	vi.stubGlobal("caches", {
		open: vi.fn(async () => ({
			delete: vi.fn(async (u: string) => pages.delete(u.split("?")[0] ?? u)),
		})),
		delete: vi.fn(async () => true),
	});
}

function view(ui: ReactNode) {
	const qc = new QueryClient();
	return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const at = (path: string) => window.history.replaceState(null, "", path);

beforeEach(() => at("/t/asia"));
afterEach(() => {
	localStorage.clear();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	at("/");
});

describe("trip route: no access (PWA-08, LINK-04)", () => {
	it("drops the worker's shell for the slug even when saved-trips no longer lists it", async () => {
		const o = window.location.origin;
		stubCaches([`${o}/`, `${o}/share`, `${o}/t/asia`]);
		view(<TripNotFound />);
		expect(
			screen.getByText("This trip doesn't exist or you don't have access."),
		).toBeInTheDocument();
		await waitFor(() => expect(pages.has(`${o}/t/asia`)).toBe(false));
		expect([...pages]).toEqual([`${o}/`, `${o}/share`]);
	});

	it("drops the saved copy too when it is still listed", async () => {
		const o = window.location.origin;
		save([{ slug: "asia", tripId: "t1", name: "Asia", savedAt: 1 }]);
		stubCaches([`${o}/t/asia`]);
		view(<TripError error={new Error("FORBIDDEN: not a member")} />);
		await waitFor(() => expect(pages.size).toBe(0));
		expect(localStorage.getItem(BRAND.storage.savedTrips)).toBe("[]");
	});
});

describe("trip route: offline (PWA-05, PWA-08)", () => {
	it("a trip this device doesn't keep says Not available offline", () => {
		stubCaches([]);
		vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
		view(<TripError error={new TypeError("Failed to fetch")} />);
		expect(
			screen.getByText(
				"Not available offline. Open this trip once while you're online to keep a copy.",
			),
		).toBeInTheDocument();
		expect(screen.queryByText("We couldn't open this trip.")).toBeNull();
		expect(
			screen.getByRole("link", { name: "Go to your trips" }),
		).toHaveAttribute("href", "/dashboard");
	});

	it("offers the trip that is kept", () => {
		stubCaches([]);
		save([
			{ slug: "phu-quoc", tripId: "t2", name: "Phu Quoc detour", savedAt: 1 },
		]);
		view(<TripError error={new TypeError("Failed to fetch")} />);
		expect(
			screen.getByRole("link", { name: "Open Phu Quoc detour" }),
		).toHaveAttribute("href", "/t/phu-quoc?from=offline");
	});

	it("the saved trip failing, or a server error online, stays 'We couldn't open this trip.'", () => {
		stubCaches([]);
		save([{ slug: "asia", tripId: "t1", name: "Asia", savedAt: 1 }]);
		const { unmount } = view(
			<TripError error={new TypeError("Failed to fetch")} />,
		);
		expect(screen.getByText("We couldn't open this trip.")).toBeInTheDocument();
		unmount();
		localStorage.clear();
		view(<TripError error={new Error("Internal Server Error")} />);
		expect(screen.getByText("We couldn't open this trip.")).toBeInTheDocument();
	});
});
