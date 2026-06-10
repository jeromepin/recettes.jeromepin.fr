import { execFileSync } from "child_process"

interface ChefQuantityValue {
  type: string
  value: number | { type: string; value: number }
}

interface ChefQuantity {
  value: ChefQuantityValue
  unit: string | null
}

interface ChefIngredient {
  name: string
  alias: string | null
  quantity: ChefQuantity | null
  note: string | null
  modifiers: string
  relation?: {
    type: string
    referenced_from?: number[]
    references_to?: number
  }
}

interface ChefCookware {
  name: string
}

interface ChefStepItem {
  type: "text" | "ingredient" | "cookware" | "timer" | "inlineQuantity"
  value?: string | { quantity: ChefQuantity; items: ChefStepItem[]; number: number }
  index?: number
}

interface ChefStep {
  items: ChefStepItem[]
  number: number
}

interface ChefSectionContent {
  type: "text" | "step"
  value: string | ChefStep
}

interface ChefSection {
  name: string | null
  content: ChefSectionContent[]
}

interface ChefInlineQuantity {
  value: ChefQuantityValue
  unit: string | null
}

interface ChefOutput {
  name: string
  metadata: { map: Record<string, unknown> }
  sections: ChefSection[]
  ingredients: ChefIngredient[]
  cookware: ChefCookware[]
  timers: unknown[]
  inline_quantities: ChefInlineQuantity[]
}

function cleanNumber(num: number): string {
  return Number.isInteger(num) ? num.toString() : num.toString()
}

function extractQuantityValue(q: ChefQuantity): number | string {
  const v = q.value
  if (typeof v.value === "string") return v.value
  if (typeof v.value === "number") return v.value
  if (typeof v.value === "object" && "value" in v.value) return v.value.value
  return 0
}

function applyReferenceQuantities(ingredients: ChefIngredient[]): ChefIngredient[] {
  return ingredients.map((ingredient) => {
    const refs = ingredient.relation?.referenced_from ?? []
    if (refs.length === 0) return ingredient

    const baseVal = ingredient.quantity ? extractQuantityValue(ingredient.quantity) : null
    if (typeof baseVal !== "number") return ingredient

    let total = baseVal
    for (const refIdx of refs) {
      const ref = ingredients[refIdx]
      if (ref?.quantity) {
        const refVal = extractQuantityValue(ref.quantity)
        if (typeof refVal === "number") total += refVal
      }
    }

    if (total === baseVal) return ingredient

    return {
      ...ingredient,
      quantity: {
        value: { type: "number", value: total } as ChefQuantityValue,
        unit: ingredient.quantity?.unit ?? null,
      },
    }
  })
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase())
}

function renderIngredientRef(ingredient: ChefIngredient): string {
  const shortName = ingredient.name.includes("(")
    ? ingredient.name.split("(")[0].trim()
    : ingredient.name
  return `<span class='ingredient_ref'>${shortName}</span>`
}

function renderCookwareRef(cookware: ChefCookware): string {
  return `<span class='cookware_ref'>${cookware.name}</span>`
}

function renderTimerRef(item: ChefStepItem, inlineQuantities: ChefInlineQuantity[]): string {
  try {
    const timer = item.value as { quantity: { value: ChefQuantityValue; unit: string | null } }
    const val = typeof timer.quantity.value.value === "number"
      ? timer.quantity.value.value
      : (timer.quantity.value.value as { value: number }).value
    const unit = timer.quantity.unit ? ` ${timer.quantity.unit}` : ""
    return `<span class='timer_ref'>${cleanNumber(val)}${unit}</span>`
  } catch {
    return ""
  }
}

function renderStepContent(
  step: ChefStep,
  ingredients: ChefIngredient[],
  cookware: ChefCookware[],
  inlineQuantities: ChefInlineQuantity[],
): string {
  const parts: string[] = []

  for (const item of step.items) {
    switch (item.type) {
      case "text": {
        let text = item.value as string
        text = text.replace(/\b(?!(?:eq|vs|etc)\b)(\w+)\. (\w+)/g, "$1.<br/>$2")
        parts.push(text)
        break
      }
      case "ingredient": {
        const idx = item.index!
        if (idx >= 0 && idx < ingredients.length) {
          parts.push(renderIngredientRef(ingredients[idx]))
        }
        break
      }
      case "cookware": {
        const idx = item.index!
        if (idx >= 0 && idx < cookware.length) {
          parts.push(renderCookwareRef(cookware[idx]))
        }
        break
      }
      case "timer": {
        parts.push(renderTimerRef(item, inlineQuantities))
        break
      }
      case "inlineQuantity": {
        const idx = item.index!
        if (idx >= 0 && idx < inlineQuantities.length) {
          const iq = inlineQuantities[idx]
          const val = typeof iq.value.value === "number"
            ? iq.value.value
            : (iq.value.value as { value: number }).value
          const unit = iq.unit ? ` ${iq.unit}` : ""
          parts.push(`${cleanNumber(val)}${unit}`)
        }
        break
      }
    }
  }

  return parts.join("")
}

interface SectionData {
  name: string | null
  steps: { number: number; content: string }[]
  ingredientIndices: number[]
}

function buildSections(
  sections: ChefSection[],
  ingredients: ChefIngredient[],
  cookware: ChefCookware[],
  inlineQuantities: ChefInlineQuantity[],
): SectionData[] {
  const result: SectionData[] = []
  const usedIndicesGlobal = new Set<number>()

  for (const section of sections) {
    const sectionData: SectionData = {
      name: section.name,
      steps: [],
      ingredientIndices: [],
    }

    for (const item of section.content) {
      if (item.type !== "step") continue
      const step = item.value as ChefStep
      const content = renderStepContent(step, ingredients, cookware, inlineQuantities)
      sectionData.steps.push({ number: step.number, content })

      for (const si of step.items) {
        if (si.type === "ingredient" && si.index !== undefined) {
          usedIndicesGlobal.add(si.index)
          if (ingredients[si.index].modifiers !== "REF" && !sectionData.ingredientIndices.includes(si.index)) {
            sectionData.ingredientIndices.push(si.index)
          }
        }
      }
    }

    result.push(sectionData)
  }

  const allIndices = new Set(ingredients.map((_, i) => i))
  const unusedIndices = [...allIndices]
    .filter((i) => !usedIndicesGlobal.has(i) && ingredients[i].modifiers !== "REF")
    .sort()
  if (unusedIndices.length > 0) {
    result.push({
      name: result.length > 1 || (result.length === 1 && result[0].name) ? "General / Other" : null,
      steps: [],
      ingredientIndices: unusedIndices,
    })
  }

  return result
}

function renderIngredientItem(ingredient: ChefIngredient): string {
  const modifiers = ingredient.modifiers || ""
  const name = titleCase(ingredient.name)
  const lines: string[] = []

  lines.push("    <li>")
  lines.push("        <span>")
  lines.push(`            <span class="ingredient_modifiers">${modifiers}</span>`)
  lines.push(`            <span>${name}</span>`)
  lines.push("        </span>")

  if (ingredient.quantity) {
    const val = extractQuantityValue(ingredient.quantity)
    lines.push("        <span class='ing-qty'>")
    if (typeof val === "number") {
      const displayVal = cleanNumber(val)
      lines.push(`            <span class='scalable-value' data-base='${val}'>${displayVal}`)
    } else {
      lines.push(`            <span>${val}`)
    }
    lines.push("            </span>")
    if (ingredient.quantity.unit) {
      lines.push(`            <span class='unit'>${ingredient.quantity.unit}</span>`)
    }
    lines.push("        </span>")
  }

  lines.push("    </li>")
  return lines.join("\n")
}

function renderRecipe(data: ChefOutput, rawFrontmatter: string): string {
  const meta = data.metadata.map
  const servings = meta.servings ?? 1
  const servingsLabel = (meta.servings_label as string) || "Portions"
  const source = meta.source as string | undefined

  const effectiveIngredients = applyReferenceQuantities(data.ingredients)
  const sections = buildSections(data.sections, data.ingredients, data.cookware, data.inline_quantities)

  const lines: string[] = []

  // Frontmatter — pass through original keys verbatim
  lines.push("---")
  lines.push(rawFrontmatter)
  lines.push("---")
  lines.push("")

  // Meta row
  lines.push("<div class='meta-row'>")
  if (source) {
    lines.push("    <div>")
    lines.push(`        <span>Source: <a href="${source}">${source}</a></span>`)
    lines.push("    </div>")
  }
  lines.push('    <div class="servings-control">')
  lines.push(`        <span>${servingsLabel}:</span>`)
  lines.push(`        <button class="servings-btn" onclick="updateServings(-1)">−</button>`)
  lines.push(`        <span id="servings-display">${servings}</span>`)
  lines.push(`        <button class="servings-btn" onclick="updateServings(1)">+</button>`)
  lines.push("    </div>")
  lines.push("</div>")
  lines.push("")
  lines.push("")

  // Ingredients
  lines.push("## Ingredients")
  lines.push("")
  for (const section of sections) {
    if (section.ingredientIndices.length === 0) continue
    if (section.name) {
      lines.push(`### ${section.name}`)
      lines.push("")
    }
    lines.push("<ul class='ing-list'>")
    for (const idx of section.ingredientIndices) {
      lines.push(renderIngredientItem(effectiveIngredients[idx]))
    }
    lines.push("</ul>")
    lines.push("")
  }

  // Instructions
  lines.push("## Instructions")
  lines.push("")
  for (const section of sections) {
    if (section.steps.length === 0) continue
    if (section.name) {
      lines.push(`### ${section.name}`)
      lines.push("")
    }
    for (const step of section.steps) {
      lines.push("<div class='step-block'>")
      lines.push("")
      lines.push(`<span class='step-num'>${step.number}.</span> ${step.content}`)
      lines.push("")
      lines.push("</div>")
      lines.push("")
    }
    lines.push("")
  }

  return lines.join("\n")
}

export function convertCooklang(filePath: string, content: string): string {
  const name = filePath.replace(/.*\//, "").replace(/\.[^.]+$/, "")

  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const rawFm = fmMatch
    ? fmMatch[1]
        .split("\n")
        .filter((l) => !/^format:\s*cooklang\s*$/.test(l.trim()))
        .join("\n")
    : ""

  const stdout = execFileSync("chef", ["recipe", "--format=json", "--name", name], {
    input: content,
    encoding: "utf-8",
    timeout: 10_000,
  })
  const data: ChefOutput = JSON.parse(stdout)
  return renderRecipe(data, rawFm)
}
