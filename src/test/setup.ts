// Setup for the Vitest "dom" project (happy-dom; see vitest.config.ts).
// F1u adds render helpers next to it (src/test/render-workspace.tsx, SPEC §4.1).
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest globals are off, so Testing Library cannot register its own cleanup.
afterEach(() => {
	cleanup();
});
