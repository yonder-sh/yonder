import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { agentOverrides, renderEnv } from "./agent-env";

describe("agent:env", () => {
	it("gives agent n its own ports, database, bucket and Redis prefix", () => {
		const o = agentOverrides(3, {
			DATABASE_URL: "postgres://trip:secret@localhost:5432/trip",
		});
		expect(o.APP_PORT).toBe("5130");
		expect(o.HOCUSPOCUS_PORT).toBe("5131");
		expect(o.APP_URL).toBe("http://localhost:5130");
		expect(o.DATABASE_URL).toBe(
			"postgres://trip:secret@localhost:5432/trip_a3",
		);
		expect(o.DATABASE_URL_TEST).toBe(
			"postgres://trip:secret@localhost:5432/trip_test_a3",
		);
		expect(o.S3_BUCKET).toBe("trip-media-a3");
		expect(o.REDIS_PREFIX).toBe("yonder-a3");
		expect(o.VITE_COLLAB_URL).toBe("");
	});

	it("keeps the template layout and comments, quotes tricky values, appends unknown keys", () => {
		const template = [
			"# ---- App ----",
			"APP_PORT=3000                # vite port",
			'EMAIL_FROM="Yonder <trips@localhost>"',
			"S3_CORS_ORIGINS='http://(localhost|127\\.0\\.0\\.1)(:[0-9]+)?'",
		].join("\n");
		const text = renderEnv(
			template,
			{
				APP_PORT: "5130",
				EMAIL_FROM: "Yonder <trips@localhost>",
				S3_CORS_ORIGINS: "http://(localhost|127\\.0\\.0\\.1)(:[0-9]+)?",
				EXTRA: "1",
			},
			"extras",
		);
		expect(text).toContain("APP_PORT=5130                # vite port");
		const parsed = parseEnv(text);
		expect(parsed.APP_PORT).toBe("5130");
		expect(parsed.EMAIL_FROM).toBe("Yonder <trips@localhost>");
		expect(parsed.S3_CORS_ORIGINS).toBe(
			"http://(localhost|127\\.0\\.0\\.1)(:[0-9]+)?",
		);
		expect(parsed.EXTRA).toBe("1");
	});

	it("refuses nonsense agent numbers", () => {
		expect(() => agentOverrides(0, {})).toThrow();
	});
});
