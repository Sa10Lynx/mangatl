/**
 * Runtime validation of the message envelope crossing the content-script <-> background
 * service-worker boundary. Fails closed: missing required fields, wrong-typed fields, unknown
 * `type` values, non-object input, and ANY unexpected/extra field (top-level or nested, e.g. inside
 * `descriptor` or `bbox`) are all rejected rather than silently stripped -- this message crosses
 * from a content script running inside an arbitrary (possibly-hostile) page's world into the
 * privileged background service worker.
 */
import type {
  CandidateFoundMessage,
  ExtensionMessage,
  FetchResultMessage,
  ImageDescriptor,
  Rect,
} from "./types";

export type { CandidateFoundMessage, ExtensionMessage, FetchResultMessage, ImageDescriptor, Rect };

export type MessageValidationResult =
  | { ok: true; message: ExtensionMessage }
  | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyAllowedKeys(obj: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(obj).every((key) => allowedKeys.includes(key));
}

function isValidRect(value: unknown): value is Rect {
  if (!isPlainObject(value)) {
    return false;
  }
  if (!hasOnlyAllowedKeys(value, ["x", "y", "width", "height"])) {
    return false;
  }
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height)
  );
}

function isValidImageDescriptor(value: unknown): value is ImageDescriptor {
  if (!isPlainObject(value)) {
    return false;
  }
  if (!hasOnlyAllowedKeys(value, ["url", "width", "height", "containerHints"])) {
    return false;
  }
  if (typeof value.url !== "string") {
    return false;
  }
  if (!Number.isFinite(value.width)) {
    return false;
  }
  if (!Number.isFinite(value.height)) {
    return false;
  }
  if ("containerHints" in value) {
    const hints = value.containerHints;
    if (!Array.isArray(hints) || !hints.every((hint) => typeof hint === "string")) {
      return false;
    }
  }
  return true;
}

// Plain boolean (not a `value is CandidateFoundMessage` predicate): CandidateFoundMessage has no
// index signature, so it isn't assignable to Record<string, unknown> for predicate-narrowing
// purposes even though every value satisfying these checks does satisfy the interface at runtime.
function isValidCandidateFoundMessage(value: Record<string, unknown>): boolean {
  if (!hasOnlyAllowedKeys(value, ["type", "requestId", "descriptor", "bbox"])) {
    return false;
  }
  if (typeof value.requestId !== "string") {
    return false;
  }
  if (!isValidImageDescriptor(value.descriptor)) {
    return false;
  }
  if (!isValidRect(value.bbox)) {
    return false;
  }
  return true;
}

function isValidFetchResultMessage(value: Record<string, unknown>): boolean {
  if (!hasOnlyAllowedKeys(value, ["type", "requestId", "ok", "reason"])) {
    return false;
  }
  if (typeof value.requestId !== "string") {
    return false;
  }
  if (typeof value.ok !== "boolean") {
    return false;
  }
  if ("reason" in value && typeof value.reason !== "string") {
    return false;
  }
  return true;
}

export function validateMessage(input: unknown): MessageValidationResult {
  if (!isPlainObject(input)) {
    return { ok: false, reason: "message must be a plain, non-array object" };
  }

  if (typeof input.type !== "string") {
    return { ok: false, reason: "message is missing a valid 'type' field" };
  }

  switch (input.type) {
    case "CANDIDATE_FOUND":
      if (!isValidCandidateFoundMessage(input)) {
        return { ok: false, reason: "malformed CANDIDATE_FOUND message" };
      }
      return { ok: true, message: input as unknown as CandidateFoundMessage };
    case "FETCH_RESULT":
      if (!isValidFetchResultMessage(input)) {
        return { ok: false, reason: "malformed FETCH_RESULT message" };
      }
      return { ok: true, message: input as unknown as FetchResultMessage };
    default:
      return { ok: false, reason: `unrecognized message type: ${input.type}` };
  }
}
