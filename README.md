# drom-brands-models

A DevTools console script that scrapes the filter dropdowns on
[auto.drom.ru](https://auto.drom.ru) and exports the result as JSON:

- **cars** (`https://auto.drom.ru/`): brands, models with listing counts,
  and every generation of every model (code, full name, production years);
- **motorcycles** (`https://auto.drom.ru/moto/`): brands and models with
  listing counts (drom has no generations for motorcycles).

The section is detected from the URL of the page the script runs on.

## Usage

1. Open a listing page, e.g. `https://auto.drom.ru/toyota/all/` or
   `https://auto.drom.ru/moto/`.
2. Open DevTools → Console.
3. Paste the contents of `drom-brands-models-v4.js` and press Enter.

No manual setup is needed: the script opens the dropdowns itself. When it
finishes, it downloads `drom-<section>-brands-models-<timestamp>.json`.

Start with a few brands to confirm everything works before running the
full pass:

```js
onlyBrands: ['Abarth', 'Volvo', 'Honda']
```

Collecting generations selects every model in turn, which adds roughly
2–3 seconds per model. For a quick brands-and-models pass, set
`collectGenerations: false`.

## Runtime controls

| Command | Effect |
|---|---|
| `window.__dromStop = true` | Stop after the current model, then export |
| `window.__dromExport()` | Download whatever has been collected so far |
| `window.__dromResult` | Raw saved state |
| `localStorage.removeItem('__drom_scrape_v4_auto')` | Reset car progress |
| `localStorage.removeItem('__drom_scrape_v4_moto')` | Reset motorcycle progress |

Progress is saved after every brand, and after every model while
generations are being collected. A reload, a captcha or a closed tab
therefore costs almost nothing: run the script again and it resumes.
A brand interrupted midway is saved as `partial` and continues from the
first model without generations.

Progress is stored per section, so car and motorcycle runs do not mix.
Progress from v2 (cars only) is migrated automatically.

> Saved progress is also exported. If a JSON file contains brands you did
> not ask for, they come from an earlier run. With `onlyBrands` set, only
> those brands are exported (`exportOnlySelected`). Unfinished brands
> found in saved progress are listed in the console at startup.

## Output

```json
{
  "schemaVersion": 4,
  "section": "auto",
  "source": "https://auto.drom.ru/",
  "collectedAt": "2026-09-16T16:04:16.973Z",
  "stats": { "brands": 1, "done": 1, "review": 0, "partial": 0, "models": 4, "generations": 6 },
  "brands": [
    {
      "name": "Abarth",
      "listings": 9,
      "status": "done",
      "modelCount": 4,
      "collectedAt": "2026-09-16T16:04:16.972Z",
      "models": [
        {
          "name": "500",
          "count": 1,
          "generations": [
            {
              "code": "394",
              "name": "1 поколение, рестайлинг",
              "yearFrom": 2022,
              "yearTo": null,
              "years": "2022 - н.в.",
              "count": null,
              "label": "1-е поколение, рестайлинг",
              "photo": "https://s.auto.drom.ru/.../abarth/500/gen240_abarth_500_1227293.jpg",
              "raw": "2022 - н.в., 394 | 1 поколение, рестайлинг"
            }
          ]
        }
      ]
    }
  ]
}
```

Field notes:

- `yearTo: null` means the generation is still in production (`н.в.`).
- `code` is `null` when drom shows no code for the generation.
- `count` in a generation is always `null`, because generation cards show
  no listing counts.
- `raw` keeps the original card text, so the parsed fields can be checked.
- `generations`, `generationsStatus` and `generationsReasons` are present
  for cars only.

### Statuses

| Level | Status | Meaning |
|---|---|---|
| Brand | `done` | Collected with no warnings |
| Brand | `review` | Collected, but something looked suspicious; see `reviewReasons` |
| Brand | `partial` | Interrupted mid-brand; resumed on the next run |
| Model | *(omitted)* | Generations collected normally |
| Model | `empty` | The model has no generations (field disabled or no cards) |
| Model | `review` | Generations could not be collected reliably; see `generationsReasons` |

On the next run, brands with status `review` are re-collected
(`retryReview`). Brands collected earlier without generations are
revisited once `collectGenerations` is on.

## Configuration

All options live in the `CONFIG` block at the top of the file. The ones
worth knowing about:

| Option | Default | Purpose |
|---|---|---|
| `onlyBrands` | `[]` | Restrict to specific brands; empty means all |
| `exportOnlySelected` | `true` | With `onlyBrands` set, export only those brands |
| `maxBrands` | `Infinity` | Hard cap on how many brands to process |
| `collectGenerations` | `true` | Collect generations (cars only) |
| `resume` | `true` | Skip brands already done in saved progress |
| `retryReview` | `true` | Re-run brands saved with status `review` |
| `tryAutoOpen` | `true` | Attempt to open dropdowns without a click |
| `useTypeahead` | `true` | Find options by typing into the field instead of scrolling |
| `autoExport` | `true` | Download JSON at the end of every run |
| `sound` | `true` | Beep when a manual click is required |

### Timing

Only the settle and stability values add time on every step. Timeouts
end as soon as the awaited condition is met.

| Option | Default | Purpose |
|---|---|---|
| `networkQuietMs` | `500` | Network silence that counts as "loaded" |
| `networkIdleTimeout` | `6000` | Give up waiting for network silence after this long |
| `afterBrandSettle` | `400` | Grace period after a brand filter applies |
| `listStableMs` | `500` | How long the model list must stay unchanged |
| `pauseAfterModelOpen` | `400` | Pause before scraping an opened model list |
| `afterModelSettle` | `800` | Grace period after a model is selected, before opening generations |
| `generationStableMs` | `600` | How long the generation cards must stay unchanged |
| `generationOptionsTimeout` | `6000` | Max wait for generation cards to appear |
| `generationFieldTimeout` | `4000` | Max wait for the generation field to become enabled |
| `modelAttempts` | `3` | Retries when the model list looks stale or empty |
| `generationAttempts` | `2` | Retries when the generation list looks stale |
| `selectAttempts` | `3` | Retries when a click does not change the field |

If generations load "just in time" or models end up in `review`, add
headroom to `afterModelSettle` (e.g. `1500`) and `generationStableMs`
(e.g. `1000`). On Toyota this costs about +1 s per model, or 4 minutes in
total. For brands, raise `afterBrandSettle` and `networkQuietMs`.

### Ignored network requests

`networkIgnore` lists URL patterns that do not count as loading:
analytics, ad beacons and drom's own tracker `www.drom.ru/dummy.txt`.
Blocked or slow requests of this kind would otherwise stretch every
"network is quiet" wait. A console message
`Could not track. TypeError: NetworkError…` comes from drom's tracker
being blocked, usually by an ad blocker, and is harmless.

## How it works

The filters are React comboboxes. Brand and model use virtualised lists;
generations use a card grid. This makes several things non-obvious.

**Finding the fields.** `role="combobox"` is present on both the `input`
and its wrapper `div`, so brand and model are searched among inputs only.

- **Brand** is matched by its label or placeholder (`Марка`), or else as
  the combobox preceding the model field.
- **Model** is matched by its placeholder (`Модель`). Once a model is
  selected, the placeholder holds that model (`500 (1)`), so the field is
  taken from cache, or else as the combobox following the brand field.
- **Generation** is not an input, because there is nothing to type into a
  card grid. It is found among all combobox-like elements by `data-ftid`,
  placeholder or text (`Поколение`). Its dropdown is resolved through
  `data-ftid="sales__filter_generation__dropdown"`, since the field may
  have no `aria-controls`.

Before anything else runs, the scraped brand list is checked against a
set of well-known brand names for the current section. If the check
fails, the script stops with an error rather than silently scraping
models as if they were brands.

**Opening a dropdown.** `element.click()` does not work: the component
listens for pointer events, and `PointerEvent` defaults to `pointerId: 0`
and `isPrimary: false`, which the component ignores. The script
dispatches a full pointer/mouse sequence with those properties set
explicitly, targeting whatever `elementFromPoint` reports on top. Three
fallbacks follow: `ArrowDown`, `Alt+ArrowDown`, and a native-setter
`input` event. The strategy that works is remembered per field and tried
first afterwards. If none of them work, the field is highlighted and the
script waits for a manual click. For the generation field, once it is
known how to open it, a failure to open is treated as "no generations"
instead of a manual prompt.

**Selecting an option quickly.** Only a window of rows exists in the DOM
at any time, so the full brand and model lists are scrolled to the bottom
once while rows are harvested. Each row is keyed by its name, which
collapses the "popular" block that duplicates entries at the top. Each
row also records the `scrollTop` at which it appeared. Selecting a row
later tries, in order:

1. the row is already rendered;
2. jump to its remembered `scrollTop`;
3. type its name into the input and let the list filter (disabled
   automatically for a field where this never works);
4. walk the list step by step and match by text.

An option is always verified by text before the click. After the click,
the field placeholder must show the chosen value. Otherwise the click is
retried, so data never ends up under the wrong brand or model.

**Parsing generations.** Each generation card has a two-line caption:

```
2022 - н.в., 394          → years, code
1 поколение, рестайлинг   → name
```

The card's `aria-label` and photo URL are kept as well. If the markup
changes, a heuristic parser falls back to classifying text segments as
years, code, name or count.

**Avoiding stale data.** Lists are fetched asynchronously after a filter
changes. The script waits for three signals: the field placeholder
updates, `fetch`/`XHR` activity goes quiet, and the list stops changing.
Two final checks catch lists that have not reloaded:

- A model list identical to the previous brand's is flagged for review.
- A generation set identical to the previous model's is re-collected
  after a pause. The comparison includes photo URLs, which contain the
  model slug, so models whose generations are textually identical, such
  as Abarth 595 and 695, are not mistaken for stale lists.
