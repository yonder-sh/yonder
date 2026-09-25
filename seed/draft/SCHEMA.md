# Asia 2027 · Full draft — draft file format (v1)

FB-11: the whole itinerary (Oct 2 – Nov 7 2027) as JSON files that one importer turns into the copy trip
**"Asia 2027 · Full draft"** (slug `asia-2027-full-draft`). The real trip `asia-2027` is never touched.
Names below follow Yonder's data model (`src/db/schema/**`, `src/lib/schemas/**`) and the sheet importer
(`scripts/sheet/lib/plan.ts`), so the importer can map each field 1:1.

## 1. Files (all in `seed/draft/`)

| File | Owner | What |
|---|---|---|
| `SCHEMA.md` | coordinator | this file |
| `allocation.json` | coordinator | every date → sleep city/kind, title, moves, parts, flex day, booking windows, **trip-default budgets** |
| `flights.json` | coordinator | every flight block (`FlightDetails`), airport nodes, flight expenses + flight todos |
| `days-<part>.json` | builders | one `DraftPart` per part: `japan`, `korea`, `vietnam`, `taiwan` (dates in `allocation.json → parts`) |

Builders write only their own `days-<part>.json`. Never edit another part's file or the coordinator files;
put disagreements in your part's `notes`.

## 2. Conventions

- **Node keys** = the sheet importer's `PlanNode.key` (and `geocode-hints.json` keys):
  - country `Japan` · city/region `Japan|Kyoto` (region: `Japan|Mt. Fuji`) · area `Japan|Kyoto|Gion`
  - place `Japan|Kyoto|<Area or empty>|<Place>` e.g. `Japan|Kyoto||Nijo Castle`, `Japan|Nagoya|Nagakute|Ghibli Park`
  - Neighborhood rows of Places are **areas** with 3-part keys (`Vietnam|Hoi An|Old Town`, `Taiwan|Taipei|Da'an District`,
    `South Korea|Seoul|Seongsu`), even when nested under another area (`Japan|Kyoto|Gion` sits under Higashiyama).
  - Existing nodes (everything from `places.json`/`cities.json`, the ryokan `Japan|Mt. Fuji|Kawaguchiko|Kawaguchiko Ryokan`)
    are referenced by key and **not** redeclared. City names are exactly the Cities tab's (`Ho Chi Minh City`, `Da Nang`,
    `Hoi An`, `Sa Pa`, `Ninh Binh`, `Mt. Fuji`).
  - Resolution in the copy trip is by names along the path (case/diacritic-insensitive): country → city → area (anywhere under
    the city) → place (under the area, or anywhere under the city when Area is empty).
- **Members**: `"dennis"` (owner) and `"audrey"` (placeholder). Default for everything = both; splits are `equal` among both.
- **Times** are local wall-clock at the place: `HH:mm`, `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm` (`LocalDT`). Zones are IANA
  (`Asia/Tokyo`, `Asia/Seoul`, `Asia/Ho_Chi_Minh`, `Asia/Taipei`, `Europe/Istanbul`, `America/New_York`).
- **Money** `{ "amount": 30000, "currency": "JPY" }` — MAJOR units (¥30,000, $12.50); the importer converts to minor units.
  Use the local currency where you'd pay (JPY, KRW, VND, TWD); USD/CAD for flights/awards. Trip home currency = USD.
- **Markdown** in `note`/`dayNote` (inline + lists; ≤ 2,000 chars). Put tips there, never in titles.
- Enums (from `src/lib/schemas/enums.ts`):
  - `PlaceCategory`: sight, temple_shrine, museum, viewpoint, nature, park, beach, onsen, food_drink, restaurant, cafe,
    market, bar, nightlife, shopping, activity, event, lodging, station, airport, port, other
  - `Priority`: must, really_want, want, sure_why_not, meh, nah
  - `ExpenseCategory`: lodging, transport, food_drink, activities, shopping, fees_other
- **Refs**: any item/leg that something else points at gets a `ref`, unique across all files, e.g. `"2027-10-09:ghibli-park"`.
  Flight items have implicit refs `<flightNumber>.dep` / `<flightNumber>.arr` (the IST layover item is `TK25.arr` = `TK29.dep`).

## 3. `days-<part>.json` → `DraftPart`

```ts
interface DraftPart {
  version: 1;
  part: "japan" | "korea" | "vietnam" | "taiwan";
  nodes?: NodeSpec[];        // NEW nodes only (hotels, restaurants, stations, extra sights); parents before children
  days: DaySpec[];           // every date of the part's range, in order (transfer days as a half, §3.2)
  expenses?: ExpenseSpec[];  // planned costs not already given as item/leg/stay `cost`
  todos?: TodoSpec[];
  budgets?: BudgetSpec[];    // optional city-level lines only; trip/country defaults live in allocation.json
  notes?: string[];          // assumptions + things to verify (goes into the import report)
}
```

### 3.1 NodeSpec → `nodes` row (+ `details`, note, link attachments)

```ts
interface NodeSpec {
  key: string;                  // path (§2); last segment = name unless `name`
  type: "country" | "region" | "city" | "area" | "place";
  category?: PlaceCategory;     // places only (hotel = "lodging", station = "station", restaurant = "restaurant")
  parent?: string;              // only when the parent isn't derivable from the key (an area inside an area)
  name?: string;                // display name override (≤ 200)
  localName?: string;           // 清水寺, 경복궁, 九份 (rendered with Noto fallbacks)
  lat: number; lng: number;     // WGS84; required
  tz?: string;                  // IANA; the server recomputes it from lat/lng anyway
  countryCode?: string;         // countries only, ISO alpha-2
  description?: string;         // ONE plain line: what it is (not tips)
  timeNeededMin?: number;       // 30 / 60 / 150 / 240 / 540 buckets preferred
  address?: string;
  website?: string;             // → details.website (http/https)
  openHours?: string;           // → details.openHoursText, e.g. "11:00–22:00; closed Mon; L.O. 21:30"
  bookAhead?: boolean;          // → details.bookAhead
  iata?: string;                // airports → details.iata
  confidence?: "high" | "medium" | "low";   // → details.geocodeConfidence (medium = within ~1 km)
  links?: { url: string; title?: string }[]; // → link attachments on the node
  priority?: { dennis?: Priority; audrey?: Priority }; // rarely; ONLY for new nodes; never overwrite existing ratings
  note?: string;                // → the node's shared note
}
```

### 3.2 DaySpec → `trip_days` (+ items, legs)

```ts
interface DaySpec {
  date: string;                 // YYYY-MM-DD, must be in allocation.json with this part in `parts`
  half?: "before" | "after";    // transfer days (allocation.days[].split): the departing part writes "before",
                                //   ending with the flight marker; the arriving part writes "after", starting with it
  owner?: true;                 // Oct 3–8: the owner's Itinerary days — see §3.5
  title?: string;               // "City · focus" (≤ 80); owner days keep the imported title; halves: the "after" half's wins
  startTime?: string;           // HH:mm, default 09:00; set earlier for sunrise starts (flight/night-train days anchor themselves)
  stay?: StaySpec | null;       // where you sleep AFTER this day; null = night train / flight / home.
                                //   On split days only the "after" half sets it. Must match allocation.days[].sleep.
  dayNote?: string;             // markdown on the day: alternates, meal ideas, closures, rain plan
  items: Entry[];               // in order (the Plan order)
}

interface StaySpec {            // → trip_days.night_node_id (+ one lodging expense per block)
  node: string;                 // lodging place key (declared in `nodes` unless it exists)
  checkIn?: true;               // first night of a contiguous block: carries `nights` + `cost`
  nights?: number;
  cost?: Money & { per: "night" | "total"; note?: string };  // room price for BOTH (not per person)
  note?: string;                // check-in time, early check-in, luggage storage
}

type Entry = ItemSpec | { leg: LegSpec } | { flight: string /* flights.json key, e.g. "KE726" */ };
```

**Flight markers** `{ "flight": "KE726" }` mark where a flight block's items sit (the importer creates them with the app's
`createFlightBlock`, airports from `flights.json`): on the departure day the marker ends the list (or is followed by the
same-day arrival items, e.g. Oct 14 AREX + hotel); on a later arrival day it starts the list. Required markers:
Oct 2 NH159, Oct 3 NH159 (first), Oct 14 KE726 (both halves), Oct 20 VN423 (both halves), Oct 23 VN132, Oct 26 VN174,
Nov 2 BR398 (both halves), Nov 6 TK25 (last), Nov 7 TK25 (only entry: layover + EWR arrival).

### 3.3 ItemSpec → `items` (+ assignees, todo, expense)

```ts
interface ItemSpec {
  ref?: string;
  node?: string | null;         // located item; null/absent = unlocated block ("Lunch near Nishiki")
  title?: string;               // required when no node; overrides the node's name when set (≤ 120).
                                //   Meals at a specific place: "Lunch · Omen Ginkakuji" with node = the restaurant.
  kind: "meal" | "sight" | "activity" | "shopping" | "nightlife" | "transport" | "lodging" | "rest";
                                //   not stored; picks the default expense category + report grouping
  durationMin: number;          // time AT the place, 0–4320 (travel is the legs' job)
  pinnedStart?: string;         // HH:mm local — only real anchors: reservations, timed tickets, tours, sunrise, shows
  fixedDate?: true;             // date-specific booking/ticket → items.fixed_date ("Booked for this date")
  bookAhead?: true;             // → a "Book ahead" todo on the item (+ node.details.bookAhead); add a TodoSpec
                                //   instead when you know the booking window
  who?: ("dennis" | "audrey")[];// only when not both
  note?: string;                // why, what to order, ⚠ closures, "tax refund with passport", reservation how-to
  cost?: Money & { per: "person" | "total"; category?: ExpenseCategory; note?: string };  // planned
}
```

### 3.4 LegSpec → `legs` (kind `pair`)

A leg entry connects the nearest **located** item before it to the nearest located item after it (skipping unlocated
meals) — same rule as the sheet importer's Travel rows. The last entry of a day may be a leg whose next located item is
the first of the next day (night trains): the day's `stay` must then be `null`. Only write legs the app can't autofill:
reserved/long-distance trains and buses, night trains, ferries/boats as transport, taxis/Grab/private cars, cable cars
used as transport. Everything else is left for leg autofill (walk/transit estimates; Google Maps link rows).

```ts
interface LegSpec {
  ref?: string;
  mode: "transit" | "walk" | "other";
  otherKind?: "taxi" | "car" | "bus" | "ferry" | "bike" | "other";  // mode "other"
  label: string;                // ≤ 80: "Nozomi · Nagoya → Kyoto", "Grab · Old Quarter → HAN"
  durationMin: number;          // door to door
  fixed?: {                     // reserved departure → details.fixed + legs.dep_at/arr_at (timed leg)
    depart: string; arrive: string;          // LocalDT
    fromTz?: string; toTz?: string;          // default: the endpoints' zones
    accessMin?: number; egressMin?: number;  // be at the platform N min early (default 10) / exit time
  };
  segments?: {                  // transit only → details.route.segments (TransitSegment)
    mode: "walk" | "bus" | "subway" | "train" | "rail" | "high_speed" | "tram" | "ferry" | "cable" | "other";
    lineName?: string; agency?: string; headsign?: string;
    from?: { name: string; lat?: number; lng?: number }; to?: { name: string; lat?: number; lng?: number };
    durationMin: number;
  }[];
  booking?: { trainNumber?: string; class?: string; car?: string };  // → details.booking (no seats: not booked)
  cost?: Money & { per: "person" | "total"; note?: string };          // planned fare → expense on the leg
  bookAhead?: true;
  note?: string;                // → the leg's note (e.g. "JR seats open 1 month before at 10:00 JST")
}
```

Mapping: `transit` → `details = { kind: "transit", route: { id: "draft", source: "manual", label, durationMin, segments,
fare? }, chosenId: "draft", fixed?, booking? }`, `source = "manual"`; `other` → `{ kind: "other", otherKind, label }`;
`walk` → `{ kind: "walk" }`. For a fixed train/bus, bracket the leg with **station items** (category `station`,
`durationMin` 10–20) so the timed leg has exact endpoints: `Nagoya Station → [Nozomi leg] → Kyoto Station`,
`Hanoi Station (last item Oct 28) → [SP1 leg] → Lao Cai Station (first item Oct 29)`.

### 3.5 Owner days (Oct 3–8) — keep them exactly

`owner: true` days come from the Itinerary tab (sheet import): **their items, order, durations, notes and the existing
Fuji legs are not recreated or edited.** The draft may only add: the `stay` (Tokyo hotel Oct 3–6, Nagoya hotel Oct 8;
the ryokan night Oct 7 already exists), the NH159 arrival marker first on Oct 3, a `dayNote` (e.g. restaurant ideas for
the owner's generic "Lunch"/"Dinner" rows), costs/todos targeting existing nodes, and optionally items **appended**
after the owner's last item. The "Tokyo backup / if time" items stay unscheduled.

## 4. `allocation.json` (coordinator)

`days[]` has one entry per date: `date, dow, tripDay (Oct 2 = 1), ownerItineraryDay?, parts, split? {before, after,
marker}, country, cities, title, sleep {kind: hotel|ryokan|train|flight|home, city, area?, checkIn?, nights?, node?, note?},
moves[] (suggested transport with times), flex?, notes[]`. Also: `parts` (date ranges + file names), `blocks` (Cities-tab
days vs. allocated nights), `flex`, `closuresAndEvents`, `bookingWindows`, and **`budgets`** (trip defaults, §6.3).
Builders keep dates, sleep cities/kinds and markers; they pick the hotels and fill the days.

## 5. `flights.json` (coordinator)

```ts
interface FlightsFile {
  version: 1;
  airportNodes: NodeSpec[];     // created/reused FIRST, before any part (reused by details.iata, like ensureAirportNode)
  flights: {
    key: string;                // first segment's flight number: NH159, KE726, VN423, VN132, VN174, BR398, TK25
    date: string;               // local departure date of the first segment
    label: string;
    status: "planned" | "booked";
    travellers: ("dennis" | "audrey")[];   // → leg_assignees
    segments: (FlightDetails & { note?: string })[];  // src/lib/schemas/legs.ts FlightDetails; `note` is stripped
                                //   before parsing and becomes that leg's note
    note?: string;              // → the first leg's note
    uncertain?: string[];       // → import report
  }[];
  expenses: ExpenseSpec[];      // award/cash flight costs, visas
  todos: TodoSpec[];            // award windows, e-visa, arrival cards
}
```

Import each block with `createFlightBlock(tx, out, tripId, { segments, afterItemId })` at its marker (then
`fitDayStartToFlight` so Oct 2 starts at 00:00). Legs carry `points`/`fees`/`cost` for display; the money rows come from
`expenses`.

## 6. Money, todos, budgets

### 6.1 ExpenseSpec → `expenses` (+ `expense_shares`; no payments: everything is planned)

```ts
type Target =
  | { trip: true } | { node: string } | { item: string /* ref */ } | { leg: string /* ref */ }
  | { flight: string /* flight number → that segment's leg */ } | { day: string /* date */ };

interface ExpenseSpec {
  title: string;                // ≤ 120
  target: Target;
  category: ExpenseCategory;
  amount?: number; currency?: string;       // planned TOTAL for everyone included (major units)
  points?: { amount: number; program: string; source?: { amount: number; program: string } };
  cashValue?: Money;            // equivalent cash price (cents-per-point)
  expectedOn?: string;          // date it will be paid
  split?: ("dennis" | "audrey")[];          // default both, equal
  note?: string;                // ≤ 2,000
}
```

Implicit expenses the importer derives (don't duplicate them in `expenses`): `stay.cost` on a check-in night → one
`lodging` expense on the lodging node ("<Hotel> · N nights", per-night × nights); `item.cost` → expense on the item
(category from `cost.category`, else by `kind`: meal→food_drink, shopping→shopping, transport→transport, lodging→lodging,
else activities); `leg.cost` → `transport` expense on the leg. `per: "person"` is multiplied by the people included.

### 6.2 TodoSpec → `list_items` (list `todo`)

```ts
interface TodoSpec {
  text: string;                 // one line
  target: Target;
  kind: "opens" | "due" | "on"; // booking window opens / deadline / do it that day
  rule?: {                      // RELATIVE window → list_items.due_rule (DueRule; moves with the item)
    anchor: string;             // item ref or "<flightNumber>.dep"
    days?: number;              // "N days before the anchor's day"  (kind "days")
    months?: number; dayOfMonth?: number;    // "N months before, on the Dth"  (kind "months")
    time: string; tz: string;
  };
  due?: { date: string; time?: string; tz?: string };  // absolute alternative (or snapshot)
  url?: string; note?: string;
  who?: ("dennis" | "audrey")[];
  replaces?: string;            // text of an imported todo (Action Timeline / "Book ahead") to UPDATE instead of duplicating
}
```

Known windows (use these rules): ANA award `days 355 @ 09:00 Asia/Tokyo`; JR reserved seats (Fuji Excursion,
Shinkansen, Haruka) `months 1 @ 10:00 Asia/Tokyo`; Ghibli Park `months 2, dayOfMonth 10 @ 14:00 Asia/Tokyo`; Ghibli
Museum `months 1, dayOfMonth 10 @ 10:00 Asia/Tokyo`; KTX `months 2 @ 07:00 Asia/Seoul` (new 2-month window from Oct
2026; time unverified); United/Turkish award `days 337` (approx.). Others: absolute date or none — say so in `note`.

### 6.3 BudgetSpec → `budget_lines` (trip default: `member_id` null)

```ts
interface BudgetSpec {
  scope: "trip" | string;       // "trip" = root, else a node key ("Japan", "Vietnam|Hanoi")
  category: ExpenseCategory | "all";
  kind: "per_day" | "total";
  amountUSD: number;            // PER PERSON, trip home currency (compared with each member's share)
  note?: string;
}
```

Trip/country defaults are in `allocation.json → budgets`; category lines stay ≤ the scope's `all` line.

## 7. Importer order (Final step)

1. Copy trip (or fresh import) → "Asia 2027 · Full draft"; members dennis (owner) + Audrey (placeholder).
2. Nodes: `flights.airportNodes`, then each part's `nodes` (parents first). Unknown key segments → error, not guesses.
3. Days: title, startTime, stay (owner days: stay only). Merge split days: "before" items + marker + "after" items.
4. Items in order; flight blocks at markers; legs; queue autofill for every other consecutive located pair.
5. Expenses (implicit + explicit + flights), todos (rules resolved to a due-date snapshot), budgets.
6. Report: counts, unresolved keys, uncertainties from `flights.json` and parts' `notes`.

## 8. Validation (the importer rejects a draft that fails these)

- Every date 2027-10-02 … 2027-11-07 exactly once (split days: exactly one "before" + one "after").
- `stay` matches `allocation.days[].sleep` (city + kind; `null` for train/flight/home nights). On owner days an
  omitted `stay` keeps the imported one (the Oct 7 ryokan).
- Every referenced key resolves to an existing or declared node; declared keys are unique across files.
- Items: `node` or `title`; `durationMin` 0–4320; `pinnedStart` `HH:mm`; refs unique; markers as listed in §3.2.
- Timed legs: `arrive > depart`; the leg's endpoints are located items.
- Per day, item time incl. meals ≤ 750 min (the owner's ~12.5 h capacity; travel on top). Flag, don't split, heavier days.

## 9. Planning rules for builders

- **Priorities:** rank Places by max(Dennis, Audrey), then the sum; Must / Really want first; skip Nah and Dropped
  cities. Unrated places (Korea/Vietnam/Taiwan): use the Cities-tab notes + judgment, and say so in `notes`.
- **Hours:** check opening hours and closed days for the actual date (weekday + holidays in `allocation.json`); put the
  hours in the node's `openHours` and any ⚠ in the item note. Realistic durations; cluster by area; travel ≤ ~2 h/day.
- **Meals:** breakfast, lunch, dinner every day (hotel/ryokan/konbini breakfast is fine as a short item). Name a real,
  well-known restaurant only when you're confident it exists and fits (area, hours, price); otherwise a title-only
  "Lunch near X" with ideas in the note. Note reservation needs (TableCheck, Catch Table, phone).
- **Owner notes to carry:** "tax refund with passport" on big stores (Japan uses a refund system since 2026-11-01:
  customs checks goods at departure, KIX Oct 14; Korea instant/airport refund; Taiwan TRS; Vietnam VAT refund at HAN);
  book-ahead items get `bookAhead` or a TodoSpec; shopping-list shops go on the plan where they're scheduled
  (Nishikawa at Daimaru Shinsaibashi, Uji matcha, Hoi An tailors on day 1 of the block).
- **Costs:** plausible planned costs for stays, tickets, tours, reserved trains; meals only for notable ones.
- Keep the owner's days exact (§3.5). Keep titles as "City · focus".
