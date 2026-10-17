# Card Scan FR/EN

Phone web app that scans a Pokémon card with the camera and shows its Cardmarket price (EUR). Works for French and English cards.

## How it works
1. Camera or photo upload. A card-shaped frame marks where the name (top) and number (bottom) should sit.
2. On-device OCR with [Tesseract.js](https://github.com/naptha/tesseract.js) in French or English, picked by the FR/EN switch.
3. Lookup in the free [TCGdex API](https://tcgdex.dev): the number (e.g. `136/189`) narrows it to sets with that card count, then the OCR name ranks the matches. If unsure, the app shows the options to tap.
4. Prices come from TCGdex's Cardmarket data.

## Limits
- Cardmarket prices from TCGdex are the same for the French and English version of a card (one product across all languages).
- OCR needs good light and little glare. You can always fix the name or number by hand.
- The camera only works over HTTPS (or localhost).

## Run locally
```
npx http-server -p 8080
```
Then open http://localhost:8080. No build step and no API keys.
