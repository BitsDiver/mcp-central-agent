#!/usr/bin/env node
import { program } from "commander";
import { createInterface } from "readline";
import { writeFile } from "fs/promises";
import { resolve } from "path";
import { loadConfig } from "./config.js";
import { McpCentralAgent } from "./agent.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function ask(
  rl: ReturnType<typeof createInterface>,
  question: string,
): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

// ── CLI ────────────────────────────────────────────────────────────────────

program
  .name("mcp-central-agent")
  .description(
    "Bridges local MCP servers to MCP Central via an outbound tunnel",
  )
  .version("0.1.0");

// ── init ──────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Create a mcp-agent.json config file interactively")
  .option("-o, --output <path>", "Output file path", "mcp-agent.json")
  .action(async (options: { output: string }) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      console.log("\n  MCP Central Agent — Config Setup\n");

      const serverUrl = (
        await ask(
          rl,
          "  MCP Central server URL (e.g. https://mcp.example.com): ",
        )
      ).trim();

      const agentName = (
        await ask(rl, "  Agent name (e.g. My Laptop): ")
      ).trim();

      const apiKey = (
        await ask(rl, "  Agent API key (starts with agent_): ")
      ).trim();

      const config = { serverUrl, agentName, apiKey };

      const outputPath = resolve(options.output);
      await writeFile(
        outputPath,
        JSON.stringify(config, null, 2) + "\n",
        "utf-8",
      );

      console.log(`\n  ✓ Config saved to ${outputPath}`);
      console.log(`\n  Run the agent with:\n  npx mcp-central-agent start\n`);
    } finally {
      rl.close();
    }
  });

// ── start ─────────────────────────────────────────────────────────────────

program
  .command("start")
  .description("Start the agent and connect to MCP Central")
  .option("-c, --config <path>", "Path to config file", "mcp-agent.json")
  .action(async (options: { config: string }) => {
    let config;
    try {
      config = await loadConfig(options.config);
    } catch (err) {
      if (err instanceof Error) {
        console.error(`\n  Error: ${err.message}\n`);
      } else {
        console.error(`\n  Error: ${String(err)}\n`);
      }
      process.exit(1);
    }

    const agent = new McpCentralAgent(config);
    agent.start();

    // Graceful shutdown
    const shutdown = async () => {
      console.log("\n  Shutting down…");
      await agent.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

// ── Parse ──────────────────────────────────────────────────────────────────

program.parse(process.argv);
