# Card Scan FR/EN

Phone web app that scans Pokémon cards with the camera, keeps a collection on your phone and shows its Cardmarket value (EUR). Works for French and English cards.

## How it works
1. Camera or photo upload. A card-shaped frame marks where the name (top) and number (bottom) should sit.
2. On-device OCR with [Tesseract.js](https://github.com/naptha/tesseract.js) in French or English, picked by the FR/EN switch.
3. Lookup in the free [TCGdex API](https://tcgdex.dev): the number (e.g. `136/189`) narrows it to sets with that card count, then the OCR name ranks the matches. If unsure, the app shows the options to tap.
   The OCR name is corrected to the closest real card name from `data/names-<lang>.json`.
4. Prices come from TCGdex's Cardmarket data. The collection uses the 30-day average (holo price for holo-only cards).
5. The collection lives in the browser's localStorage. Export/import a JSON backup from the Collection tab.

## Refresh the name lists
After new sets come out:
```
NODE_USE_ENV_PROXY=1 node scripts/build-names.mjs
```
(`NODE_USE_ENV_PROXY` is only needed behind a proxy.)

## Limits
- Cardmarket prices from TCGdex are the same for the French and English version of a card (one product across all languages).
- OCR needs good light and little glare. You can always fix the name or number by hand.
- The camera only works over HTTPS (or localhost).

## Run locally
```
npx http-server -p 8080
```
Then open http://localhost:8080. No build step and no API keys.

## Publishing a new version
Run this before every commit, so phones load the new files and show the update banner:
```
node scripts/stamp-version.mjs
```
