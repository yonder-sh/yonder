/**
 * Day operations (SPEC §7.6, §7.7, §13.1). Each is a literal
 * `createServerFn` whose handler is the gate (EXTENSIONS §3.4); the inputs
 * and DB-only cores live in `src/server/cores/days.server.ts`. A date change
 * never deletes an item. Results are `R | Proposed`.
 */
import { createServerFn } from "@tanstack/react-start";
import { withNamedUser } from "@/server/authz/middleware";
import {
	DeleteDayInput,
	InsertDayInput,
	MoveDayInput,
	SetDayStayInput,
	UpdateDayInput,
} from "@/server/cores/days.server";
import { proposable } from "@/server/proposals/proposable.server";

export type { DayMutationResult } from "@/server/cores/days.server";

/** `day.insert`: a day before/after `dayId`; later days shift by one. Keys: graph. */
export const insertDay = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(InsertDayInput))
	.handler(proposable.run("day.insert"));

/** `day.move`: to another date of the trip; the days between shift by one. Keys: graph. */
export const moveDay = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(MoveDayInput))
	.handler(proposable.run("day.move"));

/** `day.delete`: its items move to Unscheduled and later days move back one. Keys: graph, lists, media, notes, counts, money. */
export const deleteDay = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(DeleteDayInput))
	.handler(proposable.run("day.delete"));

/** `day.update`: start time and title. Keys: graph. */
export const updateDay = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(UpdateDayInput))
	.handler(proposable.run("day.update"));

/** `day.stay`: the night's stay for a day range. Keys: graph. */
export const setDayStay = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(SetDayStayInput))
	.handler(proposable.run("day.stay"));
