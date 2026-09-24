import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deploy as defaultDeploy } from "previewship";
import type { DeployOptions, DeployResult } from "previewship";
import * as store from "./store.ts";

export type PreviewShipDeploy = (options?: DeployOptions) => Promise<DeployResult>;

export interface PublishArtifactOptions {
  projectName?: string;
}

export interface PreviewShipPublication extends store.PreviewShipPublicationInput {
  ok: true;
}

export class PreviewShipPublishError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 502) {
    super(message);
    this.name = "PreviewShipPublishError";
    this.code = code;
    this.status = status;
  }
}

export interface PreviewShipPublishDependencies {
  deploy?: PreviewShipDeploy;
}

function publishFilename(artifact: store.ArtifactRow): string {
  const candidate = path.basename(artifact.filename || artifact.source_path || "");
  if (artifact.kind === "html" && /\.html?$/i.test(candidate)) return candidate;
  if (artifact.kind === "markdown" && /\.(md|markdown)$/i.test(candidate)) return candidate;
  return `artifact-${artifact.id}.${artifact.kind === "html" ? "html" : "md"}`;
}

function defaultProjectName(artifact: store.ArtifactRow): string {
  const suffix = `-${artifact.id}`;
  const prefix = `${artifact.project}-${artifact.title}`.trim() || "pi-artifact";
  return `${prefix.slice(0, 180 - suffix.length)}${suffix}`;
}

function resolveProjectName(artifact: store.ArtifactRow, requested?: string): string {
  if (requested !== undefined && !requested.trim()) {
    throw new PreviewShipPublishError("INVALID_PROJECT_NAME", "PreviewShip project name cannot be empty.", 400);
  }
  const name = requested?.trim() || artifact.previewship_project_name || defaultProjectName(artifact);
  if (name.length > 180) {
    throw new PreviewShipPublishError("INVALID_PROJECT_NAME", "PreviewShip project name must be 180 characters or fewer.", 400);
  }
  return name;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "PREVIEWSHIP_ERROR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validatedVisibility(value: unknown): store.PreviewShipVisibility | null {
  if (value === undefined || value === null) return null;
  if (value === "PUBLIC" || value === "PASSWORD" || value === "PRIVATE") return value;
  throw new PreviewShipPublishError("INVALID_RESPONSE", "PreviewShip returned an invalid project visibility.");
}

function validatedPreviewUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PreviewShipPublishError("INVALID_RESPONSE", "PreviewShip returned an incomplete deployment response.");
  }
  const previewUrl = value.trim();
  try {
    if (new URL(previewUrl).protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    throw new PreviewShipPublishError("INVALID_RESPONSE", "PreviewShip returned an invalid preview URL.");
  }
  return previewUrl;
}

export async function publishArtifactToPreviewShip(
  artifactId: string,
  options: PublishArtifactOptions = {},
  dependencies: PreviewShipPublishDependencies = {},
): Promise<PreviewShipPublication> {
  const artifact = store.getArtifact(artifactId);
  if (!artifact) throw new PreviewShipPublishError("ARTIFACT_NOT_FOUND", `Artifact not found: ${artifactId}`, 404);
  if (artifact.kind !== "html" && artifact.kind !== "markdown") {
    throw new PreviewShipPublishError(
      "UNSUPPORTED_ARTIFACT",
      `PreviewShip supports registered HTML and Markdown artifacts; ${artifact.title} is ${artifact.kind}.`,
      400,
    );
  }

  const resolved = store.resolveContentFile(artifactId, null, false);
  if (!resolved) {
    throw new PreviewShipPublishError("ARTIFACT_CONTENT_MISSING", `No stored snapshot is available for ${artifactId}.`, 409);
  }

  const projectName = resolveProjectName(artifact, options.projectName);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-previewship-"));
  const tempFile = path.join(tempDir, publishFilename(artifact));

  try {
    fs.copyFileSync(resolved.file, tempFile);
    let result: DeployResult;
    try {
      result = await (dependencies.deploy || defaultDeploy)({
        path: tempFile,
        projectName,
        source: "CLI",
      });
    } catch (error) {
      throw new PreviewShipPublishError(errorCode(error), errorMessage(error));
    }

    if (!result.success) {
      throw new PreviewShipPublishError(
        result.error?.code || "DEPLOYMENT_FAILED",
        result.error?.message || "PreviewShip deployment failed.",
      );
    }
    const deploymentId = result.deploymentId;
    if (typeof deploymentId !== "number" || !Number.isSafeInteger(deploymentId) || deploymentId <= 0) {
      throw new PreviewShipPublishError("INVALID_RESPONSE", "PreviewShip returned an incomplete deployment response.");
    }
    const previewUrl = validatedPreviewUrl(result.previewUrl);

    const publishedAt = Date.now();
    const visibility = validatedVisibility(result.visibility);
    const publication: PreviewShipPublication = {
      ok: true,
      artifactId,
      artifactVersion: resolved.version.id,
      projectName,
      deploymentId,
      previewUrl,
      visibility,
      publishedAt,
    };
    const recorded = store.recordPreviewShipPublication(publication);
    if (!recorded) {
      throw new PreviewShipPublishError("ARTIFACT_NOT_FOUND", `Artifact disappeared before publication metadata was recorded: ${artifactId}`, 409);
    }
    return publication;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
