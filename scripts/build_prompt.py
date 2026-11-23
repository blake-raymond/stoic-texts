#!/usr/bin/env python3
"""Assemble the Old Counsel system prompt from this repository.

The production prompt is three pieces, in this order:

1. prompt/persona_v22.md
2. Source text set F, the writings named below
3. prompt/persona_v22_reminder.md

Set F and the passage formatting follow the eval builder that produced the
prompt the model actually saw. Between the persona and the source text is
one header line. The model was google/gemini-3.6-flash on OpenRouter, at
temperature 0.7. This script does not call the model and reads no API key.

    python scripts/build_prompt.py
    python scripts/build_prompt.py --check

The assembled text is written to prompt/out/ and is not committed. It repeats
the texts already in texts/. prompt/meta.json records the measured size.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import tiktoken

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "manifest.json"
PERSONA_PATH = ROOT / "prompt" / "persona_v22.md"
REMINDER_PATH = ROOT / "prompt" / "persona_v22_reminder.md"
META_PATH = ROOT / "prompt" / "meta.json"
OUT_DIR = ROOT / "prompt" / "out"

# The eval runner placed this line between the persona and the source text.
MEMORY_HEADER = (
    "# Your memory: the writings of the Stoics "
    "(old public-domain translations; never quote or cite them)\n"
)

# Discourses books 1 and 3 only, so the Seneca selections fit the window.
DISCOURSE_BOOKS = re.compile(r"book-0[13]/")

# Seneca letters in set F. The rest of the 124 stay in the corpus and out of the prompt.
LETTER_NUMBERS = (1, 2, 5, 7, 13, 16, 18, 24, 28, 47, 65, 78, 104, 107, 123)

# Explicit order. This is not catalog order.
SET_F = (
    ("epictetus.enchiridion", None),
    ("epictetus.discourses", "discourses"),
    ("musonius.rufus", None),
    ("marcus.meditations", None),
    ("seneca.letters", "letters"),
    ("seneca.de_brevitate_vitae", None),
    ("seneca.de_tranquillitate", None),
)

MODEL = "google/gemini-3.6-flash"
TEMPERATURE = 0.7


def load_works() -> dict[str, dict]:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return {work["id"]: work for work in manifest["works"]}


def passages(path: Path) -> list[tuple[str, str]]:
    """Split one corpus file the way the eval builder did.

    A file with no '##' heading is one passage, and its markdown title stays
    in the text. A file with '##' headings yields one passage per heading.
    The file id is kept only when prose sits above the first heading.
    """
    text = path.read_text(encoding="utf-8")
    file_id = re.search(r"^id:\s*(\S+)", text, re.M)
    if not file_id:
        raise RuntimeError(f"no id in front matter: {path}")
    body = re.sub(r"^---.*?---\s*", "", text, count=1, flags=re.S)
    parts = re.split(r"^## (\S+)\s*$", body, flags=re.M)
    found: list[tuple[str, str]] = []
    head = parts[0].strip()
    if len(parts) == 1:
        found.append((file_id.group(1), head))
        return found
    if re.sub(r"^#.*$", "", head, flags=re.M).strip():
        found.append((file_id.group(1), head))
    for index in range(1, len(parts), 2):
        found.append((parts[index], parts[index + 1].strip()))
    return found


def select_files(work: dict, mode: str | None) -> list[str]:
    files = list(work["files"])
    if mode is None:
        return files
    if mode == "discourses":
        return [name for name in files if DISCOURSE_BOOKS.search(name)]
    if mode == "letters":
        chosen = []
        for name in files:
            match = re.search(r"letter-(\d+)", name)
            if match and int(match.group(1)) in LETTER_NUMBERS:
                chosen.append(name)
        return chosen
    raise RuntimeError(f"unknown file selection: {mode}")


def work_block(work: dict, files: list[str]) -> str:
    lines = [
        f"\n===== {work['author']}, {work['title']} "
        f"(tr. {work.get('translator', '?')}, {work.get('year', '?')}) =====\n"
    ]
    for name in files:
        for passage_id, passage in passages(ROOT / name):
            lines.append(f"[{passage_id}]\n{passage}\n")
    return "\n".join(lines)


def source_text_f(works: dict[str, dict] | None = None) -> tuple[str, list[dict]]:
    works = works or load_works()
    blocks = []
    report = []
    for work_id, mode in SET_F:
        work = works[work_id]
        files = select_files(work, mode)
        if not files:
            raise RuntimeError(f"set F selected no files for {work_id}")
        block = work_block(work, files)
        blocks.append(block)
        passage_count = sum(len(passages(ROOT / name)) for name in files)
        report.append(
            {
                "id": work_id,
                "author": work["author"],
                "title": work["title"],
                "translator": work["translator"],
                "year": work["year"],
                "files": len(files),
                "passages": passage_count,
            }
        )
    return "".join(blocks), report


def system_prompt(source: str | None = None) -> str:
    """Persona, then the source text, then the reminder. Same join as the runner."""
    persona = PERSONA_PATH.read_text(encoding="utf-8")
    reminder = REMINDER_PATH.read_text(encoding="utf-8")
    if source is None:
        source, _report = source_text_f()
    return persona + "\n\n" + MEMORY_HEADER + source + "\n\n" + reminder


def build_meta() -> dict:
    source, report = source_text_f()
    prompt = system_prompt(source)
    encoder = tiktoken.get_encoding("o200k_base")
    return {
        "set": "F",
        "model": MODEL,
        "temperature": TEMPERATURE,
        "route": "openrouter",
        "assembly": [
            "prompt/persona_v22.md",
            "source text F",
            "prompt/persona_v22_reminder.md",
        ],
        "header": MEMORY_HEADER.rstrip("\n"),
        "source_f": {
            "characters": len(source),
            "o200k_tokens": len(encoder.encode(source)),
        },
        "system_prompt": {
            "characters": len(prompt),
            "o200k_tokens": len(encoder.encode(prompt)),
        },
        "works": report,
    }


def write_outputs(meta: dict) -> None:
    source, _report = source_text_f()
    prompt = system_prompt(source)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "source-f.txt").write_text(source, encoding="utf-8")
    (OUT_DIR / "system.txt").write_text(prompt, encoding="utf-8")
    (OUT_DIR / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    META_PATH.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")


def diff_message(meta: dict) -> str | None:
    if not META_PATH.is_file():
        return "prompt/meta.json is missing. Run python scripts/build_prompt.py"
    committed = json.loads(META_PATH.read_text(encoding="utf-8"))
    if committed != meta:
        return "prompt/meta.json does not match the texts. Run python scripts/build_prompt.py"
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Assemble the Old Counsel system prompt.")
    parser.add_argument("--check", action="store_true", help="fail if prompt/meta.json is stale")
    args = parser.parse_args()
    meta = build_meta()
    if args.check:
        message = diff_message(meta)
        if message:
            print(message, file=sys.stderr)
            return 1
        print("prompt/meta.json matches")
        return 0
    write_outputs(meta)
    source = meta["source_f"]
    full = meta["system_prompt"]
    print(
        f"set F: {source['characters']} characters, {source['o200k_tokens']} o200k tokens"
    )
    print(
        f"system prompt: {full['characters']} characters, {full['o200k_tokens']} o200k tokens"
    )
    print(f"wrote {OUT_DIR.relative_to(ROOT)} and prompt/meta.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
