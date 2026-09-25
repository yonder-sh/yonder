import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { getDisplayPrefs, setDisplayPrefs } from "@/lib/format";
import {
	PREFS_STORAGE_KEY,
	resetPrefsCacheForTests,
	useViewPrefs,
} from "./view-prefs";

function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider client={new QueryClient()}>
			{children}
		</QueryClientProvider>
	);
}

describe("display prefs follow the view settings", () => {
	afterEach(() => {
		localStorage.clear();
		resetPrefsCacheForTests();
		setDisplayPrefs({ clock: "24h", units: "km" });
	});

	it("applies the cached clock and units, and later changes", () => {
		localStorage.setItem(
			PREFS_STORAGE_KEY,
			JSON.stringify({ clock: "12h", units: "mi", bogus: 1 }),
		);
		resetPrefsCacheForTests();
		const { result } = renderHook(() => useViewPrefs({ enabled: false }), {
			wrapper,
		});
		expect(result.current.prefs.clock).toBe("12h");
		expect(getDisplayPrefs()).toEqual({ clock: "12h", units: "mi" });
		act(() => result.current.setPrefs({ clock: "24h" }));
		expect(result.current.prefs.clock).toBe("24h");
		expect(getDisplayPrefs()).toEqual({ clock: "24h", units: "mi" });
	});
});
