/**
 * `psql` inside the Postgres container that serves DATABASE_URL: the dev one
 * (compose service `postgres`, :5432) or the fast full run's (`postgres-e2e`,
 * :5433). For specs that print or check rows directly.
 */
import { execSync } from "node:child_process";

const url = () => new URL(process.env.DATABASE_URL ?? "postgres://trip@localhost:5432/trip");
const container = () => (url().port === "5433" ? "trip-planner-postgres-e2e-1" : "trip-planner-postgres-1");

export const psql = (q: string): string =>
	execSync(`docker exec ${container()} psql -U trip -d ${url().pathname.slice(1)} -At -c ${JSON.stringify(q)}`, {
		encoding: "utf8",
	}).trim();
