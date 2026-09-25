/** Dice coefficient on character bigrams of folded names (0–1). Pure. */
export function nameSimilarity(a: string, b: string): number {
	const fold = (s: string) =>
		s
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, "");
	const x = fold(a);
	const y = fold(b);
	if (!x || !y) return 0;
	if (x === y) return 1;
	const grams = (s: string) => {
		const m = new Map<string, number>();
		for (let i = 0; i < s.length - 1; i++) {
			const g = s.slice(i, i + 2);
			m.set(g, (m.get(g) ?? 0) + 1);
		}
		return m;
	};
	const gx = grams(x);
	const gy = grams(y);
	let hit = 0;
	for (const [g, n] of gx) hit += Math.min(n, gy.get(g) ?? 0);
	const total = Math.max(1, x.length - 1 + y.length - 1);
	return (2 * hit) / total;
}
