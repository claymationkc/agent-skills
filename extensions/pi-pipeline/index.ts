/**
 * Pi Pipeline Extension
 *
 * Implements deterministic multi-agent orchestration on top of pi.
 * Role is detected via PI_PIPELINE_ROLE environment variable:
 *   - unset / "orchestrator" → registers orchestrator tools
 *   - "sub-agent"            → registers sub-agent tools
 *
 * Sub-agents are spawned as child pi processes with env vars:
 *   PI_PIPELINE_ROLE=sub-agent
 *   PI_PIPELINE_SESSION_ID=<id>
 *   PI_PIPELINE_SESSION_DIR=<path>
 *   PI_PIPELINE_AGENT=<name>
 *   PI_PIPELINE_RUN=<n>
 *
 * Directory layout (see ARCHITECTURE.md):
 *   ~/.pi-pipeline/sessions/<session-id>/
 *     reasoning.jsonl
 *     orchestrator/input/task.json
 *     orchestrator/output/plan.json
 *     <agent>/run-<n>/input/task.json
 *     <agent>/run-<n>/output/result.json
 *     final/summary.json
 */

import type {
  ExtensionAPI,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { spawn } from "child_process";

// ── Constants ─────────────────────────────────────────────────────────────────

const SESSIONS_BASE = join(homedir(), ".pi-pipeline", "sessions");
const SKILLS_DIR = join(homedir(), "pi-skills", "skills");

/** Approximate char limits (1 token ≈ 4 chars) */
const TOKEN_LIMITS = {
  taskJson: 4096 * 4,         // 4,096 tokens — task inputs
  resultJson: 2048 * 4,       // 2,048 tokens — sub-agent outputs
  architectResult: 8192 * 4,  // 8,192 tokens — architect output exception
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSessionId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `sess_${date}_${randomUUID().slice(0, 8)}`;
}

function appendLog(sessionDir: string, entry: object): void {
  appendFileSync(join(sessionDir, "reasoning.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
}

function enforceLimit(json: string, limitChars: number, label: string): string {
  if (json.length <= limitChars) return json;
  console.warn(`[pi-pipeline] ${label} truncated (${json.length} > ${limitChars} chars)`);
  return json.slice(0, limitChars) + "\n/* TRUNCATED: exceeded context token limit */";
}

function taskPath(sessionDir: string, agent: string, run: number): string {
  return agent === "orchestrator"
    ? join(sessionDir, "orchestrator", "input", "task.json")
    : join(sessionDir, agent, `run-${run}`, "input", "task.json");
}

function outputPath(sessionDir: string, agent: string, run: number): string {
  return agent === "orchestrator"
    ? join(sessionDir, "orchestrator", "output", "plan.json")
    : join(sessionDir, agent, `run-${run}`, "output", "result.json");
}

// ── Extension Factory ─────────────────────────────────────────────────────────

export default async function (api: ExtensionAPI) {
  const role = process.env.PI_PIPELINE_ROLE ?? "orchestrator";
  const isOrchestrator = role !== "sub-agent";

  if (isOrchestrator) {
    await registerOrchestrator(api);
  } else {
    await registerSubAgent(api);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────

async function registerOrchestrator(api: ExtensionAPI) {
  const sessionId = makeSessionId();
  const sessionDir = join(SESSIONS_BASE, sessionId);
  const runCounts = new Map<string, number>();

  // Create base session directories
  mkdirSync(join(sessionDir, "orchestrator", "input"), { recursive: true });
  mkdirSync(join(sessionDir, "orchestrator", "output"), { recursive: true });
  mkdirSync(join(sessionDir, "final"), { recursive: true });

  appendLog(sessionDir, {
    ts: new Date().toISOString(),
    session: sessionId,
    agent: "system",
    event: "session_start",
    content: { role: "orchestrator", sessionDir },
  });

  // Inject session context into system prompt
  api.on(
    "before_agent_start",
    async (event: BeforeAgentStartEvent): Promise<BeforeAgentStartEventResult> => ({
      systemPrompt: event.systemPrompt + [
        "",
        "## Pipeline Context",
        `SESSION_ID: ${sessionId}`,
        `SESSION_DIR: ${sessionDir}`,
        `ROLE: orchestrator`,
        "",
        "You have access to: log_reasoning, write_task, read_agent_output,",
        "dispatch_agent, terminate_pipeline.",
        "Never use raw file I/O for inter-agent communication.",
      ].join("\n"),
    }),
  );

  // ── log_reasoning ──────────────────────────────────────────────────────────

  api.registerTool({
    name: "log_reasoning",
    label: "Log Reasoning",
    description: "Append a reasoning entry to the session JSONL log.",
    promptSnippet: "log_reasoning(event, content) — append to reasoning.jsonl",
    parameters: Type.Object({
      event: Type.String({ description: "Event type: plan | dispatch | eval | terminate" }),
      content: Type.Unknown({ description: "JSON content to log" }),
    }),
    execute: async (_id, params) => {
      appendLog(sessionDir, {
        ts: new Date().toISOString(),
        session: sessionId,
        agent: "orchestrator",
        event: params.event,
        content: params.content,
      });
      return { llmContent: `Logged orchestrator/${params.event}` };
    },
  });

  // ── write_task ─────────────────────────────────────────────────────────────

  api.registerTool({
    name: "write_task",
    label: "Write Task",
    description: "Write a task.json to a sub-agent's input directory. Auto-increments run count.",
    promptSnippet: "write_task(agent, task) — write task.json, returns run number",
    parameters: Type.Object({
      agent: Type.String({ description: "Sub-agent name (e.g. coding, reviewer, testing)" }),
      task: Type.Unknown({ description: "Task object conforming to input schema (4,096 token limit)" }),
    }),
    execute: async (_id, params) => {
      const run = (runCounts.get(params.agent) ?? 0) + 1;
      runCounts.set(params.agent, run);

      const inputDir = join(sessionDir, params.agent, `run-${run}`, "input");
      mkdirSync(inputDir, { recursive: true });
      mkdirSync(join(sessionDir, params.agent, `run-${run}`, "output"), { recursive: true });

      const taskWithMeta = {
        session_id: sessionId,
        agent: params.agent,
        run,
        ...(params.task as object),
      };

      const raw = JSON.stringify(taskWithMeta, null, 2);
      const bounded = enforceLimit(raw, TOKEN_LIMITS.taskJson, `${params.agent}/task`);
      const path = taskPath(sessionDir, params.agent, run);

      writeFileSync(path, bounded, "utf-8");

      appendLog(sessionDir, {
        ts: new Date().toISOString(),
        session: sessionId,
        agent: "orchestrator",
        event: "write_task",
        content: { to: params.agent, run, path },
      });

      return { llmContent: `Task written → ${path} (run-${run})` };
    },
  });

  // ── read_agent_output ──────────────────────────────────────────────────────

  api.registerTool({
    name: "read_agent_output",
    label: "Read Agent Output",
    description: "Read the result.json from a sub-agent's latest completed run.",
    promptSnippet: "read_agent_output(agent, run?) — returns result JSON",
    parameters: Type.Object({
      agent: Type.String({ description: "Sub-agent name" }),
      run: Type.Optional(Type.Number({ description: "Run number (default: latest)" })),
    }),
    execute: async (_id, params) => {
      const run = params.run ?? (runCounts.get(params.agent) ?? 1);
      const path = outputPath(sessionDir, params.agent, run);

      if (!existsSync(path)) {
        return { llmContent: `Error: output not found at ${path}` };
      }

      return { llmContent: readFileSync(path, "utf-8") };
    },
  });

  // ── dispatch_agent ─────────────────────────────────────────────────────────

  api.registerTool({
    name: "dispatch_agent",
    label: "Dispatch Agent",
    description: "Spawn a sub-agent as a child pi process. Call write_task first.",
    promptSnippet: "dispatch_agent(agent, skill?) — runs specialist, returns exit status",
    parameters: Type.Object({
      agent: Type.String({ description: "Sub-agent name" }),
      skill: Type.Optional(Type.String({ description: "Skill name if different from agent name" })),
    }),
    execute: async (_id, params, signal) => {
      const run = runCounts.get(params.agent) ?? 1;
      const skillName = params.skill ?? params.agent;
      const skillPath = join(SKILLS_DIR, skillName);

      if (!existsSync(taskPath(sessionDir, params.agent, run))) {
        return { llmContent: `Error: no task written for ${params.agent} run-${run}. Call write_task first.` };
      }

      appendLog(sessionDir, {
        ts: new Date().toISOString(),
        session: sessionId,
        agent: "orchestrator",
        event: "dispatch",
        content: { to: params.agent, skill: skillName, run },
      });

      const prompt = [
        `You are the ${params.agent} agent. Run ${run}.`,
        `Start by calling read_input() to get your task.`,
        `Call log_reasoning at start and end.`,
        `Call write_output(result) when done.`,
      ].join(" ");

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PI_PIPELINE_ROLE: "sub-agent",
        PI_PIPELINE_SESSION_ID: sessionId,
        PI_PIPELINE_SESSION_DIR: sessionDir,
        PI_PIPELINE_AGENT: params.agent,
        PI_PIPELINE_RUN: String(run),
      };

      return new Promise((resolve) => {
        const proc = spawn("pi", ["--print", "--skill", skillPath, prompt], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        proc.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
        proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
        signal?.addEventListener("abort", () => proc.kill("SIGTERM"));

        proc.on("close", (code) => {
          appendLog(sessionDir, {
            ts: new Date().toISOString(),
            session: sessionId,
            agent: params.agent,
            event: "process_exit",
            run,
            content: { exit_code: code },
          });

          const tail = (s: string) => s.slice(-600).trim();
          resolve({
            llmContent: [
              `${params.agent} (run-${run}) exited ${code}.`,
              stdout ? `stdout: ${tail(stdout)}` : "",
              stderr ? `stderr: ${tail(stderr)}` : "",
            ].filter(Boolean).join("\n"),
          });
        });

        proc.on("error", (err) => {
          resolve({ llmContent: `Failed to spawn ${params.agent}: ${err.message}` });
        });
      });
    },
  });

  // ── terminate_pipeline ─────────────────────────────────────────────────────

  api.registerTool({
    name: "terminate_pipeline",
    label: "Terminate Pipeline",
    description: "Write final/summary.json and close the pipeline. Always call this at the end.",
    promptSnippet: "terminate_pipeline(status, summary) — writes final summary",
    parameters: Type.Object({
      status: Type.Union([
        Type.Literal("complete"),
        Type.Literal("max-iterations-reached"),
      ]),
      summary: Type.Object({
        goal: Type.String(),
        deliverables: Type.Array(Type.String()),
        test_results: Type.Optional(Type.Object({
          passed: Type.Number(),
          failed: Type.Number(),
          total: Type.Number(),
        })),
        outstanding_issues: Type.Optional(
          Type.Array(Type.String(), {
            description: "Unresolved issues — required when status is max-iterations-reached",
          }),
        ),
        notes: Type.Optional(Type.String()),
      }),
    }),
    execute: async (_id, params) => {
      const finalPath = join(sessionDir, "final", "summary.json");

      const summary = {
        session_id: sessionId,
        status: params.status,
        terminated_at: new Date().toISOString(),
        agent_runs: Object.fromEntries(runCounts),
        ...params.summary,
      };

      writeFileSync(finalPath, JSON.stringify(summary, null, 2), "utf-8");

      appendLog(sessionDir, {
        ts: new Date().toISOString(),
        session: sessionId,
        agent: "orchestrator",
        event: "terminate",
        content: { status: params.status, finalPath },
      });

      const lines = [
        `Pipeline ${params.status} → ${finalPath}`,
      ];

      if (params.status === "max-iterations-reached" && params.summary.outstanding_issues?.length) {
        lines.push("\nOutstanding issues (needs human resolution):");
        for (const issue of params.summary.outstanding_issues) {
          lines.push(`  - ${issue}`);
        }
        lines.push("\nDeliverables completed so far:");
        for (const d of params.summary.deliverables) {
          lines.push(`  - ${d}`);
        }
      }

      return { llmContent: lines.join("\n") };
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-AGENT
// ─────────────────────────────────────────────────────────────────────────────

async function registerSubAgent(api: ExtensionAPI) {
  const sessionId = process.env.PI_PIPELINE_SESSION_ID!;
  const sessionDir = process.env.PI_PIPELINE_SESSION_DIR!;
  const agentName = process.env.PI_PIPELINE_AGENT!;
  const run = Number(process.env.PI_PIPELINE_RUN ?? "1");

  // Inject agent identity into system prompt
  api.on(
    "before_agent_start",
    async (event: BeforeAgentStartEvent): Promise<BeforeAgentStartEventResult> => ({
      systemPrompt: event.systemPrompt + [
        "",
        "## Pipeline Context",
        `SESSION_ID: ${sessionId}`,
        `SESSION_DIR: ${sessionDir}`,
        `ROLE: sub-agent`,
        `AGENT: ${agentName}`,
        `RUN: ${run}`,
        "",
        "You have access to: read_input, write_output, log_reasoning.",
        "Never read or write other agents' directories.",
        "Never use raw file I/O for context passing.",
      ].join("\n"),
    }),
  );

  // ── log_reasoning ──────────────────────────────────────────────────────────

  api.registerTool({
    name: "log_reasoning",
    label: "Log Reasoning",
    description: "Append a reasoning entry to the session JSONL log.",
    promptSnippet: "log_reasoning(event, content) — append to reasoning.jsonl",
    parameters: Type.Object({
      event: Type.String({ description: "Event type: start | complete | error" }),
      content: Type.Unknown({ description: "JSON content to log" }),
    }),
    execute: async (_id, params) => {
      appendLog(sessionDir, {
        ts: new Date().toISOString(),
        session: sessionId,
        agent: agentName,
        run,
        event: params.event,
        content: params.content,
      });
      return { llmContent: `Logged ${agentName}/${params.event}` };
    },
  });

  // ── read_input ─────────────────────────────────────────────────────────────

  api.registerTool({
    name: "read_input",
    label: "Read Input",
    description: "Read this agent's task.json from its input directory.",
    promptSnippet: "read_input() — returns task JSON",
    parameters: Type.Object({}),
    execute: async () => {
      const path = taskPath(sessionDir, agentName, run);

      if (!existsSync(path)) {
        return { llmContent: `Error: task not found at ${path}` };
      }

      return { llmContent: readFileSync(path, "utf-8") };
    },
  });

  // ── write_output ───────────────────────────────────────────────────────────

  api.registerTool({
    name: "write_output",
    label: "Write Output",
    description: "Write this agent's result to its output directory. Enforces token limits.",
    promptSnippet: "write_output(result) — writes result.json",
    parameters: Type.Object({
      result: Type.Unknown({ description: "Result object conforming to output schema" }),
    }),
    execute: async (_id, params) => {
      const path = outputPath(sessionDir, agentName, run);
      const limitChars = agentName === "senior-architect"
        ? TOKEN_LIMITS.architectResult
        : TOKEN_LIMITS.resultJson;

      const raw = JSON.stringify(
        { session_id: sessionId, agent: agentName, run, ...(params.result as object) },
        null,
        2,
      );
      const bounded = enforceLimit(raw, limitChars, `${agentName}/output`);

      writeFileSync(path, bounded, "utf-8");

      appendLog(sessionDir, {
        ts: new Date().toISOString(),
        session: sessionId,
        agent: agentName,
        run,
        event: "write_output",
        content: { path, chars: bounded.length },
      });

      return { llmContent: `Output written → ${path} (${bounded.length} chars)` };
    },
  });
}
