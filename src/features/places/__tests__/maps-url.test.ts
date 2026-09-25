import { describe, expect, it } from "vitest";
import { isGoogleMapsHost, parseMapsUrl } from "../lib/maps-url";
import { expandShortLink } from "../lib/short-link";

describe("parseMapsUrl (E8)", () => {
	it("reads query_place_id and place_id:", () => {
		expect(
			parseMapsUrl(
				"https://www.google.com/maps/search/?api=1&query=Itoya&query_place_id=ChIJ8T1GpMGOGGARDYGSgpooDWw",
			),
		).toEqual({
			kind: "place",
			placeId: "ChIJ8T1GpMGOGGARDYGSgpooDWw",
			query: "Itoya",
		});
		expect(
			parseMapsUrl(
				"https://www.google.com/maps/place/?q=place_id:ChIJ8T1GpMGOGGARDYGSgpooDWw",
			),
		).toEqual({ kind: "place", placeId: "ChIJ8T1GpMGOGGARDYGSgpooDWw" });
	});
	it("reads /maps/place/<name>/@lat,lng and prefers the !3d!4d pin", () => {
		expect(
			parseMapsUrl(
				"https://www.google.com/maps/place/Itoya/@35.6728,139.7654,17z/data=!3m1!4b1!4m6!3m5!1s0x60188be5c5a4c8d3:0x1!8m2!3d35.6729335!4d139.7678324",
			),
		).toEqual({
			kind: "place",
			name: "Itoya",
			lat: 35.6729335,
			lng: 139.7678324,
		});
		expect(
			parseMapsUrl(
				"https://www.google.co.jp/maps/place/Senso-ji/@35.7148,139.7967,15z",
			),
		).toEqual({ kind: "place", name: "Senso-ji", lat: 35.7148, lng: 139.7967 });
	});
	it("decodes names with + and percent escapes", () => {
		expect(
			parseMapsUrl(
				"https://www.google.com/maps/place/Kiyomizu-dera+Temple/@34.99,135.78,17z",
			)?.kind === "place" &&
				(
					parseMapsUrl(
						"https://www.google.com/maps/place/Kiyomizu-dera+Temple/@34.99,135.78,17z",
					) as { name?: string }
				).name,
		).toBe("Kiyomizu-dera Temple");
		expect(
			(
				parseMapsUrl(
					"https://www.google.com/maps/place/%E6%B8%85%E6%B0%B4%E5%AF%BA/",
				) as {
					name?: string;
				}
			).name,
		).toBe("清水寺");
	});
	it("reads ?q=lat,lng and ?q=<text>", () => {
		expect(parseMapsUrl("https://maps.google.com/?q=35.6586,139.7454")).toEqual(
			{
				kind: "place",
				lat: 35.6586,
				lng: 139.7454,
			},
		);
		expect(parseMapsUrl("https://maps.google.com/maps?q=Tokyo+Tower")).toEqual({
			kind: "place",
			query: "Tokyo Tower",
		});
	});
	it("flags short links to be followed", () => {
		expect(parseMapsUrl("https://maps.app.goo.gl/AbCdEf123")).toEqual({
			kind: "short",
			url: "https://maps.app.goo.gl/AbCdEf123",
		});
		expect(parseMapsUrl("https://goo.gl/maps/xyz")?.kind).toBe("short");
	});
	it("rejects anything that isn't Google Maps", () => {
		expect(parseMapsUrl("https://evil.example/maps/place/X/@1,2")).toBeNull();
		expect(parseMapsUrl("https://www.google.com/search?q=itoya")).toBeNull();
		expect(parseMapsUrl("https://goo.gl/xyz")).toBeNull();
		expect(parseMapsUrl("javascript:alert(1)")).toBeNull();
		expect(parseMapsUrl("not a url")).toBeNull();
		expect(
			parseMapsUrl("https://www.google.com.evil.io/maps/place/x"),
		).toBeNull();
	});
	it("drops out-of-range coordinates", () => {
		expect(parseMapsUrl("https://maps.google.com/?q=135.1,39.2")).toBeNull();
	});
	it("knows the allowed hosts", () => {
		expect(isGoogleMapsHost("maps.app.goo.gl")).toBe(true);
		expect(isGoogleMapsHost("www.google.com", "/maps/place/x")).toBe(true);
		expect(isGoogleMapsHost("www.google.com", "/search")).toBe(false);
		expect(isGoogleMapsHost("maps.google.co.uk")).toBe(true);
		expect(isGoogleMapsHost("google.evil.com", "/maps")).toBe(false);
	});
});

describe("expandShortLink", () => {
	const redirect = (to: string, status = 302) =>
		new Response(null, { status, headers: { location: to } });

	it("follows Location through Google hosts to a place URL", async () => {
		const hops = [
			redirect("https://www.google.com/maps?q=Itoya&ftid=0x1"),
			redirect(
				"https://www.google.com/maps/place/Itoya/@35.67,139.76,17z/data=!3d35.6729335!4d139.7678324",
			),
		];
		const seen: string[] = [];
		const fake = (async (url: string) => {
			seen.push(url);
			return hops.shift() ?? new Response(null, { status: 404 });
		}) as unknown as typeof fetch;
		// The first hop already names a place (?q=Itoya), so it stops there.
		await expect(
			expandShortLink("https://maps.app.goo.gl/AbC", fake),
		).resolves.toBe("https://www.google.com/maps?q=Itoya&ftid=0x1");
		expect(seen).toEqual(["https://maps.app.goo.gl/AbC"]);
	});
	it("refuses a redirect to another host", async () => {
		const fake = (async () =>
			redirect(
				"http://169.254.169.254/latest/meta-data",
			)) as unknown as typeof fetch;
		await expect(
			expandShortLink("https://maps.app.goo.gl/AbC", fake),
		).resolves.toBeNull();
	});
	it("gives up after three hops", async () => {
		let n = 0;
		const fake = (async () => {
			n += 1;
			return redirect(`https://maps.app.goo.gl/hop${n}`);
		}) as unknown as typeof fetch;
		await expect(
			expandShortLink("https://maps.app.goo.gl/start", fake),
		).resolves.toBeNull();
		expect(n).toBe(3);
	});
	it("returns null when there's no redirect", async () => {
		const fake = (async () =>
			new Response("<html>", { status: 200 })) as unknown as typeof fetch;
		await expect(
			expandShortLink("https://maps.app.goo.gl/x", fake),
		).resolves.toBeNull();
	});
});
