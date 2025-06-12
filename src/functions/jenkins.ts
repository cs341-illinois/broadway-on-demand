import { FastifyBaseLogger } from "fastify";

type JenkinsNode = {
  displayName: string;
  _links: {
    self: {
      href: string;
    };
  };
};

export async function getGradingRunLog({
  jenkinsToken,
  buildUrl,
  jenkinsPipelineName,
  netId,
  jenkinsUrl,
  logger,
}: {
  jenkinsToken: string;
  buildUrl: string;
  jenkinsPipelineName: string;
  netId: string;
  jenkinsUrl: string;
  logger: FastifyBaseLogger;
}): Promise<string | undefined> {
  const splitted = buildUrl.split("/").filter((part) => part !== "");
  if (splitted.length === 0) {
    throw new Error(
      `Invalid buildUrl: could not extract buildId from ${buildUrl}`,
    );
  }
  const buildId = splitted[splitted.length - 1];
  const nodesListUrl = `${jenkinsUrl}/blue/rest/organizations/jenkins/pipelines/${jenkinsPipelineName}/runs/${buildId}/nodes/`;
  const requestHeaders = {
    Authorization: `Basic ${jenkinsToken}`,
  };
  if (netId === "_ALL_") {
    const allResponse = await fetch(`${buildUrl}/consoleText`, {
      headers: requestHeaders,
    });
    return await allResponse.text();
  }
  const nodesResponse = await fetch(nodesListUrl, { headers: requestHeaders });
  if (!nodesResponse.ok) {
    throw new Error(
      `Failed to fetch nodes list: ${nodesResponse.status} ${nodesResponse.statusText} from ${nodesListUrl}`,
    );
  }

  const nodes: JenkinsNode[] = (await nodesResponse.json()) as JenkinsNode[];

  for (const node of nodes) {
    if (node.displayName && node.displayName.startsWith(netId)) {
      if (node._links && node._links.self && node._links.self.href) {
        const logFileUrl = `${jenkinsUrl}${node._links.self.href}log`;
        const logResponse = await fetch(logFileUrl, {
          headers: requestHeaders,
        });
        if (!logResponse.ok) {
          throw new Error(
            `Failed to fetch log: ${logResponse.status} ${logResponse.statusText} from ${logFileUrl}`,
          );
        }
        return await logResponse.text();
      } else {
        logger.warn(
          `Node found for '${netId}' but it's missing '_links.self.href'. Node details: ${JSON.stringify(node)}`,
        );
      }
    }
  }
  logger.error(
    `No node found with displayName starting with '${netId}' for build ID '${buildId}'.`,
  );
  return;
}
