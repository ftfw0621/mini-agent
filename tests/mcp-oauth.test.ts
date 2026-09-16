import http from "node:http"; // one fake server plays MCP server + authorization server
import crypto from "node:crypto"; // verify PKCE on the token endpoint
import fs from "node:fs"; // inspect the token store
import os from "node:os"; // scratch dir for the token store
import path from "node:path";
import { check, checkContains, finish } from "./helpers.js"; // assertions

// The OAuth path end to end, against a fake server shaped like Slack's: the
// 401 challenge points at ORIGIN-ROOT resource metadata (the path-scoped guess
// 404s), the authorization server offers NO dynamic client registration, so the
// config must carry a pre-registered client id + a fixed callback port. Then:
// token expiry mid-session → silent refresh + retry; a dead refresh token →
// needs-auth with the readable error and the stored record wiped.

// Keep this suite's tokens out of the real store, and don't open a browser.
const STORE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mini-agent-oauth-")), "mcp-oauth.json");
process.env.MINI_AGENT_OAUTH_STORE = STORE;
process.env.MINI_AGENT_NO_BROWSER = "1";
// Imported AFTER the env is set: the store path is read at module load.
const { connectMcpServers, listMcpServers, authenticateMcpServer, discoverOAuth, NeedsAuthError } = await import("../src/mcp.js");
const { CONFIG } = await import("../src/config.js");
const { tools, dispatch } = await import("../src/tools.js");

// ---- NeedsAuthError: the WWW-Authenticate challenge is parsed, not guessed --------------
{
  const err = new NeedsAuthError("x", 'Bearer realm="OAuth", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="read write"');
  check("challenge: resource_metadata parsed", err.resourceMetadataUrl === "https://mcp.example.com/.well-known/oauth-protected-resource");
  check("challenge: scope parsed", err.scope === "read write");
  check("challenge: absent header → no hints", new NeedsAuthError("x", null).resourceMetadataUrl === undefined);
}

// ---- a free port for the fixed callback (what a pre-registered client demands) ----------
const CALLBACK_PORT = await new Promise<number>((resolve) => {
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const p = (probe.address() as { port: number }).port;
    probe.close(() => resolve(p));
  });
});

// ---- the fake server: MCP endpoint + OAuth metadata + token endpoint ------------------
const validTokens = new Set<string>(); // access tokens the MCP endpoint accepts right now
let issued = 0; // unique token suffixes
let refreshDead = false; // when true the refresh grant is rejected (invalid_grant)
let refreshes = 0; // how many refresh grants were served
let lastCodeChallenge = ""; // recorded from the authorize URL, verified on the token endpoint
let lastRedirectUri = "";
let origin = "";

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", origin);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    // -- RFC 9728: only the ORIGIN-ROOT document exists (Slack-shape) --
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["chat:write", "channels:read"] });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return json(res, 404, { error: "not here" });
    // -- RFC 8414: no registration_endpoint --
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, code_challenge_methods_supported: ["S256"], scopes_supported: ["everything"] });
    }
    // -- token endpoint --
    if (url.pathname === "/token") {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "authorization_code") {
        const verifier = form.get("code_verifier") ?? "";
        const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
        const ok = form.get("code") === "the-code" && challenge === lastCodeChallenge && form.get("client_id") === "test-client" && form.get("redirect_uri") === lastRedirectUri && form.get("resource") === `${origin}/mcp`;
        if (!ok) return json(res, 400, { error: "invalid_grant", error_description: "code/PKCE/client/redirect/resource mismatch" });
      } else if (form.get("grant_type") === "refresh_token") {
        if (refreshDead) return json(res, 400, { error: "invalid_grant" });
        if (form.get("refresh_token") !== `ref-${issued}` || form.get("resource") !== `${origin}/mcp`) return json(res, 400, { error: "invalid_grant", error_description: "stale refresh token or missing resource" });
        refreshes++;
      } else {
        return json(res, 400, { error: "unsupported_grant_type" });
      }
      issued++;
      validTokens.add(`tok-${issued}`);
      return json(res, 200, { access_token: `tok-${issued}`, refresh_token: `ref-${issued}`, expires_in: 3600, token_type: "Bearer" });
    }
    // -- the MCP endpoint: bearer-protected --
    if (url.pathname === "/mcp") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!validTokens.has(token)) {
        return json(res, 401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` });
      }
      const msg = body ? JSON.parse(body) : {};
      if (msg.id === undefined) return void res.writeHead(202).end(); // a notification
      if (msg.method === "initialize") return json(res, 200, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
      if (msg.method === "tools/list") {
        return json(res, 200, { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }] } });
      }
      if (msg.method === "tools/call") {
        const { a = 0, b = 0 } = msg.params.arguments;
        return json(res, 200, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String(a + b) }] } });
      }
      return json(res, 200, { jsonrpc: "2.0", id: msg.id, error: { message: `unknown method ${msg.method}` } });
    }
    json(res, 404, { error: "no such route" });
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// An entry shaped like Claude Code's Slack plugin config: type + url + a pre-registered client.
CONFIG.mcpServers = { fake: { type: "http", url: `${origin}/mcp`, oauth: { clientId: "test-client", callbackPort: CALLBACK_PORT } } };

// ---- startup without a token: needs-auth, tools NOT registered ---------------------------
const disconnect = await connectMcpServers();
{
  const info = listMcpServers()[0];
  check("unauthenticated server is needs-auth at startup", info.status === "needs-auth", info.status);
  check("no token stored yet", !info.authenticated);
  check("its tools are not registered", !("mcp__fake__add" in tools));
}

// ---- discovery honours the challenge pointer (root), not the path guess (404) ---------
{
  const d = await discoverOAuth(`${origin}/mcp`, { resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource` });
  check("discovery: token endpoint found", d?.tokenEndpoint === `${origin}/token`);
  check("discovery: no DCR on this server", d?.registrationEndpoint === undefined);
  check("discovery: resource comes from the resource metadata", d?.resource === `${origin}/mcp`);
  check("discovery: scopes come from the resource, not the auth server", JSON.stringify(d?.scopes) === JSON.stringify(["chat:write", "channels:read"]));
}

// ---- the browser flow, with the test playing the browser ------------------------------
// The auth URL is handed to onUrl; the "browser" then hits our loopback callback.
const playBrowser = (authUrl: string) => {
  const u = new URL(authUrl);
  check("authorize: pre-registered client id used (no DCR)", u.searchParams.get("client_id") === "test-client");
  check("authorize: fixed callback port in the redirect", u.searchParams.get("redirect_uri") === `http://localhost:${CALLBACK_PORT}/callback`);
  check("authorize: resource indicator sent (RFC 8707)", u.searchParams.get("resource") === `${origin}/mcp`);
  check("authorize: resource's scopes requested", u.searchParams.get("scope") === "chat:write channels:read");
  check("authorize: PKCE S256", u.searchParams.get("code_challenge_method") === "S256" && (u.searchParams.get("code_challenge") ?? "").length > 20);
  lastCodeChallenge = u.searchParams.get("code_challenge") ?? "";
  lastRedirectUri = u.searchParams.get("redirect_uri") ?? "";
  const state = u.searchParams.get("state") ?? "";
  setTimeout(async () => {
    const wrong = await fetch(`${lastRedirectUri}?code=evil&state=not-ours`); // a stale/foreign redirect is ignored...
    check("callback: mismatched state is rejected", wrong.status === 404);
    const ok = await fetch(`${lastRedirectUri}?code=the-code&state=${state}`); // ...the real one lands
    check("callback: the real redirect is accepted", ok.status === 200);
  }, 10);
};

{
  const msg = await authenticateMcpServer("fake", playBrowser);
  checkContains("authenticate: reports success", msg, "Authentication successful");
  const info = listMcpServers()[0];
  check("authenticate: server is connected", info.status === "connected", info.error ?? "");
  check("authenticate: token stored", info.authenticated);
  check("authenticate: tools registered", "mcp__fake__add" in tools);
  const stored = JSON.parse(fs.readFileSync(STORE, "utf8"));
  check("store: keeps what a refresh needs", stored.fake?.refreshToken === "ref-1" && stored.fake?.tokenEndpoint === `${origin}/token` && stored.fake?.resource === `${origin}/mcp`);
  check("store: written to the scratch path, not ~/.config", STORE.startsWith(os.tmpdir()));
}

// ---- the tool works; then the token expires mid-session → silent refresh + retry ------
checkContains("tool call works with the fresh token (17+25=42)", await dispatch("mcp__fake__add", JSON.stringify({ a: 17, b: 25 })), "42");

validTokens.delete("tok-1"); // the server no longer accepts the first token
checkContains("expired token: refreshed + retried transparently", await dispatch("mcp__fake__add", JSON.stringify({ a: 20, b: 22 })), "42");
check("expired token: exactly one refresh grant served", refreshes === 1, String(refreshes));
check("expired token: still connected", listMcpServers()[0].status === "connected");
check("store: rotated refresh token persisted", JSON.parse(fs.readFileSync(STORE, "utf8")).fake?.refreshToken === "ref-2");

// ---- the refresh token dies too → readable error, needs-auth, record wiped ----------
validTokens.delete("tok-2");
refreshDead = true;
{
  const out = await dispatch("mcp__fake__add", JSON.stringify({ a: 1, b: 1 }));
  checkContains("dead refresh: tool returns a readable error", out, "needs authentication");
  checkContains("dead refresh: error points at the fix", out, "/mcp auth fake");
  const info = listMcpServers()[0];
  check("dead refresh: server flagged needs-auth", info.status === "needs-auth");
  check("dead refresh: stored record wiped", !info.authenticated);
}

// ---- re-authenticate a server that never 401'd this session → the probe finds the challenge
refreshDead = false;
CONFIG.mcpServers.fake2 = { url: `${origin}/mcp`, oauth: { clientId: "test-client", callbackPort: CALLBACK_PORT } };
{
  const msg = await authenticateMcpServer("fake2", playBrowser);
  checkContains("probe: authenticating a never-connected server works", msg, "Authentication successful");
  check("probe: its tools are registered", "mcp__fake2__add" in tools);
}

disconnect();
CONFIG.mcpServers = {}; // reset for any suite that follows
await new Promise<void>((resolve) => server.close(() => resolve()));
fs.rmSync(path.dirname(STORE), { recursive: true, force: true }); // the scratch token store
finish();
