// A pasted Figma link is the lowest-friction way to point vlint at a file: the
// file key and the selected node id both ride in the URL, so onboarding needs
// no hand-typed manifest keys. This parser is pure string work; resolving a
// node id to a page still needs the API.

export interface FigmaRef {
  // The file key: the segment after /file/, /design/, or /proto/.
  fileKey: string;
  // The selected node id in Figma's API form (285:31), or null when the URL
  // carries no node-id. Figma writes it dash-separated (285-31) in links and
  // colon-separated in the API; we normalise to the API form.
  nodeId: string | null;
}

// Figma URLs look like:
//   https://www.figma.com/file/AbC123/Dashboard?node-id=285-31
//   https://www.figma.com/design/AbC123/Dashboard?node-id=285%3A31&t=...
//   https://figma.com/proto/AbC123/Name?node-id=0-1
// and the bare key on its own is accepted too, so a user who only has the key
// is not forced to reconstruct a URL.
export function parseFigmaUrl(input: string): FigmaRef | null {
  const raw = input.trim();
  if (!raw) return null;

  // A bare file key: Figma keys are URL-safe alphanumerics, no slashes.
  if (/^[A-Za-z0-9]+$/.test(raw)) {
    return { fileKey: raw, nodeId: null };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (!/(^|\.)figma\.com$/.test(url.hostname)) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const kindIdx = segments.findIndex((s) => s === "file" || s === "design" || s === "proto");
  if (kindIdx === -1 || !segments[kindIdx + 1]) return null;
  const fileKey = segments[kindIdx + 1];

  const rawNode = url.searchParams.get("node-id");
  return { fileKey, nodeId: rawNode ? normaliseNodeId(rawNode) : null };
}

// node-id=285-31 or 285%3A31 -> 285:31. URLSearchParams already decodes the
// %3A, so we only fold the dash form back to a colon; ids that already carry a
// colon (or the instance form I1:2;3:4) pass through unchanged.
function normaliseNodeId(raw: string): string {
  const decoded = raw.trim();
  if (decoded.includes(":")) return decoded;
  return decoded.replace("-", ":");
}

// True when a manifest value looks like a node id (285:31) rather than a page
// name, so extraction can decide whether to match a page by id or by name.
export function looksLikeNodeId(value: string): boolean {
  return /^[A-Za-z]?\d+[:-]\d+/.test(value.trim());
}
