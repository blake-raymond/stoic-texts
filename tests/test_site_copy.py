"""Site copy keeps the spec, the real reply, and Blake's wording rules."""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
REPLY_PATH = ROOT / "tests" / "fixtures" / "example_reply_I_P4_pay_cut_r0.json"
QUESTION = (
    "I'm 45, have about $950k invested, $70k in cash and no debt, and I spend about $42k a year. "
    "My job pays $180k but demands 60-hour weeks. I've been offered a remote job paying $75k for "
    "30 hours a week. My friends say taking a $105k pay cut is financial suicide. "
    "Is it foolish to walk away from that much money for my time?"
)

# The title and social cards keep the em dash from the mockup. Body copy does not.
HEAD_EM_DASH = "Old Counsel — Talk to the Stoics"


def visible_text(html: str) -> str:
    html = re.sub(r"<script\b[^>]*>.*?</script>", " ", html, flags=re.S | re.I)
    html = re.sub(r"<style\b[^>]*>.*?</style>", " ", html, flags=re.S | re.I)
    html = re.sub(r'data-verbatim="reply">.*</div>\s*(?=<button)', " ", html, flags=re.S)
    html = re.sub(r"<[^>]+>", " ", html)
    return html


def body(html: str) -> str:
    match = re.search(r"<body>(.*)</body>", html, re.S)
    assert match
    return match.group(1)


def test_example_reply_is_verbatim():
    html = (SITE / "public" / "index.html").read_text(encoding="utf-8")
    block = re.search(r'data-verbatim="reply">(.*)</div>\s*<button', html, re.S)
    assert block
    paragraphs = re.findall(r"<p>(.*?)</p>", block.group(1), re.S)
    text = "\n\n".join(paragraphs)
    expected = json.loads(REPLY_PATH.read_text(encoding="utf-8"))["text"]
    assert text == expected
    assert QUESTION in html
    assert "illustrative" not in html.lower()


def test_launch_date_has_one_source():
    config = (SITE / "src" / "config.ts").read_text(encoding="utf-8")
    assert 'export const LAUNCH_DATE = "[LAUNCH DATE]"' in config
    for name in ("index.html", "thanks.html"):
        html = (SITE / "public" / name).read_text(encoding="utf-8")
        assert "__LAUNCH_DATE__" in html
        assert "[LAUNCH DATE]" not in html


def test_payment_link_and_reference_id():
    html = (SITE / "public" / "index.html").read_text(encoding="utf-8")
    home = (SITE / "public" / "home.js").read_text(encoding="utf-8")
    link = "https://buy.stripe.com/5kQ6oJakdaKugGS2SNfw404"
    assert html.count(link) == 2
    assert 'data-base="' + link + '"' in html
    assert "client_reference_id=" in home
    assert "id + \"_\" + v" in home


def test_banned_words_are_absent_from_site_copy():
    index = (SITE / "public" / "index.html").read_text(encoding="utf-8")
    thanks = (SITE / "public" / "thanks.html").read_text(encoding="utf-8")
    scripts = "\n".join(
        (SITE / "public" / name).read_text(encoding="utf-8")
        for name in ("home.js", "thanks.js", "track.js")
    )
    visible = "\n".join([visible_text(index), visible_text(thanks), scripts])
    lowered = visible.lower()
    assert not re.search(r"\bphone\b", lowered)
    assert "free to try" not in lowered
    assert "free to start" not in lowered
    assert not re.search(r"\bmemory\b", lowered)
    assert not re.search(r"\bremember\w*\b", lowered)
    assert not re.search(r"(?<![&\w])#[A-Za-z]", visible)
    bodies = body(index) + body(thanks) + scripts
    verbatim = re.search(r'data-verbatim="reply">.*?</div>\s*<button', index, re.S)
    assert verbatim
    bodies = bodies.replace(verbatim.group(0), "")
    assert "\u2014" not in bodies
    assert HEAD_EM_DASH in index
