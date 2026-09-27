// `cn` (shadcn-ui/cn, a compiled clsx + tailwind-merge) taught the kit's own
// sizes, so `text-meta` merges as a font size instead of cancelling a text
// colour. Import it from here, not from the `cn` package (the kit guard checks).
import { createCn } from "cn/config";

export const cn = createCn({
	extend: { theme: { text: ["meta", "body"], shadow: ["float"] } },
});
