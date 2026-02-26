import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// ── Endpoint config ────────────────────────────────────────────────────────

export interface EndpointConfig {
  id: string;
  name: string;
  namespace: string;
  transport: "stdio" | "streamable-http" | "sse";
  url: string | null;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  headers: Record<string, string>;
  isEnabled: boolean;
}

export type HeadersInit = Record<string, string> | [string, string][] | Headers;

export type LocalClientStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

// ── Callbacks ─────────────────────────────────────────────────────────────

export interface LocalClientCallbacks {
  onToolsChanged: (tools: Tool[]) => void;
  onStatusChanged: (status: LocalClientStatus, error?: string) => void;
}

// ── LocalClient ────────────────────────────────────────────────────────────

const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];
const MAX_RECONNECT_DELAY = 60_000;

export class LocalClient {
  readonly endpointId: string;
  readonly config: EndpointConfig;

  private _client: Client | null = null;
  private _status: LocalClientStatus = "disconnected";
  private _tools: Tool[] = [];
  private _destroyed = false;
  private _connecting = false;
  private _reconnectAttempt = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _callbacks: LocalClientCallbacks;

  constructor(config: EndpointConfig, callbacks: LocalClientCallbacks) {
    this.endpointId = config.id;
    this.config = config;
    this._callbacks = callbacks;
  }

  get status(): LocalClientStatus {
    return this._status;
  }

  get tools(): Tool[] {
    return this._tools;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this._destroyed || this._connecting) return;
    this._connecting = true;
    this._setStatus("connecting");

    try {
      const client = new Client(
        {
          name: `mcp-central-agent:${this.config.namespace}`,
          version: "0.1.0",
        },
        { capabilities: { roots: {}, sampling: {} } },
      );

      // For HTTP endpoints: try Streamable HTTP (POST) first, fall back to
      // SSE (GET) if the POST handshake fails — mirrors the backend's
      // UpstreamClient.connectHttp() so the choice is transparent to users.
      let transport:
        | StdioClientTransport
        | StreamableHTTPClientTransport
        | SSEClientTransport;
      if (this.config.transport === "streamable-http") {
        transport = await this._connectHttp(client);
      } else {
        transport = this._createTransport();
        await client.connect(transport);
      }

      this._client = client;
      this._reconnectAttempt = 0;

      // Discover tools
      const response = await client.listTools();
      this._tools = response.tools ?? [];
      this._setStatus("connected");
      this._callbacks.onToolsChanged(this._tools);

      // Watch for server-side drops.
      // onerror fires when the remote end closes the connection mid-session
      // (ECONNRESET, ECONNREFUSED after restart, etc.) — this is the primary
      // signal for SSE and Streamable-HTTP transports.
      // onclose fires on an explicit transport.close() call.
      // Both must be hooked, mirroring UpstreamClient._hookTransportClose().
      // One-shot wrappers prevent double-scheduling if both fire together.
      const _onError = (err: Error) => {
        (transport as any).onerror = undefined;
        if (!this._destroyed && this._status === "connected") {
          console.warn(
            `[LocalClient] ${this.config.name}: transport error — ${err?.message ?? err}`,
          );
          this._tools = [];
          this._setStatus("error", err?.message ?? "Transport error");
          this._scheduleReconnect();
        }
      };
      const _onClose = () => {
        (transport as any).onclose = undefined;
        if (!this._destroyed && this._status === "connected") {
          console.warn(
            `[LocalClient] ${this.config.name}: transport closed unexpectedly`,
          );
          this._tools = [];
          this._setStatus("error", "Transport closed unexpectedly");
          this._scheduleReconnect();
        }
      };
      (transport as any).onerror = _onError;
      transport.onclose = _onClose;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._setStatus("error", message);
      if (!this._destroyed) {
        this._scheduleReconnect();
      }
    } finally {
      this._connecting = false;
    }
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this._client) {
      throw new Error(
        `LocalClient for endpoint ${this.endpointId} is not connected`,
      );
    }
    const result = await this._client.callTool({
      name: toolName,
      arguments: args,
    });
    return result;
  }

  async disconnect(): Promise<void> {
    this._destroyed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._client) {
      await this._client.close().catch(() => {});
      this._client = null;
    }
    this._setStatus("disconnected");
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private _createTransport() {
    const { transport, url, command, args, env, headers } = this.config;

    if (transport === "stdio") {
      if (!command) {
        throw new Error(`stdio endpoint ${this.endpointId} has no command`);
      }
      return new StdioClientTransport({
        command,
        args,
        env: { ...process.env, ...env } as Record<string, string>,
      });
    }

    if (transport === "streamable-http") {
      if (!url) {
        throw new Error(
          `streamable-http endpoint ${this.endpointId} has no URL`,
        );
      }
      return new StreamableHTTPClientTransport(new URL(url), {
        requestInit: {
          headers: headers as HeadersInit,
        },
      });
    }

    if (transport === "sse") {
      if (!url) {
        throw new Error(`sse endpoint ${this.endpointId} has no URL`);
      }
      return new SSEClientTransport(new URL(url), {
        requestInit: {
          headers: headers as HeadersInit,
        },
      });
    }

    throw new Error(
      `Unsupported transport '${transport}' for endpoint ${this.endpointId}`,
    );
  }

  /**
   * Attempts Streamable HTTP (POST) first; falls back to SSE (GET) on failure.
   * Mirrors the logic in the backend's UpstreamClient.connectHttp().
   *
   * Some MCP server providers only expose a GET/SSE endpoint while others use
   * the newer Streamable HTTP POST protocol — this makes both work transparently.
   */
  private async _connectHttp(
    client: Client,
  ): Promise<StreamableHTTPClientTransport | SSEClientTransport> {
    const { url, headers } = this.config;
    if (!url)
      throw new Error(`streamable-http endpoint ${this.endpointId} has no URL`);

    const parsedUrl = new URL(url);
    const reqInit = { headers: headers as HeadersInit };

    // ── Attempt 1: Streamable HTTP (POST) ──────────────────
    const streamableTransport = new StreamableHTTPClientTransport(parsedUrl, {
      requestInit: reqInit,
    });
    try {
      await client.connect(streamableTransport);
      console.log(
        `[LocalClient] ${this.config.name}: connected via Streamable HTTP (POST)`,
      );
      return streamableTransport;
    } catch {
      // Explicitly close the transport so its underlying fetch/socket is
      // aborted. client.close() alone may not reach the transport if
      // connect() threw before the SDK registered the transport internally.
      streamableTransport.close().catch(() => {});
      await client.close().catch(() => {});
    }

    // ── Attempt 2: SSE (GET) fallback ──────────────────────
    console.log(
      `[LocalClient] ${this.config.name}: Streamable HTTP failed, retrying via SSE (GET)…`,
    );
    const sseTransport = new SSEClientTransport(parsedUrl, {
      requestInit: reqInit,
    });
    try {
      await client.connect(sseTransport);
      console.log(`[LocalClient] ${this.config.name}: connected via SSE (GET)`);
      return sseTransport;
    } catch (err) {
      // Same cleanup — abort the dangling fetch so it doesn't fire when the
      // server eventually comes back up.
      sseTransport.close().catch(() => {});
      await client.close().catch(() => {});
      throw err;
    }
  }

  private _setStatus(status: LocalClientStatus, error?: string): void {
    this._status = status;
    this._callbacks.onStatusChanged(status, error);
  }

  private _scheduleReconnect(): void {
    if (this._destroyed) return;
    const delay =
      RECONNECT_DELAYS[
        Math.min(this._reconnectAttempt, RECONNECT_DELAYS.length - 1)
      ] ?? MAX_RECONNECT_DELAY;
    this._reconnectAttempt++;
    console.log(
      `[LocalClient] Reconnecting ${this.config.name} in ${delay / 1000}s (attempt ${this._reconnectAttempt})…`,
    );
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect().catch(() => {});
    }, delay);
  }
}
