# drom-brands-models

A DevTools console script that scrapes every car brand and its models,
together with listing counts, from the filter dropdowns on
[auto.drom.ru](https://auto.drom.ru), and exports the result as Markdown
and JSON.

## Usage

1. Open a listing page, e.g. `https://auto.drom.ru/toyota/all/`.
2. Open DevTools → Console.
3. Paste the contents of `drom-brands-models.js` and press Enter.

No manual setup is needed — the script opens the dropdowns itself. Two
files are downloaded when it finishes: `drom-brands-models.md` and
`drom-brands-models.json`.

Start with a few brands to confirm everything works before running the
full pass:

```js
onlyBrands: ['Volvo', 'Honda', 'BMW']
```

## Runtime controls

| Command | Effect |
|---|---|
| `window.__dromStop = true` | Stop after the current brand, then export |
| `window.__dromExport()` | Download whatever has been collected so far |
| `window.__dromResult` | Raw result object |
| `localStorage.removeItem('__drom_scrape_v1')` | Reset saved progress |

Progress is persisted after every brand, so a reload, a captcha or a
closed tab costs only the brand in flight. Run the script again and it
resumes where it stopped.

## Configuration

All options live in the `CONFIG` block at the top of the file. The ones
worth knowing about:

| Option | Default | Purpose |
|---|---|---|
| `onlyBrands` | `[]` | Restrict to specific brands; empty means all |
| `maxBrands` | `Infinity` | Hard cap on how many brands to process |
| `tryAutoOpen` | `true` | Attempt to open dropdowns without a click |
| `resume` | `true` | Skip brands already in the saved progress |
| `networkQuietMs` | `500` | Network silence that counts as "loaded" |
| `afterBrandSettle` | `700` | Grace period after a brand filter applies |
| `modelAttempts` | `3` | Retries when the model list looks stale |
| `sound` | `true` | Beep when a manual click is required |

If any brand is reported as needing review, raise `afterBrandSettle` to
`1500` and `networkQuietMs` to `1000` and re-run those brands.

## How it works

The filters are React comboboxes backed by virtualised lists, which makes
three things non-obvious.

**Finding the fields.** `role="combobox"` is present on both the `input`
and its wrapper `div`, so the search is restricted to inputs. The model
field is the anchor, matched by its placeholder (`Модель`), because the
brand field's placeholder holds the currently selected brand
(`Toyota (168485)`) and has no stable text. The brand field is then the
closest combobox preceding it. Before anything else runs, the scraped
list is checked against a set of well-known brand names, so the script
fails loudly rather than silently scraping models as if they were brands.

**Opening a dropdown.** `element.click()` does not work: the component
listens for pointer events, and `PointerEvent` defaults to `pointerId: 0`
and `isPrimary: false`, which the component ignores. The script
dispatches a full pointer/mouse sequence with those properties set
explicitly, targeting whatever `elementFromPoint` reports on top. Three
fallbacks follow (`ArrowDown`, `Alt+ArrowDown`, a native-setter `input`
event) and, if all of them fail, the field is highlighted and the script
waits for a manual click. Open state is read from `aria-expanded`, and
the listbox is resolved through `aria-controls` at call time, since the
id changes on re-render.

**Avoiding stale data.** The model list is fetched asynchronously after a
brand is selected. The script waits for the brand placeholder to update,
for `fetch`/`XHR` activity to go quiet, and for the list contents to stop
changing. As a final check, a model list identical to the previous
brand's is treated as stale and re-scraped.

Only a window of rows exists in the DOM at any time, so lists are
scrolled to the bottom while rows are harvested, keyed by the index
encoded in each option's id.
