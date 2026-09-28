// Setup for every Vitest project (vitest.config.ts): tests never leave this
// machine. Any connection or DNS query to a host that isn't loopback is refused
// (scripts/lib/no-egress.mjs) and fails the test that made it, even when the
// code under test swallowed the error; local Postgres and Redis still work.
// Stub the network instead: an injected fetcher, vi.stubGlobal("fetch"), or a
// server on 127.0.0.1.
import { afterAll, afterEach } from "vitest";
import { installNoEgress, type Refusal } from "../../scripts/lib/no-egress.mjs";

const refused: Refusal[] = [];
installNoEgress({ onRefuse: (r) => refused.push(r) });

/** The refusals so far, cleared (for the guard's own tests). */
export function takeRefusals(): Refusal[] {
	return refused.splice(0);
}

function check(who: string): void {
	if (!refused.length) return;
	const list = refused.splice(0);
	throw new Error(
		`${who} tried to reach ${list.length} host(s) outside this machine (refused; stub the network instead):\n${list
			.map(
				(r) =>
					`  ${r.kind} ${r.port === undefined ? r.host : `${r.host}:${r.port}`}\n${r.stack
						.split("\n")
						.slice(0, 6)
						.join("\n")}`,
			)
			.join("\n")}`,
	);
}

afterEach(() => check("This test"));
afterAll(() => check("This file"));
