/**
 * Every list write, through `useTripMutation` (SPEC §12.6): optimistic on the
 * trip's list cache, invalidating lists + counts (the live event skips this
 * tab), suggest-mode aware (a proposal rolls back and toasts). Deletes and
 * skips offer Undo; ticking a box is silent (EXTENSIONS §7 "Quick complete").
 */
import type { QueryClient } from "@tanstack/react-query";
import { generateKeyBetween } from "fractional-indexing";
import { v7 as uuidv7 } from "uuid";
import { undoToast } from "@/components/common/undo-toast";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { tripKeys } from "@/lib/query/keys";
import type { ListKind } from "@/lib/schemas/enums";
import type { BundleTarget } from "@/lib/schemas/targets";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import {
	createListItem,
	deleteListItem,
	type ListItemDto,
	moveListItem,
	restoreListItem,
	setListItemAssignees,
	setListItemStatus,
	setListItemTargets,
	updateListItem,
} from "./lists.functions";
import { sameTarget } from "./queries";
import type { ListItemPatch } from "./server/proposable.server";

/** Optional, never null (the create input leaves out what it doesn't set). */
type Present<T> = { [K in keyof T]?: NonNullable<T[K]> };

export type CreateVars = {
	target: BundleTarget;
	list: ListKind;
	text: string;
	isPrivate?: boolean;
	note?: string;
	assigneeIds?: string[];
	afterId?: string;
} & Present<
	Pick<
		ListItemDto,
		| "url"
		| "dueDayId"
		| "dueDate"
		| "dueTime"
		| "dueTz"
		| "dueKind"
		| "dueRule"
		| "quantity"
		| "priceAmount"
		| "priceCurrency"
		| "extraTargetNodeIds"
	>
> & {
		/** QA SEC-R3-01: this is the caller's private to-do, suggested to the trip. */
		fromPrivateId?: string;
	};

/**
 * "Suggest sharing with the trip" (QA SEC-R3-01): a private to-do can't be
 * suggested, so a suggester suggests a shared copy of it — everything on the
 * row — which replaces the private one when accepted.
 */
export function shareCopyOf(row: ListItemDto): CreateVars {
	const v = <T>(x: T | null | undefined): T | undefined => x ?? undefined;
	return {
		target: row.target,
		list: row.list,
		text: row.text,
		note: v(row.note),
		url: v(row.url),
		...(row.dueRule
			? { dueRule: row.dueRule }
			: {
					dueDayId: v(row.dueDayId),
					dueDate: v(row.dueDate),
					dueTime: v(row.dueTime),
					dueTz: row.dueTime ? v(row.dueTz) : undefined,
				}),
		dueKind: row.dueKind,
		quantity: v(row.quantity),
		priceAmount: v(row.priceAmount),
		priceCurrency: row.priceAmount != null ? v(row.priceCurrency) : undefined,
		assigneeIds: row.assigneeIds,
		extraTargetNodeIds: row.extraTargetNodeIds,
		fromPrivateId: row.id,
	};
}

type Status = ListItemDto["status"];

export function useListActions() {
	const { graph } = useWorkspace();
	const tripId = graph.trip.id;
	const listKey = tripKeys.lists(tripId);
	const keys = [listKey, tripKeys.counts(tripId)] as const;
	const edit = (qc: QueryClient, fn: (xs: ListItemDto[]) => ListItemDto[]) =>
		qc.setQueryData(listKey, (xs?: ListItemDto[]) => (xs ? fn(xs) : xs));
	const patchRow = (
		qc: QueryClient,
		id: string,
		fn: (r: ListItemDto) => ListItemDto,
	) => edit(qc, (xs) => xs.map((r) => (r.id === id ? fn(r) : r)));

	const create = useTripMutation(
		(v: CreateVars & { id: string }) =>
			createListItem({ data: { tripId, ...v } }),
		{
			keys,
			tripId,
			// The add row gets its text back on failure (ListBoard): no auto-retry.
			resubmit: "manual",
			optimistic: (qc, v) =>
				edit(qc, (xs) => [
					...xs,
					{
						id: v.id,
						target: v.target,
						list: v.list,
						text: v.text,
						note: v.note ?? null,
						url: null,
						status: "open",
						dueDayId: null,
						dueDate: null,
						dueTime: null,
						dueTz: null,
						dueKind: "due",
						dueRule: null,
						quantity: null,
						priceAmount: null,
						priceCurrency: null,
						position: "~",
						isPrivate: v.isPrivate ?? false,
						assigneeIds: v.assigneeIds ?? [],
						extraTargetNodeIds: [],
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
						doneAt: null,
						mine: true,
					},
				]),
		},
	);

	const update = useTripMutation(
		(v: { id: string; patch: ListItemPatch; expectedUpdatedAt?: string }) =>
			updateListItem({ data: v }),
		{
			keys,
			tripId,
			optimistic: (qc, v) =>
				patchRow(qc, v.id, (r) => {
					const p = v.patch;
					const next: ListItemDto = { ...r };
					for (const [k, val] of Object.entries(p))
						if (val !== undefined) (next as Record<string, unknown>)[k] = val;
					if (p.dueRule) {
						next.dueDate = null;
						next.dueTime = null;
						next.dueTz = null;
						next.dueDayId = null;
					} else if (
						p.dueDate !== undefined ||
						p.dueDayId !== undefined ||
						p.dueTime !== undefined
					)
						next.dueRule = null;
					return next;
				}),
		},
	);

	const status = useTripMutation(
		(v: { id: string; status: Status }) => setListItemStatus({ data: v }),
		{
			keys,
			tripId,
			optimistic: (qc, v) =>
				patchRow(qc, v.id, (r) => ({
					...r,
					status: v.status,
					doneAt: v.status === "open" ? null : new Date().toISOString(),
				})),
		},
	);

	const move = useTripMutation(
		(v: {
			id: string;
			target?: BundleTarget;
			afterId?: string;
			beforeId?: string;
		}) => moveListItem({ data: v }),
		{
			keys,
			tripId,
			// The row takes its new place at once (a key between its new neighbours).
			optimistic: (qc, v) =>
				edit(qc, (xs) => {
					const r = xs.find((x) => x.id === v.id);
					if (!r) return xs;
					const target = v.target ?? r.target;
					const sibs = xs
						.filter(
							(x) =>
								x.id !== v.id &&
								x.list === r.list &&
								sameTarget(x.target, target),
						)
						.sort((a, b) =>
							a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
						);
					const at = (id?: string) => sibs.findIndex((x) => x.id === id);
					let lo: string | null = sibs.at(-1)?.position ?? null;
					let hi: string | null = null;
					if (v.afterId && at(v.afterId) >= 0) {
						lo = sibs[at(v.afterId)]?.position ?? null;
						hi = sibs[at(v.afterId) + 1]?.position ?? null;
					} else if (v.beforeId && at(v.beforeId) >= 0) {
						lo = sibs[at(v.beforeId) - 1]?.position ?? null;
						hi = sibs[at(v.beforeId)]?.position ?? null;
					}
					let position = r.position;
					try {
						position = generateKeyBetween(lo, hi);
					} catch {
						// odd keys (an optimistic "~"): the refetch orders it
					}
					return xs.map((x) =>
						x.id === v.id ? { ...x, target, position } : x,
					);
				}),
		},
	);

	const assignees = useTripMutation(
		(v: { id: string; memberIds: string[] }) =>
			setListItemAssignees({ data: v }),
		{
			keys,
			tripId,
			optimistic: (qc, v) =>
				patchRow(qc, v.id, (r) => ({ ...r, assigneeIds: v.memberIds })),
		},
	);

	const targets = useTripMutation(
		(v: { id: string; nodeIds: string[] }) => setListItemTargets({ data: v }),
		{
			keys,
			tripId,
			optimistic: (qc, v) =>
				patchRow(qc, v.id, (r) => ({ ...r, extraTargetNodeIds: v.nodeIds })),
		},
	);

	const restore = useTripMutation(
		(v: { id: string }) => restoreListItem({ data: v }),
		{ keys },
	);

	const remove = useTripMutation(
		(v: { id: string; label: string }) =>
			deleteListItem({ data: { id: v.id } }),
		{
			keys,
			tripId,
			optimistic: (qc, v) => edit(qc, (xs) => xs.filter((r) => r.id !== v.id)),
			onSuccess: (_r, v) =>
				undoToast(`Deleted “${v.label}”`, () =>
					restore.mutateAsync({ id: v.id }).then(() => undefined),
				),
		},
	);

	return {
		/** Creates a row with a client-chosen id (so the optimistic row is the real one). */
		create: (v: CreateVars, opts?: { onError?: () => void }) => {
			const id = uuidv7();
			create.mutate({ ...v, id }, { onError: opts?.onError });
			return id;
		},
		update: (id: string, patch: ListItemPatch, expectedUpdatedAt?: string) =>
			update.mutate({ id, patch, expectedUpdatedAt }),
		/** A suggester's "Suggest sharing with the trip" (QA SEC-R3-01). */
		suggestShare: (row: ListItemDto) =>
			create.mutate({ ...shareCopyOf(row), id: uuidv7() }),
		/** Silent: the checkbox (and `x`) never toasts. */
		setStatus: (id: string, s: Status) => status.mutate({ id, status: s }),
		/** Skip keeps an Undo (EXTENSIONS §7). */
		skip: (row: ListItemDto) => {
			status.mutate(
				{ id: row.id, status: "skipped" },
				{
					onSuccess: () =>
						undoToast("Skipped", () =>
							status
								.mutateAsync({ id: row.id, status: row.status })
								.then(() => undefined),
						),
				},
			);
		},
		move: (
			id: string,
			v: { target?: BundleTarget; afterId?: string; beforeId?: string },
		) => move.mutate({ id, ...v }),
		setAssignees: (id: string, memberIds: string[]) =>
			assignees.mutate({ id, memberIds }),
		setTargets: (id: string, nodeIds: string[]) =>
			targets.mutate({ id, nodeIds }),
		remove: (id: string, label: string) => remove.mutate({ id, label }),
	};
}

export type ListActions = ReturnType<typeof useListActions>;
