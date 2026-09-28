/** Organize places over the Plan: a drag over the dialog never lands on the Plan behind it. */
import type { DroppableContainer } from "@dnd-kit/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modalDroppables } from "./workspace-dnd";

const container = (id: string, node: Element) =>
	({ id, node: { current: node } }) as unknown as DroppableContainer;

afterEach(() => vi.restoreAllMocks());

describe("modalDroppables", () => {
	document.body.innerHTML = `
		<div id="plan"><div id="day"></div></div>
		<div data-slot="dialog-overlay" id="backdrop"></div>
		<div role="dialog"><div id="row"></div><div id="empty"></div></div>`;
	const $ = (id: string) => document.getElementById(id) as Element;
	const all = [container("day", $("day")), container("row", $("row"))];
	const under = (id: string) => {
		document.elementFromPoint = vi.fn(() => $(id));
		return modalDroppables({ x: 1, y: 1 }, all)?.map((d) => d.id) ?? null;
	};

	it("keeps only the dialog's droppables over the dialog", () => {
		expect(under("empty")).toEqual(["row"]);
	});

	it("has no targets over the backdrop", () => {
		expect(under("backdrop")).toEqual([]);
	});

	it("leaves the page alone with no modal under the pointer", () => {
		expect(under("day")).toBeNull();
	});
});
