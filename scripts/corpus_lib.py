"""Shared readers for the Stoic corpus catalog and text files."""

from __future__ import annotations

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "catalog.yaml"
TEXT_ROOT = ROOT / "texts"
MANIFEST_PATH = ROOT / "manifest.json"
README_PATH = ROOT / "README.md"
TAGS_PATH = ROOT / "annotations" / "function-tags.jsonl"

COUNTS_START = "<!-- COUNTS:START -->"
COUNTS_END = "<!-- COUNTS:END -->"

# A word is a maximal run of Unicode letters. An apostrophe between letters
# stays inside the word, so "man's" is one word. Digits, underscores, and
# hyphens are boundaries.
WORD_RE = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)*", re.UNICODE)

FRONT_RE = re.compile(r"^---\nid: (\S+)\n---\n\n# .+\n\n", re.M)
SECTION_RE = re.compile(r"## (\S+)\n\n(.*)\Z", re.S)

TIERS = ("core", "foundations", "optional")


def load_catalog() -> dict:
    data = yaml.safe_load(CATALOG_PATH.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or "works" not in data:
        raise RuntimeError("catalog.yaml has no works list")
    return data


def resolve_files(entries: list[str]) -> list[Path]:
    found: list[Path] = []
    for entry in entries:
        if any(char in entry for char in "*?["):
            matches = sorted(ROOT.glob(entry))
            if not matches:
                raise RuntimeError(f"catalog glob matched nothing: {entry}")
            found.extend(matches)
        else:
            path = ROOT / entry
            if not path.is_file():
                raise RuntimeError(f"catalog file is missing: {entry}")
            found.append(path)
    unique: list[Path] = []
    seen: set[Path] = set()
    for path in found:
        if path not in seen:
            seen.add(path)
            unique.append(path)
    return unique


def iter_works(catalog: dict | None = None) -> list[dict]:
    """Return catalog works with resolved `paths`, in catalog order."""
    catalog = catalog or load_catalog()
    works = []
    claimed: dict[Path, str] = {}
    for work in catalog["works"]:
        paths = resolve_files(work["files"])
        for path in paths:
            previous = claimed.get(path)
            if previous:
                raise RuntimeError(f"{path} is claimed by both {previous} and {work['id']}")
            claimed[path] = work["id"]
        item = dict(work)
        item["paths"] = paths
        works.append(item)
    on_disk = sorted(TEXT_ROOT.rglob("*.md"))
    missing = [path for path in on_disk if path not in claimed]
    if missing:
        sample = ", ".join(str(path.relative_to(ROOT)) for path in missing[:5])
        raise RuntimeError(f"{len(missing)} text files are not in the catalog, including {sample}")
    return works


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def word_count(text: str) -> int:
    return len(WORD_RE.findall(text))


def passages(path: Path) -> list[tuple[str, str]]:
    """Return (passage id, prose) pairs.

    A file with `##` sections yields one passage per section. A file without
    them yields one passage, whose id is the file id. Headings are not part
    of the prose.
    """
    text = path.read_text(encoding="utf-8")
    match = FRONT_RE.match(text)
    if not match:
        raise RuntimeError(f"unrecognized front matter: {relative(path)}")
    file_id = match.group(1)
    rest = text[match.end() :]
    if rest.startswith("## ") or "\n## " in rest:
        found = []
        for chunk in re.split(r"\n(?=## )", rest):
            section = SECTION_RE.match(chunk)
            if not section:
                raise RuntimeError(f"unrecognized section in {relative(path)}")
            prose = section.group(2).strip("\n")
            if not prose.strip():
                raise RuntimeError(f"empty section {section.group(1)}")
            found.append((section.group(1), prose))
        return found
    prose = rest.strip("\n")
    if not prose.strip():
        raise RuntimeError(f"empty text file: {relative(path)}")
    return [(file_id, prose)]
