/**
 * "Is this a manga panel vs. ad/logo/avatar" heuristic. Operates ONLY on an already-resolved
 * ImageDescriptor (real URL + final rendered dimensions + flattened container-hint tokens) --
 * reading data-src/lazy-load attributes is dom-scan.ts's job, out of scope here.
 */
import type { ImageDescriptor } from "./types";

export type { ImageDescriptor };

export interface CandidateFilterOptions {
  minWidth?: number;
  minHeight?: number;
  minAspectRatio?: number;
  maxAspectRatio?: number;
  blockedContainerHints?: string[];
}

interface ResolvedOptions {
  minWidth: number;
  minHeight: number;
  minAspectRatio: number;
  maxAspectRatio: number;
  blockedContainerHints: string[];
}

const DEFAULT_OPTIONS: ResolvedOptions = {
  minWidth: 400,
  minHeight: 400,
  minAspectRatio: 0.3,
  maxAspectRatio: 3.0,
  blockedContainerHints: ["ad", "ads", "sponsor", "sponsored", "nav"],
};

/** Split a hint string on non-alphanumeric characters into lowercase tokens. */
function tokenize(hint: string): string[] {
  return hint
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length > 0);
}

function hasBlockedHint(containerHints: string[] | undefined, blockedList: string[]): boolean {
  if (!containerHints || containerHints.length === 0) {
    return false;
  }
  const blockedTokens = new Set(blockedList.map((hint) => hint.toLowerCase()));
  for (const hint of containerHints) {
    for (const token of tokenize(hint)) {
      if (blockedTokens.has(token)) {
        return true;
      }
    }
  }
  return false;
}

export function isCandidateImage(
  descriptor: ImageDescriptor,
  options?: CandidateFilterOptions
): boolean {
  const opts: ResolvedOptions = { ...DEFAULT_OPTIONS, ...options };

  if (!(descriptor.width > opts.minWidth) || !(descriptor.height > opts.minHeight)) {
    return false;
  }

  const aspectRatio = descriptor.width / descriptor.height;
  if (aspectRatio < opts.minAspectRatio || aspectRatio > opts.maxAspectRatio) {
    return false;
  }

  if (hasBlockedHint(descriptor.containerHints, opts.blockedContainerHints)) {
    return false;
  }

  return true;
}

export function filterCandidates(
  descriptors: ImageDescriptor[],
  options?: CandidateFilterOptions
): ImageDescriptor[] {
  return descriptors.filter((descriptor) => isCandidateImage(descriptor, options));
}
