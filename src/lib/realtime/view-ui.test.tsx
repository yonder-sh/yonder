/**
 * The followable view state (`useFollowState` and friends): it publishes
 * like `useState`, takes the leader's validated value while following,
 * ignores what doesn't pass, and the wire keeps the latest keys in budget.
 */
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useUi } from "@/lib/workspace/ui-store";
import { fitViewUi, MAX_UI_JSON } from "./view-protocol";
import {
	bool,
	ids,
	oneOf,
	useFollowedStore,
	useFollowState,
	useFollowToggle,
	useMyViewUi,
} from "./view-ui";

const LEADER = "u-leader";
const isBy = oneOf(["category", "place", "day"] as const);

afterEach(() => {
	act(() => {
		useUi.setState({ following: null });
		useFollowedStore.setState({ ui: null, focus: null });
	});
});

/** The leader's `view.ui`, as `useFollowedSync` hands it over. */
function lead(ui: Record<string, unknown> | null) {
	act(() => {
		useUi.setState({ following: ui ? LEADER : null });
		useFollowedStore.setState({ ui });
	});
}

function By({ onChange }: { onChange?: (v: string) => void }) {
	const [by, setBy] = useFollowState("money.by", "category", isBy);
	onChange?.(by);
	return (
		<button type="button" onClick={() => setBy("day")}>
			{by}
		</button>
	);
}

describe("useFollowState", () => {
	it("publishes its value while mounted, like useState", () => {
		const r = render(<By />);
		expect(useMyViewUi.getState().values["money.by"]).toBe("category");
		act(() => r.getByRole("button").click());
		expect(r.getByRole("button").textContent).toBe("day");
		expect(useMyViewUi.getState().values["money.by"]).toBe("day");
		r.unmount();
		expect(useMyViewUi.getState().values["money.by"]).toBeUndefined();
	});

	it("takes the leader's value each time it changes, and only valid ones", () => {
		const r = render(<By />);
		lead({ "money.by": "place" });
		expect(r.getByRole("button").textContent).toBe("place");
		// My own change stays until theirs changes again.
		act(() => r.getByRole("button").click());
		expect(r.getByRole("button").textContent).toBe("day");
		lead({ "money.by": "category" });
		expect(r.getByRole("button").textContent).toBe("category");
		// Something my screen can't show is ignored.
		lead({ "money.by": "weather" });
		expect(r.getByRole("button").textContent).toBe("category");
		// Stopping keeps where they were (like the URL).
		lead(null);
		expect(r.getByRole("button").textContent).toBe("category");
		r.unmount();
	});

	it("keeps to itself when disabled (a private list)", () => {
		function Private() {
			const [open] = useFollowState("lists.gift", false, bool, {
				enabled: false,
			});
			return <span>{String(open)}</span>;
		}
		const r = render(<Private />);
		expect(useMyViewUi.getState().values["lists.gift"]).toBeUndefined();
		lead({ "lists.gift": true });
		expect(r.container.textContent).toBe("false");
		r.unmount();
	});

	it("travels lists of ids (open rows) and applies them", () => {
		function Rows() {
			const [open, setOpen] = useFollowState<string[]>(
				"plan.split.open",
				[],
				ids,
			);
			return (
				<button type="button" onClick={() => setOpen(["tokyo"])}>
					{open.join(",") || "none"}
				</button>
			);
		}
		const r = render(<Rows />);
		act(() => r.getByRole("button").click());
		expect(useMyViewUi.getState().values["plan.split.open"]).toEqual(["tokyo"]);
		lead({ "plan.split.open": ["kyoto", "osaka"] });
		expect(r.getByRole("button").textContent).toBe("kyoto,osaka");
		lead({ "plan.split.open": ["<b>"] });
		expect(r.getByRole("button").textContent).toBe("kyoto,osaka");
		r.unmount();
	});
});

describe("useFollowToggle", () => {
	function Row({ id }: { id: string }) {
		const [open, setOpen] = useFollowToggle("still.open", id);
		return (
			<button type="button" data-id={id} onClick={() => setOpen((v) => !v)}>
				{open ? "open" : "closed"}
			</button>
		);
	}
	it("travels the open rows as one list, and opens mine with theirs", () => {
		const r = render(
			<>
				<Row id="nights" />
				<Row id="book" />
			</>,
		);
		const [nights, book] = r.getAllByRole("button");
		expect(useMyViewUi.getState().values["still.open"]).toEqual([]);
		act(() => book?.click());
		expect(useMyViewUi.getState().values["still.open"]).toEqual(["book"]);
		lead({ "still.open": ["nights"] });
		expect(nights?.textContent).toBe("open");
		expect(book?.textContent).toBe("closed");
		r.unmount();
		expect(useMyViewUi.getState().values["still.open"]).toBeUndefined();
	});
});

describe("the wire budget", () => {
	it("keeps the most recently changed keys when there are too many", () => {
		const Many = ({ n }: { n: number }) => {
			const [v, setV] = useFollowState<string[]>(
				`a.k${n}`,
				[
					"0192f5a0-0000-7000-8000-0000000000c1",
					"0192f5a0-0000-7000-8000-0000000000d1",
				],
				ids,
			);
			return (
				<button type="button" onClick={() => setV([...v, "x"])}>
					{n}
				</button>
			);
		};
		const r = render(
			Array.from({ length: 60 }, (_, n) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
				<Many key={n} n={n} />
			)),
		);
		// The last one (by name) changes last: it must travel.
		act(() => r.getAllByRole("button")[59]?.click());
		const { values, at } = useMyViewUi.getState();
		const fit = fitViewUi(values, at);
		expect(JSON.stringify(fit).length).toBeLessThanOrEqual(MAX_UI_JSON);
		expect(fit["a.k59"]).toBeDefined();
		expect(Object.keys(fit)[0]).toBe("a.k59");
		expect(Object.keys(fit).length).toBeLessThan(60);
		r.unmount();
	});
});
