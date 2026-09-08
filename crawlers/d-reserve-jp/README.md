# d-reserve-jp

## Run

```bash
npm run crawl d-reserve-jp
npm run crawl d-reserve-jp -- --pages 3 --delay 1500
```

Output lands in `data/d-reserve-jp/<timestamp>.json`.

## Config

| Env                | Default                 | Meaning             |
| ------------------ | ----------------------- | ------------------- |
| `D_RESERVE_JP_URL` | `https://d-reserve.jp/` | Listing entry point |

## Notes

- The selectors in `src/index.js` are still the scaffold placeholders (`a[href]`).
  Replace them with the real listing selectors.
- Pagination shape (`?page=N`) is a guess — confirm against the site.
