#!/usr/bin/env python3
"""Rebuild airports.json from OurAirports + timezonefinder.

Run:
  curl -sSfLo airports.csv https://davidmegginson.github.io/ourairports-data/airports.csv
  nix shell --impure --expr 'let p = import <nixpkgs> {}; in p.python3.withPackages (ps: [ ps.timezonefinder ])' \
    -c python3 build.py airports.csv airports.json
"""
import csv, json, sys, zoneinfo
from timezonefinder import TimezoneFinder

# Country-wide overrides: aviation/civil time differs from the tzdb polygon.
COUNTRY_TZ = {
    "CN": "Asia/Shanghai",      # all of China (incl. Xinjiang) schedules flights on Beijing time
    "VN": "Asia/Ho_Chi_Minh",   # tzdb puts north VN (HAN, HPH) in Asia/Bangkok; same UTC+7, nicer label
}
# Airport overrides: airport straddles a zone border, polygon picks the wrong side.
AIRPORT_TZ = {
    "OOL": "Australia/Brisbane",  # Gold Coast: terminal in QLD, flights on QLD time (no DST)
}

def main(src, dst):
    tf = TimezoneFinder()
    valid = zoneinfo.available_timezones()
    out = []
    with open(src, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["type"] not in ("large_airport", "medium_airport"):
                continue
            iata = r["iata_code"].strip()
            if not iata:
                continue
            lat, lng = float(r["latitude_deg"]), float(r["longitude_deg"])
            tz = (AIRPORT_TZ.get(iata) or COUNTRY_TZ.get(r["iso_country"])
                  or tf.timezone_at(lng=lng, lat=lat) or tf.certain_timezone_at(lng=lng, lat=lat))
            assert tz in valid, (iata, tz)
            out.append({
                "iata": iata,
                "icao": r["icao_code"].strip() or None,
                "name": r["name"].strip(),
                "city": r["municipality"].strip() or None,
                "country": r["iso_country"],
                "lat": round(lat, 6),
                "lng": round(lng, 6),
                "tz": tz,
            })
    out.sort(key=lambda a: a["iata"])
    assert len({a["iata"] for a in out}) == len(out), "duplicate IATA"
    with open(dst, "w", encoding="utf-8") as f:
        f.write("[\n" + ",\n".join(json.dumps(a, ensure_ascii=False) for a in out) + "\n]\n")
    print(f"wrote {len(out)} airports to {dst}")

if __name__ == "__main__":
    main(*(sys.argv[1:3] if len(sys.argv) > 2 else ("airports.csv", "airports.json")))
