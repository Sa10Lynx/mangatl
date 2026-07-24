/**
 * CLAUDE.md invariant 3 ("Images are transient... Never log image bytes... Only OCR'd text +
 * bounding-box geometry may be cached/stored long-term"), applied to this spike.
 *
 * Default logging path (buildImageLogMetadata / formatMetadataLogLine) is metadata-only and
 * structurally cannot leak raw bytes: it is never given the bytes at all past computing a length
 * and handing them to an injected hash function. Only an explicit, separate call to dumpRawBytes
 * (itself gated behind a caller-owned opt-in flag that lives outside this module) can ever write
 * raw bytes anywhere, and only under the designated, gitignored LOCAL_ONLY_DUMP_DIR directory.
 */

export type HashFn = (bytes: Uint8Array) => string;

export interface ImageMetadataInput {
  width: number;
  height: number;
  mimeType: string;
}

export interface ImageLogMetadata {
  byteLength: number;
  width: number;
  height: number;
  mimeType: string;
  hash: string;
}

/** Pure. Never touches the raw bytes beyond `.length` and handing them to the injected hashFn. */
export function buildImageLogMetadata(
  input: ImageMetadataInput,
  bytes: Uint8Array,
  hashFn: HashFn
): ImageLogMetadata {
  return {
    byteLength: bytes.length,
    width: input.width,
    height: input.height,
    mimeType: input.mimeType,
    hash: hashFn(bytes),
  };
}

/** Built ONLY from an ImageLogMetadata -- never given raw bytes -- so there is nothing to leak. */
export function formatMetadataLogLine(metadata: ImageLogMetadata): string {
  return (
    `[image] bytes=${metadata.byteLength} ` +
    `dimensions=${metadata.width}x${metadata.height} ` +
    `mime=${metadata.mimeType} hash=${metadata.hash}`
  );
}

// The designated, gitignored, local-only directory raw dumps may be written under (see
// extension/spike/.gitignore). Anything under here is for manual review only, never committed.
export const LOCAL_ONLY_DUMP_DIR = ".local-only-dumps";

export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathTraversalError";
  }
}

// Matches ANY drive-letter-colon prefix (e.g. "C:\Windows\evil.dll", "C:/Windows/evil.dll", or a
// drive-RELATIVE path like "C:evil.txt"/"C:../secret.txt" -- valid Windows syntax meaning
// "relative to the current directory on drive C", still capable of traversal). Deliberately broader
// than requiring a separator immediately after the colon: ANY drive-letter-colon prefix is treated
// as an unsafe/ambiguous path outside this module's plain relative-segment model, not just the
// slash-qualified form.
const WINDOWS_DRIVE_LETTER_PATTERN = /^[a-zA-Z]:/;

function isAbsolutePath(filename: string): boolean {
  return (
    filename.startsWith("/") ||
    filename.startsWith("\\") ||
    WINDOWS_DRIVE_LETTER_PATTERN.test(filename)
  );
}

/**
 * Joins `filename` onto `baseDir` and returns a normalized, containment-checked path. Deliberately
 * implemented without a Node-specific path module: this logic is expected to behave identically
 * whether it runs under Vitest/Node or inside a real MV3 service worker.
 *
 * Throws PathTraversalError (and never returns a path) for any attempt to escape baseDir: relative
 * ".." traversal (including one that first dips into a subdirectory), backslash-style traversal,
 * disguised dots/spaces-only segments that Windows would normalize back into a ".." at the real
 * filesystem call (e.g. ".. "), and absolute paths (Unix-style, Windows-style with a drive letter
 * whether using backslashes or forward slashes, or a drive-relative path like "C:evil.txt").
 */
export function resolveDumpPath(baseDir: string, filename: string): string {
  if (isAbsolutePath(filename)) {
    throw new PathTraversalError(
      `refusing to resolve absolute path outside of ${baseDir}: ${filename}`
    );
  }

  const segments = filename
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== ".");

  const resolvedSegments: string[] = [];
  for (const segment of segments) {
    // Reject any segment composed ENTIRELY of dots and/or spaces (length >= 2) as an unconditional
    // traversal attempt, rather than only checking for an exact ".." string match.
    //
    // Why: Win32 silently strips TRAILING dots and spaces from a path segment once it actually
    // reaches the real filesystem, so a disguised segment like ".. " ("..": two dots plus a
    // trailing space) is NOT equal to the literal string ".." at this JS-level string-comparison
    // layer, yet gets normalized right back to ".." the moment a real Windows filesystem call
    // processes it -- letting it slip past a naive `segment === ".."` check and potentially escape
    // baseDir once resolveDumpPath's caller actually writes to the resolved path on Windows.
    //
    // No legitimate dump filename ever needs a dots/spaces-only segment (real filenames here look
    // like "image-<hash>.bin" or "<date>/image-<hash>.bin"), so rather than trying to precisely
    // replicate every permutation of Win32's trailing-dot/space trim rule (which is subtle and easy
    // to get wrong -- exactly the kind of gap that's easy to reintroduce), it's simplest and safest
    // to reject the whole class of dots/spaces-only segments outright.
    if (/^[. ]{2,}$/.test(segment)) {
      throw new PathTraversalError(
        `path traversal outside of ${baseDir}: ${filename}`
      );
    }
    resolvedSegments.push(segment);
  }

  if (resolvedSegments.length === 0) {
    throw new PathTraversalError(`filename resolves to an empty path: ${filename}`);
  }

  const normalizedBaseDir = baseDir.replace(/[\\/]+$/, "");
  return `${normalizedBaseDir}/${resolvedSegments.join("/")}`;
}

/**
 * Opt-in ONLY: callers (background.ts) decide whether to invoke this at all, gated behind an
 * explicit flag/config that lives outside this module. Resolves the path via resolveDumpPath FIRST
 * so a traversal attempt throws and `writeFile` is NEVER called, then calls
 * writeFile(resolvedPath, bytes) and returns the resolved path.
 */
export function dumpRawBytes(
  baseDir: string,
  filename: string,
  bytes: Uint8Array,
  writeFile: (path: string, data: Uint8Array) => void
): string {
  const resolvedPath = resolveDumpPath(baseDir, filename);
  writeFile(resolvedPath, bytes);
  return resolvedPath;
}
