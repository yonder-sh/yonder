import * as React from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "yonder-theme";

type ThemeContextValue = {
	theme: Theme;
	resolvedTheme: ResolvedTheme;
	setTheme: (theme: Theme) => void;
};

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

/**
 * Inline script rendered in <head> so the correct `.dark` class is on <html>
 * before first paint (no flash of the wrong theme during SSR hydration).
 */
export const themeInitScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
	THEME_STORAGE_KEY,
)})||"system";var d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light";}catch(e){}})();`;

function getSystemTheme(): ResolvedTheme {
	if (typeof window === "undefined") return "light";
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

function readStoredTheme(): Theme {
	if (typeof window === "undefined") return "system";
	try {
		const v = window.localStorage.getItem(THEME_STORAGE_KEY);
		return v === "light" || v === "dark" || v === "system" ? v : "system";
	} catch {
		return "system";
	}
}

function applyTheme(resolved: ResolvedTheme) {
	const root = document.documentElement;
	root.classList.toggle("dark", resolved === "dark");
	root.style.colorScheme = resolved;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
	// Start from "system" on both server and client so hydration matches; the
	// init script has already set the real class on <html>.
	const [theme, setThemeState] = React.useState<Theme>("system");
	const [systemTheme, setSystemTheme] = React.useState<ResolvedTheme>("light");

	React.useEffect(() => {
		setThemeState(readStoredTheme());
		setSystemTheme(getSystemTheme());
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => setSystemTheme(mq.matches ? "dark" : "light");
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);

	const resolvedTheme: ResolvedTheme = theme === "system" ? systemTheme : theme;

	React.useEffect(() => {
		applyTheme(resolvedTheme);
	}, [resolvedTheme]);

	const setTheme = React.useCallback((next: Theme) => {
		setThemeState(next);
		try {
			window.localStorage.setItem(THEME_STORAGE_KEY, next);
		} catch {
			// storage unavailable (private mode etc.) - theme still applies for this session
		}
	}, []);

	const value = React.useMemo(
		() => ({ theme, resolvedTheme, setTheme }),
		[theme, resolvedTheme, setTheme],
	);

	return (
		<ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
	);
}

export function useTheme(): ThemeContextValue {
	const ctx = React.useContext(ThemeContext);
	if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>");
	return ctx;
}
