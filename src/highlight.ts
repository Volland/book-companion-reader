/**
 * Find a quote inside rendered text and wrap it in <mark> elements.
 * Matching ignores whitespace, so it works across line breaks and the PDF text layer's spans.
 */
export function wrapText(root: Node, quote: string, makeMark: (doc: Document) => HTMLElement): HTMLElement[] {
	const target = quote.replace(/\s+/g, "");
	if (target.length < 1) return [];
	const doc = root.ownerDocument ?? (root as Document);
	const texts: Text[] = [];
	const collect = (n: Node) => {
		for (let c = n.firstChild; c; c = c.nextSibling) {
			if (c.nodeType === 3) texts.push(c as Text);
			else if (c.nodeType === 1 && !(c as Element).classList?.contains("bcr-skip-hl")) collect(c);
		}
	};
	collect(root);

	// concatenated non-whitespace characters with a map back to (text node, offset)
	let flat = "";
	const map: { node: number; offset: number }[] = [];
	texts.forEach((t, ni) => {
		const s = t.data;
		for (let i = 0; i < s.length; i++) {
			if (/\s/.test(s[i])) continue;
			flat += s[i];
			map.push({ node: ni, offset: i });
		}
	});
	const at = flat.indexOf(target);
	if (at < 0) return [];
	const start = map[at];
	const end = map[at + target.length - 1];

	const marks: HTMLElement[] = [];
	for (let ni = start.node; ni <= end.node; ni++) {
		let node = texts[ni];
		const from = ni === start.node ? start.offset : 0;
		const to = ni === end.node ? end.offset + 1 : node.data.length;
		if (to <= from || !node.data.slice(from, to).trim()) continue;
		if (from > 0) node = splitAt(doc, node, from);
		if (to - from < node.data.length) splitAt(doc, node, to - from);
		const mark = makeMark(doc);
		node.parentNode!.insertBefore(mark, node);
		mark.appendChild(node);
		marks.push(mark);
	}
	return marks;
}

/** Text.splitText, written out so it works in every DOM. Returns the second half. */
function splitAt(doc: Document, node: Text, offset: number): Text {
	const rest = doc.createTextNode(node.data.slice(offset));
	node.data = node.data.slice(0, offset);
	node.parentNode!.insertBefore(rest, node.nextSibling);
	return rest;
}

/** Undo wrapText for every mark matching the selector. */
export function unwrapMarks(root: ParentNode, selector: string) {
	for (const m of Array.from(root.querySelectorAll(selector))) {
		const parent = m.parentNode;
		if (!parent) continue;
		while (m.firstChild) parent.insertBefore(m.firstChild, m);
		parent.removeChild(m);
		(parent as Element).normalize?.();
	}
}
