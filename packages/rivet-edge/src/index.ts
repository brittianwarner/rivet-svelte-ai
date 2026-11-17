/**
 * The /rivet edge. Browsers reach actors through it on the site's own origin;
 * engine administration is denied and the admin token never leaves the server.
 * The forwarder carries /api and /rivet from the web service to the api.
 */
export {
  classifyProxyPath,
  createRivetGatewayProxy,
  deriveTrustedClientIp,
  type RivetGatewayProxy,
  type RivetGatewayProxyOptions,
  type WsConnData,
} from "./gateway.ts";
export {
  createEngineTokenMinter,
  ENGINE_GATEWAY_GRANTS,
  ENGINE_TOKEN_TTL_SECONDS,
  type EngineCredentialProvider,
  type EngineTokenMinterOptions,
} from "./engine-token.ts";
export {
  createForwarder,
  createUpstreamPool,
  type Forwarder,
  type ForwarderOptions,
  type UpstreamPool,
} from "./forwarder.ts";
export {
  createSocketRelay,
  type SocketRelay,
  type SocketRelayOptions,
} from "./relay.ts";
