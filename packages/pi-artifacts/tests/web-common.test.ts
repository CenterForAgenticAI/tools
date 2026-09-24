import test from "node:test";
import assert from "node:assert/strict";

type ArtifactPathMetadata = { source_path?: string | null; project_path?: string | null; filename?: string | null };
const commonModuleUrl = new URL("../web/common.js", import.meta.url).href;
const { artifactDisplayPath, shouldPreviewText, TEXT_PREVIEW_THRESHOLD } = await import(commonModuleUrl) as {
  artifactDisplayPath: (artifact?: ArtifactPathMetadata) => string;
  shouldPreviewText: (contentLength: unknown, rangeSupported: unknown) => boolean;
  TEXT_PREVIEW_THRESHOLD: number;
};

test("shouldPreviewText is true only when range support is known and the file exceeds 1 MiB", () => {
  assert.equal(shouldPreviewText(TEXT_PREVIEW_THRESHOLD + 1, true), true);
  assert.equal(shouldPreviewText(TEXT_PREVIEW_THRESHOLD, true), false);
  assert.equal(shouldPreviewText(TEXT_PREVIEW_THRESHOLD + 1, false), false);
  assert.equal(shouldPreviewText(null, true), false);
  assert.equal(shouldPreviewText(undefined, true), false);
  assert.equal(shouldPreviewText("2097152", true), false);
});

test("artifactDisplayPath prefers the exact source file path", () => {
  assert.equal(artifactDisplayPath({
    project_path: "/work/project",
    filename: "report.md",
    source_path: "/work/project/docs/report.md",
  }), "/work/project/docs/report.md");
});

test("artifactDisplayPath includes the filename when only project metadata is available", () => {
  assert.equal(artifactDisplayPath({
    project_path: "/work/project/",
    filename: "report.md",
    source_path: null,
  }), "/work/project/report.md");
});

test("artifactDisplayPath handles partial and Windows-style metadata", () => {
  assert.equal(artifactDisplayPath({ project_path: "C:\\work\\project", filename: "report.md" }), "C:\\work\\project\\report.md");
  assert.equal(artifactDisplayPath({ project_path: "/work/project", filename: null }), "/work/project");
  assert.equal(artifactDisplayPath({ project_path: null, filename: "report.md" }), "report.md");
  assert.equal(artifactDisplayPath({}), "");
});
