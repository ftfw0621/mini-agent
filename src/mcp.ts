import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"; // stdio servers are subprocesses
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"; // the OAuth callback listener
import crypto from "node:crypto"; // PKCE + state nonces
import os from "node:os"; // home directory for token persistence
import path from "node:path"; // path joining
import fs from "node:fs"; // token file persistence
import chalk from "chalk"; // status lines
import { CONFIG, GLOBAL_SETTINGS_PATH, PROJECT_SETTINGS_PATH, readMcpServers, type McpServerDef } from "./config.js"; // configured servers + hot reload
import { registerExternalTool, unregisterExternalTool, type Tool } from "./tools.js"; // expose discovered tools
import { emit } from "./telemetry.js"; // observability

// MCP (Model Context Protocol) lets the agent borrow tools from external
// servers — a filesystem server, a GitHub server, a database server, anything.
// The wire protocol is JSON-RPC 2.0. We do the initialize handshake, ask for the
// server's tools, and register each one so it flows through the SAME dispatch and
// the SAME permission gate as a built-in. There is one execution path, period.
//
// Since Day 24 there are TWO ways to reach a server: spawn it and talk over
// stdio (local), or POST to a URL (remote, "Streamable HTTP"). The protocol is
// identical; only the pipe differs. That difference lives behind a Transport
// interface, so McpClient — handshake, ids, tool flattening — never has to care.
//
// Discovered tools are named mcp__<server>__<tool> so they never collide with
// built-ins and the user can see (and gate) exactly where each came from.
//
// Since this file also drives the /mcp command, it keeps a REGISTRY of every
// configured server and its live connection state (connected / failed /
// needs-auth / disabled) so the UI can list them and reconnect/authenticate one
// at a time — the way Claude Code's /mcp does.
//
// Remote servers (Linear, Slack, GitHub…) are OAuth-protected. The flow is the
// MCP authorization spec end to end: the 401 challenge points at the resource
// metadata (RFC 9728), which names the authorization server (RFC 8414); we
// register a client dynamically (RFC 7591) unless the config carries a
// pre-registered one; then authorization-code + PKCE with a loopback redirect,
// the `resource` indicator (RFC 8707) on every token request, and refresh
// tokens so a session survives token expiry without another browser round.

const INIT_TIMEOUT_MS = 15_000; // a server that doesn't initialize in 15s is skipped
const CALL_TIMEOUT_MS = 60_000; // a single tool call may take this long
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000; // how long the local callback waits for the browser
const PROTOCOL_VERSION = "2024-11-05"; // the MCP revision we speak in the handshake
const CLIENT_INFO = { name: "mini-agent", version: "0" }; // who we say we are in the handshake

interface JsonRpcResponse {
  id: number; // matches the request
  result?: { tools?: McpToolSpec[]; content?: McpContent[]; isError?: boolean }; // success payload
  error?: { message: string }; // failure
}
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: object;
}
interface McpToolSpec {
  name: string; // the server's tool name
  description?: string; // its manual
  inputSchema?: { type: string; properties?: Record<string, unknown>; required?: string[] }; // its parameters
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }; // the server's own effect claims (MCP tool annotations)
}
interface McpContent {
  type: string; // "text" | "image" | ...
  text?: string; // present for text content
}

// What a 401's WWW-Authenticate challenge tells us (RFC 9728 / RFC 6750): where
// the protected-resource metadata lives, and optionally which scopes to ask for.
export interface AuthChallenge {
  resourceMetadataUrl?: string; // Bearer resource_metadata="https://…/.well-known/oauth-protected-resource…"
  scope?: string; // Bearer scope="read write" — a hint some servers send
}

// Thrown when an HTTP MCP server answers 401 — the caller marks the server as
// "needs auth" instead of "failed". The challenge header is parsed and kept:
// it is the AUTHORITATIVE pointer to the OAuth metadata. Guessing well-known
// paths is what breaks on servers like Slack, whose metadata sits at the origin
// root rather than under the /mcp path.
export class NeedsAuthError extends Error implements AuthChallenge {
  resourceMetadataUrl?: string;
  scope?: string;
  constructor(message: string, wwwAuthenticate?: string | null) {
    super(message);
    this.name = "NeedsAuthError";
    // The challenge is `Bearer key="value", key="value"…` — pull out the pairs we use.
    for (const m of (wwwAuthenticate ?? "").matchAll(/(\w+)="([^"]*)"/g)) {
      if (m[1] === "resource_metadata") this.resourceMetadataUrl = m[2];
      if (m[1] === "scope") this.scope = m[2];
    }
  }
}

// The wire under JSON-RPC. A request expects a matching response; a notification
// is fire-and-forget (the handshake's "initialized" needs one). close() releases
// whatever the transport holds (a subprocess, a session).
interface Transport {
  request(payload: JsonRpcRequest, timeoutMs: number): Promise<JsonRpcResponse>;
  notify(method: string, params: object): void;
  close(): void;
  setToken?(token: string): void; // http only: swap the bearer token after a refresh, keeping the session
}

// ---- stdio transport: one JSON object per line, to a subprocess --------------
class StdioTransport implements Transport {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, (r: JsonRpcResponse) => void>(); // id → resolver (responses arrive async on one stream)
  private buffer = ""; // partial stdout, reassembled into whole lines

  constructor(def: McpServerDef) {
    this.child = spawn(def.command as string, def.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"], // we own stdin/stdout; stderr is the server's log
      env: { ...process.env, ...def.env }, // pass through + extras
    });
    // Reassemble newline-delimited JSON from the stdout stream.
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim(); // one complete message
        this.buffer = this.buffer.slice(nl + 1); // keep the remainder
        if (line) this.onMessage(line);
      }
    });
    this.child.stderr.on("data", () => {}); // the server's stderr is its own logging — never our stdout
  }

  private onMessage(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore anything that isn't valid JSON-RPC
    }
    const resolver = this.pending.get(msg.id);
    if (resolver) {
      this.pending.delete(msg.id);
      resolver(msg);
    }
  }

  request(payload: JsonRpcRequest, timeoutMs: number): Promise<JsonRpcResponse> {
    const { id } = payload;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r: JsonRpcResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(r);
      };
      const timer = setTimeout(() => finish({ id, error: { message: `MCP request '${payload.method}' timed out` } }), timeoutMs);
      this.pending.set(id, finish);
      this.child.stdin.write(JSON.stringify(payload) + "\n"); // one line, newline-terminated
    });
  }

  notify(method: string, params: object): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  close(): void {
    this.child.kill(); // best-effort cleanup
  }
}

// Pull JSON-RPC messages out of a Server-Sent-Events body. SSE frames are
// separated by blank lines; the payload lives on one or more `data:` lines.
// Exported because parsing is the fiddly part worth testing on its own.
export function parseSseData(body: string): string[] {
  const out: string[] = [];
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim()) // strip "data:" and surrounding space
      .join("\n");
    if (data) out.push(data);
  }
  return out;
}

// ---- HTTP transport: POST to a URL, read JSON or SSE back --------------------
class HttpTransport implements Transport {
  private url: string;
  private headers: Record<string, string>;
  private sessionId?: string; // assigned by the server on initialize, echoed on every later request

  constructor(def: McpServerDef, token?: string) {
    this.url = def.url as string;
    this.headers = { ...def.headers };
    if (token) this.headers["authorization"] = `Bearer ${token}`; // OAuth access token
  }

  // The response to a POST may come back as a single JSON object OR as an SSE
  // stream carrying it. Either way we want the JSON-RPC message matching our id.
  private async post(body: object, timeoutMs: number, isRequest: boolean): Promise<JsonRpcResponse | null> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream", // we accept either shape
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) {
      throw new NeedsAuthError(`MCP server at ${this.url} requires authentication`, res.headers.get("www-authenticate"));
    }
    const sid = res.headers.get("mcp-session-id"); // initialize hands us a session to keep
    if (sid) this.sessionId = sid;
    if (!isRequest) return null; // a notification expects no body (202 Accepted)

    const raw = await res.text();
    const payloads = res.headers.get("content-type")?.includes("text/event-stream") ? parseSseData(raw) : [raw];
    for (const p of payloads) {
      try {
        const msg = JSON.parse(p) as JsonRpcResponse;
        if (msg && (msg.result !== undefined || msg.error !== undefined)) return msg; // the response we came for
      } catch {
        /* skip non-JSON frames (SSE comments, keep-alives) */
      }
    }
    return null;
  }

  async request(payload: JsonRpcRequest, timeoutMs: number): Promise<JsonRpcResponse> {
    try {
      const msg = await this.post(payload, timeoutMs, true);
      return msg ?? { id: payload.id, error: { message: `MCP request '${payload.method}' returned no response` } };
    } catch (err) {
      if (err instanceof NeedsAuthError) throw err; // propagate so the registry can mark needs-auth
      return { id: payload.id, error: { message: `MCP HTTP request '${payload.method}' failed: ${(err as Error).message}` } };
    }
  }

  notify(method: string, params: object): void {
    // Fire-and-forget; errors on a notification are not worth surfacing.
    void this.post({ jsonrpc: "2.0", method, params }, INIT_TIMEOUT_MS, false).catch(() => {});
  }

  setToken(token: string): void {
    this.headers["authorization"] = `Bearer ${token}`; // a refreshed token; the session id stays valid
  }

  close(): void {
    // Best-effort: tell the server to drop the session. No await, no error care.
    if (this.sessionId) {
      void fetch(this.url, { method: "DELETE", headers: { "mcp-session-id": this.sessionId, ...this.headers } }).catch(() => {});
    }
  }
}

// Choose the pipe from the config: a url means HTTP, otherwise spawn over stdio.
function makeTransport(def: McpServerDef, token?: string): Transport {
  return def.url ? new HttpTransport(def, token) : new StdioTransport(def);
}

// The protocol layer: handshake, request ids, tool flattening. It talks to a
// Transport and is blind to whether that's a subprocess or an HTTP endpoint.
class McpClient {
  private transport: Transport;
  private nextId = 1; // JSON-RPC request id counter

  constructor(def: McpServerDef, token?: string) {
    this.transport = makeTransport(def, token);
  }

  private request(method: string, params: object, timeoutMs: number): Promise<JsonRpcResponse> {
    return this.transport.request({ jsonrpc: "2.0", id: this.nextId++, method, params }, timeoutMs);
  }

  // The MCP startup dance: initialize → initialized → list tools.
  async start(): Promise<McpToolSpec[]> {
    const init = await this.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, INIT_TIMEOUT_MS);
    if (init.error) throw new Error(init.error.message); // server refused to initialize
    this.transport.notify("notifications/initialized", {}); // tell the server we're ready
    const list = await this.request("tools/list", {}, INIT_TIMEOUT_MS); // ask what it offers
    if (list.error) throw new Error(list.error.message);
    return list.result?.tools ?? [];
  }

  // Invoke one tool and flatten its content into plain text for the model.
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.request("tools/call", { name, arguments: args }, CALL_TIMEOUT_MS);
    if (res.error) return `[error] MCP tool failed: ${res.error.message}`; // surface, don't throw
    const text = (res.result?.content ?? []).map((c) => c.text ?? `[${c.type} content]`).join("\n"); // flatten parts
    const body = text || "(no output)";
    return res.result?.isError ? `[error] ${body}` : body; // MCP can flag a logical error in a successful response
  }

  // Swap the bearer token after a refresh (a no-op for stdio).
  setToken(token: string): void {
    this.transport.setToken?.(token);
  }

  kill(): void {
    this.transport.close();
  }
}

// ---- connection-state registry ------------------------------------------------
export type McpServerStatus = "connected" | "failed" | "needs-auth" | "disabled";

export interface McpServerInfo {
  name: string;
  transport: "stdio" | "http";
  status: McpServerStatus;
  tools: number;
  error?: string;
  authenticated: boolean; // has an OAuth token (http servers only)
  url?: string;
}

interface RegistryEntry {
  def: McpServerDef;
  client?: McpClient;
  status: McpServerStatus;
  tools: number;
  error?: string;
  toolNames: string[]; // registered mcp__<server>__<tool> names, for unregistering
  challenge?: AuthChallenge; // the last 401's WWW-Authenticate hints, reused by /mcp auth
}

const registry = new Map<string, RegistryEntry>();

// OAuth tokens persist to the global config dir so a reconnect across sessions
// doesn't force the browser flow again. Plain JSON (self-hosted CLI, not a
// hardened credential store — Claude Code uses the OS keychain); tokens are
// bearer secrets — treat accordingly. Next to the tokens we keep everything a
// refresh needs (token endpoint, client, resource) so it never rediscovers.
// MINI_AGENT_OAUTH_STORE relocates the file (the test suite points it at a
// scratch path so a fake server's tokens never land in the real store).
const OAUTH_STORE_PATH = process.env.MINI_AGENT_OAUTH_STORE || path.join(os.homedir(), ".config", "mini-agent", "mcp-oauth.json");
interface OAuthRecord {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms derived from expires_in; past it we refresh before connecting
  clientId?: string;
  clientSecret?: string;
  tokenEndpoint?: string; // where to refresh
  resource?: string; // RFC 8707 resource indicator, sent on every token request
}
type OAuthStore = Record<string, OAuthRecord>;
// The token endpoint's answer (RFC 6749 §5).
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number; // seconds
  error?: string;
  error_description?: string;
}
const expiryFrom = (t: TokenResponse): number | undefined => (typeof t.expires_in === "number" ? Date.now() + t.expires_in * 1000 : undefined);
function readOAuthStore(): OAuthStore {
  try {
    return JSON.parse(fs.readFileSync(OAUTH_STORE_PATH, "utf8")) as OAuthStore;
  } catch {
    return {};
  }
}
function writeOAuthStore(store: OAuthStore): void {
  fs.mkdirSync(path.dirname(OAUTH_STORE_PATH), { recursive: true });
  fs.writeFileSync(OAUTH_STORE_PATH, JSON.stringify(store, null, 2) + "\n");
}
const oauthStore = readOAuthStore();

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// Try to open a URL in the user's browser. Best-effort: if it fails, the caller
// has already printed the link so the user can click it themselves. Set
// MINI_AGENT_NO_BROWSER=1 to only print it (an SSH session, a test).
function openBrowser(url: string): void {
  if (process.env.MINI_AGENT_NO_BROWSER) return;
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* ignore — the printed URL is the fallback */
  }
}

export interface OAuthDiscovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string; // absent = no dynamic client registration (Slack): the config must carry a client id
  scopes?: string[]; // what to ask for: the 401 hint, else the resource's advertised list, else the auth server's
  resource: string; // the canonical resource identifier (RFC 8707), from the resource metadata
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(INIT_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Ask the server for its 401 challenge without a token — the cheapest way to
// learn where the metadata lives when no 401 was recorded this session (a
// re-authenticate while still connected). Empty when the server doesn't 401.
async function probeChallenge(serverUrl: string): Promise<AuthChallenge> {
  try {
    const res = await fetch(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } }),
      signal: AbortSignal.timeout(INIT_TIMEOUT_MS),
    });
    if (res.status === 401) return new NeedsAuthError("", res.headers.get("www-authenticate"));
  } catch {
    /* unreachable server — discovery falls back to the well-known paths */
  }
  return {};
}

// Discover the OAuth endpoints for an MCP server: protected-resource metadata
// (RFC 9728) → authorization-server metadata (RFC 8414). The 401 challenge says
// exactly where the resource metadata lives; the well-known paths under the
// server's origin are a fallback for servers that don't send one. Exported so
// the discovery step can be exercised on its own. Returns null when the server
// has no OAuth metadata at all.
export async function discoverOAuth(serverUrl: string, challenge: AuthChallenge = {}): Promise<OAuthDiscovery | null> {
  const base = new URL(serverUrl);
  const rsPath = base.pathname === "/" ? "" : base.pathname.replace(/\/$/, "");
  const candidates = [
    challenge.resourceMetadataUrl, // what the server told us — authoritative
    `${base.origin}/.well-known/oauth-protected-resource${rsPath}`, // RFC 9728 path-scoped (Linear)
    `${base.origin}/.well-known/oauth-protected-resource`, // RFC 9728 origin-wide (Slack)
  ].filter((u): u is string => Boolean(u));
  let prm: Record<string, unknown> | null = null;
  for (const url of new Set(candidates)) {
    prm = await fetchJson(url);
    if (prm) break;
  }

  // The resource names its authorization server(s); default to the origin. A
  // server with a path component would need the RFC 8414 path insertion — none
  // of the servers we target has one, so keep it simple.
  const authServers = Array.isArray(prm?.authorization_servers) ? (prm.authorization_servers as string[]) : [];
  const authServer = (authServers[0] ?? base.origin).replace(/\/$/, "");
  // RFC 8414 first, then the OpenID Connect location some servers use instead.
  const metadata = (await fetchJson(`${authServer}/.well-known/oauth-authorization-server`)) ?? (await fetchJson(`${authServer}/.well-known/openid-configuration`));
  if (!metadata) return null;

  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const list = (v: unknown): string[] | undefined => (Array.isArray(v) && v.length ? (v as string[]) : undefined);
  const authorizationEndpoint = str(metadata.authorization_endpoint);
  const tokenEndpoint = str(metadata.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) return null;

  return {
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: str(metadata.registration_endpoint),
    scopes: challenge.scope?.split(/\s+/).filter(Boolean) ?? list(prm?.scopes_supported) ?? list(metadata.scopes_supported),
    resource: str(prm?.resource) ?? serverUrl,
  };
}

// Bind the loopback listener for the authorization-code redirect. The browser
// is sent to http://localhost:<port>/callback (the redirect URI Claude Code
// registers too, so a pre-registered Slack client id works unchanged), and
// "localhost" may resolve to 127.0.0.1 or ::1 depending on browser and OS — so
// listen on both; the IPv6 bind is best-effort. `port` 0 = any free port (the
// DCR case, where we register whatever we got); a fixed port is what a
// pre-registered client demands. The code promise is armed on creation, BEFORE
// the browser opens, so a fast callback can't race us.
async function listenForCallback(port: number, state: string): Promise<{ port: number; close: () => void; code: Promise<string> }> {
  let settle: { resolve: (code: string) => void; reject: (err: Error) => void } | undefined;
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("connection", "close"); // one-shot listener: a kept-alive socket would deliver a LATER flow's callback (same fixed port) to this dead handler
    if (url.pathname !== "/callback" || url.searchParams.get("state") !== state) return void res.writeHead(404).end(); // not ours (favicon, a stale tab…)
    res.setHeader("content-type", "text/html");
    res.end("<h1>Connected</h1><p>You can close this window and return to the terminal.</p>");
    // Settle only once the page has been flushed: settling tears the servers
    // down, and tearing down before the write lands would blank the browser tab.
    res.once("finish", () => {
      const code = url.searchParams.get("code");
      if (code) settle?.resolve(code);
      else settle?.reject(new Error(`OAuth callback did not include a code: ${url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "unknown error"}`));
    });
  };
  const v4: Server = createServer(handler);
  const bound = await new Promise<number>((resolve, reject) => {
    v4.once("error", (err) => reject(new Error(`Could not bind the OAuth callback on port ${port || "(any)"}: ${err.message}`)));
    v4.listen(port, "127.0.0.1", () => {
      const addr = v4.address();
      resolve(addr && typeof addr === "object" ? addr.port : port);
    });
  });
  const v6: Server = createServer(handler);
  await new Promise<void>((resolve) => {
    v6.once("error", () => resolve()); // no IPv6 loopback here — the v4 listener carries it
    v6.listen(bound, "::1", () => resolve());
  });
  const close = () => {
    // Release the port for real: close() alone leaves open sockets alive, and a
    // pre-registered client's next flow needs the SAME port back immediately.
    for (const s of [v4, v6]) {
      s.closeAllConnections();
      s.close();
    }
  };
  const code = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      close();
      reject(new Error("Timed out waiting for OAuth authorization in the browser"));
    }, OAUTH_CALLBACK_TIMEOUT_MS);
    settle = {
      resolve: (c) => (clearTimeout(timer), close(), resolve(c)),
      reject: (e) => (clearTimeout(timer), close(), reject(e)),
    };
  });
  return { port: bound, close, code };
}

// Run the OAuth authorization-code flow for an HTTP server: PKCE always;
// dynamic client registration (RFC 7591) unless the config carries a
// pre-registered client; a loopback redirect; then the code → token exchange
// with the `resource` indicator (RFC 8707). When onUrl is provided, the
// authorization URL is handed back so the UI can print it in case the browser
// doesn't open. Resolves with everything the store needs to reconnect + refresh.
async function runOAuthFlow(def: McpServerDef, challenge: AuthChallenge, onUrl?: (url: string) => void): Promise<OAuthRecord> {
  if (!def.url) throw new Error("OAuth is only available for http MCP servers");
  const discovery = await discoverOAuth(def.url, challenge);
  if (!discovery) throw new Error(`No OAuth metadata found for ${def.url}`);

  const pkce = pkcePair();
  const state = base64url(crypto.randomBytes(16));

  // The redirect URI must match what the client registered: for DCR we register
  // whatever port we were given; a pre-registered client (Slack) fixes the port.
  const listener = await listenForCallback(def.oauth?.callbackPort ?? 0, state);
  listener.code.catch(() => {}); // settled later; never an unhandled rejection if we throw before awaiting it
  const redirectUri = `http://localhost:${listener.port}/callback`;

  let clientId = def.oauth?.clientId ?? ""; // a pre-registered client skips DCR
  let clientSecret = def.oauth?.clientSecret;
  if (!clientId && discovery.registrationEndpoint) {
    // Dynamic client registration — most MCP servers register a public client on the spot.
    const regRes = await fetch(discovery.registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "mini-agent",
      }),
      signal: AbortSignal.timeout(INIT_TIMEOUT_MS),
    }).catch((err: Error) => {
      throw new Error(`OAuth client registration failed for ${def.url}: ${err.message}`);
    });
    if (regRes.ok) {
      const reg = (await regRes.json()) as { client_id?: string; client_secret?: string };
      clientId = reg.client_id ?? "";
      clientSecret = reg.client_secret;
    }
  }
  if (!clientId) {
    listener.close();
    throw new Error(
      discovery.registrationEndpoint
        ? `OAuth client registration failed for ${def.url}`
        : `${def.url} offers no dynamic client registration — set mcpServers.<name>.oauth.clientId (and callbackPort) to a pre-registered client`,
    );
  }

  const authUrl = new URL(discovery.authorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("code_challenge", pkce.challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("resource", discovery.resource); // RFC 8707: bind the token to THIS server
  const scopes = def.oauth?.scopes ?? discovery.scopes; // an explicit config list wins over what the server advertises
  if (scopes?.length) authUrl.searchParams.set("scope", scopes.join(" "));

  onUrl?.(authUrl.href);
  openBrowser(authUrl.href);
  const code = await listener.code; // the listener closes itself once settled

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: pkce.verifier,
    redirect_uri: redirectUri,
    client_id: clientId,
    resource: discovery.resource,
  });
  if (clientSecret) params.set("client_secret", clientSecret);
  const tokenRes = await fetch(discovery.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: params.toString(),
    signal: AbortSignal.timeout(INIT_TIMEOUT_MS),
  });
  if (!tokenRes.ok) {
    throw new Error(`OAuth token exchange failed: HTTP ${tokenRes.status} ${(await tokenRes.text()).slice(0, 200)}`);
  }
  const tokens = (await tokenRes.json()) as TokenResponse;
  if (!tokens.access_token) throw new Error(`OAuth token exchange returned no access_token: ${tokens.error_description ?? tokens.error ?? "unknown error"}`);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: expiryFrom(tokens),
    clientId,
    clientSecret,
    tokenEndpoint: discovery.tokenEndpoint,
    resource: discovery.resource,
  };
}

function entryFor(name: string): RegistryEntry {
  let entry = registry.get(name);
  if (!entry) {
    const def = CONFIG.mcpServers[name];
    if (!def) throw new Error(`No MCP server named "${name}"`);
    entry = { def, status: "failed", tools: 0, toolNames: [] };
    registry.set(name, entry);
  }
  return entry;
}

function registerTools(name: string, specs: McpToolSpec[], client: McpClient): number {
  for (const spec of specs) {
    const toolName = `mcp__${name}__${spec.name}`; // namespaced, collision-proof
    const tool: Tool = {
      annotations: spec.annotations,
      definition: {
        type: "function",
        function: {
          name: toolName,
          description: `[MCP:${name}] ${spec.description ?? spec.name}`, // mark the origin in the manual
          parameters: spec.inputSchema ?? { type: "object", properties: {} }, // pass the server's schema straight through
        },
      },
      // dispatch routes here; the permission gate ran first. A 401 mid-session
      // (the access token expired or was revoked) gets ONE silent refresh and a
      // retry; if that fails the server is flagged needs-auth and the model gets
      // a readable error pointing at /mcp auth — a tool result never throws.
      run: async (args) => {
        try {
          return await client.callTool(spec.name, args);
        } catch (err) {
          if (!(err instanceof NeedsAuthError)) throw err; // dispatch turns any other crash into text
          const fresh = await refreshAccessToken(name);
          if (fresh) {
            client.setToken(fresh);
            try {
              return await client.callTool(spec.name, args);
            } catch (again) {
              if (!(again instanceof NeedsAuthError)) throw again;
            }
          }
          markNeedsAuth(name, err);
          return `[error] MCP server "${name}" needs authentication — run /mcp auth ${name}`;
        }
      },
    };
    registerExternalTool(tool); // now indistinguishable from a built-in to the rest of the system
  }
  return specs.length;
}

// Flag a server as needing the browser flow and remember the challenge so
// /mcp auth knows where the OAuth metadata lives. Its tools stay registered:
// they answer with the readable error until the user authenticates.
function markNeedsAuth(name: string, challenge: NeedsAuthError): void {
  const entry = entryFor(name);
  entry.status = "needs-auth";
  entry.error = challenge.message;
  entry.challenge = challenge;
}

// Connect a single configured server and register its tools. Updates the
// registry with the live status. Used by connectMcpServers() at startup and by
// /mcp reconnect / enable / auth.
async function connectOne(name: string, retried = false): Promise<void> {
  const entry = entryFor(name);
  // Unregister any stale tools from a previous connection.
  for (const n of entry.toolNames) unregisterExternalTool(n);
  entry.toolNames = [];
  entry.client?.kill();
  entry.client = undefined;

  // A stored token we KNOW is expired is refreshed before connecting rather
  // than burning a 401 round trip on it.
  let stored = oauthStore[name];
  if (stored?.refreshToken && stored.expiresAt && stored.expiresAt <= Date.now()) {
    await refreshAccessToken(name);
    stored = oauthStore[name];
  }
  const client = new McpClient(entry.def, stored?.accessToken);
  try {
    const specs = await client.start(); // handshake + discover
    entry.client = client;
    entry.tools = registerTools(name, specs, client);
    entry.toolNames = specs.map((s) => `mcp__${name}__${s.name}`);
    entry.status = "connected";
    entry.error = undefined;
    emit("agent_mcp_connected", { server: name, tools: specs.length, transport: entry.def.url ? "http" : "stdio" });
    console.log(chalk.dim(`(mcp: ${name} — ${specs.length} tools${entry.def.url ? " over http" : ""})`)); // visible at startup / on reconnect
  } catch (err) {
    client.kill(); // don't leak the process/session
    if (err instanceof NeedsAuthError) {
      // A stale token (expired early, revoked): one refresh + retry before giving up.
      if (!retried && stored?.refreshToken && (await refreshAccessToken(name))) return connectOne(name, true);
      markNeedsAuth(name, err);
    } else {
      entry.status = "failed";
      entry.error = (err as Error).message;
    }
    emit("agent_mcp_failed", { server: name });
    console.error(chalk.yellow(`  [mcp] ${name} ${entry.status === "needs-auth" ? `needs authentication (run /mcp auth ${name})` : "failed to start"}: ${(err as Error).message}`));
  }
}

// Connect to every configured MCP server, register their tools, and return a
// cleanup function. Failures are isolated: a server that won't start is logged
// and skipped — it never stops the agent or the other servers.
export async function connectMcpServers(): Promise<() => void> {
  const entries = Object.keys(CONFIG.mcpServers); // configured server names
  for (const name of entries) {
    await connectOne(name); // sequential: a slow start doesn't starve the next one
  }
  return () => {
    for (const entry of registry.values()) entry.client?.kill(); // cleanup on exit
  };
}

// ---- hot reload: pick up settings.json edits without a restart ----------------
// Adding a server used to mean quitting and relaunching. Now a settings change
// is DIFFED against what is running and only the difference is touched:
//   added   → connect it and register its tools
//   removed → kill it and unregister its tools
//   changed → reconnect it with the new definition
//   same    → left alone (an unrelated settings edit reconnects nothing)
// The tool list sent to the model is rebuilt every turn (toolDefinitions()), so
// the next model call simply sees the new set. A tool call already in flight to
// a server being removed fails with a readable error, like any dropped server.
//
// Claude Code swaps MCP tools the same way (drop every mcp__<server>__ tool,
// append the fresh ones), but it only re-reads MCP config on explicit triggers
// like /reload-plugins. We also watch the files, so a save is enough.

// Key-order-independent JSON, so reformatting an entry doesn't count as a change.
const stableJson = (v: unknown): string =>
  JSON.stringify(v, (_k, val) => (val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b))) : val));

// Reloads run one at a time: a second save while the first reload is still
// connecting queues behind it instead of racing it over the same registry.
let reloadChain: Promise<unknown> = Promise.resolve();

// Apply a new mcpServers map. `next` is the test seam; by default both settings
// files are re-read. Returns one human-readable line per change ([] = nothing
// changed), or a single warning line when the files can't be parsed right now.
export function reloadMcpServers(next?: Record<string, McpServerDef>): Promise<string[]> {
  const run = async (): Promise<string[]> => {
    const servers = next ?? readMcpServers();
    if (!servers) return ["settings.json is not valid JSON right now — MCP servers left unchanged"];
    const previous = CONFIG.mcpServers;
    CONFIG.mcpServers = servers; // entryFor / listMcpServers read the new map from here on

    const changes: string[] = [];
    for (const name of Object.keys(previous)) {
      if (name in servers) continue;
      const entry = registry.get(name);
      if (entry) {
        for (const n of entry.toolNames) unregisterExternalTool(n);
        entry.client?.kill();
        registry.delete(name); // gone from the config → gone from /mcp too
      }
      changes.push(`removed ${name}`);
    }
    for (const [name, def] of Object.entries(servers)) {
      const old = previous[name];
      if (old && stableJson(old) === stableJson(def)) continue; // untouched
      const entry = registry.get(name);
      if (entry) entry.def = def; // entryFor only builds new entries, so swap the def by hand
      if (entry?.status === "disabled") {
        changes.push(`updated ${name} (still disabled)`); // the user turned it off this session — respect that
        continue;
      }
      await connectOne(name); // replaces any stale client + tools, logs its own status line
      changes.push(`${old ? "reconnected" : "added"} ${name} (${registry.get(name)?.status})`);
    }
    return changes;
  };
  const result = reloadChain.then(run, run);
  reloadChain = result.catch(() => {}); // a failed reload must not wedge the ones after it
  return result;
}

// Watch both settings files and hot-reload on save. Polling (fs.watchFile), not
// fs.watch: editors often save by writing a temp file and renaming it over the
// original, which silently detaches an fs.watch handle; a stat poll just sees a
// new mtime. It also works for a file that doesn't exist yet — create
// .mini-agent/settings.json mid-session and it is picked up. Returns a stop function.
const WATCH_INTERVAL_MS = 1000; // how often to stat; Claude Code polls ~/.claude.json at the same rate
const RELOAD_DEBOUNCE_MS = 300; // a burst of writes (save + format-on-save) → one reload

export function watchMcpConfig(): () => void {
  let timer: NodeJS.Timeout | undefined;
  const onChange = (curr: fs.Stats, prev: fs.Stats): void => {
    if (curr.mtimeMs === prev.mtimeMs) return; // a stat tick with nothing new
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const changes = await reloadMcpServers().catch((err: Error) => [`reload failed: ${err.message}`]);
      if (changes.length) console.log(chalk.dim(`(mcp config changed: ${changes.join(", ")})`));
    }, RELOAD_DEBOUNCE_MS);
  };
  const files = [GLOBAL_SETTINGS_PATH, PROJECT_SETTINGS_PATH];
  for (const file of files) fs.watchFile(file, { interval: WATCH_INTERVAL_MS, persistent: false }, onChange); // persistent:false — never keeps the process alive
  return () => {
    clearTimeout(timer);
    for (const file of files) fs.unwatchFile(file, onChange);
  };
}

// ---- /mcp command support ----------------------------------------------------
export function listMcpServers(): McpServerInfo[] {
  // Include every CONFIGURED server, even ones never attempted this session.
  return Object.entries(CONFIG.mcpServers).map(([name, def]) => {
    const entry = registry.get(name);
    return {
      name,
      transport: def.url ? "http" : "stdio",
      status: entry?.status ?? "failed",
      tools: entry?.tools ?? 0,
      error: entry?.error,
      authenticated: Boolean(oauthStore[name]?.accessToken),
      url: def.url,
    };
  });
}

export type McpAction = "authenticate" | "reconnect" | "disable" | "enable";

// Which actions make sense for a server in a given state. Mirrors Claude Code's
// per-server menu: authenticate when it needs auth, reconnect when it isn't,
// enable/disable to toggle it off/on.
export function mcpActionsFor(info: McpServerInfo): Array<{ label: string; action: McpAction }> {
  if (info.status === "disabled") {
    return [{ label: "Enable", action: "enable" }];
  }
  const out: Array<{ label: string; action: McpAction }> = [];
  if (info.transport === "http") {
    out.push({ label: info.authenticated ? "Re-authenticate" : "Authenticate", action: "authenticate" });
  }
  out.push({ label: "Reconnect", action: "reconnect" });
  out.push({ label: "Disable", action: "disable" });
  return out;
}

// Trade the stored refresh token for a new access token, at the token endpoint
// recorded when the user authenticated — no rediscovery. A definitive rejection
// (400/401: the refresh token itself is dead) wipes the record so the UI tells
// the truth: the user has to authenticate again. Network trouble keeps it.
// Returns the new access token, or undefined when there is none to be had.
async function refreshAccessToken(name: string): Promise<string | undefined> {
  const stored = oauthStore[name];
  if (!stored?.refreshToken || !stored.tokenEndpoint) return undefined;

  const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: stored.refreshToken });
  if (stored.clientId) params.set("client_id", stored.clientId);
  if (stored.clientSecret) params.set("client_secret", stored.clientSecret);
  if (stored.resource) params.set("resource", stored.resource);
  let res: Response;
  try {
    res = await fetch(stored.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: params.toString(),
      signal: AbortSignal.timeout(INIT_TIMEOUT_MS),
    });
  } catch {
    return undefined; // offline / timeout — keep the record, it may work next time
  }
  if (res.status === 400 || res.status === 401) {
    delete oauthStore[name]; // invalid_grant: the refresh token is gone for good
    writeOAuthStore(oauthStore);
    return undefined;
  }
  if (!res.ok) return undefined; // a server hiccup — keep the record
  const tokens = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!tokens.access_token) return undefined;
  oauthStore[name] = { ...stored, accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? stored.refreshToken, expiresAt: expiryFrom(tokens) };
  writeOAuthStore(oauthStore);
  return tokens.access_token;
}

// Authenticate a server via browser OAuth and store the tokens. Returns a
// human-readable result for the UI.
export async function authenticateMcpServer(name: string, onUrl?: (url: string) => void): Promise<string> {
  const def = CONFIG.mcpServers[name];
  if (!def) return `No MCP server named "${name}"`;
  if (!def.url) return `${name} is a stdio server — it needs no OAuth authentication`;

  // Where the OAuth metadata lives: the last 401 told us; if none was seen this
  // session (re-authenticating while connected), ask the server now.
  const entry = entryFor(name);
  const challenge = entry.challenge ?? (await probeChallenge(def.url));
  oauthStore[name] = await runOAuthFlow(def, challenge, onUrl);
  writeOAuthStore(oauthStore);

  // Immediately reconnect with the fresh token so the server shows connected.
  await connectOne(name);
  const status = entry.status;
  return status === "connected"
    ? `Authentication successful. Connected to ${name}.`
    : `Authentication done, but ${name} is ${status} — use /mcp reconnect ${name} to retry.`;
}

// Disconnect and reconnect a single server (re-registering its tools). A stale
// stored token is refreshed inside connectOne, so this is just: connect again.
export async function reconnectMcpServer(name: string): Promise<string> {
  const def = CONFIG.mcpServers[name];
  if (!def) return `No MCP server named "${name}"`;

  await connectOne(name);
  const info = listMcpServers().find((s) => s.name === name)!;
  return info.status === "connected"
    ? `Connected to ${name} (${info.tools} tool${info.tools === 1 ? "" : "s"}).`
    : `${name} is ${info.status}: ${info.error ?? "unknown error"}`;
}

// Toggle a server off/on (session-only — the config file is not rewritten).
export async function disableMcpServer(name: string): Promise<string> {
  const entry = entryFor(name);
  for (const n of entry.toolNames) unregisterExternalTool(n);
  entry.toolNames = [];
  entry.client?.kill();
  entry.client = undefined;
  entry.status = "disabled";
  entry.error = undefined;
  return `Disabled ${name}.`;
}

export async function enableMcpServer(name: string): Promise<string> {
  const entry = entryFor(name);
  if (entry.status !== "disabled") return `${name} is not disabled.`;
  await connectOne(name);
  const info = listMcpServers().find((s) => s.name === name)!;
  return info.status === "connected" ? `Enabled ${name}.` : `${name} is ${info.status}: ${info.error ?? "unknown error"}`;
}

// Run one action from mcpActionsFor and return the note to display.
export async function runMcpAction(name: string, action: McpAction, onUrl?: (url: string) => void): Promise<string> {
  switch (action) {
    case "authenticate":
      return authenticateMcpServer(name, onUrl);
    case "reconnect":
      return reconnectMcpServer(name);
    case "disable":
      return disableMcpServer(name);
    case "enable":
      return enableMcpServer(name);
  }
}
