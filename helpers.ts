import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export type Json = Record<string, unknown>;
export type DeploymentTarget = "production" | "preview";
export type PassportDeploymentType = "all" | "preview" | "production";

export type Config = {
  accessToken: string;
  projectName: string;
  projectIdOrName?: string;
  teamId?: string;
  slug?: string;
  deploymentTarget: DeploymentTarget;
  passportDeploymentType: PassportDeploymentType;
  connector: Json;
};

export type DeploymentFile = {
  file: string;
  data: string;
  encoding: "base64";
};

export type VercelDeployment = {
  id: string;
  url: string;
  projectId?: string;
  alias?: string[];
  aliasAssigned?: boolean;
  readyState?: string;
  status?: string;
};

export type DeployResult = {
  id: string;
  projectId: string;
  productionUrl: string;
};

export type ConnectorResult = {
  id: string;
};

export type ProjectResult = {
  id: string;
  name: string;
};

const API = "https://api.vercel.com";
const SITE_DIR = join(process.cwd(), "site");

export async function loadEnvLocal() {
  let contents: string;
  try {
    contents = await readFile(join(process.cwd(), ".env.local"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equals = line.indexOf("=");
    if (equals === -1) continue;

    const key = line.slice(0, equals).trim();
    const value = unquote(line.slice(equals + 1).trim());
    process.env[key] ??= value;
  }
}

export function loadConfig(): Config {
  return {
    accessToken: requiredEnv("VERCEL_ACCESS_TOKEN"),
    projectName: requiredEnv("VERCEL_PROJECT_NAME"),
    projectIdOrName: env("VERCEL_PROJECT_ID_OR_NAME"),
    teamId: env("VERCEL_TEAM_ID"),
    slug: env("VERCEL_TEAM_SLUG"),
    deploymentTarget: (env("VERCEL_DEPLOYMENT_TARGET") ?? "production") as DeploymentTarget,
    passportDeploymentType: (env("PASSPORT_DEPLOYMENT_TYPE") ?? "all") as PassportDeploymentType,
    connector: buildConnectorConfig(),
  };
}

export async function readSiteFiles(): Promise<DeploymentFile[]> {
  await stat(SITE_DIR);

  const files = await listFiles(SITE_DIR);
  if (files.length === 0) throw new Error(`No files found in ${SITE_DIR}`);

  return files;
}

export async function createDeployment({
  config,
  files,
}: {
  config: Config;
  files: DeploymentFile[];
}): Promise<VercelDeployment> {
  return vercel<VercelDeployment>(
    apiPath("/v13/deployments", config),
    {
      method: "POST",
      body: JSON.stringify({
        name: config.projectName,
        project: config.projectName,
        files,
        target: config.deploymentTarget,
        projectSettings: {
          framework: null,
          buildCommand: null,
          outputDirectory: ".",
        },
      }),
    },
    config.accessToken,
  );
}

export async function createConnector({
  config,
  projectId,
}: {
  config: Config;
  projectId: string;
}): Promise<ConnectorResult> {
  return vercel<ConnectorResult>(
    apiPath("/v1/connect/connectors", config),
    {
      method: "POST",
      body: JSON.stringify({
        ...config.connector,
        projectId,
      }),
    },
    config.accessToken,
  );
}

export async function updateProjectPassport({
  config,
  projectId,
  connectorId,
}: {
  config: Config;
  projectId: string;
  connectorId: string;
}): Promise<ProjectResult> {
  const idOrName = config.projectIdOrName || projectId;

  return vercel<ProjectResult>(
    apiPath(`/v9/projects/${encodeURIComponent(idOrName)}`, config),
    {
      method: "PATCH",
      body: JSON.stringify({
        passport: {
          connectorId,
          deploymentType: config.passportDeploymentType,
        },
      }),
    },
    config.accessToken,
  );
}

export async function waitForProductionUrl({
  config,
  deploymentId,
}: {
  config: Config;
  deploymentId: string;
}): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const deployment = await getDeployment({ config, deploymentId });
    const productionAlias = deployment.alias?.find((alias) => alias !== deployment.url);

    if (deployment.aliasAssigned && productionAlias) return asHttpsUrl(productionAlias);

    const state = deployment.readyState ?? deployment.status;
    if (state === "ERROR" || state === "CANCELED") {
      throw new Error(`Deployment ${deploymentId} finished with state ${state}; no production URL was assigned.`);
    }

    await sleep(2000);
  }

  throw new Error(
    `Timed out waiting for production alias for deployment ${deploymentId}. Refusing to return preview URL. Check the deployment in Vercel dashboard.`,
  );
}

export function requireDeploymentProjectId(deployment: VercelDeployment): string {
  if (!deployment.projectId) {
    throw new Error(
      "Deployment response did not include projectId; cannot link connector. Try using a project name that creates/targets a Vercel project.",
    );
  }
  return deployment.projectId;
}

async function getDeployment({
  config,
  deploymentId,
}: {
  config: Config;
  deploymentId: string;
}): Promise<VercelDeployment> {
  return vercel<VercelDeployment>(
    apiPath(`/v13/deployments/${encodeURIComponent(deploymentId)}`, config),
    { method: "GET" },
    config.accessToken,
  );
}

async function listFiles(dir: string): Promise<DeploymentFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) return listFiles(absolute);
      if (!entry.isFile()) return [];

      return [
        {
          file: relative(SITE_DIR, absolute).split(sep).join("/"),
          data: await readFile(absolute, "base64"),
          encoding: "base64" as const,
        },
      ];
    }),
  );

  return files.flat();
}

function buildConnectorConfig(): Json {
  const connector = jsonEnv("CONNECTOR_JSON") ?? {
    type: requiredEnv("CONNECTOR_TYPE"),
    service: requiredEnv("CONNECTOR_SERVICE"),
    uid: env("CONNECTOR_UID") ?? `passport-${Date.now()}`,
    name: env("CONNECTOR_NAME") ?? "Passport Demo Connector",
    environments: arrayEnv("CONNECTOR_ENVIRONMENTS", ["production", "preview"]),
    triggers: booleanEnv("CONNECTOR_TRIGGERS", true),
    events: arrayEnv("CONNECTOR_EVENTS", []),
    data: jsonEnv("CONNECTOR_DATA") ?? {},
  };

  return withUniqueConnectorIdentity(connector);
}

function withUniqueConnectorIdentity(connector: Json): Json {
  const suffix = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const baseName = typeof connector.name === "string" && connector.name ? connector.name : "Passport Connector";
  const baseUid = typeof connector.uid === "string" && connector.uid ? connector.uid : "passport-connector";

  return {
    ...connector,
    name: `${baseName} ${suffix}`,
    uid: `${baseUid}-${suffix}`,
  };
}

async function vercel<T>(path: string, init: RequestInit, token: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(
      `Vercel API ${init.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(body, null, 2)}`,
    );
  }

  return body as T;
}

function apiPath(path: string, config: Config): string {
  return `${path}${query({ teamId: config.teamId, slug: config.slug })}`;
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

function requiredEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function jsonEnv(name: string): Json | undefined {
  const value = env(name);
  if (!value) return undefined;

  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }

  return parsed as Json;
}

function arrayEnv(name: string, fallback: unknown[]): unknown[] {
  const value = env(name);
  if (!value) return fallback;

  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error(`${name} must be a JSON array`);

  return parsed;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (!value) return fallback;
  return value === "true";
}

function unquote(value: string): string {
  const quote = value[0];
  return (quote === '"' || quote === "'") && value.at(-1) === quote ? value.slice(1, -1) : value;
}

function asHttpsUrl(hostOrUrl: string): string {
  return hostOrUrl.startsWith("http://") || hostOrUrl.startsWith("https://") ? hostOrUrl : `https://${hostOrUrl}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
