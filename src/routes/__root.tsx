import {
	createRootRouteWithContext,
	HeadContent,
	Link,
	Scripts,
} from "@tanstack/react-router";
import { MotionConfig } from "motion/react";
import { type ReactNode, useEffect } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { ReauthDialog } from "@/components/common/reauth-dialog";
import { YonderMark } from "@/components/common/yonder-mark";
import { ThemeProvider, themeInitScript } from "@/components/theme-provider";
import { buttonVariants } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useHomeLifecycle } from "@/features/offline/app-lifecycle";
import { usePushBridge } from "@/features/push/use-push";
import { useIsMobile } from "@/hooks/use-mobile";
import { onSignOut } from "@/lib/auth/sign-out";
import { BRAND } from "@/lib/brand";
import { loadCjkFonts } from "@/lib/fonts";
import { clearPersisted } from "@/lib/query/persister";
import { resetCollabClient } from "@/lib/realtime/collab-client";
import type { RouterContext } from "@/router";
import appCss from "../styles.css?url";

export const Route = createRootRouteWithContext<RouterContext>()({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1, viewport-fit=cover",
			},
			{ title: BRAND.name },
			{ name: "description", content: BRAND.tagline },
			{ name: "application-name", content: BRAND.name },
			{ name: "apple-mobile-web-app-title", content: BRAND.name },
			{
				name: "theme-color",
				content: BRAND.themeColor.light,
				media: "(prefers-color-scheme: light)",
			},
			{
				name: "theme-color",
				content: BRAND.themeColor.dark,
				media: "(prefers-color-scheme: dark)",
			},
		],
		links: [
			{ rel: "stylesheet", href: appCss },
			{ rel: "icon", href: "/favicon.ico", sizes: "48x48" },
			{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
			{ rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
			{ rel: "manifest", href: "/manifest.webmanifest" },
		],
		// Runs before paint so the `.dark` class is correct on first render.
		scripts: [{ children: themeInitScript }],
	}),
	shellComponent: RootDocument,
	notFoundComponent: NotFound,
});

/**
 * Sign-out teardown this layer owns (SECURITY §11): the persisted query
 * cache and the collab socket (a new session must open a fresh one).
 */
function useSignOutTeardown() {
	useEffect(() => {
		const offs = [
			onSignOut(() => clearPersisted()),
			onSignOut(() => resetCollabClient()),
		];
		return () => {
			for (const off of offs) off();
		};
	}, []);
}

function RootDocument({ children }: { children: ReactNode }) {
	useSignOutTeardown();
	// DESIGN §8.8: bottom-right; bottom-centre on `sm` (< 768, above the sheet peek).
	const toastPosition = useIsMobile() ? "bottom-center" : "bottom-right";
	// WP-Home's mount point: service-worker registration + its sign-out purge.
	useHomeLifecycle();
	// Web Push: a notification click navigates this window; sign-out drops the device.
	usePushBridge();
	// The CJK @font-face rules, after first paint (QA VIS2-10 / PERF-05).
	useEffect(() => {
		void loadCjkFonts();
	}, []);
	return (
		// suppressHydrationWarning: themeInitScript mutates class/style on <html> before hydration.
		<html lang="en" suppressHydrationWarning>
			<head>
				<HeadContent />
			</head>
			<body className="min-h-svh">
				<ThemeProvider>
					<MotionConfig reducedMotion="user">
						<TooltipProvider delayDuration={300}>
							{children}
							<ReauthDialog />
							<Toaster richColors closeButton position={toastPosition} />
						</TooltipProvider>
					</MotionConfig>
				</ThemeProvider>
				{/* No TanStack devtools in any build (owner FB-01). */}
				<Scripts />
			</body>
		</html>
	);
}

function NotFound() {
	return (
		<main className="flex min-h-svh flex-col items-center justify-center gap-6 p-8">
			<YonderMark className="size-8 text-primary" />
			<EmptyState
				line="This page doesn't exist."
				action={
					<Link to="/" className={buttonVariants({ variant: "outline" })}>
						Go to your trips
					</Link>
				}
			/>
		</main>
	);
}
