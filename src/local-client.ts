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
    if (this._destroyed) return;
    this._setStatus("connecting");

    try {
      const transport = this._createTransport();
      const client = new Client(
        {
          name: `mcp-central-agent:${this.config.namespace}`,
          version: "0.1.0",
        },
        { capabilities: { roots: {}, sampling: {} } },
      );

      await client.connect(transport);
      this._client = client;
      this._reconnectAttempt = 0;

      // Discover tools
      const response = await client.listTools();
      this._tools = response.tools ?? [];
      this._setStatus("connected");
      this._callbacks.onToolsChanged(this._tools);

      // Watch for transport close to trigger reconnect
      transport.onclose = () => {
        if (!this._destroyed) {
          this._setStatus("error", "Transport closed unexpectedly");
          this._scheduleReconnect();
        }
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._setStatus("error", message);
      if (!this._destroyed) {
        this._scheduleReconnect();
      }
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
