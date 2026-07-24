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

// Matches an absolute Windows path with a drive letter, either backslash- or forward-slash-style
// (e.g. "C:\Windows\evil.dll" or "C:/Windows/evil.dll").
const WINDOWS_DRIVE_LETTER_PATTERN = /^[a-zA-Z]:[\\/]/;

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
 * and absolute paths (Unix-style, or Windows-style with a drive letter, whether using backslashes
 * or forward slashes).
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
    if (segment === "..") {
      if (resolvedSegments.length === 0) {
        throw new PathTraversalError(
          `path traversal outside of ${baseDir}: ${filename}`
        );
      }
      resolvedSegments.pop();
    } else {
      resolvedSegments.push(segment);
    }
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
