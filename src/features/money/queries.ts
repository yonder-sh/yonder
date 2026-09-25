/** WP-Money queries, built on `tripKeys.money` so live `money` events reach them. */
import { tripKeys } from "@/lib/query/keys";
import { persistedQuery } from "@/lib/query/persister";
import { listMoney, type MoneyDto } from "./money.functions";

export const tripMoneyQuery = (tripId: string) =>
	persistedQuery({
		queryKey: tripKeys.money(tripId),
		queryFn: (): Promise<MoneyDto> => listMoney({ data: { tripId } }),
	});
