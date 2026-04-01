# Pi Pipeline Architecture

A deterministic agent orchestration pattern built on pi's extension system.
The routing and I/O contracts are deterministic. The reasoning inside each agent is probabilistic.

---

## Core Concepts

### The Problem This Solves

Vanilla LLM agents accumulate context as the conversation grows. By turn 10, the model is
reasoning over a huge, noisy window full of intermediate thoughts. Errors compound. The model
loses track of the original goal.

This pattern eliminates that by:
- Giving each agent a **fresh context window** with only what it needs
- Enforcing **structured I/O contracts** so agents can't pass garbage to each other
- Keeping a **hard token cap on context passing** (separate from the working budget)
- Letting the **orchestrator own termination** so the goal never drifts

### Two Token Budgets

Every agent invocation has two distinct token limits:

| Budget | Default | Purpose |
|--------|---------|---------|
| **Context budget** | 2,048–8,192 tokens | Input/output JSON passed between agents (varies by direction and role) |
| **Work budget** | 8,192–32,768 tokens | The agent's actual reasoning and output (varies by role) |

**Inputs can be richer than outputs.** The orchestrator composes task inputs carefully and completely.
Agents are forced to summarize their results — not dump their full working context.

The one exception is the architect: its output *is* the source of truth for all downstream agents.
Compressing a real system design causes information loss that compounds through every subsequent agent.
The architect output cap is set higher to preserve fidelity.

The context budget is hard. An agent that tries to pass a 10,000-token output to the next
agent gets truncated or blocked. This forces agents to summarize and compress — which is
exactly what you want when passing context forward.

---

## Directory Structure

Every pipeline run creates a session directory:

```
~/.pi-pipeline/
└── sessions/
    └── sess_20260401_abc123/
        ├── reasoning.jsonl          ← all agent reasoning logs (append-only)
        ├── orchestrator/
        │   ├── input/
        │   │   └── task.json        ← user's original prompt, structured
        │   └── output/
        │       └── plan.json        ← orchestrator's execution plan
        ├── architect/
        │   └── run-1/
        │       ├── input/
        │       │   └── task.json    ← what architect needs to do
        │       └── output/
        │           └── result.json  ← design decisions, schema, contracts
        ├── coding/
        │   ├── run-1/
        │   │   ├── input/
        │   │   │   └── task.json
        │   │   └── output/
        │   │       └── result.json
        │   └── run-2/               ← second call after review found issues
        │       ├── input/
        │       │   └── task.json
        │       └── output/
        │           └── result.json
        ├── testing/
        │   ├── run-1/
        │   └── run-2/
        ├── review/
        │   ├── run-1/
        │   └── run-2/
        └── final/
            └── summary.json         ← orchestrator's final output
```

Agents are **never** given a path to another agent's directory directly.
The orchestrator reads outputs and writes inputs. Agents only see their own `input/` directory.

---

## I/O Schemas

### input/task.json (2,048 token hard limit)

```json
{
  "session_id": "sess_20260401_abc123",
  "agent": "coding",
  "run": 1,
  "goal": "Build a REST endpoint that accepts a Stripe webhook and saves the payment event to Postgres",
  "task": "Implement the webhook handler based on the architect's design in context_refs[0]. Write the handler, database query, and any types needed.",
  "context_refs": [
    "~/.pi-pipeline/sessions/sess_20260401_abc123/architect/run-1/output/result.json"
  ],
  "constraints": [
    "Use TypeScript",
    "Use parameterized queries, no raw string interpolation",
    "No external ORM — raw pg driver only"
  ],
  "work_token_budget": 32768
}
```

### output/result.json (2,048 token hard limit)

```json
{
  "session_id": "sess_20260401_abc123",
  "agent": "coding",
  "run": 1,
  "status": "complete",
  "summary": "Implemented POST /webhooks/stripe handler. Verifies Stripe-Signature header, parses event, inserts into payment_events table using parameterized query. Handler is in src/routes/webhooks.ts. Types in src/types/stripe.ts.",
  "artifacts": [
    "src/routes/webhooks.ts",
    "src/types/stripe.ts"
  ],
  "issues": [],
  "token_usage": {
    "input": 1240,
    "output": 890
  }
}
```

### reasoning.jsonl

One JSON object per line, appended by every agent via the `log_reasoning` tool:

```jsonl
{"ts":"2026-04-01T10:00:00Z","session":"sess_20260401_abc123","agent":"orchestrator","event":"start","content":{"goal":"Build a REST endpoint that accepts a Stripe webhook..."}}
{"ts":"2026-04-01T10:00:01Z","session":"sess_20260401_abc123","agent":"orchestrator","event":"plan","content":{"steps":["architect","coding","testing","review"],"reasoning":"Need design before code. Testing requires code. Review is final gate."}}
{"ts":"2026-04-01T10:00:02Z","session":"sess_20260401_abc123","agent":"orchestrator","event":"dispatch","content":{"to":"architect","run":1}}
{"ts":"2026-04-01T10:00:15Z","session":"sess_20260401_abc123","agent":"architect","event":"start","run":1}
{"ts":"2026-04-01T10:00:28Z","session":"sess_20260401_abc123","agent":"architect","event":"complete","run":1,"content":{"status":"complete","summary":"Designed schema and API contract"}}
{"ts":"2026-04-01T10:00:29Z","session":"sess_20260401_abc123","agent":"orchestrator","event":"eval","content":{"after":"architect","goal_achieved":false,"next":"coding","reason":"Architecture complete, proceed to implementation"}}
```

---

## Worked Example

**User prompt:**
> "Build a REST endpoint that accepts a webhook from Stripe and saves the payment event to a Postgres database"

**Session ID:** `sess_20260401_abc123`

---

### Step 1 — Orchestrator reads the prompt

The extension intercepts the user message and writes:

**`orchestrator/input/task.json`**
```json
{
  "session_id": "sess_20260401_abc123",
  "agent": "orchestrator",
  "run": 1,
  "goal": "Build a REST endpoint that accepts a Stripe webhook and saves the payment event to Postgres",
  "task": "Plan the execution pipeline. Break this into subtasks and assign each to the right specialist agent.",
  "context_refs": [],
  "constraints": [],
  "work_token_budget": 8192
}
```

The orchestrator skill runs. It reasons about what agents are needed and in what order.
It calls `log_reasoning` and then `write_output`.

**`orchestrator/output/plan.json`**
```json
{
  "session_id": "sess_20260401_abc123",
  "agent": "orchestrator",
  "run": 1,
  "status": "complete",
  "plan": [
    { "step": 1, "agent": "architect",  "reason": "Need schema design and API contract before writing code" },
    { "step": 2, "agent": "coding",     "reason": "Implement based on architect's output" },
    { "step": 3, "agent": "testing",    "reason": "Verify implementation is correct" },
    { "step": 4, "agent": "review",     "reason": "Final quality and security gate" }
  ],
  "goal_achieved": false
}
```

**`reasoning.jsonl`** (first two entries)
```jsonl
{"ts":"2026-04-01T10:00:00Z","session":"sess_20260401_abc123","agent":"orchestrator","event":"start","content":{"goal":"Build a REST endpoint..."}}
{"ts":"2026-04-01T10:00:02Z","session":"sess_20260401_abc123","agent":"orchestrator","event":"plan","content":{"steps":["architect","coding","testing","review"],"reasoning":"Schema and API contract must be designed before implementation begins. Testing requires working code. Review is the termination gate."}}
```

---

### Step 2 — Architect runs (run-1)

Orchestrator writes:

**`architect/run-1/input/task.json`**
```json
{
  "session_id": "sess_20260401_abc123",
  "agent": "architect",
  "run": 1,
  "goal": "Build a REST endpoint that accepts a Stripe webhook and saves the payment event to Postgres",
  "task": "Design the Postgres schema for storing Stripe webhook events. Define the API contract for the endpoint (method, path, headers, request/response). Specify error handling behavior. Keep it simple — one table, one endpoint.",
  "context_refs": [],
  "constraints": [
    "Idempotent — duplicate webhook deliveries must not create duplicate rows",
    "Must verify Stripe-Signature header before processing",
    "TypeScript + Node.js stack"
  ],
  "work_token_budget": 16384
}
```

The architect skill runs with a fresh context window. It only sees its `task.json`.
It designs the system, then calls `write_output`.

**`architect/run-1/output/result.json`**
```json
{
  "session_id": "sess_20260401_abc123",
  "agent": "architect",
  "run": 1,
  "status": "complete",
  "summary": "Designed payment_events table with stripe_event_id as unique key for idempotency. POST /webhooks/stripe endpoint verifies Stripe-Signature, rejects unknown event types, inserts on conflict do nothing.",
  "artifacts": [],
  "design": {
    "schema": "CREATE TABLE payment_events (id SERIAL PRIMARY KEY, stripe_event_id TEXT UNIQUE NOT NULL, type TEXT NOT NULL, payload JSONB NOT NULL, received_at TIMESTAMPTZ DEFAULT NOW());",
    "endpoint": "POST /webhooks/stripe",
    "headers_required": ["stripe-signature"],
    "success_response": "HTTP 200 {}",
    "error_responses": ["HTTP 400 invalid signature", "HTTP 422 unhandled event type"]
  },
  "issues": [],
  "token_usage": { "input": 380, "output": 610 }
}
```

**`reasoning.jsonl`** (new entries)
```jsonl
{"ts":"2026-04-01T10:00:15Z","session":"sess_20260401_abc123","agent":"architect","event":"start","run":1}
{"ts":"2026-04-01T10:00:28Z","session":"sess_20260401_abc123","agent":"architect","event":"complete","run":1,"content":{"status":"complete","key_decisions":["stripe_event_id UNIQUE for idempotency","JSONB payload for flexibility","INSERT ON CONFLICT DO NOTHING pattern"]}}
{"ts":"2026-04-01T10:00:29Z","session":"sess_20260401_abc123","agent":"orchestrator","event":"eval","content":{"after":"architect","run":1,"goal_achieved":false,"next":"coding","reason":"Architecture looks solid. No blockers."}}
```

---

### Step 3 — Coding runs (run-1)

Orchestrator reads `architect/run-1/output/result.json` and writes:

**`coding/run-1/input/task.json`**
```json
{
  "session_id": "sess_20260401_abc123",
  "agent": "coding",
  "run": 1,
  "goal": "Build a REST endpoint that accepts a Stripe webhook and saves the payment event to Postgres",
  "task": "Implement the webhook handler using the design in context_refs[0]. Write the route handler, Stripe signature verification, and database insert. Create the migration file for the schema.",
  "context_refs": [
    "~/.pi-pipeline/sessions/sess_20260401_abc123/architect/run-1/output/result.json"
  ],
  "constraints": [
    "TypeScript, strict mode",
    "Raw pg driver — no ORM",
    "Parameterized queries only",
    "No hardcoded secrets — read from process.env"
  ],
  "work_token_budget": 32768
}
```

Coding agent runs, reads its task and the architect's output, implements the files.

**`coding/run-1/output/result.json`**
```json
{
  "session_id": "sess_20260401_abc123",
  "agent": "coding",
  "run": 1,
  "status": "complete",
  "summary": "Implemented POST /webhooks/stripe. Verifies Stripe-Signature using stripe library. Inserts event into payment_events with ON CONFLICT DO NOTHING. Migration file included. Skipped idempotency key check on the header — relied solely on DB unique constraint.",
  "artifacts": [
    "src/routes/webhooks.ts",
    "src/types/stripe.ts",
    "migrations/001_payment_events.sql"
  ],
  "issues": [],
  "token_usage": { "input": 920, "output": 1100 }
}
```

---

### Step 4 — Testing runs (run-1)

Orchestrator writes:

**`testing/run-1/input/task.json`**
```json
{
  "session_id": "sess_20260401_abc123",
  "agent": "testing",
  "run": 1,
  "goal": "Build a REST endpoint that accepts a Stripe webhook and saves the payment event to Postgres",
  "task": "Write and run tests for the webhook handler. Cover: valid payload inserts correctly, duplicate event is rejected gracefully, invalid signature returns 400, missing signature returns 400.",
  "context_refs": [
    "~/.pi-pipeline/sessions/sess_20260401_abc123/coding/run-1/output/result.json"
  ],
  "constraints": [
    "Use the project's existing test runner",
    "Tests must actually run — do not just write them",
    "Report pass/fail counts in output"
  ],
  "work_token_budget": 32768
}
```

**`testing/run-1/output/result.json`**
```json
{
  "session_id": "sess_20260401_abc123",
  "agent": "testing",
  "run": 1,
  "status": "complete",
  "summary": "4 tests written. 3 passed, 1 failed. Duplicate event test failed — ON CONFLICT DO NOTHING returns 200 but no indication to caller whether event was new or duplicate.",
  "artifacts": [
    "src/routes/webhooks.test.ts"
  ],
  "issues": [
    "Duplicate event handling returns 200 with empty body — test expected a distinguishable response but spec says 200 either way. Flagging for review to decide if this is acceptable."
  ],
  "test_results": { "passed": 3, "failed": 1, "total": 4 },
  "token_usage": { "input": 780, "output": 660 }
}
```

---

### Step 5 — Review runs (run-1)

Orchestrator writes:

**`review/run-1/input/task.json`**
```json
{
  "session_id": "sess_20260401_abc123",
  "agent": "review",
  "run": 1,
  "goal": "Build a REST endpoint that accepts a Stripe webhook and saves the payment event to Postgres",
  "task": "Review the implementation and test results. Identify any correctness issues, security gaps, or deviations from the architect's design. Be specific — list exact file and line references where possible.",
  "context_refs": [
    "~/.pi-pipeline/sessions/sess_20260401_abc123/architect/run-1/output/result.json",
    "~/.pi-pipeline/sessions/sess_20260401_abc123/coding/run-1/output/result.json",
    "~/.pi-pipeline/sessions/sess_20260401_abc123/testing/run-1/output/result.json"
  ],
  "constraints": [
    "Only flag real issues — not style preferences",
    "Security issues are blockers",
    "Must explicitly state approved or needs-fixes"
  ],
  "work_token_budget": 16384
}
```

**`review/run-1/output/result.json`**
```json
{
  "session_id": "sess_20260401_abc123",
  "agent": "review",
  "run": 1,
  "status": "needs-fixes",
  "verdict": "needs-fixes",
  "summary": "Two issues found. One blocker (security), one minor.",
  "issues": [
    {
      "severity": "blocker",
      "file": "src/routes/webhooks.ts",
      "description": "Stripe-Signature verification uses a hardcoded tolerance of 300s. The stripe library's constructEvent uses 300s by default but the code is not passing the tolerance explicitly, making it unclear and fragile if the default ever changes. Pass tolerance explicitly: stripe.webhooks.constructEvent(payload, sig, secret, 300).",
      "required_fix": true
    },
    {
      "severity": "minor",
      "file": "src/routes/webhooks.ts",
      "description": "Unhandled event types silently return 200. Architect spec says HTTP 422. Fix the fallthrough case.",
      "required_fix": true
    }
  ],
  "approved": false,
  "token_usage": { "input": 1340, "output": 720 }
}
```

**`reasoning.jsonl`** (new entries)
```jsonl
{"ts":"2026-04-01T10:01:45Z","session":"sess_20260401_abc123","agent":"review","event":"complete","run":1,"content":{"verdict":"needs-fixes","blockers":1,"minor":1}}
{"ts":"2026-04-01T10:01:46Z","session":"sess_20260401_abc123","agent":"orchestrator","event":"eval","content":{"after":"review","run":1,"goal_achieved":false,"next":"coding","run_number":2,"reason":"Review found 2 required fixes. Routing back to coding with specific issues."}}
```

---

### Step 6 — Coding runs again (run-2)

Orchestrator reads `review/run-1/output/result.json` and writes a targeted fix task:

**`coding/run-2/input/task.json`**
```json
{
  "session_id": "sess_20260401_abc123",
  "agent": "coding",
  "run": 2,
  "goal": "Build a REST endpoint that accepts a Stripe webhook and saves the payment event to Postgres",
  "task": "Fix the two issues identified in code review. Do not rewrite anything else.",
  "context_refs": [
    "~/.pi-pipeline/sessions/sess_20260401_abc123/review/run-1/output/result.json"
  ],
  "constraints": [
    "Only fix the listed issues — no other changes",
    "Confirm each fix in your output summary"
  ],
  "work_token_budget": 8192
}
```

**`coding/run-2/output/result.json`**
```json
{
  "session_id": "sess_20260401_abc123",
  "agent": "coding",
  "run": 2,
  "status": "complete",
  "summary": "Fixed both issues. (1) Added explicit tolerance=300 to constructEvent call. (2) Added 422 response for unhandled event types in the fallthrough case.",
  "artifacts": [
    "src/routes/webhooks.ts"
  ],
  "issues": [],
  "token_usage": { "input": 680, "output": 310 }
}
```

---

### Step 7 — Testing runs again (run-2)

Same pattern. Testing re-runs with the updated code in context.

**`testing/run-2/output/result.json`**
```json
{
  "session_id": "sess_20260401_abc123",
  "agent": "testing",
  "run": 2,
  "status": "complete",
  "summary": "All 4 tests pass. Added one test for the 422 unhandled event type case — also passes.",
  "artifacts": ["src/routes/webhooks.test.ts"],
  "issues": [],
  "test_results": { "passed": 5, "failed": 0, "total": 5 },
  "token_usage": { "input": 740, "output": 420 }
}
```

---

### Step 8 — Review runs again (run-2)

Orchestrator writes review task with the fix outputs in context.

**`review/run-2/output/result.json`**
```json
{
  "session_id": "sess_20260401_abc123",
  "agent": "review",
  "run": 2,
  "status": "complete",
  "verdict": "approved",
  "summary": "Both issues from run-1 are resolved. All tests pass. Implementation matches architect's design. No remaining blockers.",
  "issues": [],
  "approved": true,
  "token_usage": { "input": 1180, "output": 290 }
}
```

**`reasoning.jsonl`** (termination entries)
```jsonl
{"ts":"2026-04-01T10:03:12Z","session":"sess_20260401_abc123","agent":"review","event":"complete","run":2,"content":{"verdict":"approved"}}
{"ts":"2026-04-01T10:03:13Z","session":"sess_20260401_abc123","agent":"orchestrator","event":"eval","content":{"after":"review","run":2,"goal_achieved":true,"reason":"Reviewer approved. All tests pass. Goal met."}}
{"ts":"2026-04-01T10:03:13Z","session":"sess_20260401_abc123","agent":"orchestrator","event":"terminate","content":{"goal_achieved":true,"total_agent_runs":8,"iterations":2}}
```

---

### Step 9 — Orchestrator terminates and outputs summary

**`final/summary.json`**
```json
{
  "session_id": "sess_20260401_abc123",
  "goal": "Build a REST endpoint that accepts a Stripe webhook and saves the payment event to Postgres",
  "status": "complete",
  "iterations": 2,
  "agent_runs": [
    { "agent": "architect", "runs": 1 },
    { "agent": "coding",    "runs": 2 },
    { "agent": "testing",   "runs": 2 },
    { "agent": "review",    "runs": 2 }
  ],
  "deliverables": [
    "src/routes/webhooks.ts",
    "src/types/stripe.ts",
    "src/routes/webhooks.test.ts",
    "migrations/001_payment_events.sql"
  ],
  "test_results": { "passed": 5, "failed": 0, "total": 5 },
  "issues_found_and_fixed": [
    "Explicit Stripe signature tolerance now set to 300s",
    "Unhandled webhook event types now return HTTP 422"
  ]
}
```

The pi session ends. The user sees the summary in the terminal.

---

## Termination Logic

The orchestrator uses this decision tree after every review:

```
review output received
  ├── verdict == "approved" AND test_results.failed == 0
  │     → terminate_pipeline(), write final/summary.json
  │
  ├── verdict == "needs-fixes" AND iteration < MAX_ITERATIONS (default: 3)
  │     → write targeted coding task with ONLY the flagged issues
  │     → re-run: coding → testing → review
  │
  └── iteration >= MAX_ITERATIONS
        → terminate with status "max-iterations-reached"
        → surface issues to user for manual resolution
```

The orchestrator **never** passes the full previous output as context to the fix run —
only the list of specific issues from the review. This keeps the coding agent's context
clean and focused on the delta.

---

## Extension vs. Standalone

This pattern is documented for two implementations:

| | **Pi Extension** | **Standalone Node.js** |
|---|---|---|
| Auth | Pi handles (OAuth, API keys) | You manage credentials |
| Session management | Pi's session system + our directories | Your own process management |
| Tool calls | `registerTool()` in extension API | Direct function calls in orchestrator script |
| Best for | Interactive use, exploring, building | Production deployment, embedding in apps |
| Doc | See `docs/pi-extension.md` | See `docs/standalone.md` |

---

## Adding a New Agent

1. Create `~/pi-skills/<agent-name>/SKILL.md` with the agent's behavior
2. The orchestrator's skill already references agents by name — update its list
3. No directory configuration needed — the extension creates session directories dynamically

## Token Limit Reference

### Context passing (I/O between agents)

Inputs and outputs have **asymmetric limits** by design. Task inputs need to be complete and
unambiguous. Result outputs must be compressed summaries — agents cannot pass their full working
context forward.

| File | Limit | Rationale |
|------|-------|-----------|
| `input/task.json` (all agents) | 4,096 tokens | Task definitions must be complete and unambiguous |
| `output/result.json` (all agents) | 2,048 tokens | Forces summarization — compress, don't dump |
| `architect/*/output/result.json` | 8,192 tokens | Exception: design artifacts are the source of truth for all downstream agents. Compression causes compounding information loss. |

### Work budgets (per agent role)

| Agent | Work budget | Rationale |
|-------|-------------|-----------|
| Orchestrator | 8,192 tokens | Planning only — no implementation |
| Architect | 16,384 tokens | Design needs room to reason about trade-offs |
| Coding | 32,768 tokens | Full implementations require space |
| Testing | 32,768 tokens | Writing tests + capturing run output |
| Review | 16,384 tokens | Reading and analysis, not generation |
