/**
 * DateInput (One Yonder kit): the one date field. It can open from a trigger
 * of your own (a date as text on a line) and offer clearing the date.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DateInput } from "..";

describe("DateInput", () => {
	it("reads the date and picks another", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<DateInput value="2027-10-05" onChange={onChange} label="Paid on" />,
		);
		const field = screen.getByRole("button", { name: "Paid on" });
		expect(field).toHaveTextContent("Tue 5 Oct 2027");
		await user.click(field);
		await user.click(
			await screen.findByRole("button", { name: /October 6th, 2027/ }),
		);
		expect(onChange).toHaveBeenCalledWith("2027-10-06");
		// No clearing unless asked for.
		await user.click(field);
		expect(screen.queryByRole("button", { name: "No date" })).toBeNull();
	});

	it("opens from a trigger of its own and clears with clearLabel", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		const trigger = <button type="button">Expected Tue 5 Oct</button>;
		const { rerender } = render(
			<DateInput
				value="2027-10-05"
				onChange={onChange}
				clearLabel="No date"
				trigger={trigger}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: "Expected Tue 5 Oct" }),
		);
		await user.click(await screen.findByRole("button", { name: "No date" }));
		expect(onChange).toHaveBeenCalledWith("");
		// Nothing to clear without a date.
		rerender(
			<DateInput
				value=""
				onChange={onChange}
				clearLabel="No date"
				trigger={trigger}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: "Expected Tue 5 Oct" }),
		);
		await screen.findByRole("grid");
		expect(screen.queryByRole("button", { name: "No date" })).toBeNull();
	});
});
