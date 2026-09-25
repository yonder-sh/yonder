/**
 * Video poster frames with ffmpeg (SPEC §15.2; spikes/media): ffmpeg reads
 * the upload straight from a presigned GET (internal endpoint), fetching only
 * the byte ranges it needs, with `-ss 0.5` and the `thumbnail=30` filter so
 * the frame isn't black. The demuxer is forced from the (sniffed) type so a
 * disguised playlist can never make ffmpeg fetch other URLs.
 */
import { execFile } from "node:child_process";
import { getEnv } from "@/server/env.server";

export function ffmpegPath(): string {
	return getEnv().FFMPEG_PATH?.trim() || "ffmpeg";
}

const DEMUXER: Record<string, string> = {
	"video/mp4": "mov",
	"video/quicktime": "mov",
	"video/webm": "matroska",
};

/** A JPEG poster frame, or throws (missing ffmpeg, undecodable video). */
export function posterFrame(
	url: string,
	mime: string,
	timeoutMs = 20_000,
): Promise<Buffer> {
	const format = DEMUXER[mime];
	if (!format) return Promise.reject(new Error(`no demuxer for ${mime}`));
	const args = [
		"-hide_banner",
		"-loglevel",
		"error",
		"-protocol_whitelist",
		"http,https,tcp,tls",
		"-ss",
		"0.5",
		"-f",
		format,
		"-i",
		url,
		"-vf",
		"thumbnail=30,scale='min(960,iw)':-2",
		"-frames:v",
		"1",
		"-f",
		"image2pipe",
		"-c:v",
		"mjpeg",
		"-q:v",
		"3",
		"pipe:1",
	];
	return new Promise((resolve, reject) => {
		execFile(
			ffmpegPath(),
			args,
			{
				encoding: "buffer",
				timeout: timeoutMs,
				killSignal: "SIGKILL",
				maxBuffer: 20 * 1024 * 1024,
			},
			(err, stdout) => {
				if (err) return reject(new Error("ffmpeg failed"));
				const out = stdout as Buffer;
				if (!out.length) return reject(new Error("no frame"));
				resolve(out);
			},
		);
	});
}
