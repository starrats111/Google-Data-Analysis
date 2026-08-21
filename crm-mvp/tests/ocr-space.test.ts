import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseOcrSpaceResponse } from "../src/lib/ocr-space";

describe("parseOcrSpaceResponse", () => {
  test("成功响应：拼接 ParsedText", () => {
    const raw = JSON.stringify({
      ParsedResults: [{ ParsedText: "crocs.in\nwww.crocs.in/\nUp To 50% Off", FileParseExitCode: 1 }],
      OCRExitCode: 1,
      IsErroredOnProcessing: false,
    });
    const p = parseOcrSpaceResponse(raw);
    assert.equal(p.error, null);
    assert.equal(p.rateLimited, false);
    assert.match(p.text!, /crocs\.in/);
  });

  test("处理失败：IsErroredOnProcessing + ErrorMessage 数组", () => {
    const raw = JSON.stringify({
      OCRExitCode: 4,
      IsErroredOnProcessing: true,
      ErrorMessage: ["Unable to download the file", "timeout"],
    });
    const p = parseOcrSpaceResponse(raw);
    assert.equal(p.text, null);
    assert.match(p.error!, /Unable to download/);
    assert.equal(p.rateLimited, false);
  });

  test("限速：非 JSON 纯文本响应", () => {
    const raw = "You may only perform this action upto maximum 500 number of times within 86400 seconds";
    const p = parseOcrSpaceResponse(raw);
    assert.equal(p.text, null);
    assert.equal(p.rateLimited, true);
  });

  test("非限速的非 JSON 响应：报错但不标限速", () => {
    const p = parseOcrSpaceResponse("<html>502 Bad Gateway</html>");
    assert.equal(p.text, null);
    assert.equal(p.rateLimited, false);
    assert.ok(p.error);
  });

  test("OCRExitCode 非 1 视为失败", () => {
    const raw = JSON.stringify({ ParsedResults: [], OCRExitCode: 3, IsErroredOnProcessing: false });
    const p = parseOcrSpaceResponse(raw);
    assert.equal(p.text, null);
    assert.match(p.error!, /OCRExitCode=3/);
  });
});
