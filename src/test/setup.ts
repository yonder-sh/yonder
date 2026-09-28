// Setup for the Vitest "dom" project (happy-dom; see vitest.config.ts).
// F1u adds render helpers next to it (src/test/render-workspace.tsx, SPEC §4.1).
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach } from "vitest";

// Motion's animations jump to their end: happy-dom's Animation rejects a
// cancelled one's `finished`, which nothing awaits (an unhandled rejection).
MotionGlobalConfig.skipAnimations = true;

// Vitest globals are off, so Testing Library cannot register its own cleanup.
afterEach(() => {
	cleanup();
});
