/**
 * Unit tests for `extension/spike/src/logging.ts` -- encodes CLAUDE.md invariant 3 ("Images are
 * transient. Never persist them... Never log image bytes... Only OCR'd text + bounding-box
 * geometry may be cached/stored long-term") for THIS spike, per the human-locked decision that
 * resolved the planner's open question:
 *
 *   "Logging is metadata-only by default. logging.ts must emit only: byte length, width, height,
 *   MIME type, and a short hash (e.g. sha256 prefix) -- never raw bytes, never full base64. A
 *   full-byte dump is only possible behind an explicit opt-in flag, writing to a gitignored
 *   local-only path, meant to be deleted after manual review."
 *
 * logging.ts does NOT exist yet at test-writing time. These tests are the contract the coder
 * stage implements against.
 *
 * Expected public API:
 *
 *   export type HashFn = (bytes: Uint8Array) => string;
 *
 *   export interface ImageMetadataInput { width: number; height: number; mimeType: string; }
 *
 *   export interface ImageLogMetadata {
 *     byteLength: number;
 *     width: number;
 *     height: number;
 *     mimeType: string;
 *     hash: string;
 *   }
 *
 *   // Pure. `hashFn` is an injected DI seam (same pattern as image-fetch.ts's injected fetch) so
 *   // this module never needs a real crypto implementation to be unit-tested, and stays
 *   // synchronous (Web Crypto's subtle.digest is async; injecting keeps this layer pure and
 *   // environment-agnostic -- it must work identically in a Node test run and in a real MV3
 *   // service worker).
 *   export function buildImageLogMetadata(
 *     input: ImageMetadataInput,
 *     bytes: Uint8Array,
 *     hashFn: HashFn
 *   ): ImageLogMetadata;
 *
 *   // The actual string handed to console.log(...) (or written to a metadata-only log). Built
 *   // ONLY from an ImageLogMetadata -- never given the raw bytes -- which is itself a structural
 *   // guarantee against ever accidentally including them: there is nothing to leak because the
 *   // bytes were never passed in.
 *   export function formatMetadataLogLine(metadata: ImageLogMetadata): string;
 *
 *   // The designated, gitignored, local-only directory raw dumps may be written under (the
 *   // coder's real implementation is expected to ensure this directory -- or a parent of it -- is
 *   // listed in .gitignore). This constant is what dumpRawBytes enforces path containment
 *   // against.
 *   export const LOCAL_ONLY_DUMP_DIR: string; // e.g. ".local-only-dumps"
 *
 *   export class PathTraversalError extends Error {}
 *
 *   // Joins `filename` onto `baseDir` and returns a normalized, containment-checked path. Throws
 *   // PathTraversalError -- and must NOT return any path -- if the normalized result would fall
 *   // outside baseDir (".." segments, absolute paths, drive letters, backslash tricks, etc. --
 *   // path traversal in general, not just one specific technique).
 *   export function resolveDumpPath(baseDir: string, filename: string): string;
 *
 *   // Opt-in ONLY: callers (background.ts) decide whether to invoke this at all, gated behind an
 *   // explicit flag/config that lives outside this module -- logging.ts itself does not read any
 *   // ambient env var or global flag. `writeFile` is an injected DI seam (same pattern as
 *   // image-fetch.ts's injected fetch), so this suite performs zero real disk I/O. Resolves the
 *   // path via resolveDumpPath FIRST (so a traversal attempt throws and writeFile is NEVER
 *   // called), then calls writeFile(resolvedPath, bytes) and returns the resolved path.
 *   export function dumpRawBytes(
 *     baseDir: string,
 *     filename: string,
 *     bytes: Uint8Array,
 *     writeFile: (path: string, data: Uint8Array) => void
 *   ): string;
 *
 * Note on "opt-in by default off": buildImageLogMetadata/formatMetadataLogLine (the default,
 * always-on logging path) don't accept a writeFile/fs dependency at all -- there is structurally
 * no way for the default path to perform any disk I/O, raw-byte or otherwise. Only an explicit,
 * separate call to dumpRawBytes (with its own injected writeFile) can ever write bytes anywhere.
 * That separation is what "opt-in" means here and is exercised by the tests below.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildImageLogMetadata,
  dumpRawBytes,
  formatMetadataLogLine,
  LOCAL_ONLY_DUMP_DIR,
  PathTraversalError,
  resolveDumpPath,
  type ImageLogMetadata,
} from "../src/logging";

// A distinctive byte payload -- if it (or its base64 form) ever showed up in logged metadata or
// the formatted log line, that would be an invariant-3 violation caught by these tests.
const SECRET_MARKER = "SECRET-RAW-MANGA-PAGE-BYTES-DO-NOT-LOG";
const secretBytes = new TextEncoder().encode(SECRET_MARKER);
const secretBase64 = Buffer.from(secretBytes).toString("base64");

const fakeHashFn = vi.fn((bytes: Uint8Array) => `fake-hash-of-${bytes.length}-bytes`);

describe("buildImageLogMetadata / formatMetadataLogLine -- default metadata-only logging", () => {
  it("produces exactly the five documented metadata fields and nothing else", () => {
    const metadata = buildImageLogMetadata(
      { width: 900, height: 1350, mimeType: "image/jpeg" },
      secretBytes,
      fakeHashFn
    );

    expect(Object.keys(metadata).sort()).toEqual(
      ["byteLength", "hash", "height", "mimeType", "width"].sort()
    );
  });

  it("reports byteLength, width, height, and mimeType pass-through correctly", () => {
    const metadata = buildImageLogMetadata(
      { width: 900, height: 1350, mimeType: "image/jpeg" },
      secretBytes,
      fakeHashFn
    );

    expect(metadata.byteLength).toBe(secretBytes.length);
    expect(metadata.width).toBe(900);
    expect(metadata.height).toBe(1350);
    expect(metadata.mimeType).toBe("image/jpeg");
  });

  it("uses the injected hashFn for the hash field, rather than computing its own", () => {
    fakeHashFn.mockClear();
    const metadata = buildImageLogMetadata(
      { width: 900, height: 1350, mimeType: "image/jpeg" },
      secretBytes,
      fakeHashFn
    );

    expect(fakeHashFn).toHaveBeenCalledTimes(1);
    expect(fakeHashFn).toHaveBeenCalledWith(secretBytes);
    expect(metadata.hash).toBe(`fake-hash-of-${secretBytes.length}-bytes`);
  });

  it("never includes the raw bytes or a base64 encoding of them anywhere in the metadata object", () => {
    const metadata = buildImageLogMetadata(
      { width: 900, height: 1350, mimeType: "image/jpeg" },
      secretBytes,
      fakeHashFn
    );

    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain(SECRET_MARKER);
    expect(serialized).not.toContain(secretBase64);
    // No key on the object should hold the raw bytes either.
    expect(metadata).not.toHaveProperty("bytes");
    expect(metadata).not.toHaveProperty("base64");
    expect(metadata).not.toHaveProperty("data");
  });

  it("never includes the raw bytes or a base64 encoding of them in the formatted log line", () => {
    const metadata: ImageLogMetadata = {
      byteLength: secretBytes.length,
      width: 900,
      height: 1350,
      mimeType: "image/jpeg",
      hash: "abc123",
    };

    const line = formatMetadataLogLine(metadata);

    expect(typeof line).toBe("string");
    expect(line).not.toContain(SECRET_MARKER);
    expect(line).not.toContain(secretBase64);
    // The formatted line should still surface the metadata itself, for it to be a useful log.
    expect(line).toContain(String(metadata.byteLength));
    expect(line).toContain(String(metadata.width));
    expect(line).toContain(String(metadata.height));
    expect(line).toContain(metadata.mimeType);
    expect(line).toContain(metadata.hash);
  });
});

describe("resolveDumpPath -- containment under LOCAL_ONLY_DUMP_DIR", () => {
  it("resolves a simple filename under the base dir successfully", () => {
    const path = resolveDumpPath(LOCAL_ONLY_DUMP_DIR, "image-abc123.bin");
    expect(path.startsWith(LOCAL_ONLY_DUMP_DIR)).toBe(true);
  });

  it("resolves a nested-subdirectory filename under the base dir successfully", () => {
    const path = resolveDumpPath(LOCAL_ONLY_DUMP_DIR, "2026-07-23/image-abc123.bin");
    expect(path.startsWith(LOCAL_ONLY_DUMP_DIR)).toBe(true);
  });

  it.each([
    ["a simple ../ traversal", "../escape.bin"],
    ["a deeper ../../ traversal", "../../etc/escape.bin"],
    ["a traversal that first dips into a subdirectory", "safe/../../escape.bin"],
    ["a backslash-style traversal", "..\\escape.bin"],
    ["a unix absolute path", "/etc/passwd"],
    ["a windows absolute path with drive letter", "C:\\Windows\\evil.dll"],
    ["a windows-style absolute path with forward slashes", "C:/Windows/evil.dll"],
  ])("throws PathTraversalError for %s and does not return a path", (_label, filename) => {
    expect(() => resolveDumpPath(LOCAL_ONLY_DUMP_DIR, filename)).toThrow(PathTraversalError);
  });
});

describe("dumpRawBytes -- opt-in raw-byte dump path", () => {
  it("writes bytes via the injected writeFile, to a path under LOCAL_ONLY_DUMP_DIR, when explicitly invoked", () => {
    const writeFile = vi.fn();

    const path = dumpRawBytes(LOCAL_ONLY_DUMP_DIR, "image-abc123.bin", secretBytes, writeFile);

    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith(path, secretBytes);
    expect(path.startsWith(LOCAL_ONLY_DUMP_DIR)).toBe(true);
  });

  it("returns the exact resolved path it wrote to", () => {
    const writeFile = vi.fn();

    const path = dumpRawBytes(LOCAL_ONLY_DUMP_DIR, "image-def456.bin", secretBytes, writeFile);
    const expectedPath = resolveDumpPath(LOCAL_ONLY_DUMP_DIR, "image-def456.bin");

    expect(path).toBe(expectedPath);
  });

  it("throws PathTraversalError and NEVER calls writeFile for a path-traversal filename", () => {
    const writeFile = vi.fn();

    expect(() =>
      dumpRawBytes(LOCAL_ONLY_DUMP_DIR, "../../escape.bin", secretBytes, writeFile)
    ).toThrow(PathTraversalError);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("throws PathTraversalError and NEVER calls writeFile for an absolute-path escape attempt", () => {
    const writeFile = vi.fn();

    expect(() =>
      dumpRawBytes(LOCAL_ONLY_DUMP_DIR, "/etc/passwd", secretBytes, writeFile)
    ).toThrow(PathTraversalError);
    expect(writeFile).not.toHaveBeenCalled();
  });
});
