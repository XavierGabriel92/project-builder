/**
 * Unit tests for frontmatter parser
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { parseFrontmatter, parseArrayValue, parseRecordValue } from "../../src/shared/frontmatter.ts";

describe("parseFrontmatter", () => {
  it("parses simple key-value frontmatter", () => {
    const content = [
      "---",
      "id: test-agent",
      "version: 1",
      "tools: ['read', 'write']",
      "---",
      "This is the body.",
    ].join("\n");

    const { frontmatter, body } = parseFrontmatter(content);

    assert.deepEqual(frontmatter, {
      id: "test-agent",
      version: "1",
      tools: "['read', 'write']",
    });
    assert.equal(body, "This is the body.");
  });

  it("parses quoted values", () => {
    const content = [
      "---",
      'id: "test-agent"',
      "version: 1",
      "---",
      "Body",
    ].join("\n");

    const { frontmatter } = parseFrontmatter(content);
    assert.equal(frontmatter["id"], "test-agent");
  });

  it("parses single-quoted values", () => {
    const content = [
      "---",
      "id: 'my-agent'",
      "---",
      "Body",
    ].join("\n");

    const { frontmatter } = parseFrontmatter(content);
    assert.equal(frontmatter["id"], "my-agent");
  });

  it("returns empty frontmatter when no --- delimiter", () => {
    const content = "Just a body, no frontmatter.";

    const { frontmatter, body } = parseFrontmatter(content);

    assert.deepEqual(frontmatter, {});
    assert.equal(body, "Just a body, no frontmatter.");
  });

  it("returns empty frontmatter when no closing ---", () => {
    const content = [
      "---",
      "id: test",
      "version: 1",
      "Body without closing.",
    ].join("\n");

    const { frontmatter, body } = parseFrontmatter(content);

    assert.deepEqual(frontmatter, {});
    assert.equal(body, content);
  });

  it("handles empty lines in frontmatter", () => {
    const content = [
      "---",
      "id: test",
      "",
      "version: 1",
      "---",
      "Body",
    ].join("\n");

    const { frontmatter } = parseFrontmatter(content);
    assert.equal(frontmatter["id"], "test");
    assert.equal(frontmatter["version"], "1");
  });

  it("handles Windows line endings", () => {
    const content = "---\r\nid: test\r\n---\r\nBody";

    const { frontmatter, body } = parseFrontmatter(content);
    assert.equal(frontmatter["id"], "test");
    assert.equal(body, "Body");
  });

  it("trims body whitespace after frontmatter", () => {
    const content = [
      "---",
      "id: test",
      "---",
      "",
      "  Body  ",
      "",
    ].join("\n");

    const { body } = parseFrontmatter(content);
    assert.equal(body, "Body");
  });

  it("parses JSON values as raw strings", () => {
    const content = [
      "---",
      'tools: ["read", "write"]',
      'approval: {"header": "Review"}',
      "---",
      "Body",
    ].join("\n");

    const { frontmatter } = parseFrontmatter(content);
    assert.equal(frontmatter["tools"], '["read", "write"]');
    assert.equal(frontmatter["approval"], '{"header": "Review"}');
  });
});

describe("parseArrayValue", () => {
  it("parses a JSON array string", () => {
    const result = parseArrayValue('["read", "write", "bash"]', "tools");
    assert.deepEqual(result, ["read", "write", "bash"]);
  });

  it("returns empty array for undefined", () => {
    const result = parseArrayValue(undefined, "tools");
    assert.deepEqual(result, []);
  });

  it("returns empty array for empty string", () => {
    const result = parseArrayValue("", "tools");
    assert.deepEqual(result, []);
  });

  it("throws for invalid JSON", () => {
    assert.throws(
      () => parseArrayValue("not json", "tools"),
      /"tools" is not valid JSON/
    );
  });

  it("throws for non-array JSON", () => {
    assert.throws(
      () => parseArrayValue('{"key": "value"}', "tools"),
      /"tools" must be a JSON array/
    );
  });
});

describe("parseRecordValue", () => {
  it("parses a JSON object string", () => {
    const result = parseRecordValue('{"worker": "subagents/worker.md"}', "subagents");
    assert.deepEqual(result, { worker: "subagents/worker.md" });
  });

  it("returns empty object for undefined", () => {
    const result = parseRecordValue(undefined, "subagents");
    assert.deepEqual(result, {});
  });

  it("throws for invalid JSON", () => {
    assert.throws(
      () => parseRecordValue("bad", "subagents"),
      /"subagents" is not valid JSON/
    );
  });

  it("throws for non-object JSON (array)", () => {
    assert.throws(
      () => parseRecordValue('["a", "b"]', "subagents"),
      /"subagents" must be a JSON object/
    );
  });
});
