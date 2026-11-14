# Book Companion Reader — how it behaves

There is no original program to copy: every value below is a design choice made for this build ("estimated" = chosen, not measured from anything). Where a value lives in the code is named.

## Platforms
| What | Value | Source |
|---|---|---|
| Runs on | Obsidian desktop (macOS, Windows, Linux) and mobile (iOS, Android) | manifest.json `isDesktopOnly: false` |
| Minimum Obsidian | 1.5.0 | manifest.json (estimated) |
| Network calls | Obsidian `requestUrl` (works on phones, no CORS) | src/main.ts |

## Reading
| What | Value | Source |
|---|---|---|
| EPUB layout default | turn pages (paged) | settings.ts DEFAULT_SETTINGS, estimated |
| Text size default / range | 18 px / 12–34 px, ±2 per tap | settings.ts, readerView.changeText, estimated |
| Line height | 1.6 | estimated |
| Max column width (paged) | 720 px, gap 48 px | epubRenderer.ts MAX_COLUMN/GAP, estimated |
| Tap zones to turn pages | left 22 % / right 22 % of the page | readerView.onStageClick, estimated |
| Swipe to turn | > 60 px sideways, < 60 px up/down, < 600 ms | readerView.onSwipeEnd, estimated |
| Keys | → / PageDown / Space next, ← / PageUp previous | readerView.onKey |
| PDF fit | page fits width (max 1000 px) × zoom | pdfRenderer.scaleFor |
| PDF zoom step / range | ×1.15 / 0.5–4 | readerView toolbar, pdfRenderer.setZoom |
| PDF pages kept drawn | 10 nearest (phone memory) | pdfRenderer MAX_RENDERED, estimated |
| Canvas size cap | ~12 megapixels per page, sharpness ≤ 2× | pdfRenderer.renderPage, estimated |
| Paper | like Obsidian / sepia / light / dark (dark also darkens PDFs) | styles.css |
| Position saved | 1.5 s after moving; book page "progress" updated after 8 s | readerView.onLocation |
| Finished | progress ≥ 99 % sets `status: finished` | notes.updateProgress |

## AI helper
| What | Value | Source |
|---|---|---|
| Default service | My Claude subscription (Claude Code app on the computer) | settings.ts |
| Subscriptions | Claude Pro/Max (Claude Code), ChatGPT Plus/Pro (Codex), Google (Gemini CLI) — computer only | cliRunner.ts |
| Phones | question opens in Claude / ChatGPT / Gemini app, answer pasted back | readerView.renderHandoff |
| API options | Anthropic, OpenAI, OpenRouter, Ollama, any OpenAI-compatible | ai.ts |
| Subscription app time limit | 120 s | cliRunner.ts, estimated |
| Hand-off prompt cap | 6000 characters in the link (full text copied) | readerView.renderHandoff, estimated |
| Creativity (temperature) | 0.3 | estimated |
| Longest answer | 1200 tokens | estimated |
| Context sent with a selection | the paragraph plus neighbours, ≤ 2500 chars (PDF: ±900 chars on the page) | readerView.contextFor |
| "Study this page" text | what's on screen, ≤ 6000 chars | prompts.ts |
| Answers kept per book | 60 | readerView.runAi |
| Learner level default | B1 (A1–C2 or native) | settings.ts, estimated |
| Words per simplification | ≤ 10 (page study ≤ 12) | prompts.ts |
| Actions | Explain, Simplify for my level, Word meaning (≤ 4 words selected), Translate, Ask, Study this page, follow-up | prompts.ts |

## Notes in the vault
| What | Value | Source |
|---|---|---|
| Books folder | `Books/<Title>/` | settings.ts |
| Book page | `Books/<Title>/<Title>.md` with Highlights, Notes, Handwriting, Vocabulary, AI explanations | notes.ts |
| Notes | `Books/<Title>/Notes/<date> <first words>.md`, `book: [[Title]]`, link back to the exact place | notes.createNote |
| Links back into the book | `obsidian://book-reader?file=…&loc=p12` or `c3@0.4200` | types.bookLink |
| Vocabulary | `Vocabulary – <Title>.md`, one `word :: meaning` flashcard per line, tag `#flashcards` | notes.addVocabulary |
| Highlight colours | yellow, green, blue, pink, orange | settings.ts HIGHLIGHT_COLORS |
| Quiz | up to 15 cards, Leitner boxes 0–5 | modals.QuizModal |

## Handwriting
| What | Value | Source |
|---|---|---|
| On PDF pages | pen, highlighter, eraser, 5 colours, undo/redo | readerView.setInkMode |
| Handwritten notes | separate sheet (lined / dotted / blank), saved as SVG and embedded in a note | modals.HandwritingModal |
| Sheet shape | 1 : 1.3, "Longer page" adds 0.65 | modals.ts, estimated |
| Pen width | 2.5 px at 800 px wide; pressure scales 0.55–1.45× | ink.ts, estimated |
| Highlighter | 6× pen width, 35 % opacity | ink.ts, estimated |
| Eraser radius | 14 px at 800 px wide (removes whole strokes) | ink.ts, estimated |
| Pen only | off by default; when on, fingers scroll and only a stylus draws | settings.ts |

## Typed Graph pairing
| What | Value | Source |
|---|---|---|
| Typed notes default | on when the Typed Graph plugin (`typed-graph`) is enabled | settings.ts `typedNotes: "auto"` |
| Schema folder | Typed Graph's own setting, else `Types` | main.ts typedState, typed.ts |
| Types written | Book (library ontology), ReadingNote, Explanation, Handwriting, Vocabulary, + Quote for notes with a quote | notes.ts, typed.ts |
| Edges written | written_by {role}, note_on {loc}, explains {loc, action}, quoted_from, vocabulary_of | notes.ts |
| Library ontology | written only when no schema note declares Book | notes.ensureSchema |
| Verified | Typed Graph core engine reads a generated vault: 6 nodes, 7 edges; schema exports 9 types / 10 edge types | Typed Graph 0.28.0 core + `tg schema export` |
