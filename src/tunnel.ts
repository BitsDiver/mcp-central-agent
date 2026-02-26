import { io, type Socket } from "socket.io-client";
import type { AgentConfig } from "./config.js";
import type { EndpointConfig } from "./local-client.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { AGENT_VERSION } from "./version.js";

// ── Tunnel protocol types ────────────────────────────────────────────────

export interface ToolCallPayload {
  callId: string;
  endpointId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface TunnelCallbacks {
  onEndpoints: (endpoints: EndpointConfig[]) => void;
  onEndpointAdd: (endpoint: EndpointConfig) => void;
  onEndpointRemove: (endpointId: string) => void;
  onEndpointToggle: (endpointId: string, isEnabled: boolean) => void;
  onEndpointUpdate: (endpoint: EndpointConfig) => void;
  onEndpointRefresh: (endpointId: string) => void;
  onToolCall: (payload: ToolCallPayload) => void;
}

// ── AgentTunnel ──────────────────────────────────────────────────────────

export class AgentTunnel {
  private _socket: Socket | null = null;
  private readonly _config: AgentConfig;
  private readonly _callbacks: TunnelCallbacks;

  constructor(config: AgentConfig, callbacks: TunnelCallbacks) {
    this._config = config;
    this._callbacks = callbacks;
  }

  /** Connect to the /agent-tunnel namespace with the agent API key. */
  connect(): void {
    const url = this._config.serverUrl.replace(/\/$/, "");

    this._socket = io(`${url}/agent-tunnel`, {
      auth: { apiKey: this._config.apiKey, version: AGENT_VERSION },
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      reconnectionAttempts: Infinity,
    });

    this._socket.on("connect", () => {
      console.log(`[AgentTunnel] Connected to ${url}/agent-tunnel`);
      // Emit join so AgentTunnelService registers the socket and pushes endpoints.
      // IOServer wires public service methods as socket.on(method) handlers;
      // the agent must explicitly emit this first event.
      this._socket?.emit("join", {}, (ack: unknown) => {
        if (ack && typeof ack === "object" && (ack as any).status === "error") {
          console.error(`[AgentTunnel] join rejected:`, ack);
        }
      });
    });

    this._socket.on("disconnect", (reason) => {
      console.warn(`[AgentTunnel] Disconnected: ${reason}`);
    });

    this._socket.on("connect_error", (err) => {
      console.error(`[AgentTunnel] Connection error: ${err.message}`);
    });

    // ── Server → Agent events ───────────────────────────────────────────

    this._socket.on("agent:endpoints", (endpoints: EndpointConfig[]) => {
      console.log(`[AgentTunnel] Received ${endpoints.length} endpoints`);
      this._callbacks.onEndpoints(endpoints);
    });

    this._socket.on(
      "agent:endpoint_add",
      ({ endpoint }: { endpoint: EndpointConfig }) => {
        console.log(`[AgentTunnel] Endpoint added: ${endpoint.name}`);
        this._callbacks.onEndpointAdd(endpoint);
      },
    );

    this._socket.on(
      "agent:endpoint_remove",
      (payload: { endpointId: string }) => {
        console.log(`[AgentTunnel] Endpoint removed: ${payload.endpointId}`);
        this._callbacks.onEndpointRemove(payload.endpointId);
      },
    );

    this._socket.on(
      "agent:endpoint_toggle",
      (payload: { endpointId: string; isEnabled: boolean }) => {
        this._callbacks.onEndpointToggle(payload.endpointId, payload.isEnabled);
      },
    );

    this._socket.on(
      "agent:endpoint_update",
      ({ endpoint }: { endpoint: EndpointConfig }) => {
        console.log(`[AgentTunnel] Endpoint updated: ${endpoint.name}`);
        this._callbacks.onEndpointUpdate(endpoint);
      },
    );

    this._socket.on(
      "agent:endpoint_refresh",
      (payload: { endpointId: string }) => {
        console.log(`[AgentTunnel] Endpoint refresh: ${payload.endpointId}`);
        this._callbacks.onEndpointRefresh(payload.endpointId);
      },
    );

    this._socket.on("agent:tool_call", (payload: ToolCallPayload) => {
      this._callbacks.onToolCall(payload);
    });
  }

  disconnect(): void {
    this._socket?.disconnect();
    this._socket = null;
  }

  // ── Agent → Server events ──────────────────────────────────────────────

  /** Announce the list of tools available for an endpoint. */
  announceTools(endpointId: string, tools: Tool[]): void {
    this._socket?.emit("toolsAnnounce", {
      endpointId,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  }

  /** Send the result of a tool call back to the server. */
  sendToolResult(callId: string, result: unknown): void {
    this._socket?.emit("toolResult", { callId, result });
  }

  /** Send a tool call error back to the server. */
  sendToolError(callId: string, error: string): void {
    this._socket?.emit("toolResult", { callId, error });
  }

  /** Report the connection status of a local endpoint. */
  sendStatusUpdate(
    endpointId: string,
    status: "connecting" | "connected" | "disconnected" | "error",
    error?: string,
  ): void {
    this._socket?.emit("statusUpdate", { endpointId, status, error });
  }
}
