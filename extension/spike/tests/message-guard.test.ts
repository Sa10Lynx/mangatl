/**
 * Unit tests for `extension/spike/src/message-guard.ts` -- runtime validation of the message
 * envelope crossing the content-script <-> background service-worker boundary (spec 01 "What to
 * build" #1: content script finds candidate images; background worker fetches/captures them).
 *
 * message-guard.ts does NOT exist yet at test-writing time. These tests are the contract the
 * coder stage implements against.
 *
 * Expected public API:
 *
 *   export interface Rect { x: number; y: number; width: number; height: number; }
 *
 *   export interface ImageDescriptor {
 *     url: string;
 *     width: number;
 *     height: number;
 *     containerHints?: string[];
 *   }
 *
 *   // content-script -> background: "I found a candidate image at this DOM position."
 *   export interface CandidateFoundMessage {
 *     type: "CANDIDATE_FOUND";
 *     requestId: string;
 *     descriptor: ImageDescriptor;
 *     bbox: Rect; // element's bounding rect, for the captureVisibleTab crop-rect fallback
 *   }
 *
 *   // background -> content-script: fetch/capture outcome for a given requestId.
 *   export interface FetchResultMessage {
 *     type: "FETCH_RESULT";
 *     requestId: string;
 *     ok: boolean;
 *     reason?: string; // present when ok === false
 *   }
 *
 *   export type ExtensionMessage = CandidateFoundMessage | FetchResultMessage;
 *
 *   export type MessageValidationResult =
 *     | { ok: true; message: ExtensionMessage }
 *     | { ok: false; reason: string };
 *
 *   export function validateMessage(input: unknown): MessageValidationResult;
 *
 * Design decision this suite locks down (spec doesn't specify it; a default had to be picked, per
 * CLAUDE.md working style of noting rather than silently guessing on anything at a trust
 * boundary): unexpected/extra fields anywhere in the message -- top-level or nested -- are
 * REJECTED (fail closed), never silently stripped. This message crosses from a content script
 * running inside an arbitrary (possibly-hostile) page's world into the privileged background
 * service worker; being strict costs nothing here (the spike only ever sends the fields declared
 * above) and mirrors the "fail closed" precedent already set by `check_authorized` in spec 00's
 * ocr_pipeline.py.
 */
import { describe, expect, it } from "vitest";
import { validateMessage, type CandidateFoundMessage, type FetchResultMessage } from "../src/message-guard";

function validCandidateFoundMessage(): CandidateFoundMessage {
  return {
    type: "CANDIDATE_FOUND",
    requestId: "req-1",
    descriptor: {
      url: "https://reader.example/img.jpg",
      width: 900,
      height: 1350,
      containerHints: ["manga-reader"],
    },
    bbox: { x: 10, y: 20, width: 300, height: 450 },
  };
}

function validFetchResultMessage(): FetchResultMessage {
  return {
    type: "FETCH_RESULT",
    requestId: "req-1",
    ok: true,
  };
}

function expectValid(input: unknown) {
  const result = validateMessage(input);
  expect(result.ok).toBe(true);
  return result;
}

function expectInvalid(input: unknown) {
  const result = validateMessage(input);
  expect(result.ok).toBe(false);
  return result;
}

describe("validateMessage -- CANDIDATE_FOUND messages", () => {
  it("accepts a well-formed CANDIDATE_FOUND message", () => {
    const result = expectValid(validCandidateFoundMessage());
    if (result.ok) {
      expect(result.message).toEqual(validCandidateFoundMessage());
    }
  });

  it("rejects a message missing a required top-level field (requestId)", () => {
    const message = validCandidateFoundMessage();
    // @ts-expect-error -- intentionally constructing an invalid message for the test
    delete message.requestId;
    expectInvalid(message);
  });

  it("rejects a message missing the descriptor entirely", () => {
    const message = validCandidateFoundMessage();
    // @ts-expect-error -- intentionally constructing an invalid message for the test
    delete message.descriptor;
    expectInvalid(message);
  });

  it("rejects a message missing a required field inside descriptor (url)", () => {
    const message = validCandidateFoundMessage();
    // @ts-expect-error -- intentionally constructing an invalid message for the test
    delete message.descriptor.url;
    expectInvalid(message);
  });

  it("rejects a message where bbox fields are the wrong type (numbers expected, strings given)", () => {
    const message = {
      ...validCandidateFoundMessage(),
      bbox: { x: "10", y: "20", width: "300", height: "450" },
    };
    expectInvalid(message);
  });

  it("rejects a message where bbox is not an object at all", () => {
    const message = { ...validCandidateFoundMessage(), bbox: "not-a-rect" };
    expectInvalid(message);
  });

  it("rejects a message where descriptor.width is the wrong type", () => {
    const message = validCandidateFoundMessage();
    message.descriptor = { ...message.descriptor, width: "900" as unknown as number };
    expectInvalid(message);
  });

  it("rejects a message with an unexpected extra top-level field", () => {
    const message = { ...validCandidateFoundMessage(), unexpectedField: "sneaky" };
    expectInvalid(message);
  });

  it("rejects a message with an unexpected extra field nested inside bbox", () => {
    const message = validCandidateFoundMessage();
    message.bbox = { ...message.bbox, extra: true } as unknown as CandidateFoundMessage["bbox"];
    expectInvalid(message);
  });

  // Regression: typeof NaN === "number" and typeof Infinity === "number" are both true in JS, so a
  // bare `typeof value.x === "number"` check does NOT reject these -- defeating this module's
  // fail-closed purpose at the content-script/background trust boundary. isValidRect and
  // isValidImageDescriptor must additionally check Number.isFinite(...) for every numeric field.
  it("rejects a message where a bbox field is NaN", () => {
    const message = validCandidateFoundMessage();
    message.bbox = { ...message.bbox, width: NaN };
    expectInvalid(message);
  });

  it("rejects a message where a bbox field is Infinity", () => {
    const message = validCandidateFoundMessage();
    message.bbox = { ...message.bbox, height: Infinity };
    expectInvalid(message);
  });

  it("rejects a message where a bbox field is -Infinity", () => {
    const message = validCandidateFoundMessage();
    message.bbox = { ...message.bbox, x: -Infinity };
    expectInvalid(message);
  });

  it("rejects a message where descriptor.width and descriptor.height are NaN", () => {
    const message = validCandidateFoundMessage();
    message.descriptor = { ...message.descriptor, width: NaN, height: NaN };
    expectInvalid(message);
  });
});

describe("validateMessage -- FETCH_RESULT messages", () => {
  it("accepts a well-formed FETCH_RESULT message with ok: true", () => {
    expectValid(validFetchResultMessage());
  });

  it("accepts a well-formed FETCH_RESULT message with ok: false and a reason", () => {
    const message: FetchResultMessage = {
      type: "FETCH_RESULT",
      requestId: "req-1",
      ok: false,
      reason: "non-2xx",
    };
    expectValid(message);
  });

  it("rejects a FETCH_RESULT message missing requestId", () => {
    const message = validFetchResultMessage();
    // @ts-expect-error -- intentionally constructing an invalid message for the test
    delete message.requestId;
    expectInvalid(message);
  });

  it("rejects a FETCH_RESULT message with an unexpected extra field", () => {
    const message = { ...validFetchResultMessage(), debug: "leaky" };
    expectInvalid(message);
  });
});

describe("validateMessage -- malformed input in general", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "CANDIDATE_FOUND"],
    ["an array", []],
  ])("rejects %s as input", (_label, input) => {
    expectInvalid(input);
  });

  it("rejects a message with an unrecognized `type` value", () => {
    const message = { ...validCandidateFoundMessage(), type: "SOMETHING_ELSE" };
    expectInvalid(message);
  });

  it("rejects a message with no `type` field at all", () => {
    const message = validCandidateFoundMessage();
    // @ts-expect-error -- intentionally constructing an invalid message for the test
    delete message.type;
    expectInvalid(message);
  });
});
