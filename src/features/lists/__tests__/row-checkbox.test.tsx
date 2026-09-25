/**
 * QA MOB-07 (VIS-05): a list row's checkbox is a 44×44 hit area on phones
 * (28×28 from md) around the 16px box, and the whole area toggles it.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RowCheckbox } from "../RowCheckbox";

describe("RowCheckbox", () => {
	it("has a 44px hit area on phones around a 16px box, and toggles", () => {
		const onChange = vi.fn();
		render(
			<RowCheckbox
				data-testid="check"
				aria-label="Done: Book ahead"
				checked={false}
				onCheckedChange={onChange}
			/>,
		);
		const box = screen.getByTestId("check");
		expect(box.getAttribute("role")).toBe("checkbox");
		// size-11 = 2.75rem = 44px; the negative margins keep the row's layout.
		expect(box.className).toMatch(/(^|\s)size-11(\s|$)/);
		expect(box.className).toMatch(/(^|\s)md:size-7(\s|$)/);
		expect(box.className).toMatch(/(^|\s)-mx-3\.5(\s|$)/);
		const visual = box.querySelector("span[aria-hidden]");
		expect(visual?.className).toMatch(/(^|\s)size-4(\s|$)/);
		fireEvent.click(box);
		expect(onChange).toHaveBeenCalledWith(true);
	});

	it("shows the tick when checked and can't toggle when disabled", () => {
		const onChange = vi.fn();
		render(
			<RowCheckbox
				data-testid="check"
				aria-label="Done"
				checked
				disabled
				onCheckedChange={onChange}
			/>,
		);
		const box = screen.getByTestId("check");
		expect(box.getAttribute("data-state")).toBe("checked");
		expect(box.querySelector("svg")).not.toBeNull();
		fireEvent.click(box);
		expect(onChange).not.toHaveBeenCalled();
	});
});
