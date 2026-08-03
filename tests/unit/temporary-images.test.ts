import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  containsTemporaryClipboardImage,
  TEMPORARY_IMAGE_ERROR,
} from "../../packages/pi-tai/src/core/subagents/temporary-images.ts";

const image = "pi-clipboard-123e4567-e89b-42d3-a456-426614174000.png";

describe("temporary clipboard image detection", () => {
  it("recognizes normalized macOS, /tmp, and alternate tmp roots", () => {
    assert.equal(containsTemporaryClipboardImage([`/var/folders/ab/cd/T/${image}`]), true);
    assert.equal(containsTemporaryClipboardImage([`/private/var/folders/ab/cd/T/${image}`]), true);
    assert.equal(containsTemporaryClipboardImage([`see /tmp/a/../${image}`]), true);
    assert.equal(
      containsTemporaryClipboardImage([`/opt/custom-tmp/session/${image}`], ["/opt/custom-tmp"]),
      true,
    );
  });

  it("allows stable project paths and ordinary prose with similar basenames", () => {
    assert.equal(containsTemporaryClipboardImage([`/work/project/assets/${image}`]), false);
    assert.equal(
      containsTemporaryClipboardImage([`/tmp/project/assets/${image}`], ["/tmp"], ["/tmp/project"]),
      false,
    );
    assert.equal(containsTemporaryClipboardImage([image]), false);
    assert.equal(
      containsTemporaryClipboardImage([`Discuss pi-clipboard-not-a-uuid.png in prose`]),
      false,
    );
    assert.equal(containsTemporaryClipboardImage([`/tmp/${image}.txt`]), false);
    assert.equal(containsTemporaryClipboardImage([`/tmp/pi-clipboard-123.png`]), false);
  });

  it("uses lexical containment without following or authorizing paths", () => {
    assert.equal(containsTemporaryClipboardImage([`/tmp/link/project/${image}`]), true);
    assert.equal(containsTemporaryClipboardImage([`/work/link-to-tmp/${image}`]), false);
    assert.equal(containsTemporaryClipboardImage([`/tmp/../work/${image}`]), false);
  });

  it("keeps the rejection bounded, actionable, and path-private", () => {
    assert.ok(Buffer.byteLength(TEMPORARY_IMAGE_ERROR) < 256);
    assert.match(TEMPORARY_IMAGE_ERROR, /Describe the image in text/);
    assert.match(TEMPORARY_IMAGE_ERROR, /stable user-authorized project path/);
    assert.doesNotMatch(TEMPORARY_IMAGE_ERROR, /\/tmp|\/var\/folders|pi-clipboard/);
  });
});
