# pi-skills

This repository contains two things used by the pi coding agent:

1. A set of reusable **skills** in `skills/`
2. A **pipeline extension** in `extensions/pi-pipeline/` that runs those skills as deterministic sub-agents

See `ARCHITECTURE.md` for the full pipeline design and session layout.

## What is in this repo

### Skills

Each folder under `skills/` contains a `SKILL.md` file with the instructions for one agent role.
The `**Model**:` line in each skill is machine-read by the extension and passed as `--model` when
dispatching that agent — changing it in the markdown actually changes which model runs.

- `coding`
- `committer`
- `daily-skill`
- `data-engineer`
- `debugger`
- `documenter`
- `orchestrator`
- `professor`
- `prompt-optimizer`
- `refactor`
- `reviewer`
- `scouter`
- `senior-architect`
- `sql-analyzer`
- `test-data-generator`
- `testing`

### Extension

`extensions/pi-pipeline/index.ts` registers a pi extension that:

- creates a session under `~/.pi-pipeline/sessions/<session-id>/`
- writes each agent's `task.json` and `result.json`
- appends reasoning to `reasoning.jsonl`
- tracks token usage and cost per agent under `usage/`
- exposes a `/pipeline <task>` command for orchestrated runs

`extensions/pi-pipeline/package.json` declares the extension entry point (`index.ts`) for pi.

### Resources

`resources.json` declares named resource bundles (e.g. `datalake-core-schema`, `dbt-project`).
Paths in `resources.json` use `${VAR}` placeholders resolved from `~/.pi-pipeline/env`.

`~/.pi-pipeline/env` is machine-local and not committed to the repo. Create it on each machine:

```sh
# ~/.pi-pipeline/env
DATALAKE_DOCS=/absolute/path/to/datalake/docs
DBT_PROJECT_DIR=/absolute/path/to/dbt/project
```

Resources are only injected when explicitly requested via the `--context` flag — no auto-injection
based on agent type.

## Requirements

- pi coding agent installed and able to load extensions
- a working Node/TypeScript runtime for the extension environment
- the repository available at `~/pi-skills`
- `~/.pi-pipeline/env` created with your machine-local paths (only needed for domain-specific pipelines)

The extension resolves skills from `~/pi-skills/skills`. If the repo lives elsewhere, update `SKILLS_DIR`
in `extensions/pi-pipeline/index.ts`.

## Install / get dependencies

This repository does **not** include a root package manifest or lockfile. There is no repo-level install command.

To use the extension, make sure the pi environment can already resolve the packages imported by `extensions/pi-pipeline/index.ts`:

- `@mariozechner/pi-coding-agent`
- `@sinclair/typebox`

## Make this directory available to pi

1. Place or symlink the repo at `~/pi-skills`
2. Load the extension from `extensions/pi-pipeline/` in your pi setup
3. Start pi and run `/pipeline` for a task

## Usage

### General task — no domain context injected

```text
/pipeline Build a Python script that pulls FRED economic data and writes it to Parquet
```

### Domain-specific task — opt in to named resource bundles

```text
/pipeline --context datalake-core-schema,dbt-project Create the dbt models for the Retail Dashboard use case ~/AAA/datalake/docs/use_case_context.md
```

The `--context` flag names one or more resource bundles from `resources.json`. The extension resolves
them to real paths and injects them into the relevant sub-agent tasks. Without the flag, no domain
resources are loaded regardless of which agents run.

You can also pass file paths directly — any argument that looks like a path gets added to `context_refs`
on the orchestrator task and forwarded from there.

## Session files created by the extension

A pipeline run writes files under `~/.pi-pipeline/sessions/<session-id>/`.
The important ones are:

- `reasoning.jsonl` — append-only reasoning log for the full session
- `orchestrator/input/task.json` — initial task for the orchestrator
- `orchestrator/output/plan.json` — orchestrator plan
- `<agent>/run-<n>/input/task.json` — sub-agent task (4K token limit)
- `<agent>/run-<n>/output/result.json` — sub-agent output (2–16K token limit depending on agent)
- `usage/<agent>-run-<n>.json` — per-agent token usage and cost
- `usage/total.json` — session-wide totals
- `final/summary.json` — final pipeline summary

### Output token limits by agent

| Agent | Limit |
|---|---|
| `senior-architect` | 16K tokens |
| `coding`, `scouter`, `reviewer`, `data-engineer` | 4K tokens |
| all others | 2K tokens |

## Extending the repo

### Add a new skill

1. Create a folder under `skills/<name>/`
2. Add a `SKILL.md` file with `**Model**:`, `**Tools**:`, and instructions
3. Match the skill name to the agent name the orchestrator will dispatch to
4. If the agent produces large outputs, add it to `AGENT_RESULT_LIMITS` in `extensions/pi-pipeline/index.ts`

### Add or change pipeline behavior

1. Edit `extensions/pi-pipeline/index.ts`
2. Keep the file/task/output contract consistent with `ARCHITECTURE.md`
3. Sub-agents must use `read_input`, `log_reasoning`, and `write_output` — no raw file I/O

### Add a new resource bundle

1. Add an entry to `resources.json` using `${VAR}` placeholders for machine-local paths
2. Document the expected `VAR` in `~/.pi-pipeline/env`
3. Use `--context <bundle-name>` in the `/pipeline` command to activate it

## Reference

- `ARCHITECTURE.md` — pipeline design, file layout, and JSON contracts
- `resources.json` — named resource bundles for domain-specific context
- `skills/*/SKILL.md` — role-specific instructions and model declaration for each agent
