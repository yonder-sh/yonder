/**
 * The single demo fixture (SPEC §17.1): fixed UUIDs and `demoGraph`, behind
 * the engine tests, `renderWithWorkspace`, `/dev/fixture`, the dev seed and
 * `POST /api/test/fixture`. The data lives with the engine tests
 * (`src/lib/engine/__fixtures__/demo.ts`, F1e); this is the import path
 * everything else uses.
 */
export {
	DEMO_MEMBERS,
	DEMO_TRIP_ID,
	demo,
	demoGraph,
	N,
	scenario,
} from "@/lib/engine/__fixtures__/demo";
