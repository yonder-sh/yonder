/**
 * WP-Suggest server function (EXTENSIONS §3.7): `proposeNoteAppend` is the
 * propose-only `note.append` op (core in `server/proposable.server.ts`).
 * Resolving, withdrawing and listing proposals are F functions
 * (`src/functions/proposals.functions.ts`).
 */
import { createServerFn } from "@tanstack/react-start";
import { withNamedUser } from "@/server/authz/middleware";
import { proposable } from "@/server/proposals/proposable.server";
import { ProposeNoteAppendInput } from "./server/proposable.server";

/** Suggest an addition to a note (Markdown ≤ 4,000). Always a proposal. */
export const proposeNoteAppend = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(ProposeNoteAppendInput))
	.handler(proposable.run("note.append"));
