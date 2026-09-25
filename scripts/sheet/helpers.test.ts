/** The importer's small pure helpers: cell Markdown, links, money text, ET times, windows, flags. */
import { describe, expect, it } from "vitest";
import { markdownToYdoc } from "@/lib/notes/ydoc.server";
import { ArgsError, DEFAULTS, describeArgs, parseImportArgs } from "./lib/args";
import {
	absoluteDue,
	actionDueKind,
	actionTarget,
	attractionName,
	minusMonthsIso,
	parseEtTime,
	resolveWindow,
} from "./lib/due";
import {
	cellMarkdown,
	escapeInline,
	hrsToMin,
	linkTitle,
	saysBooked,
	yenAmount,
} from "./lib/text";

describe("cellMarkdown", () => {
	it("turns each linked anchor run into a Markdown link, in order", () => {
		const md = cellMarkdown(
			"Shinjuku, Kappabashi Street for knives/chopsticks",
			[
				{
					text: "Kappabashi Street",
					url: "https://www.japan-guide.com/e/e3020.html",
				},
				{ text: "knives", url: "https://tokyocheapo.com/x_(y)" },
			],
		);
		expect(md).toBe(
			"Shinjuku, [Kappabashi Street](https://www.japan-guide.com/e/e3020.html) for [knives](https://tokyocheapo.com/x_%28y%29)/chopsticks",
		);
	});

	it("keeps sheet text literal: ~ is not strikethrough, * is not emphasis", () => {
		const md = cellMarkdown("Fitting ~1 h, ~¥30k; *reserve*");
		const { plainText } = markdownToYdoc(md);
		expect(plainText).toContain("Fitting ~1 h, ~¥30k; *reserve*");
	});

	it("turns sheet bullets into a list and ignores non-http links", () => {
		expect(cellMarkdown("• one\n• two")).toBe("- one\n- two");
		expect(cellMarkdown("x", [{ text: "x", url: "javascript:alert(1)" }])).toBe(
			"x",
		);
	});

	it("escapes the inline Markdown set", () => {
		expect(escapeInline("a_b*c~d[e]")).toBe("a\\_b\\*c\\~d\\[e\\]");
	});
});

describe("links, money and hours", () => {
	it("labels generic anchors with the site and the subject (SEED-07)", () => {
		expect(
			linkTitle(
				"Link ↗",
				"https://www.japan-guide.com/e/e3020.html",
				"Kappabashi Street",
			),
		).toBe("japan-guide.com: Kappabashi Street");
		expect(
			linkTitle(
				"Tokyo Weekender: vintage watches ↗",
				"https://x.test/",
				"Watch",
			),
		).toBe("Tokyo Weekender: vintage watches");
	});
	it("reads yen amounts and hours", () => {
		expect(yenAmount("~¥30,000")).toBe(30000);
		expect(yenAmount("from ~¥6,600")).toBe(6600);
		expect(yenAmount("~$20")).toBeNull();
		expect(hrsToMin(1.25)).toBe(75);
		expect(hrsToMin(9.75)).toBe(585);
		expect(hrsToMin(null)).toBeNull();
	});
	it("treats booked/confirmed/ref as booked, never reserve or 'not booked' (E2, D4)", () => {
		expect(saysBooked("Booked, ref: ABC123")).toBe(true);
		expect(saysBooked("ticket # 42")).toBe(true);
		expect(saysBooked("Earliest tour 9:30–11:40 (reserve)")).toBe(false);
		expect(saysBooked("Not booked ahead, but order on day 1")).toBe(false);
		expect(saysBooked("Confirm dinner time when booking")).toBe(false);
	});
});

describe("Action Timeline", () => {
	it("parses the ET time column", () => {
		expect(parseEtTime("8:00 PM")).toEqual({ time: "20:00", dayOffset: 0 });
		expect(parseEtTime("End of day")).toEqual({ time: "23:59", dayOffset: 0 });
		expect(parseEtTime("9:00 PM (eve before)")).toEqual({
			time: "21:00",
			dayOffset: -1,
		});
		expect(parseEtTime("12:30 AM")).toEqual({ time: "00:30", dayOffset: 0 });
		expect(parseEtTime("soon")).toBeNull();
		expect(absoluteDue("2026-10-11", "9:00 PM (eve before)")).toEqual({
			dueDate: "2026-10-10",
			dueTime: "21:00",
			dueTz: "America/New_York",
		});
		expect(absoluteDue("TBD", "8:00 PM")).toEqual({
			dueDate: null,
			dueTime: null,
			dueTz: null,
		});
	});

	it("resolves relative windows like WP-Lists' effectiveDue", () => {
		expect(minusMonthsIso("2027-10-07", 1)).toBe("2027-09-07");
		expect(minusMonthsIso("2027-03-31", 1)).toBe("2027-02-28");
		expect(minusMonthsIso("2027-01-15", 2, 10)).toBe("2026-11-10");
		expect(
			resolveWindow(
				{ kind: "days", days: 355, time: "09:00", tz: "Asia/Tokyo" },
				"2027-10-02",
			),
		).toEqual({
			dueDate: "2026-10-12",
			dueTime: "09:00",
			dueTz: "Asia/Tokyo",
		});
	});

	it("maps rows to targets and kinds (SPEC §17.3 step 8)", () => {
		expect(attractionName("Universal Studios Japan + Express Pass")).toBe(
			"Universal Studios Japan",
		);
		expect(attractionName("Shibuya Sky (sunset slot)")).toBe("Shibuya Sky");
		expect(attractionName("JAL Sky Museum tour")).toBe("JAL Sky Museum");
		expect(actionTarget("Hotels — Korea / Vietnam / Taiwan", "Hotel")).toEqual({
			kind: "root",
		});
		expect(
			actionTarget("Fuji Excursion train (Shinjuku → Kawaguchiko)", "Train"),
		).toEqual({
			kind: "leg",
			key: "fujiExcursion",
		});
		expect(actionTarget("Something new", "Other")).toEqual({ kind: "root" });
		expect(actionDueKind("Points", "DEADLINE, not an opening")).toBe("due");
		expect(actionDueKind("Other", null)).toBe("on");
		expect(actionDueKind("Attraction", null)).toBe("opens");
	});
});

describe("flags", () => {
	it("defaults to the ADDENDUM §8 owner and dates", () => {
		expect(parseImportArgs([])).toEqual(DEFAULTS);
		expect(DEFAULTS).toMatchObject({
			owner: "dennis@dennispham.me",
			ownerFirst: "Dennis",
			start: "2027-10-02",
			day1: "2027-10-03",
			end: "2027-11-07",
		});
	});
	it("parses the SPEC flags and --dump-graph with or without a file", () => {
		const a = parseImportArgs([
			"--",
			"--owner",
			"X@Example.com",
			"--replace",
			"--no-media",
			"--dump-graph",
		]);
		expect(a).toMatchObject({
			owner: "x@example.com",
			replace: true,
			media: false,
			dumpGraph: "seed/import/asia-2027.graph.json",
		});
		expect(parseImportArgs(["--dump-graph", "/tmp/g.json"]).dumpGraph).toBe(
			"/tmp/g.json",
		);
		expect(describeArgs(a)).toEqual(
			expect.arrayContaining([
				"--replace",
				"--no-media",
				"--owner x@example.com",
			]),
		);
	});
	it("refuses bad input", () => {
		expect(() => parseImportArgs(["--owner", "nope"])).toThrow(ArgsError);
		expect(() =>
			parseImportArgs(["--start", "2027-10-05", "--day1", "2027-10-03"]),
		).toThrow(/start ≤ day1/);
		expect(() => parseImportArgs(["--slug", "rate"])).toThrow(ArgsError);
		expect(() => parseImportArgs(["--frobnicate"])).toThrow(/unknown flag/);
	});
});
