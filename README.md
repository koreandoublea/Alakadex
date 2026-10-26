# Alakadex (web)

The phone / browser version of Alakadex, a Pokémon card scanner. This folder is the whole
site: open it on any static host and share the link.

Everything runs in the visitor's browser. The camera picture never leaves the phone, and
pulls are saved on the phone. The first visit downloads about 60 MB of models and card data
once; after that the app works offline.

- `index.html`, `app.js`, `style.css`: the Alakadex page, same as the desktop app
- `shim.js`, `worker.mjs`, `imgops.mjs`: the scanner, run in the browser
- `models/`, `data/`: card detector, identifier, language model, card list, fingerprints
- `data/prices.json`: TCGplayer market prices, refreshed every night by
  `.github/workflows/pages.yml` running `tools/prices.py`

Built by `web/build_web.py` in the Alakadex project. Don't edit these files here: rebuild instead.
