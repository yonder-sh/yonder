/**
 * PDF pages for the in-app viewer and the first-page thumbnail (ADDENDUM §9):
 * poppler's `pdftoppm` renders at most PDF_MAX_PAGES pages to PNG in a
 * throwaway directory; the worker turns them into WebP. Without poppler (or on
 * an encrypted/broken file) the tile falls back to the PDF icon and the
 * viewer offers the download only.
 *
 * `PDFTOPPM_PATH` (default `pdftoppm` on PATH; `pdfinfo` is looked up next to
 * it). NixOS dev: `nix build nixpkgs#poppler-utils --no-link --print-out-paths`
 * + `/bin/pdftoppm`. Untrusted input: a hard timeout, one process per file,
 * run only in the worker.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getEnv } from "@/server/env.server";
import { PDF_MAX_PAGES } from "../media-kinds";

export function pdftoppmPath(): string {
	return getEnv().PDFTOPPM_PATH?.trim() || "pdftoppm";
}

function pdfinfoPath(): string {
	const p = pdftoppmPath();
	return p.includes("/") ? path.join(path.dirname(p), "pdfinfo") : "pdfinfo";
}

function run(
	bin: string,
	args: string[],
	timeoutMs: number,
): Promise<{ stdout: string }> {
	return new Promise((resolve, reject) => {
		execFile(
			bin,
			args,
			{ timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
			(err, stdout) =>
				err ? reject(err) : resolve({ stdout: String(stdout) }),
		);
	});
}

export type RenderedPdf = {
	/** PNG bytes per rendered page, in order. */
	pages: Buffer[];
	/** Total pages in the document (from pdfinfo), when known. */
	pageCount: number | null;
};

/**
 * Renders pages 1…`maxPages` so the long side is `longSide` px. Throws when
 * poppler is missing or the file can't be rendered.
 */
export async function renderPdfPages(
	pdf: Buffer,
	opts: { maxPages?: number; longSide?: number; timeoutMs?: number } = {},
): Promise<RenderedPdf> {
	const maxPages = opts.maxPages ?? PDF_MAX_PAGES;
	const dir = await mkdtemp(path.join(tmpdir(), "yonder-pdf-"));
	try {
		const input = path.join(dir, "in.pdf");
		await writeFile(input, pdf, { mode: 0o600 });
		let pageCount: number | null = null;
		try {
			const info = await run(pdfinfoPath(), [input], 15_000);
			const m = /^Pages:\s+(\d+)/m.exec(info.stdout);
			pageCount = m ? Number(m[1]) : null;
		} catch {
			pageCount = null; // pdfinfo is optional
		}
		await run(
			pdftoppmPath(),
			[
				"-q",
				"-png",
				"-f",
				"1",
				"-l",
				String(maxPages),
				"-scale-to",
				String(opts.longSide ?? 1600),
				input,
				path.join(dir, "p"),
			],
			opts.timeoutMs ?? 60_000,
		);
		const files = (await readdir(dir))
			.map((f) => ({
				f,
				n: Number(/^p-(\d+)\.png$/.exec(f)?.[1] ?? Number.NaN),
			}))
			.filter((x) => Number.isFinite(x.n))
			.sort((a, b) => a.n - b.n);
		if (files.length === 0) throw new Error("no pages rendered");
		const pages = await Promise.all(
			files.map((x) => readFile(path.join(dir, x.f))),
		);
		return { pages, pageCount: pageCount ?? pages.length };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
