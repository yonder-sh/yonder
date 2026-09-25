/**
 * Country → currency (ADDENDUM §6 "fast mobile entry" defaults and §7.2 the
 * "Local" display currency). Shared by WP-Money (expense defaults, Local
 * display), WP-Lists (shopping prices) and anyone formatting a local price.
 * ISO 3166-1 alpha-2 → ISO 4217. Countries not listed fall back to the
 * caller's default (the trip's home currency).
 */
export const CURRENCY_BY_COUNTRY: Readonly<Record<string, string>> = {
	// The Asia 2027 trip and its neighbours
	JP: "JPY",
	KR: "KRW",
	TW: "TWD",
	VN: "VND",
	TR: "TRY",
	CN: "CNY",
	HK: "HKD",
	MO: "MOP",
	TH: "THB",
	SG: "SGD",
	MY: "MYR",
	ID: "IDR",
	PH: "PHP",
	KH: "KHR",
	LA: "LAK",
	MM: "MMK",
	IN: "INR",
	NP: "NPR",
	LK: "LKR",
	MN: "MNT",
	AE: "AED",
	QA: "QAR",
	// Home currencies and common stops
	US: "USD",
	CA: "CAD",
	MX: "MXN",
	GB: "GBP",
	CH: "CHF",
	NO: "NOK",
	SE: "SEK",
	DK: "DKK",
	IS: "ISK",
	PL: "PLN",
	CZ: "CZK",
	HU: "HUF",
	AU: "AUD",
	NZ: "NZD",
	BR: "BRL",
	AR: "ARS",
	CL: "CLP",
	CO: "COP",
	PE: "PEN",
	ZA: "ZAR",
	EG: "EGP",
	MA: "MAD",
	IL: "ILS",
	// Euro area
	AT: "EUR",
	BE: "EUR",
	HR: "EUR",
	CY: "EUR",
	EE: "EUR",
	FI: "EUR",
	FR: "EUR",
	DE: "EUR",
	GR: "EUR",
	IE: "EUR",
	IT: "EUR",
	LV: "EUR",
	LT: "EUR",
	LU: "EUR",
	MT: "EUR",
	NL: "EUR",
	PT: "EUR",
	SK: "EUR",
	SI: "EUR",
	ES: "EUR",
};

/** The country's currency, else `fallback` (the trip's home currency). */
export function currencyForCountry(
	countryCode: string | null | undefined,
	fallback: string,
): string {
	if (!countryCode) return fallback;
	return CURRENCY_BY_COUNTRY[countryCode.toUpperCase()] ?? fallback;
}
