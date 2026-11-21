#!/usr/bin/env python3
"""Apply a conservative keyword heuristic to passage prose.

Writes annotations/function-tags.jsonl. Every record is origin=auto,
status=unreviewed, method=keyword_heuristic. Passages the lexicon misses
are left out. Absence is not a negative label, and there is no confidence
score. The rules live in this file; schema/function-tags.md explains them.

    python scripts/tag_passages.py
    python scripts/tag_passages.py --check
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from corpus_lib import TAGS_PATH, iter_works, passages, relative  # noqa: E402

TAG_ORDER = (
    "ethical_claim",
    "psychology",
    "human_nature",
    "cosmic_justification",
    "natural_science",
)

# A phrase match is enough on its own. A word match counts only toward the
# `min_words` threshold. Matching is case-insensitive. Phrases are substrings;
# words use boundaries, so "vice" does not match inside another word.
RULES: dict[str, dict] = {
    "ethical_claim": {
        "phrases": (
            "according to nature",
            "contrary to nature",
            "in our power",
            "not in our power",
            "chief good",
            "moral good",
            "supreme good",
            "the honourable",
            "the honorable",
            "right action",
            "good man",
            "good men",
        ),
        "words": (
            "virtue",
            "virtues",
            "vice",
            "vices",
            "duty",
            "duties",
            "justice",
            "injustice",
            "honourable",
            "honorable",
            "wicked",
            "temperance",
            "courage",
            "piety",
        ),
        "min_words": 2,
    },
    "psychology": {
        "phrases": (
            "the passions",
            "freedom from passion",
            "first movements",
        ),
        "words": (
            "anger",
            "fear",
            "grief",
            "desire",
            "desires",
            "appetite",
            "passion",
            "passions",
            "impression",
            "impressions",
            "assent",
            "impulse",
            "anxiety",
            "perturbation",
            "emotion",
            "emotions",
            "pleasure",
            "pain",
            "aversion",
        ),
        "min_words": 2,
    },
    "human_nature": {
        "phrases": (
            "human nature",
            "nature of man",
            "man's nature",
            "rational animal",
            "political animal",
            "social being",
            "born for",
            "common fellowship",
            "natural affection",
            "oikeiosis",
            "self-preservation",
            "dear to himself",
            "endowed with reason",
            "gift of reason",
            "seed of reason",
            "kinship",
            "kindred",
        ),
        "words": (),
        "min_words": 99,
    },
    "cosmic_justification": {
        "phrases": (
            "providence",
            "universal law",
            "divine reason",
            "world-soul",
            "world soul",
            "the cosmos",
            "nature of the universe",
        ),
        "words": ("fate", "zeus", "cosmos", "universe"),
        "min_words": 2,
    },
    "natural_science": {
        # Outside Natural Questions, two high-precision words are required.
        # Inside it, one high-precision word plus any second science word is enough.
        "high": (
            "comet",
            "comets",
            "eclipse",
            "rainbow",
            "earthquake",
            "earthquakes",
            "planet",
            "planets",
            "meteor",
            "meteors",
            "constellation",
            "solstice",
            "halo",
            "thunderbolt",
            "lightning",
            "volcano",
        ),
        "low": (
            "thunder",
            "hail",
            "tide",
            "tides",
            "star",
            "stars",
            "moon",
            "sun",
            "cloud",
            "clouds",
            "rain",
            "wind",
            "winds",
            "nile",
            "flood",
            "floods",
        ),
    },
}

WORD_RE = {word: re.compile(rf"\b{re.escape(word)}\b") for rule in RULES.values() for word in (*rule.get("words", ()), *rule.get("high", ()), *rule.get("low", ()))}


def find_phrases(text: str, phrases: tuple[str, ...]) -> list[str]:
    return [phrase for phrase in phrases if phrase in text]


def find_words(text: str, words: tuple[str, ...]) -> list[str]:
    return [word for word in words if WORD_RE[word].search(text)]


def classify(prose: str, work_id: str) -> dict[str, list[str]]:
    text = prose.lower()
    found: dict[str, list[str]] = {}
    for tag in ("ethical_claim", "psychology", "human_nature", "cosmic_justification"):
        rule = RULES[tag]
        phrases = find_phrases(text, rule["phrases"])
        words = find_words(text, rule["words"])
        if phrases or len(words) >= rule["min_words"]:
            signals = phrases + [word for word in words if word not in phrases]
            if signals:
                found[tag] = signals
    high = find_words(text, RULES["natural_science"]["high"])
    low = find_words(text, RULES["natural_science"]["low"])
    science = high + low
    if work_id == "seneca.naturales_quaestiones":
        science_hit = len(high) >= 1 and len(science) >= 2
    else:
        science_hit = len(high) >= 2
    if science_hit:
        found["natural_science"] = science
    return found


def build_records() -> tuple[list[dict], dict]:
    records = []
    passage_count = 0
    for work in iter_works():
        for path in work["paths"]:
            for passage_id, prose in passages(path):
                passage_count += 1
                signals = classify(prose, work["id"])
                if not signals:
                    continue
                records.append(
                    {
                        "id": passage_id,
                        "work_id": work["id"],
                        "tags": [tag for tag in TAG_ORDER if tag in signals],
                        "method": "keyword_heuristic",
                        "status": "unreviewed",
                        "origin": "auto",
                        "signals": {tag: signals[tag] for tag in TAG_ORDER if tag in signals},
                    }
                )
    summary = {"passages": passage_count, "tagged": len(records)}
    for tag in TAG_ORDER:
        summary[tag] = sum(1 for record in records if tag in record["tags"])
    return records, summary


def render(records: list[dict]) -> str:
    return "".join(json.dumps(record, ensure_ascii=False, separators=(", ", ": ")) + "\n" for record in records)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="exit 1 if the jsonl is stale")
    args = parser.parse_args()
    records, summary = build_records()
    rendered = render(records)
    if args.check:
        if not TAGS_PATH.is_file() or TAGS_PATH.read_text(encoding="utf-8") != rendered:
            print("annotations/function-tags.jsonl does not match a fresh tagging run", file=sys.stderr)
            return 1
        print(f"tags match ({summary['tagged']} of {summary['passages']} passages)")
        return 0
    TAGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    TAGS_PATH.write_text(rendered, encoding="utf-8")
    parts = [f"{summary[tag]} {tag}" for tag in TAG_ORDER]
    print(
        f"wrote {summary['tagged']} of {summary['passages']} passages: " + ", ".join(parts)
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
