"""The committed corpus matches its catalog, counts, and tag schema."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from corpus_lib import (  # noqa: E402
    MANIFEST_PATH,
    TAGS_PATH,
    TEXT_ROOT,
    iter_works,
    load_catalog,
    passages,
    relative,
)
from count_tokens import diff_message, build_manifest  # noqa: E402
from tag_passages import TAG_ORDER, build_records, render  # noqa: E402

SECTION_RE = re.compile(r"^## (\S+)", re.M)


def test_every_manifest_file_exists_and_covers_the_tree():
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    listed = []
    for work in manifest["works"]:
        assert work["files"], work["id"]
        for name in work["files"]:
            path = ROOT / name
            assert path.is_file(), name
            listed.append(path)
    on_disk = sorted(TEXT_ROOT.rglob("*.md"))
    assert sorted(listed) == on_disk
    assert len(listed) == len(set(listed))


def test_counts_are_reproducible():
    message = diff_message(build_manifest())
    assert message is None, message


def test_tags_are_reproducible_and_marked_unreviewed():
    records, _summary = build_records()
    assert TAGS_PATH.is_file()
    assert TAGS_PATH.read_text(encoding="utf-8") == render(records)
    seen = set()
    passage_ids = {
        passage_id
        for work in iter_works()
        for path in work["paths"]
        for passage_id, _prose in passages(path)
    }
    for record in records:
        assert record["origin"] == "auto"
        assert record["status"] == "unreviewed"
        assert record["method"] == "keyword_heuristic"
        assert record["tags"]
        assert record["tags"] == [tag for tag in TAG_ORDER if tag in record["signals"]]
        assert set(record["signals"]) == set(record["tags"])
        assert record["id"] in passage_ids
        assert record["id"] not in seen
        seen.add(record["id"])
        for signals in record["signals"].values():
            assert signals
            assert all(isinstance(item, str) and item for item in signals)


def test_required_works_and_no_boilerplate():
    catalog = load_catalog()
    ids = [work["id"] for work in catalog["works"]]
    for required in (
        "marcus.meditations",
        "epictetus.discourses",
        "epictetus.enchiridion",
        "epictetus.fragments",
        "seneca.letters",
        "seneca.de_providentia",
        "seneca.de_ira",
        "seneca.de_clementia",
        "seneca.de_beneficiis",
        "cicero.de_officiis",
        "cicero.de_finibus.3",
        "cicero.de_natura_deorum.2",
        "diogenes.lives.7",
        "cleanthes.hymn_to_zeus",
        "seneca.naturales_quaestiones",
        "musonius.rufus",
    ):
        assert required in ids
    missing = {item["id"] for item in catalog["missing"]}
    assert {"cleomedes.caelestia", "early_stoic.fragments", "cicero.de_fato"} <= missing
    assert "musonius.rufus" not in missing
    tiers = {work["id"]: work["tier"] for work in catalog["works"]}
    assert tiers["seneca.naturales_quaestiones"] == "optional"
    assert tiers["cicero.de_finibus.3"] == "foundations"
    assert tiers["marcus.meditations"] == "core"
    for path in TEXT_ROOT.rglob("*.md"):
        text = path.read_text(encoding="utf-8").lower()
        assert "project gutenberg" not in text, relative(path)
        assert "standard ebooks" not in text, relative(path)


def test_edition_shape_and_openings():
    letters = list((TEXT_ROOT / "seneca" / "letters").glob("letter-*.md"))
    assert len(letters) == 124
    assert (TEXT_ROOT / "seneca" / "letters" / "letter-124.md").is_file()
    letter = (TEXT_ROOT / "seneca" / "letters" / "letter-001.md").read_text(encoding="utf-8")
    assert "Lucilius" in letter

    med = (TEXT_ROOT / "marcus-aurelius" / "meditations" / "book-01.md").read_text(encoding="utf-8")
    assert "From my grandfather Verus" in med
    assert "shamefastness" not in med
    assert "marcus.meditations.1.place" in med
    assert len(list((TEXT_ROOT / "marcus-aurelius" / "meditations").glob("book-*.md"))) == 12

    for book, count in ((1, 30), (2, 26), (3, 26), (4, 13)):
        folder = TEXT_ROOT / "epictetus" / "discourses" / f"book-{book:02d}"
        assert len(list(folder.glob("chapter-*.md"))) == count

    ench = (TEXT_ROOT / "epictetus" / "enchiridion" / "enchiridion.md").read_text(encoding="utf-8")
    assert "Of things some are in our power" in ench
    assert len(SECTION_RE.findall(ench)) == 52

    fragments = (TEXT_ROOT / "epictetus" / "fragments" / "fragments.md").read_text(encoding="utf-8")
    numbers = [int(item.split(".")[-1]) for item in SECTION_RE.findall(fragments)]
    assert numbers == list(range(1, 179))

    officiis = {
        1: 161,
        2: 89,
        3: 121,
    }
    for book, count in officiis.items():
        text = (TEXT_ROOT / "cicero" / "de-officiis" / f"book-{book:02d}.md").read_text(encoding="utf-8")
        found = [int(item.split(".")[-1]) for item in SECTION_RE.findall(text)]
        assert found == list(range(1, count + 1))
    assert "My dear son Marcus" in (TEXT_ROOT / "cicero" / "de-officiis" / "book-01.md").read_text(encoding="utf-8")

    finibus = (TEXT_ROOT / "cicero" / "de-finibus" / "book-03.md").read_text(encoding="utf-8")
    assert "Pleasure" in finibus and "Virtue" in finibus
    assert "Balbus" in (TEXT_ROOT / "cicero" / "de-natura-deorum" / "book-02.md").read_text(encoding="utf-8")
    assert "Mnaseas" in (TEXT_ROOT / "diogenes-laertius" / "book-7" / "zeno.md").read_text(encoding="utf-8")

    hymn = (TEXT_ROOT / "cleanthes" / "hymn-to-zeus" / "hymn.md").read_text(encoding="utf-8")
    assert "Most glorious of Immortals" in hymn
    assert not any(re.search(r"\d", line) for line in hymn.splitlines())

    nq_chapters = {1: 17, 2: 59, 3: 30, 4: 13, 5: 18, 6: 32, 7: 32}
    for book, count in nq_chapters.items():
        text = (TEXT_ROOT / "seneca" / "natural-questions" / f"book-{book:02d}.md").read_text(encoding="utf-8")
        ids = SECTION_RE.findall(text)
        chapters = [item for item in ids if not item.endswith(".preface")]
        assert len(chapters) == count
        assert "NOTES ON SENECA" not in text
    assert "Lucilius" in (TEXT_ROOT / "seneca" / "natural-questions" / "book-01.md").read_text(encoding="utf-8")

    mus_lectures = list((TEXT_ROOT / "musonius-rufus" / "lectures").glob("lecture-*.md"))
    assert len(mus_lectures) == 24
    mus_fr = (TEXT_ROOT / "musonius-rufus" / "fragments" / "fragments.md").read_text(encoding="utf-8")
    mus_ids = SECTION_RE.findall(mus_fr)
    assert mus_ids == [f"musonius.rufus.{n}" for n in range(22, 54)]
    assert "provided that point is sound" in (TEXT_ROOT / "musonius-rufus" / "lectures" / "lecture-01.md").read_text(encoding="utf-8")



def test_passage_ids_are_unique():
    seen = []
    for work in iter_works():
        for path in work["paths"]:
            for passage_id, prose in passages(path):
                seen.append(passage_id)
                assert prose.strip()
    assert len(seen) == len(set(seen))
