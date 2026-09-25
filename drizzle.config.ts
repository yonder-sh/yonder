import { defineConfig } from "drizzle-kit";
import { loadDotEnv } from "./scripts/load-env.ts";

// drizzle-kit does not read .env itself. Variables already set win over .env.
loadDotEnv();

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");

// Always pass a name: `pnpm db:generate --name <what>` (SPEC §5.3). Schema changes
// after the foundation are additive only: drizzle-kit cannot ask about renames
// outside a TTY (SPEC §0 rule 14).
export default defineConfig({
	dialect: "postgresql",
	schema: "./src/db/schema/index.ts",
	out: "./drizzle",
	casing: "snake_case",
	dbCredentials: { url },
});
