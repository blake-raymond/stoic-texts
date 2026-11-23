# Stoic texts

A public-domain English corpus of the surviving ancient Stoic primary texts, arranged for language-model use. The selection is ethics-first. Physical doctrines stay where they are part of the ethical argument: nature, providence, fate, and human nature, including oikeiosis. A separate optional tier holds Seneca's *Natural Questions*, which is natural science rather than an ethical treatise.

One translation is included per work. The text files contain the translation only. Editorial introductions, commentaries, indexes, textual notes, and duplicate translations are left out.

## Old Counsel

Old Counsel is a conversation built on this corpus. The repository holds the texts and the prompt.

- `prompt/persona_v22.md` is the system persona. It goes first.
- `prompt/persona_v22_reminder.md` goes after the source text.

`scripts/build_prompt.py` assembles the full system prompt from those files and from source text set F. The order is the persona, then set F, then the reminder. One header line sits between the persona and the texts:

```
# Your memory: the writings of the Stoics (old public-domain translations; never quote or cite them)
```

That join is the one the runner used: the persona file, then a blank line, then the header, then set F, then a blank line, then the reminder.

Set F is the source text the model sees. Measured from the files in this repository, it is 992,644 characters and 225,271 tokens in the tiktoken encoding `o200k_base`. The assembled system prompt is 997,660 characters and 226,360 tokens in that same encoding. `prompt/meta.json` records both figures and the eval model, `google/gemini-3.6-flash`. The live chat model is a separate constant, `CHAT_MODEL` in `site/src/config.ts`: `anthropic/claude-sonnet-5.5` through OpenRouter, temperature 0.7. API keys stay out of the repository.

Set F contains only these works, in this order:

- Epictetus, *Encheiridion* (George Long, 1877)
- Epictetus, *Discourses* books 1 and 3 (George Long, 1877). Books 2 and 4, and the fragments, stay in the corpus and out of the prompt.
- Musonius Rufus, *Lectures and Fragments*, the English text already in this repository (Blake Raymond, 2026, from Otto Hense's 1905 Greek edition, released under CC0). Cora E. Lutz's 1947 translation is still under copyright in Canada and is not used.
- Marcus Aurelius, *Meditations* (George Long, 1862)
- Seneca, *Moral Letters to Lucilius* 1, 2, 5, 7, 13, 16, 18, 24, 28, 47, 65, 78, 104, 107, and 123 (Richard Mott Gummere, 1925). The other letters stay in the corpus.
- Seneca, *On the Shortness of Life* (Aubrey Stewart, 1889)
- Seneca, *On Peace of Mind* (Aubrey Stewart, 1889)

Passage formatting follows the eval builder. Each work opens with a line `===== Author, Title (tr. Translator, Year) =====`. Each passage is `[passage id]` and then the passage text. Files that have no `##` heading keep their markdown title in the passage. Files that do have `##` headings yield one passage per heading.

Every translation in set F is public domain in the United States and in Canada, or, for the Musonius text, dedicated to the public domain under CC0 by its translator. The same rule covers the rest of the corpus. See Licensing.

The script writes the assembled prompt to `prompt/out/`. That directory is not committed, because it repeats `texts/`. Rebuild and check:

```bash
python scripts/build_prompt.py
python scripts/build_prompt.py --check
```

The site lives in `site/`. Deploying it is a separate step, described in `site/README.md`, and is not part of regenerating the corpus.

## Scope

**Core.** The complete ethical works that survive in a public-domain English translation:

- Marcus Aurelius, *Meditations*
- Epictetus, *Discourses*, *Encheiridion*, and fragments
- Seneca, all 124 *Moral Letters to Lucilius*; the moral dialogues and consolations; *On Benefits*; *On Clemency*
- Musonius Rufus, *Lectures and Fragments*

**Foundations.** Ancient reports that supply the ethical foundations, not a general library of Hellenistic philosophy:

- Cicero, *On Ends* book 3 (Cato's account of Stoic ethics), *On Duties*, and *On the Nature of the Gods* book 2 (Balbus's Stoic speech)
- Diogenes Laertius, book 7, the lives of Zeno, Ariston, Herillus, Dionysius, Cleanthes, Sphaerus, and Chrysippus
- Cleanthes, *Hymn to Zeus*

Cicero's Epicurean and Academic speeches, the other books of *On Ends*, and the non-Stoic lives in Diogenes are out of scope. There is no public-domain English collection of the early Stoic fragments; what those collections translate out of Cicero and Diogenes is present here only inside those works.

**Optional.** *Natural Questions* is included because a clean public-domain translation exists, and it is flagged `optional` so it can be dropped without touching the ethical corpus. Cleomedes is optional and missing.

Physics is kept where it supports the ethics. *On Providence*, *On the Nature of the Gods* book 2, the Stoic physics and theology inside Diogenes book 7, and the *Hymn to Zeus* are foundations or core works, not optional extras. *Natural Questions* is the exception: it is a physical treatise, so it sits in the optional tier even though Seneca ties parts of it back to how one should live.

## Texts

Files live under `texts/`, one work to a directory. A work that divides into books has one Markdown file per book. Letters and Discourses chapters are one file each. Inside a file, `##` headings are the passages, and the heading text is the passage id.

```
---
id: marcus.meditations.1
---

# Book 1

## marcus.meditations.1.1

From my grandfather Verus ...
```

A file with no `##` heading is itself one passage. Its id is the `id` in the front matter. That is how each letter, each discourse, and the hymn are addressed.

Ids follow the edition that was transcribed. They are stable for this corpus. They are not a claim about standard critical numbering:

- *Meditations* ids are paragraph numbers in the Standard Ebooks transcription of Long. They diverge from the traditional section numbers; book 4 has 54 paragraphs. Books 1 and 2 end with a place-note (`marcus.meditations.1.place`, `marcus.meditations.2.place`).
- *On Duties* uses Cicero's standard section numbers (1–161, 1–89, 1–121). The Latin facing text is not included.
- *On Ends* book 3 and *On the Nature of the Gods* book 2 use Yonge's chapter numbers, not the modern Latin section numbers.
- Diogenes book 7 uses paragraph numbers within each life, not the usual 7.1-style sections.
- *Natural Questions* uses Clarke's books and chapters. His book 4 is the book later editions split into IVA and IVB.
- The *Encheiridion* has 52 chapters in Long's 1877 edition.
- Long's fragments 179–181 are omitted because that edition prints them only in Latin.

`catalog.yaml` records the author, title, translator, year, source URL, license basis, tier, and numbering note for each work. It does not store counts.

## Counts

<!-- COUNTS:START -->

Word counts are Unicode letter-runs in each file as stored, including the id line and headings. Token counts are tiktoken encodings `o200k_base` and `cl100k_base`: each file encoded on its own, with no chat wrapper. A total is the sum of those file counts, not the token count of the files joined together.

| Tier | Author | Title | Translator | Year | Words | o200k_base | cl100k_base |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| core | Marcus Aurelius | Meditations | George Long | 1862 | 46,363 | 59,116 | 59,388 |
| core | Epictetus | Discourses | George Long | 1877 | 118,667 | 144,504 | 145,535 |
| core | Epictetus | Encheiridion | George Long | 1877 | 8,266 | 10,301 | 10,436 |
| core | Epictetus | Fragments | George Long | 1877 | 7,710 | 10,396 | 10,551 |
| core | Seneca | Moral Letters to Lucilius | Richard Mott Gummere | 1925 | 210,812 | 253,827 | 254,944 |
| core | Seneca | On Providence | Aubrey Stewart | 1889 | 6,859 | 8,316 | 8,345 |
| core | Seneca | On the Firmness of the Wise Person | Aubrey Stewart | 1889 | 8,890 | 10,699 | 10,742 |
| core | Seneca | On Anger | Aubrey Stewart | 1889 | 39,290 | 47,798 | 47,975 |
| core | Seneca | To Marcia, on Consolation | Aubrey Stewart | 1889 | 14,849 | 17,804 | 17,908 |
| core | Seneca | On the Happy Life | Aubrey Stewart | 1889 | 12,741 | 15,263 | 15,300 |
| core | Seneca | On Leisure | Aubrey Stewart | 1889 | 3,404 | 3,986 | 4,010 |
| core | Seneca | On Peace of Mind | Aubrey Stewart | 1889 | 13,312 | 15,810 | 15,896 |
| core | Seneca | On the Shortness of Life | Aubrey Stewart | 1889 | 10,718 | 12,869 | 12,925 |
| core | Seneca | To Helvia, on Consolation | Aubrey Stewart | 1889 | 11,364 | 13,606 | 13,661 |
| core | Seneca | To Polybius, on Consolation | Aubrey Stewart | 1889 | 9,325 | 11,060 | 11,119 |
| core | Seneca | On Clemency | Aubrey Stewart | 1889 | 14,477 | 17,388 | 17,476 |
| core | Seneca | On Benefits | Aubrey Stewart | 1887 | 81,547 | 98,262 | 98,506 |
| core | Musonius Rufus | Lectures and Fragments | Blake Raymond | 2026 | 21,034 | 25,638 | 25,730 |
| **core total** | 18 works | 279 files |  |  | 639,628 | 776,643 | 780,447 |
| foundations | Cicero | On Ends, book 3 | C. D. Yonge | 1875 | 13,464 | 16,135 | 16,317 |
| foundations | Cicero | On Duties | Walter Miller | 1913 | 67,670 | 93,960 | 94,639 |
| foundations | Cicero | On the Nature of the Gods, book 2 | C. D. Yonge | 1877 | 22,427 | 28,344 | 28,479 |
| foundations | Diogenes Laertius | Lives of the Eminent Philosophers, book 7 | C. D. Yonge | 1853 | 31,454 | 43,589 | 43,840 |
| foundations | Cleanthes | Hymn to Zeus | E. H. Blakeney | 1921 | 393 | 564 | 570 |
| **foundations total** | 5 works | 13 files |  |  | 135,408 | 182,592 | 183,845 |
| optional | Seneca | Natural Questions | John Clarke | 1910 | 81,450 | 99,301 | 99,852 |
| **optional total** | 1 work | 7 files |  |  | 81,450 | 99,301 | 99,852 |
| **corpus total** | 24 works | 299 files |  |  | 856,486 | 1,058,536 | 1,064,144 |

<!-- COUNTS:END -->

The same numbers are in `manifest.json`, along with the license basis and the file list for each work. Both files are generated. Edit `catalog.yaml` or the texts, then regenerate. Do not hand-edit the counts.

A word is a maximal run of Unicode letters. An apostrophe between letters stays inside the word, so "man's" counts as one word. The count covers the file as stored, including the id line and the headings.

Token counts use the tiktoken encodings named `o200k_base` and `cl100k_base`. Each file is encoded on its own, as exact UTF-8 text, with no chat wrapper and no added special tokens. A work total, a tier total, and the corpus total are sums of those file counts. They are not the token count of the files concatenated, because byte-pair encoding can merge across a file boundary.

## Licensing

The translations included here are public domain in the United States and in Canada, or the transcription layer on top of a public-domain translation is CC0. The United States rule used is the one in force for this corpus: works published in 1930 or earlier are in the public domain. The Canadian rule is life of the author plus 70 years, in force since 30 December 2022, with the important limit that a work already in the public domain on that date was not pulled back into copyright. A translator who died before 1972 was already clear of the old life-plus-50 term.

Modern copyrighted translations are excluded. That includes Gregory Hays's *Meditations*, Robin Hard's Epictetus, and Robin Campbell's Seneca.

Judgment calls, stated so they can be checked:

- **Gummere** died on 3 December 1969. The Canadian term expired on 31 December 2019, before the 2022 extension, and was not revived. The Loeb volumes are 1917, 1920, and 1925, so the United States term has expired. The manifest year is 1925, the last volume.
- **Miller** died on 28 July 1949. The Canadian term expired at the end of 1999. The Loeb *On Duties* is 1913.
- **Clarke** is identified as John Clarke, Lecturer in Education at Aberdeen, born in 1853 or 1854 and died in 1939, by matching the 1910 title page to a family genealogy. That is not a national-biography entry. On that death date the Canadian term expired at the end of 1989. *Natural Questions* stays in the optional tier partly because of this identification.
- **Blakeney** died in August 1955. The Canadian term expired at the end of 2005. The hymn was published in 1921.
- **On the Nature of the Gods** is the 1877 Harper text, "literally translated, chiefly by C. D. Yonge," revising an earlier version sometimes ascribed to Franklin. Both layers are public domain. Yonge is the translator of record.
- **Standard Ebooks** dedicates its own transcription and markup to CC0. The underlying wording is the named public-domain translation. Where a Standard Ebooks file is the source, the orthography is that transcription's. Standard Ebooks attests United States public-domain status; the Canadian analysis above is this corpus's, not theirs.
- **Project Gutenberg** files had the Gutenberg header, footer, and trademark language removed, which is what the Gutenberg license requires when its boilerplate is stripped. Gutenberg ebook numbers are cited only in `catalog.yaml` and `manifest.json`, not in the text files.
- **Perseus** markup is often under a share-alike license. Those editions were not used, so this repository can stay CC0 without dragging a share-alike obligation onto the texts.

`LICENSE` is the CC0 1.0 legal text. CC0 covers the original work in this repository: the selection, the file structure, the passage ids, the scripts, the schema, the heuristic tags, and this README. CC0 does not change the status of the translations. Those remain public domain for the reasons in each manifest entry. Anyone may copy the repository. Attribution of the translators is recorded in the manifest and is the right scholarly practice even where the law does not require it.

## What is missing

| Work | Why it is not here |
| --- | --- |
| Cleomedes, *On the Heavens* | Optional. The first complete English translation, Bowen and Todd (2004), is in copyright. No earlier complete English text was found at Gutenberg, Wikisource, or Perseus. |
| Collected early Stoic fragments | Von Arnim is Greek and Latin. Long and Sedley (1987) and Inwood and Gerson are in copyright. No public-domain English collection was found. |
| Cicero, *On Fate* | Yonge's translation is public domain but was found only as a page scan. This corpus does not ship OCR. Fate is still discussed in *On the Nature of the Gods* book 2, *On Ends* book 3, and Diogenes book 7. |
| Epictetus, fragments 179–181 | Present in Long (1877) only as Latin quotations, with no English rendering. |

The full reasons are the `missing` list in `catalog.yaml` and `manifest.json`.

## Function tags

`annotations/function-tags.jsonl` tags some passages with one or more of: ethical claim, psychology, human nature, cosmic justification, natural science. The tags are a keyword heuristic. Every record has `origin` `auto`, `status` `unreviewed`, and `method` `keyword_heuristic`, and it lists the words that fired. Passages the lexicon misses are omitted. A missing tag is not a negative finding, and there is no confidence score.

The rules and the limits are in [`schema/function-tags.md`](schema/function-tags.md). The lists themselves live in `scripts/tag_passages.py`, which is what the tests regenerate against.

## Regenerating

Counts and the README table:

```bash
pip install -r requirements.txt
python scripts/count_tokens.py
python scripts/count_tokens.py --check
```

Tags:

```bash
python scripts/tag_passages.py
python scripts/tag_passages.py --check
```

The Old Counsel prompt:

```bash
python scripts/build_prompt.py
python scripts/build_prompt.py --check
```

Tests, which also check that every file named in the manifest exists and that the counts and tags are reproducible:

```bash
pytest
```

Rebuilding the text files needs the source ebooks and Gutenberg texts named in `scripts/build_corpus.py`, plus a live read of the three Wikisource pages. Those sources are not part of this repository. From a directory that contains them:

```bash
python scripts/build_corpus.py --sources /path/to/sources
python scripts/count_tokens.py
python scripts/tag_passages.py
```

The checked-in texts are already the output of that build. Continuous integration runs the count check, the tag check, the prompt check, and `pytest`. It does not download the sources.

## Layout

```
catalog.yaml                 bibliographic records, no counts
manifest.json                catalog plus measured word and token counts
texts/                       one Markdown tree per work
prompt/persona_v22.md        Old Counsel system persona, verbatim
prompt/persona_v22_reminder.md
prompt/meta.json             measured size of set F and the assembled prompt
annotations/function-tags.jsonl
schema/function-tags.md      how to read the tags
scripts/build_corpus.py      rebuild the texts from the sources
scripts/build_prompt.py      assemble the Old Counsel system prompt
scripts/count_tokens.py      recompute counts
scripts/tag_passages.py      recompute the heuristic tags
tests/test_corpus.py
site/                        oldcounsel.com (see site/README.md)
```
