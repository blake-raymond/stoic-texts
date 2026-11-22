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
    match = re.search(r"<body\b[^>]*>(.*)</body>", html, re.S)
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
    assert 'export const LAUNCH_DATE = "2027"' in config
    index = (SITE / "public" / "index.html").read_text(encoding="utf-8")
    thanks = (SITE / "public" / "thanks.html").read_text(encoding="utf-8")
    for html in (index, thanks):
        assert "__LAUNCH_DATE__" in html
        assert "[LAUNCH DATE]" not in html
        assert "2027" not in html
    assert "Old Counsel opens in __LAUNCH_DATE__." in index
    assert "Not open by the end of __LAUNCH_DATE__? Full refund, automatically." in index
    assert index.count("if it hasn't opened by the end of __LAUNCH_DATE__.") == 2
    assert "when it opens in __LAUNCH_DATE__." in thanks
    wrangler = (SITE / "wrangler.jsonc").read_text(encoding="utf-8")
    assert '"pattern": "oldcounsel.com"' in wrangler
    assert '"custom_domain": true' in wrangler


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
    refund = (SITE / "public" / "refund.html").read_text(encoding="utf-8")
    refund_js = (SITE / "public" / "refund.js").read_text(encoding="utf-8")
    scripts = "\n".join(
        (SITE / "public" / name).read_text(encoding="utf-8")
        for name in ("home.js", "thanks.js", "track.js")
    )
    visible = "\n".join([visible_text(index), visible_text(thanks), visible_text(refund), scripts, refund_js])
    lowered = visible.lower()
    assert not re.search(r"\bphone\b", lowered)
    assert "free to try" not in lowered
    assert "free to start" not in lowered
    assert not re.search(r"\bmemory\b", lowered)
    assert not re.search(r"\bremember\w*\b", lowered)
    assert not re.search(r"(?<![&\w])#[A-Za-z]", visible)
    bodies = body(index) + body(thanks) + body(refund) + scripts + refund_js
    verbatim = re.search(r'data-verbatim="reply">.*?</div>\s*<button', index, re.S)
    assert verbatim
    bodies = bodies.replace(verbatim.group(0), "")
    assert "\u2014" not in bodies
    assert HEAD_EM_DASH in index


def test_refund_links_and_copy():
    index = (SITE / "public" / "index.html").read_text(encoding="utf-8")
    thanks = (SITE / "public" / "thanks.html").read_text(encoding="utf-8")
    refund = (SITE / "public" / "refund.html").read_text(encoding="utf-8")
    copy = (SITE / "src" / "refund-copy.ts").read_text(encoding="utf-8")
    stripe = (SITE / "src" / "refund-stripe.ts").read_text(encoding="utf-8")
    events = (SITE / "src" / "events.ts").read_text(encoding="utf-8")
    wrangler = (SITE / "wrangler.jsonc").read_text(encoding="utf-8")
    assert index.count('href="/refund"') == 1
    assert thanks.count('href="/refund"') == 1
    assert ">Get a refund</a>" in index
    assert ">Get a refund</a>" in thanks
    assert "get a refund at https://oldcounsel.com/refund" in index
    assert "Enter the email from your pre-order." in refund
    assert "Email <a href=\"mailto:help@oldcounsel.com\">help@oldcounsel.com</a> and you'll be refunded in full." in refund
    assert "5 to 10 business days" in copy
    assert "If that email has a pre-order, a code is on its way." in copy
    assert "noreply@oldcounsel.com" in copy
    assert "plink_1UejbsRssDxlNdX37XKaLinq" in stripe
    assert "oldcounsel-fakedoor-nov2026" in stripe
    assert 'export const OFFER_META = "lifetime_49"' in stripe
    assert "STRIPE_REFUND_KEY" in (SITE / "src" / "secrets.d.ts").read_text(encoding="utf-8")
    assert '"send_email"' in wrangler
    assert "noreply@oldcounsel.com" in wrangler
    public = events.split("] as const", 1)[0]
    assert "refund_" not in public
    for text in (refund, copy, stripe):
        assert "\u2014" not in text
        assert not re.search(r"\bphone\b", text.lower())
    assert "2027" not in refund
