/**
 * Collab document names (SPEC §10.2). The parser lives in the shared protocol so
 * the browser builds exactly the names the server accepts.
 */
export {
	channelDocName,
	type DocRef,
	type NoteTarget,
	noteDocName,
	parseDocName,
} from "@/lib/realtime/protocol";
