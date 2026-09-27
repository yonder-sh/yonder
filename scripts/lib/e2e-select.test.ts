import { describe, expect, it } from "vitest";
import {
	affectedByTestIds,
	affectedSpecs,
	featureOf,
	parseTestIds,
	SMOKE,
	selectionArgs,
	smokeArgs,
} from "./e2e-select";

describe("e2e selection", () => {
	it("pins each smoke entry to its project and file", () => {
		const args = smokeArgs([
			{ spec: "money-tab.spec.ts" },
			{ spec: "places-flow.spec.ts", grep: "the step bar|a (b)" },
			{ spec: "money-tab.spec.ts", grep: "mobile: fast entry", phone: true },
		]);
		expect(args.slice(0, 2)).toEqual([
			"tests/app/money-tab.spec.ts",
			"tests/app/places-flow.spec.ts",
		]);
		expect(args[2]).toBe("--grep");
		const re = new RegExp(args[3] as string);
		expect(re.test("chromium money-tab.spec.ts desktop anything")).toBe(true);
		expect(re.test("mobile money-tab.spec.ts desktop anything")).toBe(false);
		expect(
			re.test("chromium places-flow.spec.ts desktop the step bar: 1 Rate"),
		).toBe(true);
		expect(re.test("chromium places-flow.spec.ts desktop other")).toBe(false);
		expect(
			re.test("mobile money-tab.spec.ts mobile: fast entry in the drawer"),
		).toBe(true);
	});

	it("keeps the smoke set's greps valid regexes", () => {
		expect(() => new RegExp(smokeArgs(SMOKE).at(-1) as string)).not.toThrow();
	});

	it("maps a change to the specs importing that feature, and changed specs", () => {
		expect(featureOf("src/features/places/tab/RateFeed.tsx")).toBe("places");
		expect(featureOf("src/lib/utils.ts")).toBeNull();
		const specs = {
			"places-flow.spec.ts":
				'import { T } from "../../../src/features/places/tab/testids";',
			"money-tab.spec.ts":
				'import { M } from "../../../src/features/money/testids";',
			"landing.spec.ts": 'import { test } from "@playwright/test";',
		};
		expect(
			affectedSpecs(
				[
					"src/features/places/tab/RateFeed.tsx",
					"src/lib/utils.ts",
					"e2e/tests/app/landing.spec.ts",
				],
				specs,
			),
		).toEqual(["landing.spec.ts", "places-flow.spec.ts"]);
	});

	it("widens the smoke set to every test in the touched specs", () => {
		const args = selectionArgs(
			["plan-colour.spec.ts"],
			[{ spec: "landing.spec.ts" }],
		);
		expect(args.slice(0, 2)).toEqual([
			"tests/app/landing.spec.ts",
			"tests/app/plan-colour.spec.ts",
		]);
		const re = new RegExp(args.at(-1) as string);
		expect(re.test("mobile plan-colour.spec.ts phone anything")).toBe(true);
		expect(re.test("chromium landing.spec.ts x")).toBe(true);
		expect(re.test("chromium plan-timeline.spec.ts x")).toBe(false);
	});

	it("maps a changed component to the specs using the test ids it renders", () => {
		const ids = parseTestIds(
			'export const SHELL_TESTID = {\n\tdetailsSection: "details-section",\n\tinbox: "inbox",\n};\n',
		);
		expect(ids.get("SHELL_TESTID.detailsSection")).toBe("details-section");
		const files = {
			"src/features/shell/InspectorBody.tsx":
				'import { SHELL_TESTID } from "./testids";\n<div data-testid={SHELL_TESTID.detailsSection} />',
			"src/features/lists/model.ts": "export const x = 1;",
		};
		const specs = {
			"a.spec.ts":
				'import { SHELL_TESTID as S } from "../../../src/features/shell/testids";\nS.detailsSection',
			"b.spec.ts": "page.locator('[data-testid=\"details-section\"]')",
			"c.spec.ts": 'page.getByTestId("inbox")',
			"d.spec.ts": 'import { L } from "../../../src/features/lists/testids";',
		};
		expect(affectedByTestIds(files, specs, ids)).toEqual([
			"a.spec.ts",
			"b.spec.ts",
			"d.spec.ts",
		]);
	});
});
