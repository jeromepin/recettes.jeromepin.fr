#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "minijinja",
# ]
# ///
import dataclasses
import json
import pathlib
import re
import subprocess
import sys
import textwrap
from typing import Any

import minijinja

GIT_ROOT = pathlib.Path(__file__).parent
RECIPES_DIR = GIT_ROOT / "recettes"
CONTENT_DIR = GIT_ROOT / "content"


def clean_number(num: float | int | str) -> str:
    """
    Formats a number to remove trailing zeros (e.g., 75.0 -> 75).
    """
    try:
        f_num = float(num)
        if f_num.is_integer():
            return str(int(f_num))
        return str(f_num)
    except (ValueError, TypeError):
        return str(num)


class Metadata:
    def __init__(self, data: dict[str, Any]):
        self.title: str = data["title"]
        self.servings: int = self._parse_servings(data.get("servings", 1))
        self.tags: list[str] = self._parse_tags(data.get("tags", []))
        self.source: str = data.get("source")
        self.cooking_time: str | None = data.get("time", {}).get("cook")
        self.preping_time: str | None = data.get("time", {}).get("prep")

    def _parse_servings(self, val: Any) -> int:
        try:
            return int(val)
        except (ValueError, TypeError):
            return 1

    def _parse_tags(self, val: Any) -> list[str]:
        if isinstance(val, str):
            return [t.strip() for t in val.split(",")]
        elif isinstance(val, list):
            return val
        return []


@dataclasses.dataclass
class Ingredient:
    @dataclasses.dataclass
    class Quantity:
        unit: str
        _type: str
        value: Any

        @staticmethod
        def from_dict(raw_quantity: dict[str, Any]) -> "Ingredient.Quantity":
            return Ingredient.Quantity(
                unit=raw_quantity["unit"],
                _type=raw_quantity["value"]["type"],
                value=raw_quantity["value"]["value"]["value"]
                if "value" in raw_quantity["value"]["value"]
                else raw_quantity["value"]["value"],
            )

    name: str
    _alias: str | None = None
    quantity: Quantity | None = None
    note: str | None = None
    modifiers: str | None = None

    @staticmethod
    def from_dict(raw_ingredient: dict[str, Any]) -> "Ingredient":
        return Ingredient(
            name=raw_ingredient["name"],
            _alias=raw_ingredient.get("alias"),
            quantity=Ingredient.Quantity.from_dict(raw_ingredient["quantity"])
            if raw_ingredient["quantity"]
            else None,
            note=raw_ingredient.get("note"),
            modifiers=raw_ingredient.get("modifiers"),
        )

    def render_inline(self) -> str:
        """Renders the ingredient as a span for use inside steps."""
        # TODO: Consider using tooltip : https://www.w3schools.com/css/css_tooltip.asp
        return f"<span class='ingredient_ref'>{self.name}</span>"


class Cookware:
    def __init__(self, data: dict[str, Any]):
        self.name = data.get("name", "Unknown")

    def render_inline(self) -> str:
        return f"<span class='cookware_ref'>{self.name}</span>"


class Step:
    def __init__(
        self,
        data: dict[str, Any],
        ingredients_list: list[Ingredient],
        cookware_list: list[Cookware],
    ):
        self.number = data.get("value", {}).get("number", 0)
        self.items_data = data.get("value", {}).get("items", [])
        self.ingredients_master = ingredients_list
        self.cookware_master = cookware_list

        # Track which ingredients are used in this step
        self.used_ingredient_indices: list[int] = []
        self._analyze_usage()
        self.content = self.render()

    def _analyze_usage(self):
        for item in self.items_data:
            if item.get("type") == "ingredient":
                idx = item.get("index")
                if idx is not None:
                    self.used_ingredient_indices.append(idx)

    def render(self) -> str:
        p_content = []
        for item in self.items_data:
            itype = item.get("type")

            if itype == "text":
                text = item["value"]
                if "." in text:
                    # Replace `WORD. WORD` with `WORD.\nWORD` to make longer steps easier to read
                    text = re.sub(
                        r"\b(?!(?:eq|vs|etc)\b)(\w+)\. (\w+)", r"\1.<br/>\2", text
                    )
                p_content.append(text)

            elif itype == "ingredient":
                idx = item["index"]
                if 0 <= idx < len(self.ingredients_master):
                    p_content.append(self.ingredients_master[idx].render_inline())
                else:
                    p_content.append("??")

            elif itype == "cookware":
                idx = item["index"]
                if 0 <= idx < len(self.cookware_master):
                    p_content.append(self.cookware_master[idx].render_inline())

            elif itype == "timer":
                try:
                    t_val = item["value"]["quantity"]["value"]["value"]["value"]
                    t_unit = item["value"]["quantity"]["unit"]
                    # Timers usually have units, but we safeguard just in case
                    unit_str = f" {t_unit}" if t_unit else ""
                    p_content.append(
                        f"<span class='timer_ref'>{clean_number(t_val)}{unit_str}</span>"
                    )
                except:
                    pass

        p_content = ["<li>"] + p_content + ["</li>"]

        return textwrap.dedent("".join(p_content))


class Section:
    def __init__(
        self,
        name: str | None,
        steps_data: list[dict[str, Any]],
        all_ingredients: list[Ingredient],
        all_cookware: list[Cookware],
    ):
        self.name = name
        self.steps: list[Step] = []
        self.used_ingredient_indices: list[int] = []

        # Parse steps
        for s_data in steps_data:
            if s_data.get("type") == "step":
                step = Step(s_data, all_ingredients, all_cookware)
                self.steps.append(step)
                self.used_ingredient_indices.extend(step.used_ingredient_indices)

        # Deduplicate indices
        self.used_ingredient_indices = list(dict.fromkeys(self.used_ingredient_indices))
        self.ingredients = [
            all_ingredients[idx] for idx in self.used_ingredient_indices
        ]


class Recipe:
    def __init__(self, json_data: dict[str, Any]):
        self.metadata = Metadata(json_data["metadata"]["map"])

        self.ingredients = [
            Ingredient.from_dict(i) for i in json_data.get("ingredients", [])
        ]

        # Parse Cookware
        self.cookware = [Cookware(c) for c in json_data.get("cookware", [])]

        # Parse Sections
        self.sections: list[Section] = []
        raw_sections = json_data.get("sections", [])
        used_indices_set = set()

        for sec_data in raw_sections:
            section = Section(
                sec_data.get("name"),
                sec_data.get("content", []),
                self.ingredients,
                self.cookware,
            )
            self.sections.append(section)
            used_indices_set.update(section.used_ingredient_indices)

        # Handle Orphans (Ingredients not used in any step)
        all_indices = set(range(len(self.ingredients)))
        unused_indices = sorted(list(all_indices - used_indices_set))

        if unused_indices:
            # Create a virtual section for orphans
            orphan_section = Section(
                "General / Other", [], self.ingredients, self.cookware
            )
            orphan_section.used_ingredient_indices = unused_indices

            # If we only have one section and it's nameless, merge; otherwise append
            if len(self.sections) == 1 and self.sections[0].name is None:
                # Actually, usually better to just append as 'General' if there are steps
                # or if the first section is just steps, assume these ingredients belong to it?
                # For simplicity, we append a new section.
                self.sections.append(orphan_section)
            elif not self.sections:
                orphan_section.name = None
                self.sections.append(orphan_section)
            else:
                self.sections.append(orphan_section)

    def render_html(self) -> str:
        # has_multiple_sections = len([s for s in self.sections if s.name]) > 0

        env = minijinja.Environment(templates={"recipe": open("template.jinja").read()})
        result = env.render_template(
            "recipe",
            title=self.metadata.title,
            tags=self.metadata.tags,
            source=self.metadata.source,
            servings=self.metadata.servings,
            sections=self.sections,
        )

        return result


if __name__ == "__main__":
    raw_recipes_paths = (
        [pathlib.Path(sys.argv[1]).absolute()]
        if len(sys.argv) > 1
        else RECIPES_DIR.glob("**/*.cook")
    )
    for recipe_path in raw_recipes_paths:
        json_content = subprocess.run(
            ["chef", "recipe", "--format=json", recipe_path], capture_output=True
        ).stdout.decode("utf-8")

        filename = recipe_path.name
        final_directory = pathlib.Path(
            str(recipe_path.parent).replace(str(RECIPES_DIR), str(CONTENT_DIR))
        )
        final_directory.mkdir(parents=True, exist_ok=True)

        print(f"Parsing '{filename}'")
        # print(json_content)

        recipe = Recipe(json.loads(json_content))

        with open(final_directory / (filename.replace(".cook", ".md")), "w") as fd:
            fd.write(recipe.render_html())
