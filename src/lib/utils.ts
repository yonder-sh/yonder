// shadcn >= 4.21 generates components that import `cn` from the `cn` package
// (shadcn-ui/cn, a compiled clsx + tailwind-merge replacement). Re-exported here
// so app code and any older-style `@/lib/utils` imports share one implementation.
export { cn } from "cn";
