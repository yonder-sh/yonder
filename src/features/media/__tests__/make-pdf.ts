/**
 * A tiny valid PDF with one line of text per page (Helvetica), for tests and
 * e2e fixtures ("E-ticket NH 9"). No dependencies.
 */
export function makePdf(
	pages: string[],
	opts: { title?: string } = {},
): Buffer {
	const objects: string[] = [];
	const n = pages.length;
	const pageIds = pages.map((_, i) => 3 + i * 2);
	const fontId = 3 + n * 2;
	objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
	objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${n} >>`;
	const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
	pages.forEach((text, i) => {
		const pageId = pageIds[i] as number;
		const lines = [
			"BT /F1 28 Tf 72 740 Td",
			`(${esc(text)}) Tj`,
			"ET",
			"BT /F1 14 Tf 72 700 Td",
			`(${esc(opts.title ?? "Yonder test document")} - page ${i + 1} of ${n}) Tj`,
			"ET",
			"0.29 0.31 0.65 RG 4 w 72 680 m 523 680 l S",
		].join("\n");
		objects[pageId] =
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
		objects[pageId + 1] =
			`<< /Length ${Buffer.byteLength(lines)} >>\nstream\n${lines}\nendstream`;
	});
	objects[fontId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

	let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
	const offsets: number[] = [];
	for (let id = 1; id < objects.length; id++) {
		offsets[id] = Buffer.byteLength(out, "latin1");
		out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
	}
	const xref = Buffer.byteLength(out, "latin1");
	out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
	for (let id = 1; id < objects.length; id++)
		out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}
