/**
 * The query persister (SPEC §12.2, §16.4): selected queries are written to
 * IndexedDB (idb-keyval) so the last-loaded trip opens offline, straight from
 * the cache, with a background refetch when online.
 *
 * - Identity (de)serialisation: IndexedDB stores structured clones.
 * - `CACHE_SCHEMA_VERSION` is the buster: bump it by hand ONLY when the
 *   persisted shapes (TripGraph, …) change, never per build.
 * - On the server `storage` is undefined, so persisting is a no-op there.
 */
import {
	type AsyncStorage,
	experimental_createQueryPersister,
	type PersistedQuery,
} from "@tanstack/query-persist-client-core";
import {
	type QueryFunction,
	type QueryKey,
	type QueryPersister,
	queryOptions,
} from "@tanstack/react-query";
import { del, entries, get, set } from "idb-keyval";
import { BRAND } from "@/lib/brand";

/** Bump when a persisted query's data shape changes (e.g. TripGraph). */
export const CACHE_SCHEMA_VERSION = "1";

/** Persisted data older than this is discarded. */
export const PERSIST_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

/**
 * In-memory `gcTime` of persisted queries. SPEC §12.2 says 30 days, but
 * timers above 2^31-1 ms (~24.8 days) overflow to ~0 in browsers and Node
 * (queries would be collected at once), so this is the largest safe value.
 * IndexedDB still keeps the data for `PERSIST_MAX_AGE`.
 */
export const PERSISTED_GC_TIME = 24 * 24 * 60 * 60 * 1000;

const idbStorage: AsyncStorage<PersistedQuery> | undefined =
	typeof window !== "undefined" && typeof indexedDB !== "undefined"
		? {
				getItem: (key) => get<PersistedQuery>(key),
				setItem: (key, value) => set(key, value),
				removeItem: (key) => del(key),
				entries: () => entries<string, PersistedQuery>(),
			}
		: undefined;

export const queryPersister = experimental_createQueryPersister<PersistedQuery>(
	{
		storage: idbStorage,
		maxAge: PERSIST_MAX_AGE,
		buster: CACHE_SCHEMA_VERSION,
		prefix: BRAND.storage.queryPrefix,
		serialize: (q) => q,
		deserialize: (q) => q,
		// We revalidate restored data ourselves (`revalidatingPersister`), so a
		// failed background fetch is caught instead of becoming an unhandled
		// rejection (the library's own refetch is not awaited or caught).
		refetchOnRestore: false,
	},
);

/**
 * The persister with stale-while-revalidate: a query restored from IndexedDB
 * shows at once and is then fetched again in the background. The library's
 * default refetches only data older than `staleTime` (30 s), and IndexedDB
 * writes trail the fetches, so a reload right after a change could restore a
 * proposals list older than the graph beside it; the channel's version check
 * (which follows the graph) then saw nothing to refresh (found at
 * integration, QA SUG-09). A failed revalidation (offline, access lost) keeps
 * the restored copy and is swallowed here.
 */
const revalidatingPersister = <TData, TKey extends QueryKey>(
	queryFn: QueryFunction<TData, TKey>,
	ctx: Parameters<QueryFunction<TData, TKey>>[0],
	query: Parameters<QueryPersister<TData, TKey>>[2],
): Promise<TData> => {
	let fetched = false;
	const counted: QueryFunction<TData, TKey> = (c) => {
		fetched = true;
		return queryFn(c);
	};
	const persist = queryPersister.persisterFn as unknown as QueryPersister<
		TData,
		TKey
	>;
	return Promise.resolve(persist(counted, ctx, query)).then((data) => {
		if (!fetched && typeof window !== "undefined")
			setTimeout(() => {
				void query.fetch().catch(() => {});
			}, 0);
		return data;
	});
};

/**
 * `queryOptions` for a query that is kept in IndexedDB (SPEC §12.2):
 * `networkMode: 'offlineFirst'`, a long `gcTime` and the persister.
 *
 *   export const tripMediaQuery = (tripId: string) =>
 *     persistedQuery({ queryKey: tripKeys.media(tripId), queryFn: () => listTripMedia({ data: { tripId } }) })
 */
export function persistedQuery<TData, TKey extends QueryKey>(opts: {
	queryKey: TKey;
	queryFn: QueryFunction<TData, TKey>;
	staleTime?: number;
}) {
	return queryOptions<TData, Error, TData, TKey>({
		...opts,
		persister: revalidatingPersister as QueryPersister<TData, TKey>,
		networkMode: "offlineFirst",
		gcTime: PERSISTED_GC_TIME,
	});
}

/** Deletes every persisted query of one trip (`['trip', tripId, …]`). */
export async function removePersistedTrip(tripId: string): Promise<void> {
	if (!idbStorage) return;
	await queryPersister.removeQueries({ queryKey: ["trip", tripId] });
}

/** Deletes every persisted query (sign-out also wipes IndexedDB wholesale). */
export async function clearPersisted(): Promise<void> {
	if (!idbStorage) return;
	await queryPersister.removeQueries();
}
