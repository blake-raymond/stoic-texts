#!/usr/bin/env python3
"""Recompute word and token counts into manifest.json and the README table.

Word count: a maximal run of Unicode letters. An apostrophe between letters
stays inside the word. The count covers the file as stored, including the
id line and the headings.

Token count: tiktoken encodings named o200k_base and cl100k_base. Each file
is encoded on its own, as exact UTF-8 text, with no chat wrapper and no
added special tokens. A work total, a tier total, and the corpus total are
sums of those file counts. They are not the token count of the files
concatenated, because byte-pair encoding can merge across a file boundary.

    python scripts/count_tokens.py
    python scripts/count_tokens.py --check
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import tiktoken

sys.path.insert(0, str(Path(__file__).resolve().parent))

from corpus_lib import (  # noqa: E402
    COUNTS_END,
    COUNTS_START,
    MANIFEST_PATH,
    README_PATH,
    TIERS,
    iter_works,
    load_catalog,
    relative,
    word_count,
)

TOKENIZER_NAMES = ("o200k_base", "cl100k_base")

WORD_DEFINITION = (
    "A word is a maximal run of Unicode letters. An apostrophe between letters "
    "stays inside the word. Digits, underscores, and hyphens are boundaries. "
    "The count covers each file as stored, including its id line and headings."
)
TOKEN_DEFINITION = (
    "Each file is encoded on its own with tiktoken, as exact UTF-8 text, with "
    "no chat wrapper and no added special tokens. Work, tier, and corpus totals "
    "are sums of those file counts, not the token count of the files concatenated."
)


def encodings() -> dict:
    return {name: tiktoken.get_encoding(name) for name in TOKENIZER_NAMES}


def token_counts(text: str, encoders: dict) -> dict[str, int]:
    # Default encode() rejects special-token strings instead of inserting any.
    return {name: len(encoder.encode(text)) for name, encoder in encoders.items()}


def build_manifest() -> dict:
    catalog = load_catalog()
    encoders = encodings()
    works_out = []
    totals = {
        tier: {"works": 0, "files": 0, "word_count": 0, "tokens": {name: 0 for name in TOKENIZER_NAMES}}
        for tier in TIERS
    }
    overall = {"works": 0, "files": 0, "word_count": 0, "tokens": {name: 0 for name in TOKENIZER_NAMES}}
    for work in iter_works(catalog):
        words = 0
        tokens = {name: 0 for name in TOKENIZER_NAMES}
        files = []
        for path in work["paths"]:
            text = path.read_text(encoding="utf-8")
            words += word_count(text)
            counted = token_counts(text, encoders)
            for name in TOKENIZER_NAMES:
                tokens[name] += counted[name]
            files.append(relative(path))
        entry = {
            "id": work["id"],
            "author": work["author"],
            "title": work["title"],
            "translator": work["translator"],
            "year": work["year"],
            "source": work["source"],
            "license_basis": " ".join(work["license_basis"].split()),
            "tier": work["tier"],
            "numbering": " ".join(work["numbering"].split()),
            "files": files,
            "word_count": words,
            "tokens": tokens,
        }
        works_out.append(entry)
        bucket = totals[work["tier"]]
        bucket["works"] += 1
        bucket["files"] += len(files)
        bucket["word_count"] += words
        overall["works"] += 1
        overall["files"] += len(files)
        overall["word_count"] += words
        for name in TOKENIZER_NAMES:
            bucket["tokens"][name] += tokens[name]
            overall["tokens"][name] += tokens[name]
    return {
        "schema_version": 1,
        "word_count": WORD_DEFINITION,
        "token_count": TOKEN_DEFINITION,
        "tokenizers": {
            name: f"tiktoken encoding {name}" for name in TOKENIZER_NAMES
        },
        "works": works_out,
        "missing": catalog.get("missing", []),
        "totals": {**totals, "all": overall},
    }


def render_manifest(manifest: dict) -> str:
    return json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"


def _count(number: int, noun: str) -> str:
    return f"{number} {noun}" if number == 1 else f"{number} {noun}s"


def render_table(manifest: dict) -> str:
    lines = [
        "Word counts are Unicode letter-runs in each file as stored, including the id line and headings. Token counts are tiktoken encodings `o200k_base` and `cl100k_base`: each file encoded on its own, with no chat wrapper. A total is the sum of those file counts, not the token count of the files joined together.",
        "",
        "| Tier | Author | Title | Translator | Year | Words | o200k_base | cl100k_base |",
        "| --- | --- | --- | --- | ---: | ---: | ---: | ---: |",
    ]
    by_tier: dict[str, list[dict]] = {tier: [] for tier in TIERS}
    for work in manifest["works"]:
        by_tier[work["tier"]].append(work)
    for tier in TIERS:
        for work in by_tier[tier]:
            lines.append(
                "| {tier} | {author} | {title} | {translator} | {year} | {words} | {o200k} | {cl100k} |".format(
                    tier=tier,
                    author=work["author"],
                    title=work["title"],
                    translator=work["translator"],
                    year=work["year"],
                    words=f"{work['word_count']:,}",
                    o200k=f"{work['tokens']['o200k_base']:,}",
                    cl100k=f"{work['tokens']['cl100k_base']:,}",
                )
            )
        total = manifest["totals"][tier]
        lines.append(
            "| **{tier} total** | {works} | {files} |  |  | {words} | {o200k} | {cl100k} |".format(
                tier=tier,
                works=_count(total["works"], "work"),
                files=_count(total["files"], "file"),
                words=f"{total['word_count']:,}",
                o200k=f"{total['tokens']['o200k_base']:,}",
                cl100k=f"{total['tokens']['cl100k_base']:,}",
            )
        )
    overall = manifest["totals"]["all"]
    lines.append(
        "| **corpus total** | {works} | {files} |  |  | {words} | {o200k} | {cl100k} |".format(
            works=_count(overall["works"], "work"),
            files=_count(overall["files"], "file"),
            words=f"{overall['word_count']:,}",
            o200k=f"{overall['tokens']['o200k_base']:,}",
            cl100k=f"{overall['tokens']['cl100k_base']:,}",
        )
    )
    return "\n".join(lines)


def replace_table(readme: str, table: str) -> str:
    start = readme.find(COUNTS_START)
    end = readme.find(COUNTS_END)
    if start < 0 or end < 0 or end < start:
        raise RuntimeError("README is missing COUNTS markers")
    end += len(COUNTS_END)
    block = f"{COUNTS_START}\n\n{table}\n\n{COUNTS_END}"
    return readme[:start] + block + readme[end:]


def diff_message(manifest: dict) -> str | None:
    rendered = render_manifest(manifest)
    table = render_table(manifest)
    problems = []
    if not MANIFEST_PATH.is_file():
        problems.append("manifest.json is missing")
    elif MANIFEST_PATH.read_text(encoding="utf-8") != rendered:
        problems.append("manifest.json does not match a fresh count")
    readme = README_PATH.read_text(encoding="utf-8")
    try:
        updated = replace_table(readme, table)
    except RuntimeError as exc:
        problems.append(str(exc))
    else:
        if updated != readme:
            problems.append("the README counts table does not match a fresh count")
    if not problems:
        return None
    return "; ".join(problems)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit 1 if manifest.json or the README table disagree with a fresh count",
    )
    args = parser.parse_args()
    manifest = build_manifest()
    if args.check:
        message = diff_message(manifest)
        if message:
            print(message, file=sys.stderr)
            return 1
        print("counts match manifest.json and the README table")
        return 0
    MANIFEST_PATH.write_text(render_manifest(manifest), encoding="utf-8")
    readme = README_PATH.read_text(encoding="utf-8")
    README_PATH.write_text(replace_table(readme, render_table(manifest)), encoding="utf-8")
    overall = manifest["totals"]["all"]
    print(
        "wrote {files} files, {words} words, o200k_base {o200k}, cl100k_base {cl100k}".format(
            files=overall["files"],
            words=overall["word_count"],
            o200k=overall["tokens"]["o200k_base"],
            cl100k=overall["tokens"]["cl100k_base"],
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
