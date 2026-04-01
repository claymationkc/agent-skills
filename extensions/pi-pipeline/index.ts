/**
 * Pi Pipeline Extension
 *
 * Implements deterministic multi-agent orchestration on top of pi.
 *
 * Registered tools (callable by any agent via the model):
 *   - log_reasoning      — append a structured entry to reasoning.jsonl
 *   - read_input         — read this agent's task.json from its input directory
 *   - write_output       — write result.json to this agent's output directory
 *   - dispatch_agent     — spawn a specialist agent as a child pi process
 *   - terminate_pipeline — write final/summary.json and close the session
 *
 * Session directories live under ~/.pi-pipeline/sessions/<session-id>/
 * See ARCHITECTURE.md for the full directory layout and I/O schemas.
 */

import type { ExtensionAPI, BeforeAgentStartEvent, BeforeAgentStartEventResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { spawn } from "child_process";

// ── Constants ────────────────────────────────────────────────────────────────

const SESSIONS_BASE = join(homedir(), ".pi-pipeline", "sessions");
const SKILLS_DIR = join(homedir(), "pi-skills", "skills");

/** Context-passing token limits enforced in task/result JSON (chars ≈ tokens * 4) */
const LIMITS = {
  taskJson: 4096 * 4,       // 4,096 token input cap
  resultJson: 2048 * 4,     // 2,048 token output cap
  architectResult: 8192 * 4 // 8,192 token exception for architect
} as const;

// ── State ────────────────────────────────────────────────────────────────────

interface PipelineState {
  sessionId: string;
  sessionDir: string;
  /** Tracks run count per agent name for directory naming */
  runCounts: Map<string, number>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSessionId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `sess_${date}_${randomUUID().slice(0, 8)}`;
}

function appendLog(sessionDir: string, entry: object): void {
  const logPath = join(sessionDir, "reasoning.jsonl");
  appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

function agentInputPath(state: PipelineState, agent: string, run: number): string {
  if (agent === "orchestrator") {
    return join(state.sessionDir, "orchestrator", "input", "task.json");
  }
  return join(state.sessionDir, agent, `run-${run}`, "input", "task.json");
}

function agentOutputPath(state: PipelineState, agent: string, run: number): string {
  if (agent === "orchestrator") {
    return join(state.sessionDir, "orchestrator", "output", "plan.json");
  }
  return join(state.sessionDir, agent, `run-${run}`, "output", "result.json");
}

function enforceTokenLimit(json: string, limitChars: number, label: string): string {
  if (json.length <= limitChars) return json;
  const truncated = json.slice(0, limitChars);
  console.warn(`[pi-pipeline] ${label} exceeded limit (${json.length} > ${limitChars} chars) — truncated`);
  return truncated + "\n/* TRUNCATED: exceeded context token limit */";
}

// ── Extension Factory ─────────────────────────────────────────────────────────

export default async function (api: ExtensionAPI) {
  let state: PipelineState | null = null;

  // ── Session Start ──────────────────────────────────────────────────────────
  // Create session directory structure and reasoning log on new session.

  api.on("session_start", async () => {
    const sessionId = makeSessionId();
    const sessionDir = join(SESSIONS_BASE, sessionId);

    mkdirSync(join(sessionDir, "orchestrator", "input"), { recursive: true });
    mkdirSync(join(sessionDir, "orchestrator", "output"), { recursive: true });
    mkdirSync(join(sessionDir, "final"), { recursive: true });

    state = { sessionId, sessionDir, runCounts: new Map() };

    appendLog(sessionDir, {
      ts: new Date().toISOString(),
      session: sessionId,
      agent: "system",
      event: "session_start",
      content: { sessionsBase: SESSIONS_BASE },
    });

    api.appendEntry("pi-pipeline-session", {
      sessionId,
      sessionDir,
      message: `Pipeline session started → ${sessionDir}`,
    });
  });

  // ── Before Agent Start ─────────────────────────────────────────────────────
  // Inject session context into every agent's system prompt so they know
  // their session ID and where to find their input/output directories.

  api.on(
    "before_agent_start",
    async (event: BeforeAgentStartEvent): Promise<BeforeAgentStartEventResult> => {
      if (!state) return {};

      const injection = [
        "",
        "## Pipeline Context",
        `SESSION_ID: ${state.sessionId}`,
        `SESSION_DIR: ${state.sessionDir}`,
        `SKILLS_DIR: ${SKILLS_DIR}`,
        "",
        "Use the pipeline tools (read_input, write_output, log_reasoning, dispatch_agent,",
        "terminate_pipeline) for all inter-agent communication. Do not use raw file I/O",
        "for context passing.",
      ].join("\n");

      return {
        systemPrompt: event.systemPrompt + injection,
      };
    },
  );

  // ── Tool: log_reasoning ────────────────────────────────────────────────────

  api.registerTool({
    name: "log_reasoning",
    label: "Log Reasoning",
    description: "Append a structured reasoning entry to the session JSONL log.",
    promptSnippet: "log_reasoning(agent, event, content) → appends to reasoning.jsonl",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name (e.g. orchestrator, coding, reviewer)" }),
      event: Type.String({ description: "Event type (e.g. plan, dispatch, eval, complete, terminate)" }),
      content: Type.Unknown({ description: "Arbitrary JSON content to log" }),
    }),
    execute: async (_id, params) => {
      if (!state) return { llmContent: "Error: no active pipeline session" };

      const entry = {
        ts: new Date().toISOString(),
        session: state.sessionId,
        agent: params.agent,
        event: params.event,
        content: params.content,
      };

      appendLog(state.sessionDir, entry);
      return { llmContent: `Logged: ${params.agent}/${params.event}` };
    },
  });

  // ── Tool: read_input ───────────────────────────────────────────────────────

  api.registerTool({
    name: "read_input",
    label: "Read Input",
    description: "Read this agent's task.json from its input directory.",
    promptSnippet: "read_input(agent, run?) → returns task JSON",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name" }),
      run: Type.Optional(Type.Number({ description: "Run number (default: 1)" })),
    }),
    execute: async (_id, params) => {
      if (!state) return { llmContent: "Error: no active pipeline session" };

      const run = params.run ?? 1;
      const inputPath = agentInputPath(state, params.agent, run);

      if (!existsSync(inputPath)) {
        return { llmContent: `Error: input not found at ${inputPath}` };
      }

      const content = readFileSync(inputPath, "utf-8");
      return { llmContent: content };
    },
  });

  // ── Tool: write_output ─────────────────────────────────────────────────────

  api.registerTool({
    name: "write_output",
    label: "Write Output",
    description: "Write this agent's result.json to its output directory. Enforces token limits.",
    promptSnippet: "write_output(agent, run, result) → writes result.json",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name" }),
      run: Type.Optional(Type.Number({ description: "Run number (default: 1)" })),
      result: Type.Unknown({ description: "Result object to write (must conform to output schema)" }),
    }),
    execute: async (_id, params) => {
      if (!state) return { llmContent: "Error: no active pipeline session" };

      const run = params.run ?? 1;
      const outputPath = agentOutputPath(state, params.agent, run);
      const outputDir = join(outputPath, "..");

      mkdirSync(outputDir, { recursive: true });

      const limitChars = params.agent === "senior-architect"
        ? LIMITS.architectResult
        : LIMITS.resultJson;

      const raw = JSON.stringify(params.result, null, 2);
      const bounded = enforceTokenLimit(raw, limitChars, `${params.agent}/output`);

      writeFileSync(outputPath, bounded, "utf-8");
      return { llmContent: `Written to ${outputPath} (${bounded.length} chars)` };
    },
  });

  // ── Tool: dispatch_agent ───────────────────────────────────────────────────
  // Spawns a specialist agent as a child pi process in print mode.
  // The child process runs the named skill with its pipeline context injected.

  api.registerTool({
    name: "dispatch_agent",
    label: "Dispatch Agent",
    description: "Spawn a specialist agent as a child pi process to process its input task.",
    promptSnippet: "dispatch_agent(agent, skill) → runs specialist, returns exit status",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name (matches directory and skill name)" }),
      skill: Type.Optional(Type.String({ description: "Skill name if different from agent name" })),
    }),
    execute: async (_id, params, signal) => {
      if (!state) return { llmContent: "Error: no active pipeline session" };

      const skillName = params.skill ?? params.agent;
      const skillPath = join(SKILLS_DIR, skillName);
      const runCount = (state.runCounts.get(params.agent) ?? 0) + 1;
      state.runCounts.set(params.agent, runCount);

      // Create input/output directories for this run
      mkdirSync(join(state.sessionDir, params.agent, `run-${runCount}`, "input"), { recursive: true });
      mkdirSync(join(state.sessionDir, params.agent, `run-${runCount}`, "output"), { recursive: true });

      appendLog(state.sessionDir, {
        ts: new Date().toISOString(),
        session: state.sessionId,
        agent: "orchestrator",
        event: "dispatch",
        content: { to: params.agent, skill: skillName, run: runCount },
      });

      const prompt = [
        `You are the ${params.agent} agent.`,
        `Session: ${state.sessionId}`,
        `Run: ${runCount}`,
        `Call read_input("${params.agent}", ${runCount}) to get your task.`,
        `Call log_reasoning at the start and end of your work.`,
        `Call write_output("${params.agent}", ${runCount}, result) when done.`,
      ].join(" ");

      return new Promise((resolve) => {
        const args = ["--print", "--skill", skillPath, prompt];
        const proc = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"] });

        let stdout = "";
        let stderr = "";

        proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

        signal?.addEventListener("abort", () => proc.kill("SIGTERM"));

        proc.on("close", (code) => {
          appendLog(state!.sessionDir, {
            ts: new Date().toISOString(),
            session: state!.sessionId,
            agent: params.agent,
            event: "complete",
            run: runCount,
            content: { exit_code: code },
          });

          const tail = (s: string) => s.slice(-800).trim();
          resolve({
            llmContent: [
              `Agent ${params.agent} (run-${runCount}) exited with code ${code}.`,
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

  // ── Tool: terminate_pipeline ──────────────────────────────────────────────

  api.registerTool({
    name: "terminate_pipeline",
    label: "Terminate Pipeline",
    description: "Mark the pipeline as complete or max-iterations-reached and write final/summary.json.",
    promptSnippet: "terminate_pipeline(status, summary) → writes final summary",
    parameters: Type.Object({
      status: Type.Union([
        Type.Literal("complete"),
        Type.Literal("max-iterations-reached"),
      ], { description: "Outcome status" }),
      summary: Type.Object({
        goal: Type.String(),
        deliverables: Type.Array(Type.String(), { description: "Artifact paths produced" }),
        test_results: Type.Optional(Type.Object({
          passed: Type.Number(),
          failed: Type.Number(),
          total: Type.Number(),
        })),
        outstanding_issues: Type.Optional(
          Type.Array(Type.String(), {
            description: "Issues not resolved — required when status is max-iterations-reached",
          })
        ),
        notes: Type.Optional(Type.String()),
      }),
    }),
    execute: async (_id, params) => {
      if (!state) return { llmContent: "Error: no active pipeline session" };

      const finalPath = join(state.sessionDir, "final", "summary.json");
      const summary = {
        session_id: state.sessionId,
        status: params.status,
        terminated_at: new Date().toISOString(),
        iterations: Math.max(...Array.from(state.runCounts.values()), 0),
        agent_runs: Object.fromEntries(state.runCounts),
        ...params.summary,
      };

      writeFileSync(finalPath, JSON.stringify(summary, null, 2), "utf-8");

      appendLog(state.sessionDir, {
        ts: new Date().toISOString(),
        session: state.sessionId,
        agent: "orchestrator",
        event: "terminate",
        content: { status: params.status, summary_path: finalPath },
      });

      return {
        llmContent: [
          `Pipeline terminated: ${params.status}`,
          `Summary written to: ${finalPath}`,
          params.status === "max-iterations-reached" && params.summary.outstanding_issues?.length
            ? `\nOutstanding issues:\n${params.summary.outstanding_issues.map((i) => `  - ${i}`).join("\n")}`
            : "",
        ].filter(Boolean).join("\n"),
      };
    },
  });
}
