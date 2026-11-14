import { unzipSync, strFromU8 } from "fflate";

export interface EpubChapter {
	href: string;
	title: string;
	mediaType: string;
}

export interface EpubBook {
	title: string;
	author: string;
	language: string;
	chapters: EpubChapter[];
	toc: { title: string; chapter: number; fragment?: string; depth: number }[];
	coverPath?: string;
	files: Record<string, Uint8Array>;
}

type DomParserLike = { parseFromString(s: string, type: string): Document };

export function resolvePath(base: string, rel: string): string {
	if (/^[a-z]+:/i.test(rel)) return rel;
	const clean = rel.split("#")[0].split("?")[0];
	let decoded = clean;
	try { decoded = decodeURIComponent(clean); } catch { /* keep as is */ }
	const parts = base.split("/");
	parts.pop();
	for (const seg of decoded.split("/")) {
		if (seg === "..") parts.pop();
		else if (seg !== "." && seg !== "") parts.push(seg);
	}
	return parts.join("/");
}

function byLocalName(root: Document | Element, name: string): Element[] {
	return Array.from(root.querySelectorAll("*")).filter((e) => (e.localName || e.nodeName).toLowerCase().replace(/^.*:/, "") === name);
}

function firstText(root: Document | Element, name: string): string {
	const el = byLocalName(root, name)[0];
	return (el?.textContent ?? "").trim();
}

export function parseXml(parser: DomParserLike, text: string): Document {
	let doc = parser.parseFromString(text, "application/xhtml+xml");
	if (byLocalName(doc, "parsererror").length) doc = parser.parseFromString(text, "text/html");
	return doc;
}

export function parseEpub(data: ArrayBuffer | Uint8Array, parser: DomParserLike): EpubBook {
	const files = unzipSync(data instanceof Uint8Array ? data : new Uint8Array(data));
	const read = (p: string) => (files[p] ? strFromU8(files[p]) : "");
	const container = read("META-INF/container.xml");
	if (!container) throw new Error("This file is not a valid EPUB (container.xml is missing).");
	const cdoc = parser.parseFromString(container, "application/xml");
	const opfPath = byLocalName(cdoc, "rootfile")[0]?.getAttribute("full-path");
	if (!opfPath || !files[opfPath]) throw new Error("This EPUB has no package file.");
	const opf = parser.parseFromString(read(opfPath), "application/xml");

	const manifest = new Map<string, { href: string; type: string; props: string }>();
	for (const item of byLocalName(opf, "item")) {
		const id = item.getAttribute("id") ?? "";
		const href = item.getAttribute("href") ?? "";
		manifest.set(id, { href: resolvePath(opfPath, href), type: item.getAttribute("media-type") ?? "", props: item.getAttribute("properties") ?? "" });
	}

	const chapters: EpubChapter[] = [];
	for (const ref of byLocalName(opf, "itemref")) {
		if (ref.getAttribute("linear") === "no") continue;
		const it = manifest.get(ref.getAttribute("idref") ?? "");
		if (!it || !files[it.href]) continue;
		if (!/html|xml/.test(it.type)) continue;
		chapters.push({ href: it.href, title: "", mediaType: it.type });
	}
	if (!chapters.length) throw new Error("This EPUB has no readable chapters.");

	const chapterIndex = (href: string) => chapters.findIndex((c) => c.href === href);
	const toc: EpubBook["toc"] = [];

	// EPUB 3 navigation document
	const navItem = Array.from(manifest.values()).find((m) => m.props.split(/\s+/).includes("nav"));
	if (navItem && files[navItem.href]) {
		const nav = parseXml(parser, read(navItem.href));
		const navs = byLocalName(nav, "nav");
		const tocNav = navs.find((n) => (n.getAttribute("epub:type") ?? n.getAttribute("type") ?? "").includes("toc")) ?? navs[0];
		if (tocNav) {
			const walk = (el: Element, depth: number) => {
				for (const child of Array.from(el.children)) {
					const ln = (child.localName || "").toLowerCase();
					if (ln === "li") {
						const a = byLocalName(child, "a")[0];
						if (a) {
							const href = a.getAttribute("href") ?? "";
							const target = resolvePath(navItem.href, href);
							const idx = chapterIndex(target);
							if (idx >= 0) toc.push({ title: (a.textContent ?? "").trim().replace(/\s+/g, " "), chapter: idx, fragment: href.split("#")[1], depth });
						}
						for (const sub of Array.from(child.children)) if ((sub.localName || "").toLowerCase() === "ol") walk(sub, depth + 1);
					} else if (ln === "ol") walk(child, depth);
				}
			};
			walk(tocNav, 0);
		}
	}
	// EPUB 2 NCX
	if (!toc.length) {
		const spine = byLocalName(opf, "spine")[0];
		const ncx = manifest.get(spine?.getAttribute("toc") ?? "") ?? Array.from(manifest.values()).find((m) => m.type === "application/x-dtbncx+xml");
		if (ncx && files[ncx.href]) {
			const ndoc = parser.parseFromString(read(ncx.href), "application/xml");
			const walk = (el: Element, depth: number) => {
				for (const np of Array.from(el.children).filter((c) => (c.localName || "").toLowerCase() === "navpoint")) {
					const label = firstText(np, "text");
					const src = byLocalName(np, "content")[0]?.getAttribute("src") ?? "";
					const idx = chapterIndex(resolvePath(ncx.href, src));
					if (idx >= 0) toc.push({ title: label, chapter: idx, fragment: src.split("#")[1], depth });
					walk(np, depth + 1);
				}
			};
			const navMap = byLocalName(ndoc, "navmap")[0];
			if (navMap) walk(navMap, 0);
		}
	}
	for (const t of toc) if (!chapters[t.chapter].title) chapters[t.chapter].title = t.title;
	chapters.forEach((c, i) => { if (!c.title) c.title = `Section ${i + 1}`; });

	let coverPath: string | undefined;
	const coverItem = Array.from(manifest.values()).find((m) => m.props.includes("cover-image"));
	if (coverItem) coverPath = coverItem.href;
	else {
		const metaCover = byLocalName(opf, "meta").find((m) => m.getAttribute("name") === "cover")?.getAttribute("content");
		if (metaCover && manifest.get(metaCover)) coverPath = manifest.get(metaCover)!.href;
	}

	return {
		title: firstText(opf, "title") || "Untitled book",
		author: firstText(opf, "creator"),
		language: firstText(opf, "language"),
		chapters,
		toc,
		coverPath,
		files,
	};
}

export function mimeFor(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp" } as Record<string, string>)[ext] ?? "application/octet-stream";
}

/**
 * Turn one chapter into safe, reader-styled HTML: scripts, styles and inline handlers removed,
 * images pointed at data-bcr-src (the renderer swaps in blob URLs), links marked for in-book navigation.
 */
export function chapterHtml(book: EpubBook, index: number, parser: DomParserLike): string {
	const ch = book.chapters[index];
	const doc = parseXml(parser, strFromU8(book.files[ch.href]));
	const body = byLocalName(doc, "body")[0] ?? doc.documentElement;
	for (const tag of ["script", "style", "link", "iframe", "object", "embed", "form", "input", "button", "meta", "title", "head"]) {
		for (const el of byLocalName(body, tag)) el.parentNode?.removeChild(el);
	}
	// SVG cover wrappers: <svg><image xlink:href="..."/></svg> → <img>
	for (const svg of byLocalName(body, "svg")) {
		const img = byLocalName(svg, "image")[0];
		if (img) {
			const href = img.getAttribute("xlink:href") ?? img.getAttribute("href") ?? "";
			const rep = createEl("img");
			rep.setAttribute("data-bcr-src", resolvePath(ch.href, href));
			rep.setAttribute("alt", "");
			svg.parentNode?.replaceChild(rep, svg);
		}
	}
	const all = Array.from(body.querySelectorAll("*"));
	for (const el of all) {
		for (const attr of Array.from(el.attributes)) {
			const n = attr.name.toLowerCase();
			// Book CSS is dropped (the reader styles the text), so classes and inline styles go too.
			if (n.startsWith("on") || n === "style" || n === "class") el.removeAttribute(attr.name);
		}
		const ln = (el.localName || "").toLowerCase();
		if (ln === "img") {
			const src = el.getAttribute("src");
			if (src && !src.startsWith("data:")) {
				el.setAttribute("data-bcr-src", resolvePath(ch.href, src));
				el.removeAttribute("src");
			}
		} else if (ln === "a") {
			const href = el.getAttribute("href");
			if (href && !/^[a-z]+:/i.test(href)) {
				const target = href.startsWith("#") ? ch.href : resolvePath(ch.href, href);
				const idx = book.chapters.findIndex((c) => c.href === target);
				el.setAttribute("data-bcr-chapter", String(idx));
				const frag = href.split("#")[1];
				if (frag) el.setAttribute("data-bcr-fragment", frag);
				el.setAttribute("href", "#");
			}
		}
	}
	const serializer = body.innerHTML;
	return serializer;
}
