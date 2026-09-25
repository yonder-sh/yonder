/** Currency choices for Trip settings (home currency) and Profile (display currency). */

/** The trip currencies first (ADDENDUM §7.3), then common home currencies. */
export const HOME_CURRENCIES = [
	"USD",
	"CAD",
	"EUR",
	"GBP",
	"AUD",
	"NZD",
	"CHF",
	"JPY",
	"KRW",
	"TWD",
	"VND",
	"THB",
	"SGD",
	"HKD",
	"CNY",
	"TRY",
	"MXN",
] as const;

/** "Japanese Yen" for "JPY" (the code itself when Intl can't name it). */
export function currencyName(code: string): string {
	try {
		return new Intl.DisplayNames(["en"], { type: "currency" }).of(code) ?? code;
	} catch {
		return code;
	}
}
