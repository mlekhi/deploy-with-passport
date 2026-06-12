#!/usr/bin/env -S npx tsx
import {
  type Config,
  type DeployResult,
  createConnector,
  createDeployment,
  loadConfig,
  loadEnvLocal,
  readSiteFiles,
  requireDeploymentProjectId,
  updateProjectPassport,
  waitForProductionUrl,
} from "./helpers.ts";

async function main() {
  await loadEnvLocal();

  const config = loadConfig();
  const deployment = await deploy({ config });
  const connector = await createConnector({ config, projectId: deployment.projectId });
  const project = await updateProjectPassport({
    config,
    projectId: deployment.projectId,
    connectorId: connector.id,
  });

  console.log(JSON.stringify({ deployment, connector, project }, null, 2));
}

async function deploy({ config }: { config: Config }): Promise<DeployResult> {
  const files = await readSiteFiles();
  const deployment = await createDeployment({ config, files });

  const projectId = requireDeploymentProjectId(deployment);
  const productionUrl = await waitForProductionUrl({ config, deploymentId: deployment.id });

  return {
    id: deployment.id,
    projectId,
    productionUrl,
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
