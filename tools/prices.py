"""Today's TCGplayer market prices for every Pokémon card, for the web version's PRICES key.

    python prices.py data/prices.json

Reads TCGplayer's card search (the public endpoint the TCGplayer website itself uses, not an
official API, so it may change) set by set, English and Japanese, about 1,200 requests, and
writes {"updated", "source", "by_tcgp": {product id: market price}}. The app looks a card up by
its TCGplayer product id; cards without one (Korean, Chinese) use their English twin's price.

Self-contained (only `requests`), so the publishing job (.github/workflows/pages.yml, in the
site's own repository) can run it every night. The file is only replaced when the read
succeeds, so a bad night keeps the last good prices.
"""
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

SEARCH = "https://mp-search-api.tcgplayer.com/v1/search/request?q=&isList=false"
LINES = ("pokemon", "pokemon-japan")
session = requests.Session()
session.headers["User-Agent"] = "Mozilla/5.0 (compatible; Alakadex/1.0; daily price list)"


def search(filters, line, start=0, size=50):
    body = {"algorithm": "sales_synonym_v2", "from": start, "size": size,
            "filters": {"term": {"productLineName": [line], "productTypeName": ["Cards"], **filters}},
            "listingSearch": {"filters": {"term": {"sellerStatus": "Live"}}},
            "sort": {"field": "product-sorting-name", "order": "asc"}}
    for attempt in range(5):
        try:
            r = session.post(SEARCH, json=body, timeout=30)
            r.raise_for_status()
            return r.json()["results"][0]
        except Exception:
            if attempt == 4:
                raise
            time.sleep(3 * (attempt + 1))


def main(out):
    prices, failed = {}, []
    for line in LINES:
        sets = search({}, line, size=1)["aggregations"]["setName"]
        print(f"{line}: {len(sets)} sets", flush=True)
        for i, s in enumerate(sets, 1):
            try:
                start = 0
                while True:
                    res = search({"setName": [s["urlValue"]]}, line, start)
                    for p in res["results"]:
                        if p.get("marketPrice") is not None:
                            prices[str(int(p["productId"]))] = round(float(p["marketPrice"]), 2)
                    start += 50
                    if start >= res["totalResults"] or not res["results"]:
                        break
                    time.sleep(0.15)
            except Exception as e:
                failed.append(f"{line}/{s['value']}: {e}")
            if i % 50 == 0:
                print(f"  {i}/{len(sets)} sets, {len(prices)} prices", flush=True)
    if len(prices) < 10000:
        raise SystemExit(f"Only {len(prices)} prices read ({len(failed)} sets failed); keeping the old file.")
    data = {"updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"), "source": "TCGplayer market price",
            "by_tcgp": prices}
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    tmp.replace(out)
    print(f"Wrote {len(prices)} prices to {out}" + (f"; {len(failed)} sets failed: {failed[:5]}" if failed else ""))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data/prices.json")
