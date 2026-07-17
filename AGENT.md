# Agent reference: cooklang + Quartz integration

## Stack

- Recipe source files: `content/**/*.md` with `format: cooklang` in YAML frontmatter
- Parser: `chef` CLI (cooklang-rs) called via `execFileSync` in `quartz/util/cooklang.ts`
- Integration point: `quartz/processors/parse.ts` — detects `format: cooklang` in frontmatter before textTransforms run, calls `convertCooklang(fp, rawContent)` which replaces `file.value` with rendered markdown

## Chef CLI

```
chef recipe --format=json --name "<name>" < input.cook
```

Reads cooklang from stdin, writes JSON to stdout.

## Chef JSON output shape

```
{
  name, metadata: { map: Record<string, unknown> },
  sections: [{ name: string|null, content: [{type:"text"|"step", value}] }],
  ingredients: [ChefIngredient],
  cookware, timers, inline_quantities
}
```

### ChefIngredient

```
{
  name: string, alias: string|null, note: string|null,
  modifiers: "" | "REF",           // "REF" = & reference modifier
  quantity: { value: ChefQuantityValue, unit: string|null } | null,
  relation: {
    type: "definition", referenced_from: number[], ...   // definition
    | type: "reference", references_to: number, ...      // reference
  }
}
```

### ChefQuantityValue

```
{ type: "number", value: { type: "regular", value: float } }
{ type: "fraction", value: { whole, num, den } }  // no inner .value field
{ type: "text", value: string }   // when chef can't parse as number (e.g. "1,2" French decimal)
```

`extractQuantityValue` returns `number | string`. Text quantities are non-scalable and rendered as-is.

### Steps

`section.content[].type === "step"` → `value: { items: [{type, value?, index?}], number }`

- `type: "ingredient"` / `"cookware"` / `"timer"` / `"inlineQuantity"` → use `index` to look up in respective arrays
- `type: "text"` → raw string (may contain wikilinks, inline HTML, etc.)
- `type !== "step"` items (text sections/notes) are currently **dropped** by `buildSections`

## Cooklang syntax (relevant subset)

- `@ingredient{qty%unit}` — defines ingredient
- `@&ingredient{qty%unit}` — REF: references previous definition; qty is additive
- `#cookware{}` — cookware
- `~{qty%unit}` — timer
- Comma in qty (`{1,2%kg}`) → parsed as `type:"text"`, value `"1,2"` (not a number)
- Use dot for decimals: `{1.2%kg}`

## cooklang.ts key functions

| Function | Purpose |
|---|---|
| `extractQuantityValue(q)` | Returns `number \| string` from ChefQuantity |
| `applyReferenceQuantities(ingredients)` | Sums REF quantities into their definition's quantity |
| `buildSections(...)` | Maps sections → steps + ingredient indices; skips REF ingredients (`modifiers === "REF"`) from ingredient list |
| `renderIngredientItem(ingredient)` | Renders one `<li>`; uses `scalable-value` + `data-base` for numeric qty, plain span for text qty |
| `renderStepContent(step, ...)` | Joins text/ingredient-ref/cookware-ref/timer spans into a string |
| `renderRecipe(data)` | Full markdown output: frontmatter → meta-row → ingredients → instructions |

## Supported frontmatter keys (in recipe .md files)

| Key | Effect |
|---|---|
| `format: cooklang` | Triggers cooklang conversion in parse.ts |
| `title` | Page title |
| `locale` / `lang` | Lang attribute |
| `tags` | Array or comma-separated string |
| `servings` | Initial serving count (default 1) |
| `servings_label` | Label shown next to +/- control (default "Portions") |
| `source` | URL shown as source link |

## Quartz pipeline and wikilinks — CRITICAL

Pipeline order:
1. `convertCooklang` (if `format: cooklang`) → replaces `file.value`
2. `textTransform` (OFM) → raw string regex, normalizes `[[foo]]` but keeps `[[...]]` syntax
3. `remark-parse` → markdown AST
4. `markdownPlugins` (OFM) → AST walk, converts `[[...]]` text nodes to link nodes
5. `remarkRehype` → HTML AST
6. `htmlPlugins`

**Rule**: `markdownPlugins` cannot see inside HTML AST nodes. Wikilinks inside CommonMark HTML blocks are invisible to it → silently dropped.

**CommonMark HTML block trigger**: a line starting (0–3 spaces) with a known block-level element (`div`, `ul`, `li`, `p`, `section`, `article`, `h1`–`h6`, etc.). The block continues until a blank line.

**`<span>` is NOT a block-level element** → a line starting with `<span>` after a blank line is a markdown paragraph. Wikilinks and markdown syntax in it are fully processed.

### Step rendering pattern (preserves wikilinks)

```
<div class='step-block'>        ← HTML block (ends at blank line below)

<span class='step-num'>N.</span> step text with [[wikilink]] and <span class='ingredient_ref'>...</span>

</div>                          ← new HTML block
```

The step content line is a markdown paragraph because `<span>` is inline. Wikilinks work. Ingredient `<span>` refs are inline HTML within the paragraph — also fine.

**Do not** wrap step content in `<ul><li>` or any block-level HTML element — it will create an HTML block and break wikilinks.

**Do not** indent HTML block-level tags ≥4 spaces — CommonMark treats that as a code block.

## CSS classes used by cooklang.ts output

| Class | Element | Purpose |
|---|---|---|
| `meta-row` | div | Flex row for source + servings |
| `servings-control` | div | +/- servings control |
| `servings-btn` | button | +/- buttons |
| `ing-list` | ul | Ingredient list |
| `ing-qty` | span | Quantity cell in ingredient list |
| `scalable-value` | span | Has `data-base` attr; JS scales this on servings change |
| `unit` | span | Unit label next to quantity |
| `ingredient_modifiers` | span | Modifier badges |
| `step-block` | div | Wrapper for one step |
| `step-num` | span | Step number (bold, gray) |
| `ingredient_ref` | span | Inline ingredient highlight in step text |
| `cookware_ref` | span | Inline cookware highlight |
| `timer_ref` | span | Inline timer highlight |

## Servings scaling (explorer.inline.ts)

`updateServings(delta)` reads `#servings-display` for the base count, adjusts, then scales all `.scalable-value` elements using their `data-base` attribute. Persists via `?portions=` URL param. The label text (`.step-num` adjacent span) is not touched by JS — only the numeric display and `data-base` values are scaled.
