// external-agent-parsing.mjs: neuro-san's ExternalAgentParsing, made to work.
//
import { ExternalAgentParsing } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/utils/external_agent_parsing.js";
import { AgentSessionConstants } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/interfaces/agent_session_constants.js";

// WORKAROUND: ExternalAgentParsing.parse_external_agent throws on every URL or
// path, because the transpiled code calls Python str methods on a JS string:
//   hostinfo = at(parse_result.netloc.rsplit("@", 1), (-1))
//   port = slice(parse_result.netloc.rsplit(":", 1), 1)
// JS strings have no rsplit, and slice(..., 1) returns the tail of the list where
// the Python indexes [1]. is_external_agent and get_safe_agent_name both go
// through it, so they throw too. Fixing those two lines is not enough on its own:
// pythonlib's urlparse, which it calls, does not match Python's either. It reads
// "/agents/booking" as host "agents" with scheme "http", accepts
// "https://host:/a", and rewrites port "0443" as "443".
// PORT BACK: substitute the two rsplit lines and point urlparse at a
// Python-faithful implementation in the transpiling source, then delete
// this module and use the package's ExternalAgentParsing directly.
// Until then parseExternalAgent follows the Python line for line.

// The parts of CPython's urllib.parse.urlsplit that parse_external_agent reads:
// scheme, netloc, path, hostname and port, with .port raising for a bad port.
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

export function parseExternalAgent(agentUrl, serverPort = null) {
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

// WORKAROUND: see parseExternalAgent. Same as ExternalAgentParsing.is_external_agent.
export function isExternalAgent(agentUrl) {
  return parseExternalAgent(agentUrl) != null;
}

// WORKAROUND: see parseExternalAgent. Same as ExternalAgentParsing.get_safe_agent_name.
export function getSafeAgentName(agentUrl) {
  const location = parseExternalAgent(agentUrl);
  if (location == null) {
    return agentUrl;
  }
  return "__" + location.agent_name.replaceAll("/", "__");
}

// The package's own agent loop calls these statics too (BaseToolFactory asks
// is_external_agent for every tool; the session factory calls
// parse_external_agent), so they are replaced on the class, not only wrapped here.
// parse_external_agent takes its server_port either positionally or as the
// transpiler's keyword object ({ server_port }).
ExternalAgentParsing.parse_external_agent = (agentUrl, serverPort = null) =>
  parseExternalAgent(agentUrl, serverPort != null && typeof serverPort === "object" ? serverPort.server_port ?? null : serverPort);
ExternalAgentParsing.is_external_agent = isExternalAgent;
ExternalAgentParsing.get_safe_agent_name = getSafeAgentName;

export { ExternalAgentParsing };
