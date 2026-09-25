# seed/airports

`airports.json` is a lookup table of 4,568 commercial airports, sorted by IATA code. It covers every
OurAirports `large_airport` and `medium_airport` that has an IATA code. Each IATA code
appears only once.

```json
{"iata":"HND","icao":"RJTT","name":"Tokyo Haneda International Airport","city":"Tokyo","country":"JP","lat":35.549678,"lng":139.786958,"tz":"Asia/Tokyo"}
```

| field     | source / notes |
|-----------|----------------|
| `iata`    | OurAirports `iata_code` |
| `icao`    | OurAirports `icao_code`, or `null` if it is empty |
| `name`    | OurAirports `name` |
| `city`    | OurAirports `municipality`, or `null` if it is empty |
| `country` | OurAirports `iso_country` (ISO 3166-1 alpha-2) |
| `lat`/`lng` | OurAirports `latitude_deg`/`longitude_deg`, rounded to 6 decimal places |
| `tz`      | An IANA zone looked up from the coordinates with `timezonefinder` 8.2.4, then corrected by the overrides below. Every value is checked against Python `zoneinfo`. |

## Sources and licensing

- **OurAirports** `airports.csv` (downloaded 2026-09-22) from
  https://davidmegginson.github.io/ourairports-data/airports.csv. OurAirports releases this
  data into the **Public Domain** (https://ourairports.com/data/).
- **Timezones** come from `timezonefinder` (MIT). Its polygon data comes from
  [timezone-boundary-builder](https://github.com/evansiroky/timezone-boundary-builder) and is
  licensed under **ODbL**
  (https://github.com/jannikmi/timezonefinder/blob/master/packages/timezonefinder-data/DATA_LICENSE).
  If you redistribute the `tz` column, attribute it to timezone-boundary-builder / OpenStreetMap
  contributors.
- I checked the zones against the `tz` field of the mwgg/Airports dataset (MIT,
  https://raw.githubusercontent.com/mwgg/Airports/master/airports.json), joined on ICAO. The two
  disagreed on 72 of 4,568 airports. In most of those cases mwgg was wrong (for example GVA=Europe/Paris,
  AVR=Europe/Lisbon, YZY=America/Vancouver). None of the mwgg values were used in the output.

## Timezone overrides (see `build.py`)

- **CN → `Asia/Shanghai`.** tzdb puts Xinjiang (URC, KHG, and others) in `Asia/Urumqi` (UTC+6).
  China has one official time, and flight schedules use Beijing time.
- **VN → `Asia/Ho_Chi_Minh`.** tzdb's `zone1970.tab` maps north Vietnam (HAN, HPH) to
  `Asia/Bangkok`. It has the same UTC+7 offset with no DST, but the label is confusing in a UI.
  (https://raw.githubusercontent.com/eggert/tz/main/zone1970.tab)
- **OOL → `Australia/Brisbane`.** The Gold Coast airport straddles the QLD/NSW border. Its terminal
  and schedules use Queensland time. The polygon lookup gave `Australia/Sydney`.

## Verified

HND, NRT and KIX → Asia/Tokyo · ICN and PUS → Asia/Seoul · SGN, DAD and HAN → Asia/Ho_Chi_Minh ·
TPE → Asia/Taipei · JFK and EWR → America/New_York · IST (LTFM) → Europe/Istanbul.

## Rebuild

```sh
curl -sSfLo airports.csv https://davidmegginson.github.io/ourairports-data/airports.csv
nix shell --impure --expr 'let p = import <nixpkgs> {}; in p.python3.withPackages (ps: [ ps.timezonefinder ])' \
  -c python3 build.py airports.csv airports.json
```
