/**
 * Typed Graph pairing (https://github.com/Volland/typedgraph, plugin id "typed-graph").
 *
 * When typed notes are on, every note the reader writes carries a Typed Graph type in its front matter and
 * typed edge lines (`edge:: [[Target]] {props}`), so books, quotes, reading notes, AI explanations,
 * handwriting and vocabulary become one queryable graph. Books, authors and quotes use Typed Graph's own
 * "library" ontology; the reader adds a few types of its own in a schema note.
 */

export const TYPED_GRAPH_ID = "typed-graph";
export const TYPED_GRAPH_GRAPH_COMMAND = "typed-graph:open-graph-view";
export const DEFAULT_SCHEMA_FOLDER = "Types";
export const COMPANION_SCHEMA_NAME = "Book Companion";
export const LIBRARY_SCHEMA_NAME = "Library";

export interface TypedState {
	on: boolean;
	schemaFolder: string;
}

/** One typed edge line: `name:: [[Target]] {key: "value", n: 2}`. */
export function edgeLine(name: string, target: string, props?: Record<string, string | number | undefined>): string {
	const parts = Object.entries(props ?? {})
		.filter(([, v]) => v !== undefined && v !== "")
		.map(([k, v]) => `${k}: ${typeof v === "number" ? v : JSON.stringify(v)}`);
	return `${name}:: [[${target}]]${parts.length ? ` {${parts.join(", ")}}` : ""}`;
}

/** The reader's own types. Edges point at Book from Typed Graph's library ontology. */
export const COMPANION_SCHEMA = `---
tgs: "0.1"
schemas:
  ReadingNote:
    properties:
      location: text
      created: date
    edges:
      note_on: Book
    visualization: {color: "#7b5cd6", shape: round-rectangle, icon: sticky-note}
  Explanation:
    properties:
      action: text
      location: text
      created: date
    edges:
      explains: Book
    visualization: {color: "#f59f00", shape: diamond, icon: sparkles}
  Handwriting:
    properties:
      location: text
      created: date
    edges:
      note_on: Book
    visualization: {color: "#1c7ed6", shape: round-rectangle, icon: pen-tool}
  Vocabulary:
    properties:
      level: text
      language: text
    edges:
      vocabulary_of: Book
    visualization: {color: "#2f9e44", shape: rectangle, icon: graduation-cap}
edgeTypes:
  note_on: {from: [ReadingNote, Handwriting], to: Book, properties: {loc: text}}
  explains: {from: Explanation, to: Book, properties: {loc: text, action: text}}
  vocabulary_of: {from: Vocabulary, to: Book}
---
Types written by **Book Companion Reader**: your notes, AI explanations, handwriting and vocabulary for each book, all pointing at the Book they belong to. A note made from a selection is also a \`Quote\` (from the library ontology) with \`quoted_from\` the book.

Try it in a note:

\`\`\`graph-query
MATCH (n)-[r:note_on|explains]->(b:Book)
RETURN b.title AS book, count(n) AS notes
ORDER BY notes DESC
\`\`\`
`;

/** Typed Graph's library ontology (MIT, © Volodymyr Pavlyshyn), written only when the vault has no Book type yet. */
export const LIBRARY_SCHEMA = `---
tgs: "0.1"
schemas:
  Book:
    properties:
      status: {values: [wishlist, to-read, reading, finished, abandoned], default: to-read}
      format: {values: [paper, ebook, audio]}
      rating: number
      pages: number
      year: number
      isbn: text
      started: date
      finished: date
    edges:
      written_by: {target: Author, required: true}
      in_series: Series
      has_genre: Genre
      sequel_of: Book
      inspired_by: Book
    visualization: {color: "#0ea5e9", shape: round-rectangle, icon: book}
  Author:
    properties:
      born: number
      country: text
    edges:
      influenced: Author
    visualization: {color: "#a855f7", shape: ellipse, icon: user}
  Series:
    properties:
      planned_volumes: number
    visualization: {color: "#14b8a6", shape: hexagon, icon: library}
  Genre:
    visualization: {color: "#f59e0b", shape: tag, icon: tag}
  Quote:
    properties:
      page: number
      saved: date
    edges:
      quoted_from: {target: Book, required: true}
    visualization: {color: "#64748b", shape: rectangle, icon: quote}
edgeTypes:
  written_by: {from: Book, to: Author, properties: {role: {values: [author, translator, editor, illustrator]}}}
  in_series: {from: Book, to: Series, properties: {volume: number}}
  has_genre: {from: Book, to: Genre}
  sequel_of: {from: Book, to: Book}
  inspired_by: {from: Book, to: Book}
  influenced: {from: Author, to: Author}
  quoted_from: {from: Quote, to: Book}
---
The library ontology from Typed Graph: books with a reading status, their authors, series and genres, and the quotes you saved from them.
`;

/** True when a schema note already declares the Book type (so the library ontology must not be declared twice). */
export function declaresBook(schemaText: string): boolean {
	return /^\s{2}Book:\s*$/m.test(schemaText) || /^title:\s*"?Book"?\s*$/m.test(schemaText);
}
