import type { DownloadedFile } from "#lib/data/project-view-model.svelte.js";

/** Hand a downloaded file to the browser's save flow. */
export function saveFile({ blob, filename }: DownloadedFile): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // The click starts the download synchronously; the URL can go next tick.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
