import type { AgentConfig } from "./config.js";
import type { EndpointConfig } from "./local-client.js";
import { LocalClient } from "./local-client.js";
import { AgentTunnel } from "./tunnel.js";

// ── McpCentralAgent ──────────────────────────────────────────────────────

export class McpCentralAgent {
  private readonly _config: AgentConfig;
  private readonly _tunnel: AgentTunnel;
  private readonly _clients = new Map<string, LocalClient>();

  constructor(config: AgentConfig) {
    this._config = config;
    this._tunnel = new AgentTunnel(config, {
      onEndpoints: (endpoints) => this._syncEndpoints(endpoints),
      onEndpointAdd: (endpoint) => this._addEndpoint(endpoint),
      onEndpointRemove: (endpointId) => this._removeEndpoint(endpointId),
      onEndpointToggle: (endpointId, isEnabled) =>
        this._toggleEndpoint(endpointId, isEnabled),
      onEndpointUpdate: (endpoint) => this._updateEndpoint(endpoint),
      onEndpointRefresh: (endpointId) => this._refreshEndpoint(endpointId),
      onToolCall: (payload) => this._handleToolCall(payload),
    });
  }

  /** Start the agent: connect tunnel and wait for endpoint list. */
  start(): void {
    console.log(
      `[McpCentralAgent] Starting agent '${this._config.agentName}'…`,
    );
    console.log(`[McpCentralAgent] Connecting to ${this._config.serverUrl}…`);
    this._tunnel.connect();
  }

  /** Gracefully stop the agent. */
  async stop(): Promise<void> {
    console.log(`[McpCentralAgent] Stopping…`);
    for (const [id, client] of this._clients) {
      await client.disconnect();
      this._clients.delete(id);
    }
    this._tunnel.disconnect();
  }

  // ── Endpoint lifecycle ───────────────────────────────────────────────

  private _syncEndpoints(endpoints: EndpointConfig[]): void {
    // Remove clients no longer in the list
    const incoming = new Set(endpoints.map((e) => e.id));
    for (const id of this._clients.keys()) {
      if (!incoming.has(id)) {
        this._removeEndpoint(id);
      }
    }
    // Add/update endpoints
    for (const ep of endpoints) {
      if (ep.isEnabled) {
        if (this._clients.has(ep.id)) {
          // Already connected — nothing to do unless config changed
        } else {
          this._addEndpoint(ep);
        }
      }
    }
  }

  private _addEndpoint(endpoint: EndpointConfig): void {
    if (!endpoint.isEnabled) {
      console.log(
        `[McpCentralAgent] Endpoint '${endpoint.name}' is disabled — skipping`,
      );
      return;
    }

    const existing = this._clients.get(endpoint.id);
    if (existing) {
      // Replace existing client
      existing.disconnect().catch(() => {});
      this._clients.delete(endpoint.id);
    }

    const client = new LocalClient(endpoint, {
      onToolsChanged: (tools) => {
        this._tunnel.announceTools(endpoint.id, tools);
      },
      onStatusChanged: (status, error) => {
        this._tunnel.sendStatusUpdate(endpoint.id, status, error);
      },
    });

    this._clients.set(endpoint.id, client);
    client.connect().catch((err) => {
      console.error(
        `[McpCentralAgent] Failed to connect '${endpoint.name}': ${String(err)}`,
      );
    });
  }

  private _removeEndpoint(endpointId: string): void {
    const client = this._clients.get(endpointId);
    if (client) {
      client.disconnect().catch(() => {});
      this._clients.delete(endpointId);
      console.log(`[McpCentralAgent] Endpoint ${endpointId} removed`);
    }
  }

  private _toggleEndpoint(endpointId: string, isEnabled: boolean): void {
    const client = this._clients.get(endpointId);
    if (!isEnabled) {
      if (client) {
        client.disconnect().catch(() => {});
        this._clients.delete(endpointId);
        this._tunnel.sendStatusUpdate(endpointId, "disconnected");
      }
    } else {
      if (!client) {
        // Re-enable: we need the endpoint config — request a refresh
        this._tunnel.sendStatusUpdate(endpointId, "connecting");
        // The server will send agent:endpoint_refresh with the full config
      }
    }
  }

  private _updateEndpoint(endpoint: EndpointConfig): void {
    // Reconnect with updated config
    this._removeEndpoint(endpoint.id);
    if (endpoint.isEnabled) {
      this._addEndpoint(endpoint);
    }
  }

  private _refreshEndpoint(endpointId: string): void {
    const client = this._clients.get(endpointId);
    if (client) {
      // Reconnect
      client.disconnect().catch(() => {});
      this._clients.delete(endpointId);
      // Re-create with same config
      this._addEndpoint(client.config);
    }
  }

  // ── Tool call handling ───────────────────────────────────────────────

  private async _handleToolCall(payload: {
    callId: string;
    endpointId: string;
    toolName: string;
    args: Record<string, unknown>;
  }): Promise<void> {
    const { callId, endpointId, toolName, args } = payload;
    const client = this._clients.get(endpointId);

    if (!client) {
      this._tunnel.sendToolError(
        callId,
        `No local client for endpoint ${endpointId}`,
      );
      return;
    }

    if (client.status !== "connected") {
      this._tunnel.sendToolError(
        callId,
        `Endpoint ${endpointId} is not connected (status: ${client.status})`,
      );
      return;
    }

    try {
      const result = await client.callTool(toolName, args);
      this._tunnel.sendToolResult(callId, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._tunnel.sendToolError(callId, message);
    }
  }
}
