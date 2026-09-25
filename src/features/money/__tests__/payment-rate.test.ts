/**
 * MONEY-R2-06: a payment's rate field shows the rate it was converted at
 * (its own paid date), never today's rate labelled "that day's rate".
 */
import { describe, expect, it } from "vitest";
import { autoPaymentRate, formatRate } from "../payment-rate";

const p1 = {
	id: "p1",
	currency: "JPY",
	paidAt: "2026-07-01T03:00:00.000Z",
	paidTz: "Asia/Tokyo",
	fxRate: 0.006142925,
	fxDate: "2026-07-01",
	fxManual: false,
};
const saved = [p1];
/** Today's rate: 157.6 JPY per 1 USD (≈ 0.006345). */
const LATEST = 157.6;
const TODAY = "2026-09-23";

describe("autoPaymentRate (MONEY-R2-06)", () => {
	it("a saved payment shows the rate of its paid date, not today's", () => {
		const r = autoPaymentRate(
			{ id: "p1", currency: "JPY", date: "2026-07-01" },
			saved,
			LATEST,
			TODAY,
		);
		expect(r).toEqual({ rate: 0.006142925, label: "that day's rate" });
		expect(formatRate(r.rate as number)).toBe("0.006142925");
	});

	it("says which date a gap-filled rate came from", () => {
		const gap = [{ ...p1, id: "p2", fxDate: "2026-06-30" }];
		expect(
			autoPaymentRate(
				{ id: "p2", currency: "JPY", date: "2026-07-01" },
				gap,
				LATEST,
				TODAY,
			).label,
		).toBe("rate of 30 Jun");
	});

	it("a re-dated or re-currencied payment no longer shows the stored rate", () => {
		expect(
			autoPaymentRate(
				{ id: "p1", currency: "JPY", date: "2026-06-15" },
				saved,
				LATEST,
				TODAY,
			),
		).toEqual({ rate: null, label: "that day's rate, set on save" });
		expect(
			autoPaymentRate(
				{ id: "p1", currency: "KRW", date: "2026-07-01" },
				saved,
				1400,
				TODAY,
			).rate,
		).toBeNull();
	});

	it("a payment made today (or planned later) uses today's rate", () => {
		const r = autoPaymentRate(
			{ currency: "JPY", date: TODAY },
			saved,
			LATEST,
			TODAY,
		);
		expect(r.label).toBe("today's rate");
		expect(r.rate).toBeCloseTo(1 / LATEST, 12);
		expect(
			autoPaymentRate({ currency: "JPY", date: "2026-10-05" }, [], null, TODAY),
		).toEqual({ rate: null, label: "today's rate" });
	});

	it("never presents a manual rate as the source's", () => {
		const manual = [{ ...p1, fxManual: true }];
		expect(
			autoPaymentRate(
				{ id: "p1", currency: "JPY", date: "2026-07-01" },
				manual,
				LATEST,
				TODAY,
			).rate,
		).toBeNull();
	});
});
