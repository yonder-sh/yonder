import {
	defineConfig,
	type TestProjectInlineConfiguration,
} from "vitest/config";
import { loadDotEnv } from "./scripts/load-env.ts";
import { isolateTestEnv } from "./src/test/isolation.ts";

// DATABASE_URL_TEST, REDIS_URL, … for the db project; variables already set win.
loadDotEnv();
// Tests never write to the main stack (README): anything still pointing at the
// main database, bucket or Redis prefix moves to its test twin before a test
// process starts, and the db project refuses to run if anything is main.
isolateTestEnv(process.env);

// Only the app is collected: spikes/, e2e/, brand/, infra/ and qa/ hold their own
// tests with dependencies that are not installed at the root (critique #40).
const OUTSIDE_APP = [
	"spikes/**",
	"e2e/**",
	"brand/**",
	"infra/**",
	"qa/**",
	"seed/**",
	"node_modules/**",
	"**/node_modules/**",
	".output/**",
];

// Every project: a test that reaches a host outside this machine fails.
const NO_NETWORK = "src/test/no-network.ts";

const projects: TestProjectInlineConfiguration[] = [
	{
		// Pure logic: engine, schemas, server helpers, collab, scripts.
		extends: true,
		test: {
			name: "unit",
			environment: "node",
			// Engine tests assume a host zone far from UTC and from every trip zone, so
			// a stray host-local conversion fails loudly (SPEC §0 rule 10).
			env: { TZ: "Pacific/Kiritimati" },
			include: [
				"src/**/*.test.ts",
				"collab/**/*.test.ts",
				"scripts/**/*.test.ts",
			],
			exclude: [...OUTSIDE_APP, "**/*.db.test.ts"],
			setupFiles: [NO_NETWORK],
		},
	},
	{
		// React components (Testing Library on happy-dom).
		extends: true,
		test: {
			name: "dom",
			environment: "happy-dom",
			include: ["src/**/*.test.tsx"],
			setupFiles: [NO_NETWORK, "src/test/setup.ts"],
			// A clicked target=_blank link opens no page (it would load the real site).
			environmentOptions: {
				happyDOM: {
					settings: { navigation: { disableChildPageNavigation: true } },
				},
			},
		},
	},
	{
		// Real Postgres (DATABASE_URL_TEST). One file at a time; each test makes its own trip.
		extends: true,
		test: {
			name: "db",
			environment: "node",
			include: [
				"src/**/*.db.test.ts",
				"collab/**/*.db.test.ts",
				"scripts/**/*.db.test.ts",
			],
			fileParallelism: false,
			globalSetup: ["scripts/db-test-prepare.ts"],
			setupFiles: [NO_NETWORK, "src/test/db-guard.ts"],
		},
	},
];

export default defineConfig({
	resolve: { tsconfigPaths: true },
	test: {
		exclude: OUTSIDE_APP,
		// SKIP_DB_TESTS=1 drops the db project (no Postgres available).
		projects:
			process.env.SKIP_DB_TESTS === "1"
				? projects.filter((p) => p.test?.name !== "db")
				: projects,
	},
});
