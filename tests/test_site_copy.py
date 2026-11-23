"""Site copy keeps the spec and Blake's wording rules."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
QUESTION = (
    "I'm 45, have about $950k invested, $70k in cash and no debt, and I spend about $42k a year. "
    "My job pays $180k but demands 60-hour weeks. I've been offered a remote job paying $75k for "
    "30 hours a week. My friends say taking a $105k pay cut is financial suicide. "
    "Is it foolish to walk away from that much money for my time?"
)

# Titles use a middle dot. Body copy and titles do not use an em dash.
HEAD_TITLE = "Old Counsel · Talk to the Stoics"


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


def test_examples_replace_the_pay_cut_thread():
    html = (SITE / "public" / "index.html").read_text(encoding="utf-8")
    assert QUESTION not in html
    assert "950k" not in html
    assert "financial suicide" not in html.lower()
    assert "Seneca observed" not in html
    assert "Read the full reply" not in html
    assert "An example" not in html
    assert "illustrative" not in html.lower()
    assert ">Examples</span>" in html
    assert "A coworker takes credit for my work in meetings." in html
    assert "My sister and I haven't spoken in two years." in html
    assert "I've been offered a job in another city." in html
    assert 'role="tablist"' in html
    assert html.count('role="tab"') == 3


def test_live_product_copy():
    index = (SITE / "public" / "index.html").read_text(encoding="utf-8")
    thanks = (SITE / "public" / "thanks.html").read_text(encoding="utf-8")
    config = (SITE / "src" / "config.ts").read_text(encoding="utf-8")
    public = (SITE / "src" / "public-config.ts").read_text(encoding="utf-8")
    assert "buy.stripe.com" not in public
    assert "LAUNCH_DATE" not in config
    assert "MONTHLY_REPLY_CAP = 100" in config
    assert "FOUNDING_BUYER_CAP = 100" in config
    assert "COLD_REPLY_RESERVE_MICRO_USD = 1_400_000" in config
    for html in (index, thanks):
        assert "2027" not in html
        assert "__LAUNCH_DATE__" not in html
        assert "pre-order" not in html.lower()
        assert "not open yet" not in html.lower()
    assert index.count('href="/chat"') == 4
    assert "Get lifetime access" not in index
    assert "Continue to checkout" not in index
    assert "$49" not in index
    assert "200 replies" not in index
    assert "One payment. No subscription." not in index
    assert "What does lifetime mean?" not in index
    assert "How do I come back on another device?" in index
    assert "What if I want a refund?" in index
    assert "What if it never opens?" not in index
    assert "First conversation free. Then $19 a month." in index
    assert "One plan. Two ways to pay." not in index
    assert "Your first conversation is free. Eight replies." in index
    assert "Then $19 a month." in index
    assert "Or $180 a year. That's $15 a month." not in index
    assert "Billed $180 yearly" in index
    assert "100 replies a month" in index
    assert "What does it cost?" in index
    assert "What happens after 100 replies?" in index
    assert 'data-cancel hidden' in index
    assert "Cancel anytime" in index
    assert "Yes. Any time, from the link in your receipt." in index
    assert "for as long as Old Counsel runs" not in index
    assert "Get founding access" in index
    assert 'data-plan="yearly"' in index
    assert 'data-plan="founding"' in index
    assert "data-founding hidden" in index
    assert "100 spots left" in index
    assert "price_" not in index
    assert 'href="/privacy"' not in index
    assert 'href="/terms"' not in index
    assert "You can talk now." in thanks
    assert "Lifetime access is yours" not in thanks
    assert "Paid once?" in thanks
    assert "We could not confirm that payment." in thanks
    assert "If you were charged, email" in thanks
    assert "__THANKS_STATE__" in thanks
    wrangler = (SITE / "wrangler.jsonc").read_text(encoding="utf-8")
    assert '"pattern": "oldcounsel.com"' in wrangler
    assert '"custom_domain": true' in wrangler
    assert "92147965-54f1-4d4d-b8a3-3cb75e65d9e3" in wrangler


def test_checkout_is_created_on_the_server():
    html = (SITE / "public" / "index.html").read_text(encoding="utf-8")
    home = (SITE / "public" / "home.js").read_text(encoding="utf-8")
    billing = (SITE / "src" / "billing.ts").read_text(encoding="utf-8")
    assert "buy.stripe.com" not in html
    assert "buy.stripe.com" not in home
    assert "client_reference_id" in billing
    assert "STRIPE_PRICE_MONTHLY" in (SITE / "src" / "stripe-env.ts").read_text(encoding="utf-8")
    assert "price_1" not in billing
    assert "price_" not in home
    assert "/api/offer" in home
    assert "/api/checkout" in home
    assert 'JSON.stringify({ plan: plan })' in home
    assert "Stuck on a hard choice?" not in home
    assert "Not another" not in home


def test_banned_words_are_absent_from_site_copy():
    index = (SITE / "public" / "index.html").read_text(encoding="utf-8")
    thanks = (SITE / "public" / "thanks.html").read_text(encoding="utf-8")
    refund = (SITE / "public" / "refund.html").read_text(encoding="utf-8")
    refund_js = (SITE / "public" / "refund.js").read_text(encoding="utf-8")
    scripts = "\n".join(
        (SITE / "public" / name).read_text(encoding="utf-8")
        for name in ("home.js", "thanks.js", "track.js")
    )
    chat_html = (SITE / "web" / "index.html").read_text(encoding="utf-8")
    chat_src = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (SITE / "web" / "src").glob("*.ts*")
    )
    visible = "\n".join([
        visible_text(index),
        visible_text(thanks),
        visible_text(refund),
        visible_text(chat_html),
        scripts,
        refund_js,
        chat_src,
    ])
    lowered = visible.lower()
    assert not re.search(r"\bphone\b", lowered)
    assert "free to try" not in lowered
    assert "free to start" not in lowered
    assert not re.search(r"\bmemory\b", lowered)
    assert not re.search(r"\bremember\w*\b", lowered)
    assert not re.search(r"(?<![&\w])#[A-Za-z]", visible)
    bodies = body(index) + body(thanks) + body(refund) + body(chat_html) + scripts + refund_js + chat_src
    assert "\u2014" not in bodies
    assert "\u2014" not in index
    assert HEAD_TITLE in index
    assert "225,000" not in visible
    assert "in full, not summarized" not in visible
    assert "for as long as Old Counsel runs" not in visible
    assert "free to try" not in lowered
    assert "free to start" not in lowered


def test_landing_page_fixes():
    index = (SITE / "public" / "index.html").read_text(encoding="utf-8")
    home = (SITE / "public" / "home.js").read_text(encoding="utf-8")
    thanks = (SITE / "public" / "thanks.html").read_text(encoding="utf-8")
    refund = (SITE / "public" / "refund.html").read_text(encoding="utf-8")
    chat = (SITE / "web" / "index.html").read_text(encoding="utf-8")
    hero = (
        "Tell it what's wrong. It helps you think clearly about a hard choice, "
        "a hard person or a hard day. In the voice of Epictetus, Seneca, "
        "Musonius Rufus and Marcus Aurelius. Plain words."
    )
    assert hero in index
    assert hero in home
    assert "It does the thinking with you." in index
    assert "Nothing hidden." in index
    assert "The prompt and the texts are public." in index
    assert "about 180,000 words, roughly 600 pages." in index
    assert ">The prompt</a>" in index
    assert ">The prompt</a>" in thanks
    assert ">The prompt</a>" in refund
    assert ">Open source</a>" not in index + thanks + refund
    assert "https://988lifeline.org" in index
    assert "https://988.ca" in index
    assert "https://findahelpline.com" in index
    assert "call or text" in index
    assert "What happens to what you tell it" not in index
    assert "[CONFIRM]" not in index
    image = 'content="https://oldcounsel.com/og-image.png"'
    card = 'name="twitter:card" content="summary_large_image"'
    assert image in index
    assert image in thanks
    assert image in refund
    assert image in chat
    assert card in index
    assert card in thanks
    assert card in refund
    assert card in chat
    assert (SITE / "public" / "og-image.png").is_file()
    sitemap = (SITE / "public" / "sitemap.xml").read_text(encoding="utf-8")
    assert "<loc>https://oldcounsel.com/</loc>" in sitemap
    assert "<loc>https://oldcounsel.com/chat</loc>" in sitemap
    assert "<loc>https://oldcounsel.com/refund</loc>" in sitemap
    assert "/privacy" not in sitemap
    assert "/terms" not in sitemap
    assert "/thanks" not in sitemap
    robots = (SITE / "public" / "robots.txt").read_text(encoding="utf-8")
    assert "Sitemap: https://oldcounsel.com/sitemap.xml" in robots
    assert "ai-train" in robots
    assert "content signals" in robots
    assert "Billed monthly" in home
    assert "founding_full" in home
    lead = (SITE / "web" / "src" / "copy.ts").read_text(encoding="utf-8")
    assert "for as long as Old Counsel runs" not in lead
    assert "Or $249 once. Up to 100 replies a month." in lead


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
    assert 'href="/refund">get a refund</a>' in index
    assert ">Get a refund</a>" in thanks
    assert "https://oldcounsel.com/refund" not in index
    assert "Enter the email from your purchase." in refund
    assert "Email <a href=\"mailto:help@oldcounsel.com\">help@oldcounsel.com</a> and you'll be refunded in full." in refund
    assert "5 to 10 business days" in copy
    assert "If that email has a purchase, a code is on its way." in copy
    assert "pre-order" not in copy.lower()
    chat_copy = (SITE / "src" / "chat-copy.ts").read_text(encoding="utf-8")
    assert "\u2014" not in chat_copy
    assert "help@oldcounsel.com" in chat_copy
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
