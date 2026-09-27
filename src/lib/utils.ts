// `cn` (shadcn-ui/cn, a compiled clsx + tailwind-merge) taught the kit's own
// classes: `text-meta` merges as a font size instead of cancelling a text
// colour, and `eyebrow` replaces an earlier size, weight, tracking or case.
// Import it from here, not from the `cn` package (the kit guard checks).
import { createCn } from "cn/config";

export const cn = createCn({
	extend: {
		theme: { text: ["2xs", "meta", "body"], shadow: ["float"] },
		classGroups: { eyebrow: ["eyebrow"] },
		conflictingClassGroups: {
			eyebrow: [
				"font-size",
				"font-weight",
				"tracking",
				"leading",
				"text-transform",
			],
		},
	},
});
