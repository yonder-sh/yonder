import parkinsansLatin from "@fontsource-variable/parkinsans/files/parkinsans-latin-wght-normal.woff2?url";
import { createFileRoute } from "@tanstack/react-router";
import { LandingPage } from "@/features/landing/LandingPage";
import { LANDING_META } from "@/features/landing/meta";
import { siteOrigin } from "@/features/landing/site-origin";
import { landingViewer } from "@/lib/auth/guards";

/**
 * `/` — the public landing page, for everyone: signed in, its links lead to
 * the dashboard instead of sign-in (only an installed app's `?source=pwa`
 * start forwards there). Indexable, unlike the app's trip pages; the
 * canonical and Open Graph URLs are absolute, from this deployment's APP_URL.
 */
export const Route = createFileRoute("/")({
	beforeLoad: ({ location }) => landingViewer(location.searchStr),
	loader: () => ({ origin: siteOrigin() }),
	head: ({ loaderData }) => {
		const origin = loaderData?.origin ?? "";
		const url = `${origin}/`;
		const image = `${origin}/og.png`;
		const m = LANDING_META;
		return {
			meta: [
				{ title: m.title },
				{ name: "description", content: m.description },
				{ name: "robots", content: "index, follow" },
				// The hero is dark in both themes: so is the browser's bar.
				{ name: "theme-color", content: "#040507" },
				{ property: "og:type", content: "website" },
				{ property: "og:site_name", content: "Yonder" },
				{ property: "og:title", content: m.ogTitle },
				{ property: "og:description", content: m.description },
				{ property: "og:url", content: url },
				{ property: "og:image", content: image },
				{ property: "og:image:type", content: "image/png" },
				{ property: "og:image:width", content: "1200" },
				{ property: "og:image:height", content: "630" },
				{ property: "og:image:alt", content: m.ogImageAlt },
				{ property: "og:locale", content: "en" },
				{ name: "twitter:card", content: "summary_large_image" },
				{ name: "twitter:title", content: m.ogTitle },
				{ name: "twitter:description", content: m.description },
				{ name: "twitter:image", content: image },
				{ name: "twitter:image:alt", content: m.ogImageAlt },
				{
					"script:ld+json": {
						"@context": "https://schema.org",
						"@type": "WebApplication",
						name: "Yonder",
						url,
						description: m.description,
						applicationCategory: "TravelApplication",
						operatingSystem: "Any (web browser)",
						offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
					},
				},
			],
			links: [
				...(origin ? [{ rel: "canonical", href: url }] : []),
				// The headline's face: fetched with the stylesheet, not after it.
				{
					rel: "preload",
					href: parkinsansLatin,
					as: "font",
					type: "font/woff2",
					crossOrigin: "anonymous",
				},
			],
		};
	},
	component: Landing,
});

function Landing() {
	const { signedIn } = Route.useRouteContext();
	return <LandingPage signedIn={signedIn} />;
}
