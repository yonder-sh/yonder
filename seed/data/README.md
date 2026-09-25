# Asia 2027: seed data export

A read-only export of the Google Sheet **"Asia 2027"** (`<sheet-id>`, sheet time zone `America/New_York`), taken 2026-09-22 for a later seed import. Nothing was written to the sheet.

The trip is in Oct–Nov 2027: Japan, then South Korea, Vietnam and Taiwan. The travelers are **Dennis** and his girlfriend **Audrey**. Friends may join individual legs.

## Files

| File | Tab (sheetId) | Rows |
|---|---|---|
| `cities.json` | Cities (1700000003), formerly "Destinations" | 26 |
| `places.json` | Places (1700000004) | 125 |
| `itinerary.json` | Itinerary (1700000008), formerly "Tokyo Plan" | 65, plus the `summary` block |
| `shopping-list.json` | Shopping List (1700000005) | 27 |
| `action-timeline.json` | Action Timeline (1700000006) | 21 |
| `ana-watch-log.json` | ANA Watch Log (1700000007) | 33 (6 filled in) |
| `usa-to-asia-flights.json` | USA to Asia Flights (1700000001) | 20 |
| `airline-aircraft-seating-ratings.json` | Airline Aircraft Seating Ratings (1700000002) | 13 |
| `random-notes.json` | Random Notes (2037826441) | 19 non-empty lines |
| `geocode-hints.json` | (derived) lat/lng + IANA timezone per country, city, area and place | see below |
| `_index.json` | Tab list with row and link counts | |

Scripts in `../scripts/` can be re-run to refresh these files:

```sh
python3 seed/scripts/export-sheet.py        # uses the authenticated gws CLI; read-only spreadsheets.get
python3 seed/scripts/build-geocode-hints.py # exits non-zero if a new city/area/place has no hint yet
```

## File shape (every tab file)

```jsonc
{
  "source":  { "spreadsheetId", "spreadsheetTitle", "spreadsheetTimeZone", "tab", "sheetId", "tabIndex", "exportedAt", "exporter" },
  "headers": ["Country", "City", ...],              // row 1, in column order
  "columns": [{ "letter": "A", "header": "Country", "has_links": false }, ...],
  "rows": [                                          // one object per non-empty data row
    { "_row": 2,                                     // 1-based sheet row, for tracing back
      "Country": "Japan", "Days": 4,                 // keyed by the exact header text
      "Guide": "Guide ↗",
      "Guide_url": "https://…",                      // first link in the cell, or null
      "Guide_links": [{ "text": "Guide ↗", "url": "https://…" }] }  // every link in the cell, with its anchor text
  ],
  "raw": {
    "values":   [["Country", "City", ...], ...],     // 2D formatted values as displayed; trailing blanks trimmed
    "links":    { "F2": [{ "text", "url" }] },       // every linked cell, by A1 address
    "formulas": { "K2": "=SUMIF(...)" }              // every formula, by A1 address
  }
}
```

How values are converted in `rows`:

- **Blanks.** An empty cell and the sheet's `—` placeholder both become `null`. The literal `—` is kept in `raw.values`.
- **Numbers** are JSON numbers: Days, Hrs, Miles, Taxes & Fees (USD), Seats, First/Business seats.
- **Dates** are ISO `YYYY-MM-DD`. The sheet shows them as "Wed, Sep 30, 2026" or "Thu, Sep 17", but the stored serial carries the year. Text such as `TBD` stays a string.
- **Everything else** is the displayed string, including multi-line cells (with `\n`), `~` approximations, and `¥` amounts.
- **Links.** `<Header>_url` and `<Header>_links` appear only on columns that have at least one link, and then on every row (`null` / `[]` when that row has none). A cell can hold several links: Cities notes link individual words, and Shopping List Sources joins links with ` · `. Use `_links` for those.

Known sheet quirk: **Places J29** (Kappabashi Street, Notes) says "Knife shopping guide ↗" and is styled as a link, but no URL is stored. The intended URL is probably the Tokyo Cheapo knife guide, which is linked from Cities E2: `https://tokyocheapo.com/shopping-2/kappabashi-knife-shopping-tokyo/`.

---

## Cities

Columns: `Country | City | Status | Days | Notes | Guide`

One row per city or town on the route. The rows are grouped by country, in trip order: Japan → South Korea → Vietnam → Taiwan. Within each country, Dropped rows are sorted to the bottom.

- **City.** A city, or a separate town you travel out to (Uji, Nara, Hoi An, Jiufen, Shifen, Miyajima Island). "Mt. Fuji" and "Ha Long Bay" are regions, not cities. Neighborhoods inside a city (Shinjuku, Shibuya, ...) are **not** here. They live in Places, either as `Area` values or as Neighborhood rows.
- **Status.** `Planned` or `Dropped`. Dropped cities have `Days = null` (shown as `—` in the sheet).
- **Days.** Planned nights/days in that stop. Fractions are intentional: Kyoto 2.75, Uji 0.15 (a ~1 h stop between Kyoto and Nara), Nara 0.35, Shifen and Jiufen 0.5 each. Da Nang holds 3 days and Hoi An has none (`null`). The user wants this kept as-is: Hoi An's time is counted inside the Da Nang block.
- **Notes.** Free text listing highlights. Some words are linked (`Notes_links`).
- **Guide.** Always the text "Guide ↗" linking to a guide page (`Guide_url`), usually japan-guide.com. `null` when there is no guide. Suwon's guide URL is a copy-paste error in the sheet: it points to the Sapporo japan-guide page (e2163).

## Places

Columns: `Country | City | Area | Place | Description | Category | Priority (Dennis) | Priority (Audrey) | Time Needed | Notes | Link`

The master list of things to see, eat, buy and do (125 rows).

- **Country / City** match Cities, except for five cities that appear only in Places: Urayasu (Tokyo DisneySea), Miyazu (Amanohashidate), Ikoma, Minoh and Ikeda.
- **Area.** A sub-area of the city that you can get around within: a ward or neighborhood such as Shinjuku, Ginza, Arashiyama, Namba or Old Town. It is blank when the place is not tied to a sub-area. There are two kinds of rows:
  - **Area/neighborhood row**: `Category = Neighborhood` and `Area` blank. The row *is* the area (e.g. Place "Shinjuku", "Asakusa", "Old Town", "Da'an District").
  - **Place row**: its `Area` names the neighborhood it sits in. The value usually matches an area row's `Place` (e.g. Area "Shinjuku" → the "Shinjuku" row), but not always (e.g. Harajuku, Kinugasa and Namba have no area row of their own).
  - Some nearby towns are stored as the Area under a nearby city: Nagakute → Nagoya (Ghibli Park), Kawaguchiko / Fujiyoshida / Fujinomiya → Mt. Fuji, Maihama → Urayasu.
- **Description.** What the place *is*, and nothing else.
- **Notes.** Practical tips: hours, booking, crowds, prices, travel time, best time to go. Tips are appended with `; `. Japanese stores say "tax refund with passport" because Japan switches from tax-free-at-checkout to a refund system on 2026-11-01.
- **Category** (dropdown): `Neighborhood, Sight, Temple/Shrine, Museum, Shopping, Food/Drink, Bar, Activity, Nature`. There is no Hotel category. Lodging lives in Action Timeline.
- **Priority (Dennis) / Priority (Audrey)** (dropdowns): `Must > Really want > Want > Sure why not > Meh > Nah`. A blank means not rated yet. Both have rated the Tokyo places, though some Tokyo neighborhood rows are still blank for Dennis. Audrey hasn't rated Kyoto onward. Neither has rated Korea, Vietnam or Taiwan. The user's ranking rule: sort by **max(Dennis, Audrey)**, then by the **sum**, so anything one person loves rises to the top.
- **Time Needed** (dropdown, time *at* the place, not including travel): `Quick stop` ≈ 0.5 h, `An hour` = 1, `Few hours` ≈ 2.5, `Half day` ≈ 4, `Full day` ≈ 9. Big-store shopping and Kappabashi take longer than their bucket, because of buying and tax-refund queues.
- **Link.** Display text is "Link ↗", "Book ↗" or a domain. The URL is in `Link_url`.

## Itinerary

Columns (A:H): `Day | Area | Place | Category | Hrs | Book ahead | Open Hours | Notes`

The day-by-day plan. It started as "Tokyo Plan" and now covers the whole trip, though it has only been filled in through Day 6.

- **Day** is a label, repeated on every row of that day: `"N · City · Area"`, e.g. `"2 · Tokyo · Asakusa / Ginza"` or `"5 · Mt. Fuji · Shinjuku → Kawaguchiko"`. Some labels have only two parts: `"6 · Mt. Fuji → Nagoya"`. Rows labelled **`"Tokyo backup / if time"`** are *not* scheduled; they are alternates. The export adds a parsed `_day: { number, city, title, is_backup }` to each row. For two-part labels, `city` holds the whole second part (e.g. `"Mt. Fuji → Nagoya"`) and `title` is `null`. Backup rows have `number: null`.
- **Row order is the planned order within the day.** Days 1–4 are Tokyo, 5–6 are Mt. Fuji (one night at a Kawaguchiko ryokan) then on to Nagoya, followed by the backup list. The assumed arrival is a JFK departure on a Sat (ideal) or Sun (backup), landing at Haneda ~5 AM, so Tokyo Day 1 is a Sun or Mon. The plan has been checked against weekday closures for both cases.
- **Area.** Neighborhood (matches Places Area / area rows where possible). `null` for generic meal rows. On Day 6 the dinner Area is "Nagoya" (the city).
- **Place.** Usually a Places `Place` name. The exceptions:
  - **Meal rows**: `Breakfast`, `Lunch`, `Dinner`, `Dinner (ryokan kaiseki)`, `Breakfast (ryokan)`. Category `Meal`. They are included so the day totals count all 3 meals.
  - **Travel rows** (Category `Travel`): the big legs, e.g. `Fuji Excursion (Shinjuku → Kawaguchiko)`, `Bus → Shiraito Falls`, `Shiraito → Shin-Fuji → Nagoya`.
  - **Hotel rows** (Category `Hotel`): `Drop bags at ryokan`, `Ryokan check-in + onsen`.
  - `Chureito Pagoda (sunrise)` is the Places row "Chureito Pagoda".
  - `geocode-hints.json → itinerary_aliases` maps each of these.
- **Category.** The Places categories plus `Meal`, `Travel` and `Hotel`.
- **Hrs.** Planned hours for the row, as a number. Meals and travel legs count.
- **Book ahead.** `Yes` or `null`.
- **Open Hours.** Free text: opening hours, closed days, caveats (⚠ flags). Researched 2026-09-22 and still needs re-checking closer to the trip.
- **Notes.** Free text.

**Summary block (J1:K10) is NOT itinerary data.** It is exported separately as `itinerary.json → summary`. Its `rows[]` each have `label`, `hrs`, `hrs_formatted`, `formula` and `kind`:

- `kind: "day_total"` (J2:K8): one row per Day label. K is `=SUMIF($A$2:$A,Jn,$E$2:$E)`, the total `Hrs` for that day. Values: Day 1 = 11, Day 2 = 15, Day 3 = 13, Day 4 = 11, Day 5 = 10.5, Day 6 = 9.75, backup = 13. A new day needs a new row here.
- `kind: "capacity"` (J9:K9): `Capacity/day ~12.5`. This is the planning budget. It already includes all 3 meals and excludes about 2 h/day of travel plus tax-refund queues.
- `kind: "note"` (J10): the assumptions behind the budget. About 14.5 h per day out of the room: 7.5 h sleep, ~1 h in-room in the morning, ~1 h wind-down.

A day over ~12.5 is overbooked. Day 2 (15 h) is the known heavy day.

## Shopping List

Columns: `Item | For | Where | City | Rough budget | Status | Notes | Sources`

- **Item.** What to buy. The spelling "Stationary" is in the sheet as-is.
- **For.** Who it's for, by first name: `Dennis`, `Audrey`, `Audrey, Dennis`. This is a comma-separated list.
- **Where.** The shop(s) to buy it at, usually matching a Places `Place` name. Alternatives are separated by ` · ` (e.g. `Hands Shibuya · Shibuya Loft`). Some values are free text (`Nishikawa — Osaka (Daimaru Shinsaibashi) or Tokyo (Hiroo)`, `Hoi An tailors (Old Town)`). `null` means no shop picked yet.
- **City.** Free text, sometimes several cities (`Osaka / Tokyo`, `Tokyo, Uji`, `Tokyo, Vietnam`). This is not a strict FK to Cities.
- **Rough budget.** Free text (`~¥30,000`, `from ~¥700`). Mostly blank.
- **Status.** Currently always `Want it`. Expect it to grow into something like bought / skipped.
- **Notes.** Free text.
- **Sources.** Anchor texts ending in `↗`, joined with ` · `. The URLs are in `Sources_links`.

## Action Timeline

Columns: `What | Type | For travel date | Booking opens | Time (ET) | Status | Notes | Link`

Things that must be booked or done on a certain date.

- **Type**: `Points, Flight, Attraction, Hotel, Train, Other`.
- **For travel date.** ISO date of the travel it books (e.g. the ANA departure date), or `null`.
- **Booking opens.** ISO date when booking opens (or the deadline, for the Chase → Aeroplan transfer), or the string `TBD`.
- **Time (ET).** Free text in **US Eastern** time: `8:00 PM`, `End of day`, `9:00 PM (eve before)`. ANA releases award seats at 9 AM JST, which is 8 PM ET the evening before (7 PM ET after Nov 1).
- **Status.** `Not yet` or `null`.
- **Notes.** Free text. It can be long and multi-line, e.g. the ranked booking strategy on row 3.
- **Link.** Currently empty in every row.

## ANA Watch Log

Columns: `Checked (ET) | Departure date released | First seats | Business seats | 1 F + 1 J same flight? | Notes`

A daily log of ANA JFK→HND partner award space seen at release time (booked through Aeroplan).

- **Checked (ET).** The 2026 evening it was checked, as an ISO date.
- **Departure date released.** The 2027 departure date that opened that night, as an ISO date.
- **First seats / Business seats.** Numbers, or `null` when not recorded.
- **1 F + 1 J same flight?** A formula: `Yes` when both counts are ≥ 1, `No` otherwise. The formula result is exported, and the formula itself is in `raw.formulas`.
- Rows from `_row` 8 onward are pre-filled date pairs with no observations yet. Filter them out on import if you only want real observations.

## USA to Asia Flights

Columns: `Booking Program | Operating Airline(s) | From | Via | To | Cabin | Duration | Miles | Taxes & Fees | Availability | Seats | Notes`

Award flight options for the outbound flight.

- **From / Via / To.** IATA codes. `Via` is `null` for nonstops.
- **Cabin**: `First` or `Business`.
- **Duration.** Free text: `14 hrs`, `22–30 hrs`.
- **Miles.** Points cost as a number. For Air Canada rows it is the **Chase points needed after the 20% transfer bonus** (e.g. 70,833 Chase is 85k Aeroplan).
- **Taxes & Fees.** A USD number.
- **Availability**: `High, Medium, Low, Extremely Low`.
- **Seats.** Number, or `null` when unknown.
- **Notes.** Bullets, each starting with `• ` and separated by `\n`.

## Airline Aircraft Seating Ratings

Columns: `Airline | Aircraft | Seat Config | Rating | Lie-Flat | Private Suite | Notes`

Business-class seat quality by airline and aircraft.

- **Rating**: `Amazing > Good > Fine > Bad`.
- **Lie-Flat / Private Suite**: `Yes` or `No`.
- **Seat Config** gives the row layout, e.g. `1-2-1`.

## Random Notes

This tab has no header row. It is a scratch pad, exported as lines:

`rows[] = { _row, text, extra[], url, links[] }`

- `text` is the first non-empty cell in the row. `extra` holds the other cells.
- Rows 1–7 are ryokan, omakase, kaiseki and cocktail-bar links.
- Row 17 is a credit-card transfer-partners cheat sheet.
- Rows 24–35 are an old "Shopping List" draft (pillow, watch, knives, ...). It was replaced by the Shopping List tab. Don't import it as shopping items.

---

## geocode-hints.json

Best-effort WGS84 pins plus IANA timezones for every distinct country, city, area and place above.

- `countries[]`, `cities[]`, `areas[]` and `places[]` each carry `key`, `lat`, `lng`, `timezone`, `utc_offset`, `confidence` and an optional `note`.
- **Key format** is `Country|City|Area|Place`. Area is empty when not set, e.g. `Japan|Kyoto||Nijo Castle`. Places match `places.json` rows on (Country, City, Area, Place). Each hint also carries `places_row`.
- **Timezones**: Japan `Asia/Tokyo` (+09:00), South Korea `Asia/Seoul` (+09:00), Vietnam `Asia/Ho_Chi_Minh` (+07:00, used for the whole country), Taiwan `Asia/Taipei` (+08:00). None of them observe DST.
- **Confidence** (places: 92 high, 33 medium; country centroids are low):
  - `high`: within ~300 m (landmark or station).
  - `medium`: within ~1 km. These are address-level guesses, large or spread-out sights, or one of several branches.
  - `low`: region only.
- Store pins marked "(web-checked address)" were placed from a looked-up street address. All other pins come from model knowledge. **Verify medium pins before using them for walking directions.**
- `cities[]` also records `in_cities_tab`, `status` and `places_count`. "Mt. Fuji" is pinned at Kawaguchiko Station (the base); the summit's coordinates are in its note.
- `areas[]` covers every Places `Area` value plus the Itinerary `Area` values. `seen_in` says which tab each one came from.
- `itinerary_aliases`, `itinerary_area_aliases` and `transit_points` map Itinerary rows that aren't Places rows (travel legs, ryokan, meals) to pins or routes. Examples: Shinjuku Station → Kawaguchiko Station, and Shiraito Falls → Shin-Fuji Station → Nagoya Station.
