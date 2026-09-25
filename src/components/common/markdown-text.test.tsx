import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownText, safeUrlTransform } from "./markdown-text";

describe("MarkdownText (SPEC §7.10, F1u acceptance)", () => {
	it("renders no raw HTML (no <img onerror>)", () => {
		const { container } = render(
			<MarkdownText md={'Hi <img src=x onerror="alert(1)"> there'} />,
		);
		expect(container.querySelector("img")).toBeNull();
		expect(container.innerHTML).not.toContain("onerror");
	});

	it("drops javascript: and data: links but keeps http(s) and mailto", () => {
		expect(safeUrlTransform("javascript:alert(1)")).toBe("");
		expect(safeUrlTransform(" JavaScript:alert(1)")).toBe("");
		expect(safeUrlTransform("data:text/html,x")).toBe("");
		expect(safeUrlTransform("https://example.com")).toBe("https://example.com");
		expect(safeUrlTransform("mailto:a@b.c")).toBe("mailto:a@b.c");
		const { container } = render(
			<MarkdownText
				md={"[click](javascript:alert(1)) and [ok](https://example.com)"}
			/>,
		);
		const hrefs = [...container.querySelectorAll("a")].map((a) =>
			a.getAttribute("href"),
		);
		expect(hrefs).toEqual(["https://example.com"]);
		expect(container.querySelector("a")?.getAttribute("rel")).toContain(
			"noopener",
		);
	});

	it("renders mention tokens as chips (never as links)", () => {
		render(
			<MarkdownText
				md="Ask [@Maya](mention:00000000-0000-7000-8000-000000000051)"
				inline
			/>,
		);
		expect(screen.getByText("@Maya").tagName).toBe("SPAN");
	});

	it("never renders images, even markdown ones", () => {
		const { container } = render(
			<MarkdownText md="![pixel](https://tracker.example/p.gif)" />,
		);
		expect(container.querySelector("img")).toBeNull();
	});
});

describe("MentionChip follows merges and reads removed members plainly (QA MENT-03)", () => {
	it("a merged placeholder shows its new name; a removed member is plain text", async () => {
		const { renderWithWorkspace } = await import("@/test/render-workspace");
		const { demoGraph, DEMO_MEMBERS } = await import("@/lib/fixtures/demo");
		const kai = "00000000-0000-4000-8000-00000000c0de";
		const graph = {
			...demoGraph,
			members: [
				...demoGraph.members.map((m) =>
					m.id === DEMO_MEMBERS.audrey
						? {
								...m,
								status: "removed" as const,
								mergedIntoId: DEMO_MEMBERS.dennis,
							}
						: m,
				),
				{
					...(demoGraph.members[0] as (typeof demoGraph.members)[number]),
					id: kai,
					userId: null,
					status: "removed" as const,
					role: "viewer" as const,
					name: "Kai Viewer",
				},
			],
		};
		const { container } = renderWithWorkspace(
			<MarkdownText
				md={`[@Audrey](mention:${DEMO_MEMBERS.audrey}) and [@Kai](mention:${kai})`}
			/>,
			{ graph },
		);
		const dennis = graph.members.find((m) => m.id === DEMO_MEMBERS.dennis);
		expect(container.textContent).toContain(`@${dennis?.name}`);
		const removed = container.querySelector(`[data-mention="${kai}"]`);
		expect(removed?.textContent).toBe("Kai Viewer");
		expect(removed?.hasAttribute("data-removed")).toBe(true);
	});
});

describe("MentionChip shows the member's picture, round (owner FB-16)", () => {
	it("a member with a picture gets a round avatar; one without, none; a removed one, none", async () => {
		const { renderWithWorkspace } = await import("@/test/render-workspace");
		const { demoGraph, DEMO_MEMBERS } = await import("@/lib/fixtures/demo");
		const kai = "00000000-0000-4000-8000-00000000c0de";
		const base = demoGraph.members[0] as (typeof demoGraph.members)[number];
		const graph = {
			...demoGraph,
			members: [
				...demoGraph.members.map((m) =>
					m.id === DEMO_MEMBERS.dennis
						? { ...m, image: "/api/avatar/dennis_user?v=v1" }
						: { ...m, image: null },
				),
				{
					...base,
					id: kai,
					userId: "kai_user",
					status: "removed" as const,
					name: "Kai Viewer",
					image: "/api/avatar/kai_user?v=k1",
				},
			],
		};
		const { container } = renderWithWorkspace(
			<MarkdownText
				md={`[@D](mention:${DEMO_MEMBERS.dennis}) [@A](mention:${DEMO_MEMBERS.audrey}) [@K](mention:${kai})`}
				inline
			/>,
			{ graph },
		);
		const dennis = container.querySelector(
			`[data-mention="${DEMO_MEMBERS.dennis}"]`,
		);
		const img = dennis?.querySelector("img[data-mention-avatar]");
		expect(img?.getAttribute("src")).toBe("/api/avatar/dennis_user?v=v1&s=64");
		expect(img?.getAttribute("alt")).toBe("");
		expect(img?.className).toContain("rounded-full");
		expect(img?.className).toContain("object-cover");
		expect(dennis?.hasAttribute("data-avatar")).toBe(true);
		expect(
			container
				.querySelector(`[data-mention="${DEMO_MEMBERS.audrey}"]`)
				?.querySelector("img"),
		).toBeNull();
		expect(
			container.querySelector(`[data-mention="${kai}"]`)?.querySelector("img"),
		).toBeNull();
	});
});
