"""The Old Counsel prompt is the persona, source set F, then the reminder."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from build_prompt import (  # noqa: E402
    DISCOURSE_BOOKS,
    LETTER_NUMBERS,
    MEMORY_HEADER,
    META_PATH,
    PERSONA_PATH,
    REMINDER_PATH,
    SET_F,
    build_meta,
    diff_message,
    load_works,
    select_files,
    source_text_f,
    system_prompt,
)


def test_meta_matches_the_texts():
    assert diff_message(build_meta()) is None
    meta = json.loads(META_PATH.read_text(encoding="utf-8"))
    assert meta["source_f"]["characters"] == 992644
    assert meta["source_f"]["o200k_tokens"] == 225271
    assert meta["model"] == "google/gemini-3.6-flash"
    assert meta["temperature"] == 0.7
    assert [item["id"] for item in meta["works"]] == [work_id for work_id, _mode in SET_F]


def test_system_prompt_order_matches_the_runner():
    persona = PERSONA_PATH.read_text(encoding="utf-8")
    reminder = REMINDER_PATH.read_text(encoding="utf-8")
    source, report = source_text_f()
    prompt = system_prompt(source)
    assert prompt == persona + "\n\n" + MEMORY_HEADER + source + "\n\n" + reminder
    assert prompt.startswith(persona)
    assert prompt.endswith(reminder)
    assert MEMORY_HEADER in prompt
    ids = [item["id"] for item in report]
    positions = [prompt.index(f"===== {item['author']}, {item['title']}") for item in report]
    assert positions == sorted(positions)
    assert ids[0] == "epictetus.enchiridion"
    assert ids[-1] == "seneca.de_tranquillitate"


def test_set_f_is_the_public_domain_selection():
    works = load_works()
    source, report = source_text_f(works)
    by_id = {item["id"]: item for item in report}

    discourses = select_files(works["epictetus.discourses"], "discourses")
    assert discourses
    assert all(DISCOURSE_BOOKS.search(name) for name in discourses)
    assert not any("book-02/" in name or "book-04/" in name for name in discourses)
    assert by_id["epictetus.discourses"]["files"] == 56

    letters = select_files(works["seneca.letters"], "letters")
    numbers = sorted(int(name.rsplit("letter-", 1)[1].removesuffix(".md")) for name in letters)
    assert tuple(numbers) == tuple(sorted(LETTER_NUMBERS))
    assert by_id["seneca.letters"]["files"] == 15

    musonius = works["musonius.rufus"]
    assert musonius["translator"] == "Blake Raymond"
    assert "Lutz" not in source
    assert "lutz" not in source.lower()
    assert "Blake Raymond" in source
    assert by_id["musonius.rufus"]["files"] == len(musonius["files"])
