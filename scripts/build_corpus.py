#!/usr/bin/env python3
"""Build the cleaned public-domain Stoic corpus from local source files.

Sources (downloaded separately; see README):

- Standard Ebooks EPUBs (CC0 editorial layer on the named public-domain
  translations) for Marcus, Epictetus' Discourses, Seneca's letters, Seneca's
  dialogues including On Benefits and On Clemency, and Diogenes Laertius.
- Project Gutenberg plain texts, boilerplate removed, for Cicero and for
  Seneca's Natural Questions.
- Wikisource rendered text of George Long's 1877 Encheiridion and Fragments,
  and of E. H. Blakeney's 1921 Hymn of Cleanthes. Translator endnotes are dropped.

The script writes only the translation, split at the edition's own divisions.
It does not copy introductions, commentaries, indexes, or textual notes.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
WIKI_API = "https://en.wikisource.org/w/api.php"
USER_AGENT = "stoic-texts-corpus/1.0 (public-domain corpus; attribution in manifest)"

ROMAN_VALUES = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}

EN_WORDS = {
    "the", "and", "of", "to", "that", "his", "he", "with", "which", "from",
    "this", "for", "not", "are", "was", "be", "you", "we", "it", "is", "have",
    "has", "by", "as", "or", "an", "their", "they", "who", "but", "man", "men",
    "a", "in", "on", "our", "your", "would", "should", "than", "what",
}
LAT_WORDS = {
    "est", "sunt", "quod", "quae", "quam", "etiam", "enim", "atque", "autem",
    "igitur", "quidem", "esse", "sit", "quoniam", "tamen", "nec", "neque",
    "qui", "sed", "aut", "vel", "iam", "ac", "nam", "cum", "ut", "non", "ad",
    "ex", "per", "si", "hoc", "haec", "ille", "illa", "quid", "ne", "se",
}


def roman_to_int(token: str) -> int:
    total = 0
    prev = 0
    for ch in reversed(token.upper()):
        value = ROMAN_VALUES[ch]
        if value < prev:
            total -= value
        else:
            total += value
            prev = value
    return total


def clean_inline(text: str) -> str:
    text = (
        text.replace("\u2060", "")
        .replace("\ufeff", "")
        .replace("\u200b", "")
        .replace("\xa0", " ")
    )
    text = text.replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    return text.strip()


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def epub_type(el: ET.Element) -> str:
    for key, value in el.attrib.items():
        if key.endswith("type"):
            return value
    return ""


def element_text(el: ET.Element) -> str:
    parts: list[str] = []

    def walk(node: ET.Element) -> None:
        if not isinstance(node.tag, str):
            return
        name = local_name(node.tag)
        if name in {"script", "style"}:
            return
        if name == "a" and "noteref" in epub_type(node):
            return
        if node.text:
            parts.append(node.text)
        for child in list(node):
            if local_name(child.tag) == "br":
                parts.append("\n")
            else:
                walk(child)
            if child.tail:
                parts.append(child.tail)

    walk(el)
    return clean_inline("".join(parts))


def direct_children(el: ET.Element, name: str) -> list[ET.Element]:
    return [child for child in list(el) if local_name(child.tag) == name]


def find_all(el: ET.Element, name: str) -> list[ET.Element]:
    return [node for node in el.iter() if local_name(node.tag) == name]


def write_markdown(path: Path, file_id: str, title: str, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = f"---\nid: {file_id}\n---\n\n# {title}\n\n{body.strip()}\n"
    path.write_text(text, encoding="utf-8")


def section_block(section_id: str, paragraphs: list[str]) -> str:
    prose = "\n\n".join(p for p in paragraphs if p.strip())
    return f"## {section_id}\n\n{prose}"


def unzip_epub(epub_path: Path, dest: Path) -> Path:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    with zipfile.ZipFile(epub_path) as archive:
        archive.extractall(dest)
    return dest


def xhtml_root(path: Path) -> ET.Element:
    # Standard Ebooks XHTML is well-formed XML.
    return ET.parse(path).getroot()


def chapter_sections(path: Path) -> list[ET.Element]:
    root = xhtml_root(path)
    body = find_all(root, "body")[0]
    top = direct_children(body, "section")
    if not top:
        raise RuntimeError(f"no section in {path}")
    nested = [child for child in list(top[0]) if local_name(child.tag) == "section"]
    return nested or top


def is_title_paragraph(node: ET.Element) -> bool:
    tokens = epub_type(node).split()
    return any(token == "title" or token.endswith(":title") for token in tokens)


def paragraphs_of(section: ET.Element) -> list[str]:
    paragraphs: list[str] = []
    for node in section.iter():
        if local_name(node.tag) != "p":
            continue
        if "noteref" in epub_type(node) or is_title_paragraph(node):
            continue
        text = element_text(node)
        if text:
            paragraphs.append(text)
    return paragraphs


def title_paragraph(section: ET.Element) -> str:
    for node in section.iter():
        if local_name(node.tag) == "p" and epub_type(node).split()[-1:] == ["title"]:
            return element_text(node)
    return ""


def heading_text(section: ET.Element, level: str) -> str:
    for node in list(section):
        if local_name(node.tag) == level:
            return element_text(node)
        if local_name(node.tag) == "hgroup":
            for child in list(node):
                if local_name(child.tag) == level:
                    return element_text(child)
    return ""


def build_meditations(epub_text: Path, out_root: Path) -> None:
    folder = out_root / "marcus-aurelius" / "meditations"
    books = sorted(epub_text.glob("book-*.xhtml"), key=lambda p: int(p.stem.split("-")[1]))
    if len(books) != 12:
        raise RuntimeError(f"expected 12 meditation books, found {len(books)}")
    place_re = re.compile(r"^(among the quadi\b|this in carnuntum\b)", re.I)
    for path in books:
        book_no = int(path.stem.split("-")[1])
        root = xhtml_root(path)
        section = find_all(root, "section")[0]
        paragraphs = []
        for node in list(section):
            if local_name(node.tag) != "p":
                continue
            text = element_text(node)
            if text:
                paragraphs.append(text)
        if not paragraphs:
            raise RuntimeError(f"empty meditations book {book_no}")
        blocks = []
        body = paragraphs
        place = None
        if place_re.match(paragraphs[-1]):
            place = paragraphs[-1]
            body = paragraphs[:-1]
        for index, paragraph in enumerate(body, start=1):
            blocks.append(section_block(f"marcus.meditations.{book_no}.{index}", [paragraph]))
        if place:
            blocks.append(section_block(f"marcus.meditations.{book_no}.place", [place]))
        write_markdown(
            folder / f"book-{book_no:02d}.md",
            f"marcus.meditations.{book_no}",
            f"Book {book_no}",
            "\n\n".join(blocks),
        )


def build_discourses(epub_text: Path, out_root: Path) -> None:
    expected = {1: 30, 2: 26, 3: 26, 4: 13}
    folder = out_root / "epictetus" / "discourses"
    for book_no, count in expected.items():
        path = epub_text / f"book-{book_no}.xhtml"
        sections = chapter_sections(path)
        if len(sections) != count:
            raise RuntimeError(f"discourses book {book_no}: expected {count} chapters, found {len(sections)}")
        for index, section in enumerate(sections, start=1):
            title = title_paragraph(section)
            label = f"{book_no}.{index}. {title}".strip().rstrip(".")
            if title:
                label = f"{book_no}.{index}. {title}"
            else:
                label = f"{book_no}.{index}"
            prose = "\n\n".join(paragraphs_of(section))
            write_markdown(
                folder / f"book-{book_no:02d}" / f"chapter-{index:02d}.md",
                f"epictetus.discourses.{book_no}.{index}",
                label,
                prose,
            )


def build_letters(epub_text: Path, out_root: Path) -> None:
    folder = out_root / "seneca" / "letters"
    paths = sorted(epub_text.glob("letter-*.xhtml"), key=lambda p: int(p.stem.split("-")[1]))
    if len(paths) != 124:
        raise RuntimeError(f"expected 124 letters, found {len(paths)}")
    for path in paths:
        number = int(path.stem.split("-")[1])
        root = xhtml_root(path)
        section = find_all(root, "section")[0]
        title = title_paragraph(section) or f"Letter {number}"
        prose = "\n\n".join(paragraphs_of(section))
        write_markdown(
            folder / f"letter-{number:03d}.md",
            f"seneca.letters.{number}",
            f"Letter {number}. {title}",
            prose,
        )


DIALOGUE_FILES = {
    "on-providence.xhtml": ("seneca.de_providentia", "de-providentia", "On Providence"),
    "on-the-firmness-of-the-wise-person.xhtml": (
        "seneca.de_constantia",
        "de-constantia",
        "On the Firmness of the Wise Person",
    ),
    "on-anger.xhtml": ("seneca.de_ira", "de-ira", "On Anger"),
    "to-marcia-on-consolation.xhtml": (
        "seneca.consolatio_ad_marciam",
        "consolatio-ad-marciam",
        "To Marcia, on Consolation",
    ),
    "on-a-happy-life.xhtml": ("seneca.de_vita_beata", "de-vita-beata", "On the Happy Life"),
    "on-leisure.xhtml": ("seneca.de_otio", "de-otio", "On Leisure"),
    "on-peace-of-mind.xhtml": ("seneca.de_tranquillitate", "de-tranquillitate", "On Peace of Mind"),
    "on-the-shortness-of-life.xhtml": (
        "seneca.de_brevitate_vitae",
        "de-brevitate-vitae",
        "On the Shortness of Life",
    ),
    "to-helvia-on-consolation.xhtml": (
        "seneca.consolatio_ad_helviam",
        "consolatio-ad-helviam",
        "To Helvia, on Consolation",
    ),
    "to-polybius-on-consolation.xhtml": (
        "seneca.consolatio_ad_polybium",
        "consolatio-ad-polybium",
        "To Polybius, on Consolation",
    ),
    "on-clemency.xhtml": ("seneca.de_clementia", "de-clementia", "On Clemency"),
    "on-benefits.xhtml": ("seneca.de_beneficiis", "de-beneficiis", "On Benefits"),
}


def h3_sections(section: ET.Element) -> list[ET.Element]:
    return [child for child in list(section) if local_name(child.tag) in {"section", "hgroup"} or local_name(child.tag).startswith("h")]


def subsection_paragraphs(section: ET.Element) -> list[str]:
    return paragraphs_of(section)


def build_dialogues(epub_text: Path, out_root: Path) -> None:
    for filename, (work_id, folder_name, fallback_title) in DIALOGUE_FILES.items():
        path = epub_text / filename
        root = xhtml_root(path)
        top = find_all(root, "section")[0]
        title = heading_text(top, "h2") or fallback_title
        nested = [child for child in list(top) if local_name(child.tag) == "section"]
        multi = any(heading_text(child, "h3").lower().startswith("book") for child in nested)
        folder = out_root / "seneca" / folder_name
        if multi:
            for book_index, book in enumerate(nested, start=1):
                blocks = []
                pieces = [child for child in list(book) if local_name(child.tag) == "section"]
                if not pieces:
                    # Sections may be direct h4 groups; fall back to h4 siblings via nested sections.
                    pieces = [child for child in list(book) if local_name(child.tag) == "section"]
                for sec_index, piece in enumerate(pieces, start=1):
                    prose_paras = paragraphs_of(piece)
                    if not prose_paras:
                        continue
                    blocks.append(
                        section_block(f"{work_id}.{book_index}.{sec_index}", prose_paras)
                    )
                if not blocks:
                    raise RuntimeError(f"no sections in {filename} book {book_index}")
                write_markdown(
                    folder / f"book-{book_index:02d}.md",
                    f"{work_id}.{book_index}",
                    f"{title}, Book {book_index}",
                    "\n\n".join(blocks),
                )
        else:
            blocks = []
            for sec_index, piece in enumerate(nested, start=1):
                prose_paras = paragraphs_of(piece)
                if not prose_paras:
                    continue
                blocks.append(section_block(f"{work_id}.{sec_index}", prose_paras))
            if not blocks:
                raise RuntimeError(f"no sections in {filename}")
            write_markdown(
                folder / f"{folder_name}.md",
                work_id,
                title,
                "\n\n".join(blocks),
            )


def build_diogenes(epub_text: Path, out_root: Path) -> None:
    path = epub_text / "book-7.xhtml"
    root = xhtml_root(path)
    top = find_all(root, "section")[0]
    lives = [child for child in list(top) if local_name(child.tag) == "section"]
    if len(lives) < 7:
        raise RuntimeError(f"expected the Stoic lives in DL 7, found {len(lives)}")
    folder = out_root / "diogenes-laertius" / "book-7"
    for life in lives:
        name = heading_text(life, "h3")
        if not name:
            raise RuntimeError("DL life without a heading")
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        paragraphs = paragraphs_of(life)
        blocks = [
            section_block(f"diogenes.lives.7.{slug}.{index}", [paragraph])
            for index, paragraph in enumerate(paragraphs, start=1)
        ]
        write_markdown(
            folder / f"{slug}.md",
            f"diogenes.lives.7.{slug}",
            name,
            "\n\n".join(blocks),
        )


def language_kind(text: str) -> str:
    words = re.findall(r"[A-Za-z']+", text.lower())
    english = sum(word in EN_WORDS for word in words)
    latin = sum(word in LAT_WORDS for word in words)
    if len(words) < 25:
        if english >= 3 and english > latin:
            return "en"
        if latin >= 3 and latin >= english:
            return "la"
        return "short"
    if english >= 5 and english > latin:
        return "en"
    if latin >= 3 and latin >= english:
        return "la"
    return "unk"


def pg_paragraphs(chunk: str) -> list[str]:
    chunk = chunk.replace("\r\n", "\n").replace("\r", "\n")
    chunk = re.sub(r"-\n([a-z])", r"\1", chunk)
    kept_lines = []
    for line in chunk.split("\n"):
        if re.match(r"\s+\[(?:\d+|[A-Z]{1,3})\]", line):
            continue
        kept_lines.append(line.rstrip())
    text = "\n".join(kept_lines)
    paragraphs = []
    for part in re.split(r"\n\s*\n", text):
        part = re.sub(r"\s*\n\s*", " ", part).strip()
        if part:
            paragraphs.append(part)
    return paragraphs


def english_prefix(raw: str) -> str:
    """Keep the English start of a bilingual chunk and stop at the Latin parallel."""
    raw = re.sub(r"#[^#\n]*#", " ", raw)
    raw = re.sub(r"\[[A-Z]{1,3}\]", "", raw)
    raw = re.sub(r"\[\d+\]", "", raw)
    raw = re.sub(r"_([^_]+)_", r"\1", raw)
    paragraphs = [re.sub(r"\s+", " ", part).strip() for part in re.split(r"\n\s*\n", raw)]
    paragraphs = [part for part in paragraphs if part]
    kept: list[str] = []
    for paragraph in paragraphs:
        if re.match(r"^\[(?:\d+|[A-Z]{1,3})\]", paragraph):
            continue
        if re.fullmatch(r"[IVXLCDM]+\.", paragraph):
            continue
        kind = language_kind(paragraph)
        if kind == "la":
            if kept:
                break
            return ""
        if kind == "short" and not kept:
            # A tiny scrap such as a bare numeral is not a section.
            if len(re.findall(r"[A-Za-z']+", paragraph)) < 8:
                continue
        kept.append(paragraph)
    blob = clean_inline(" ".join(kept))
    if language_kind(blob) == "la":
        return ""
    if language_kind(blob) == "short" and len(re.findall(r"[A-Za-z']+", blob)) < 12:
        return ""
    return blob


def build_de_officiis(pg_path: Path, out_root: Path) -> None:
    text = pg_path.read_text(encoding="utf-8")
    body = text.split("*** START OF THE PROJECT GUTENBERG EBOOK DE OFFICIIS ***", 1)[1]
    body = body.split("*** END OF THE PROJECT GUTENBERG", 1)[0]
    body = re.sub(r"-\n([a-z])", r"\1", body.replace("\r\n", "\n"))
    parts = re.split(r"\n(?=BOOK (?:I|II|III)\n)", body)
    expected = {1: 161, 2: 89, 3: 121}
    folder = out_root / "cicero" / "de-officiis"
    seen = 0
    for part in parts:
        if not part.strip().startswith("BOOK"):
            continue
        seen += 1
        lines = []
        for line in part.split("\n"):
            if re.match(r"\s+\[(?:\d+|[A-Z]{1,3})\]", line):
                continue
            lines.append(line)
        chunk = "\n".join(lines)
        bits = re.split(r"\*(\d+)\*", chunk)
        sections: dict[int, str] = {}
        scores: dict[int, int] = {}
        for index in range(1, len(bits), 2):
            number = int(bits[index])
            prose = english_prefix(bits[index + 1])
            if not prose:
                continue
            score = sum(word in EN_WORDS for word in re.findall(r"[A-Za-z']+", prose.lower()))
            if number not in sections or score > scores[number]:
                sections[number] = prose
                scores[number] = score
        want = expected[seen]
        missing = [n for n in range(1, want + 1) if n not in sections]
        if missing:
            raise RuntimeError(f"De Officiis book {seen} missing sections {missing[:20]} (of {len(missing)})")
        blocks = [section_block(f"cicero.de_officiis.{seen}.{n}", [sections[n]]) for n in range(1, want + 1)]
        write_markdown(
            folder / f"book-{seen:02d}.md",
            f"cicero.de_officiis.{seen}",
            f"Book {seen}",
            "\n\n".join(blocks),
        )
    if seen != 3:
        raise RuntimeError("De Officiis did not yield 3 books")


def group_roman_chapters(chunk: str) -> list[tuple[int, str]]:
    paragraphs = pg_paragraphs(chunk)
    chapters: list[tuple[int, list[str]]] = []
    current_no = None
    current: list[str] = []

    def flush() -> None:
        nonlocal current_no, current
        if current_no is not None and current:
            prose = clean_inline("\n\n".join(current))
            if prose:
                chapters.append((current_no, [prose] if False else current))
        current_no = None
        current = []

    for paragraph in paragraphs:
        if re.match(r"^\[(?:\d+|[A-Z]{1,3})\]", paragraph):
            continue
        if re.fullmatch(r"BOOK [IVXLC]+\.?", paragraph.strip()):
            continue
        match = re.match(r"^([IVXLCDM]{1,8})\.\s+(.*)$", paragraph)
        if match and roman_to_int(match.group(1)) < 200:
            flush()
            current_no = roman_to_int(match.group(1))
            rest = match.group(2).strip()
            if rest:
                current = [rest]
            else:
                current = []
            continue
        if current_no is None:
            continue
        current.append(paragraph)
    flush()
    # Rejoin paragraphs of a chapter into a list of prose blocks.
    return [(number, paras) for number, paras in chapters]


def build_de_finibus(pg_path: Path, out_root: Path) -> None:
    text = pg_path.read_text(encoding="utf-8")
    # The contents list the same headings; the body copies are the last ones.
    start = text.rfind("Third Book Of The Treatise On The Chief Good And Evil.")
    end = text.rfind("Fourth Book Of The Treatise On The Chief Good And Evil.")
    if start < 0 or end < 0 or end <= start:
        raise RuntimeError("could not locate De Finibus book 3")
    chapters = group_roman_chapters(text[start:end])
    if len(chapters) < 8:
        raise RuntimeError(f"De Finibus 3 looks too short: {len(chapters)} chapters")
    blocks = []
    for number, paras in chapters:
        prose_paras = [re.sub(r"\s+", " ", p).strip() for p in paras]
        blocks.append(section_block(f"cicero.de_finibus.3.{number}", prose_paras))
    write_markdown(
        out_root / "cicero" / "de-finibus" / "book-03.md",
        "cicero.de_finibus.3",
        "Book 3",
        "\n\n".join(blocks),
    )


def build_de_natura_deorum(pg_path: Path, out_root: Path) -> None:
    text = pg_path.read_text(encoding="utf-8")
    marker = text.find("THE NATURE OF THE GODS.")
    if marker < 0:
        raise RuntimeError("De Natura Deorum heading not found")
    rest = text[marker:]
    book2 = re.search(r"\nBOOK II\.\n", rest)
    book3 = re.search(r"\nBOOK III\.\n", rest)
    if not book2 or not book3 or book3.start() <= book2.end():
        raise RuntimeError("could not locate De Natura Deorum book 2")
    chunk = rest[book2.end() : book3.start()]
    chapters = group_roman_chapters(chunk)
    if len(chapters) < 10:
        raise RuntimeError(f"DND 2 looks too short: {len(chapters)} chapters")
    blocks = []
    for number, paras in chapters:
        cleaned = []
        for paragraph in paras:
            paragraph = re.sub(r"\[\d+\]", "", paragraph)
            paragraph = re.sub(r"\s+", " ", paragraph).strip()
            if paragraph:
                cleaned.append(paragraph)
        blocks.append(section_block(f"cicero.de_natura_deorum.2.{number}", cleaned))
    write_markdown(
        out_root / "cicero" / "de-natura-deorum" / "book-02.md",
        "cicero.de_natura_deorum.2",
        "Book 2",
        "\n\n".join(blocks),
    )


# Clarke prints each chapter number on its own line. Counts are his, not a later editor's.
NQ_CHAPTERS = {1: 17, 2: 59, 3: 30, 4: 13, 5: 18, 6: 32, 7: 32}
ROMAN_LINE = re.compile(r"^[IVXLCDM]+$")


def nq_units(book_text: str) -> list[tuple[str, list[str]]]:
    """Split one Clarke book on its standalone Roman chapter numbers.

    Margin section numbers and bracketed translator notes are dropped.
    Prose before the first chapter number, when present, is the preface.
    """
    book_text = re.sub(r"-\n([a-z])", r"\1", book_text)
    paragraphs: list[str] = []
    for raw in re.split(r"\n\s*\n", book_text):
        lines = []
        for line in raw.split("\n"):
            line = re.sub(r"\s{3,}\d+\s*$", "", line).strip()
            if line:
                lines.append(line)
        joined = clean_inline(" ".join(lines))
        if not joined or joined.upper() == "PREFACE":
            continue
        if re.match(r"^\[\d+\]", joined):
            continue
        if ROMAN_LINE.fullmatch(joined):
            paragraphs.append(joined)
            continue
        if joined == joined.upper() and len(joined) < 80 and re.search(r"[A-Z]", joined):
            continue
        text_p = re.sub(r"\[\d+\]", "", joined)
        text_p = re.sub(r"\s+", " ", text_p).strip()
        text_p = re.sub(r"\s+([,.;:?!])", r"\1", text_p)
        if text_p:
            paragraphs.append(text_p)

    units: list[tuple[str, list[str]]] = []
    kind: str | None = None
    current: list[str] = []
    seen: list[int] = []
    for paragraph in paragraphs:
        if ROMAN_LINE.fullmatch(paragraph):
            if current:
                units.append((kind or "chapter", current))
            seen.append(roman_to_int(paragraph))
            kind = "chapter"
            current = []
            continue
        if kind is None:
            kind = "preface"
        current.append(paragraph)
    if current:
        units.append((kind or "chapter", current))
    if seen != list(range(1, len(seen) + 1)):
        raise RuntimeError(f"NQ chapter numbers are not 1..n: {seen[:8]}...{seen[-3:]}")
    return units


def build_natural_questions(pg_path: Path, out_root: Path) -> None:
    text = pg_path.read_text(encoding="utf-8").replace("\r\n", "\n")
    start = text.find("THE NATURAL QUESTIONS OF L. ANNAEUS SENECA")
    end = text.find("NOTES ON SENECA")
    if start < 0 or end < 0:
        raise RuntimeError("could not locate the Natural Questions translation")
    chunk = text[start:end]
    book_splits = list(re.finditer(r"(?m)^BOOK ([IVX]+)\s*$", chunk))
    if len(book_splits) < 7:
        raise RuntimeError(f"expected 7 NQ books, found {len(book_splits)}")
    folder = out_root / "seneca" / "natural-questions"
    for index, match in enumerate(book_splits[:7]):
        book_no = index + 1
        stop = book_splits[index + 1].start() if index + 1 < len(book_splits) else len(chunk)
        units = nq_units(chunk[match.end() : stop])
        chapters = [unit for unit in units if unit[0] == "chapter"]
        if len(chapters) != NQ_CHAPTERS[book_no]:
            raise RuntimeError(
                f"NQ book {book_no}: expected {NQ_CHAPTERS[book_no]} chapters, got {len(chapters)}"
            )
        blocks = []
        chapter_no = 0
        for kind, paras in units:
            if kind == "preface":
                sid = f"seneca.naturales_quaestiones.{book_no}.preface"
            else:
                chapter_no += 1
                sid = f"seneca.naturales_quaestiones.{book_no}.{chapter_no}"
            blocks.append(section_block(sid, paras))
        write_markdown(
            folder / f"book-{book_no:02d}.md",
            f"seneca.naturales_quaestiones.{book_no}",
            f"Book {book_no}",
            "\n\n".join(blocks),
        )


def wiki_parse(page: str) -> str:
    query = urllib.parse.urlencode(
        {"action": "parse", "page": page, "prop": "text", "format": "json"}
    )
    request = urllib.request.Request(
        WIKI_API + "?" + query,
        headers={"User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        payload = json.load(response)
    if "error" in payload:
        raise RuntimeError(payload["error"])
    return payload["parse"]["text"]["*"]


def html_paragraphs(html: str) -> list[str]:
    import html as html_lib

    html = re.sub(r"<style\b.*?</style>", "", html, flags=re.S | re.I)
    html = re.sub(r"<script\b.*?</script>", "", html, flags=re.S | re.I)
    html = re.split(r"<h2[^>]*>\s*Footnotes", html, maxsplit=1, flags=re.I)[0]
    html = re.sub(r"<sup\b[^>]*class=\"reference\".*?</sup>", "", html, flags=re.S | re.I)
    html = re.sub(r"<br\s*/?>", "\n", html, flags=re.I)
    paragraphs = []
    for match in re.findall(r"<p\b[^>]*>(.*?)</p>", html, flags=re.S | re.I):
        text = re.sub(r"<[^>]+>", "", match)
        text = html_lib.unescape(text)
        text = clean_inline(text)
        text = re.sub(r"\s+", " ", text).strip()
        if text and text.lower() != "layout 1":
            paragraphs.append(text)
    return paragraphs


def is_roman_token(text: str) -> bool:
    return bool(re.fullmatch(r"[IVXLCDM]+\.", text.strip()))


def build_enchiridion_and_fragments(out_root: Path) -> list[str]:
    ench_html = wiki_parse(
        "The Discourses of Epictetus; with the Encheiridion and Fragments/The Encheiridion or Manual"
    )
    paragraphs = html_paragraphs(ench_html)
    chapters: list[tuple[int, list[str]]] = []
    current_no = None
    current: list[str] = []
    for paragraph in paragraphs:
        if paragraph.upper().startswith("THE ENCHEIRIDION"):
            continue
        if is_roman_token(paragraph):
            if current_no is not None:
                chapters.append((current_no, current))
            current_no = roman_to_int(paragraph[:-1])
            current = []
            continue
        if current_no is not None:
            current.append(paragraph)
    if current_no is not None:
        chapters.append((current_no, current))
    if len(chapters) < 50:
        raise RuntimeError(f"Encheiridion chapter count looks low: {len(chapters)}")
    blocks = []
    for number, paras in chapters:
        blocks.append(section_block(f"epictetus.enchiridion.{number}", paras))
    write_markdown(
        out_root / "epictetus" / "enchiridion" / "enchiridion.md",
        "epictetus.enchiridion",
        "Encheiridion",
        "\n\n".join(blocks),
    )

    frag_html = wiki_parse(
        "The Discourses of Epictetus; with the Encheiridion and Fragments/Fragments"
    )
    fparas = html_paragraphs(frag_html)
    omitted: list[str] = []
    fragments: list[tuple[int, list[str]]] = []
    current_no = None
    current = []
    started = False
    for paragraph in fparas:
        if paragraph.upper().startswith("FRAGMENTS OF EPICTETUS"):
            continue
        if is_roman_token(paragraph):
            if not started and roman_to_int(paragraph[:-1]) != 1:
                continue
            started = True
            if current_no is not None:
                fragments.append((current_no, current))
            current_no = roman_to_int(paragraph[:-1])
            current = []
            continue
        if current_no is not None:
            current.append(paragraph)
    if current_no is not None:
        fragments.append((current_no, current))
    blocks = []
    for number, paras in fragments:
        body = [p for p in paras if p.strip()]
        blob = " ".join(body)
        if language_kind(blob) == "la" or (
            language_kind(blob) != "en" and sum(w in EN_WORDS for w in re.findall(r"[A-Za-z']+", blob.lower())) < 6
        ):
            omitted.append(str(number))
            continue
        blocks.append(section_block(f"epictetus.fragments.{number}", body))
    if len(blocks) < 100:
        raise RuntimeError(f"too few English fragments kept: {len(blocks)}")
    write_markdown(
        out_root / "epictetus" / "fragments" / "fragments.md",
        "epictetus.fragments",
        "Fragments",
        "\n\n".join(blocks),
    )
    return omitted


def build_hymn(out_root: Path) -> None:
    import html as html_lib

    html = wiki_parse("The Hymn of Cleanthes")
    html = re.sub(r"<style\b.*?</style>", "", html, flags=re.S | re.I)
    html = re.sub(r"<script\b.*?</script>", "", html, flags=re.S | re.I)
    text = re.sub(r"<br\s*/?>", "\n", html, flags=re.I)
    text = re.sub(r"</p>", "\n\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html_lib.unescape(text)
    start = text.find("Most glorious of Immortals")
    if start < 0:
        raise RuntimeError("Hymn translation not found")
    rest = text[start:]
    for stopper in ("ARGUMENT OF THE HYMN", "Footnotes", "NOTES"):
        pos = rest.find(stopper)
        if pos > 0:
            rest = rest[:pos]
            break
    lines = []
    for line in rest.splitlines():
        line = clean_inline(line)
        if not line:
            continue
        if re.fullmatch(r"\d+", line):
            continue
        line = re.sub(r"^\d+(?=[A-Za-z])", "", line)
        line = re.sub(r"\s+\d+$", "", line)
        lines.append(line)
    prose = "\n".join(lines).strip()
    if "Most glorious of Immortals" not in prose:
        raise RuntimeError("hymn extract failed")
    write_markdown(
        out_root / "cleanthes" / "hymn-to-zeus" / "hymn.md",
        "cleanthes.hymn_to_zeus",
        "Hymn to Zeus",
        prose,
    )


def assert_samples(out_root: Path) -> None:
    med = (out_root / "marcus-aurelius" / "meditations" / "book-01.md").read_text(encoding="utf-8")
    if "From my grandfather Verus" not in med or "shamefastness" in med:
        raise RuntimeError("Meditations sample is not Long's opening")
    letter = (out_root / "seneca" / "letters" / "letter-001.md").read_text(encoding="utf-8")
    if "Lucilius" not in letter:
        raise RuntimeError("letter 1 missing")
    if not (out_root / "seneca" / "letters" / "letter-124.md").exists():
        raise RuntimeError("letter 124 missing")
    off = (out_root / "cicero" / "de-officiis" / "book-01.md").read_text(encoding="utf-8")
    if "My dear son Marcus" not in off:
        raise RuntimeError("De Officiis opening missing")
    fin = (out_root / "cicero" / "de-finibus" / "book-03.md").read_text(encoding="utf-8")
    if "Pleasure" not in fin or "Virtue" not in fin:
        raise RuntimeError("De Finibus 3 opening missing")
    dnd = (out_root / "cicero" / "de-natura-deorum" / "book-02.md").read_text(encoding="utf-8")
    if "Balbus" not in dnd:
        raise RuntimeError("DND 2 opening missing")
    zeno = (out_root / "diogenes-laertius" / "book-7" / "zeno.md").read_text(encoding="utf-8")
    if "Mnaseas" not in zeno:
        raise RuntimeError("DL Zeno opening missing")
    nq = (out_root / "seneca" / "natural-questions" / "book-01.md").read_text(encoding="utf-8")
    if "Lucilius" not in nq:
        raise RuntimeError("Natural Questions opening missing")
    hymn = (out_root / "cleanthes" / "hymn-to-zeus" / "hymn.md").read_text(encoding="utf-8")
    if "Most glorious of Immortals" not in hymn:
        raise RuntimeError("hymn missing")
    ench = (out_root / "epictetus" / "enchiridion" / "enchiridion.md").read_text(encoding="utf-8")
    if "Of things some are in our power" not in ench:
        raise RuntimeError("Encheiridion opening missing")
    for banned in ("PROJECT GUTENBERG", "Standard Ebooks", "End of the Project Gutenberg"):
        for path in out_root.rglob("*.md"):
            if banned.lower() in path.read_text(encoding="utf-8").lower() and banned != "Standard Ebooks":
                raise RuntimeError(f"{banned} left in {path}")
            if "project gutenberg" in path.read_text(encoding="utf-8").lower():
                raise RuntimeError(f"Gutenberg boilerplate left in {path}")


def build(sources: Path, out_root: Path) -> list[str]:
    if out_root.exists():
        shutil.rmtree(out_root)
    out_root.mkdir(parents=True)
    work = sources / "_unzipped"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir()

    def text_dir(name: str) -> Path:
        dest = work / name
        unzip_epub(sources / f"{name}.epub", dest)
        return dest / "epub" / "text"

    build_meditations(text_dir("marcus-long"), out_root)
    build_discourses(text_dir("epictetus-long"), out_root)
    build_letters(text_dir("seneca-letters-gummere"), out_root)
    build_dialogues(text_dir("seneca-dialogues-stewart"), out_root)
    build_diogenes(text_dir("diogenes-yonge"), out_root)
    build_de_officiis(sources / "pg47001.txt", out_root)
    build_de_finibus(sources / "pg29247.txt", out_root)
    build_de_natura_deorum(sources / "pg14988.txt", out_root)
    build_natural_questions(sources / "pg76392.txt", out_root)
    omitted = build_enchiridion_and_fragments(out_root)
    build_hymn(out_root)
    assert_samples(out_root)
    shutil.rmtree(work, ignore_errors=True)
    return omitted


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, default=Path("/tmp/stoic-sources"))
    parser.add_argument("--out", type=Path, default=ROOT / "texts")
    args = parser.parse_args()
    omitted = build(args.sources, args.out)
    files = list(args.out.rglob("*.md"))
    print(f"wrote {len(files)} markdown files under {args.out}")
    if omitted:
        print("Latin-only Epictetus fragments omitted: " + ", ".join(omitted))
    return 0


if __name__ == "__main__":
    sys.exit(main())
