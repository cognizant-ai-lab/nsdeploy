import "../neuro-san/index.mjs";
import { AgentSessionConstants } from "../neuro-san/interfaces.mjs";
import { ExternalAgentParsing } from "../neuro-san/internals.mjs";
function pythonUrlSplit(url) {
  let rest = url;
  let scheme = "";
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(rest);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    rest = rest.slice(schemeMatch[0].length);
  }
  let netloc = "";
  if (rest.startsWith("//")) {
    const end = rest.slice(2).search(/[/?#]/);
    netloc = end === -1 ? rest.slice(2) : rest.slice(2, end + 2);
    rest = end === -1 ? "" : rest.slice(end + 2);
    if (netloc.includes("[") !== netloc.includes("]")) {
      throw new Error("Invalid IPv6 URL");
    }
  }
  const pathEnd = rest.search(/[?#]/);
  const path = pathEnd === -1 ? rest : rest.slice(0, pathEnd);
  const hostinfo = netloc.slice(netloc.lastIndexOf("@") + 1);
  let hostname = hostinfo;
  let portText = null;
  const bracketEnd = hostinfo.indexOf("]");
  if (hostinfo.startsWith("[") && bracketEnd !== -1) {
    hostname = hostinfo.slice(1, bracketEnd);
    const after = hostinfo.slice(bracketEnd + 1);
    if (after.startsWith(":")) portText = after.slice(1);
  } else if (hostinfo.includes(":")) {
    hostname = hostinfo.slice(0, hostinfo.indexOf(":"));
    portText = hostinfo.slice(hostinfo.indexOf(":") + 1);
  }
  hostname = hostname ? hostname.toLowerCase() : null;
  let port = null;
  if (portText) {
    if (!/^[0-9]+$/.test(portText) || Number(portText) > 65535) {
      throw new Error(`Port could not be cast to integer value as '${portText}'`);
    }
    port = Number(portText);
  }
  return { scheme, netloc, path, hostname, port };
}
function parseExternalAgent(agentUrl, serverPort = null) {
  if (agentUrl == null || typeof agentUrl !== "string" || agentUrl.length === 0) {
    return null;
  }
  let parseResult = null;
  let portNumber = null;
  try {
    parseResult = pythonUrlSplit(agentUrl);
    portNumber = parseResult.port;
  } catch {
    return null;
  }
  if (parseResult.path == null || parseResult.path.length <= 1) {
    return null;
  }
  const netloc = parseResult.netloc || "";
  const hostinfo = netloc.slice(netloc.lastIndexOf("@") + 1);
  const malformedAuthority = Boolean(netloc) && (!parseResult.hostname || hostinfo.endsWith(":"));
  if (!parseResult.path.startsWith("/") || malformedAuthority) {
    return null;
  }
  const scheme = parseResult.scheme || "";
  let host = null;
  let port = null;
  if (parseResult.hostname) {
    host = parseResult.hostname;
    if (host.includes(":")) {
      host = `[${host}]`;
    }
    if (portNumber != null) {
      port = netloc.slice(netloc.lastIndexOf(":") + 1);
    }
  }
  if (host == null || host.length === 0) {
    host = "localhost";
  }
  if (host === "localhost" && port == null) {
    port = serverPort;
  }
  if (port == null && scheme === "https") {
    port = String(AgentSessionConstants.DEFAULT_HTTPS_PORT);
  }
  let agentName = parseResult.path;
  while (agentName.startsWith("/")) {
    agentName = agentName.slice(1);
  }
  return { host, port, agent_name: agentName, scheme };
}
function isExternalAgent(agentUrl) {
  return parseExternalAgent(agentUrl) != null;
}
function getSafeAgentName(agentUrl) {
  const location = parseExternalAgent(agentUrl);
  if (location == null) {
    return agentUrl;
  }
  return "__" + location.agent_name.replaceAll("/", "__");
}
ExternalAgentParsing.parse_external_agent = (agentUrl, serverPort = null) => parseExternalAgent(agentUrl, serverPort != null && typeof serverPort === "object" ? serverPort.server_port ?? null : serverPort);
ExternalAgentParsing.is_external_agent = isExternalAgent;
ExternalAgentParsing.get_safe_agent_name = getSafeAgentName;
export {
  getSafeAgentName,
  isExternalAgent,
  parseExternalAgent
};
