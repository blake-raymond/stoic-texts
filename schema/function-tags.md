# Passage function tags

`annotations/function-tags.jsonl` is a first pass at saying what a passage is doing. It is a keyword heuristic. Every record is machine-generated and unreviewed. Do not treat a tag as a scholarly classification, and do not treat a missing record as a decision that the passage lacks that function.

## Record

One JSON object per tagged passage:

| Field | Value |
| --- | --- |
| `id` | The passage id from the text file (`##` heading, or the file id when the file is a single passage). |
| `work_id` | The work id in `catalog.yaml`. |
| `tags` | One or more of the five labels below. A passage may carry several. |
| `method` | Always `keyword_heuristic`. |
| `status` | Always `unreviewed`. |
| `origin` | Always `auto`. |
| `signals` | The lexicon strings that fired, one list per tag. There is no confidence score. |

The machine-readable shape is `schema/function-tags.schema.json`.

Untagged passages are omitted. Omission means the lexicon did not fire. It is not a negative label.

## Labels

The labels are functional, not topics in the library-catalog sense. A passage can be an ethical claim and a cosmic justification at the same time.

- `ethical_claim` — prescription or evaluation: what is good, right, in our power, or according to nature.
- `psychology` — passions, impressions, assent, desire, aversion, pleasure and pain.
- `human_nature` — what human beings are, including kinship and appropriation (`oikeiosis`) where the English wording is explicit.
- `cosmic_justification` — nature, providence, fate, or Zeus offered as the ground of the ethics.
- `natural_science` — a passage that is actually talking about physical phenomena.

## How a tag fires

Matching is case-insensitive. A multi-word phrase is a substring. A single word uses a word boundary, so `vice` does not match inside another word.

For `ethical_claim`, `psychology`, `human_nature`, and `cosmic_justification`, one distinctive phrase is enough. Otherwise the tag fires only when at least two different words from that tag's list occur. One stray `virtue` or one stray `fear` is not enough. The phrase lists and the word lists are the tuples in `scripts/tag_passages.py`. That file is the rule, so a regenerated jsonl cannot drift from a second copy of the lexicon.

`natural_science` is stricter, because moral arguments often mention weather.

- Inside `seneca.naturales_quaestiones`, the tag fires when the passage has at least one high-precision word (`comet`, `eclipse`, `rainbow`, `earthquake`, `planet`, `lightning`, and the rest of the `high` list) and at least one other science word.
- Everywhere else, it fires only when two different high-precision words occur. `rain` and `wind` alone do not qualify, so a metaphor in a moral essay usually stays untagged.

## What this is not

The heuristic does not find irony, does not know when Seneca is quoting an opponent, and does not line up with Stephanus or other standard section numbers. Two high-precision science words are enough to mark `natural_science` outside *Natural Questions*, so the *Hymn to Zeus* is tagged that way because it says "thunderbolt" and "lightning," and a few consolatory or theological passages are too. A reviewer would probably remove those. The doxography in Diogenes Laertius 7 and the physical chapters of *On the Nature of the Gods* 2 are the kind of hit the rule is for. Short passages and passages that use different English (`appropriation` for oikeiosis, for example, is not in the list unless the phrase was added) stay untagged. Review would mean a person reading the passage and editing the record. Nothing in this file has been reviewed.
