# MCP tool rendering

MCP support in Pi comes from the **`pi-mcp-adapter`** extension, not from Pi itself. It registers
several tools, and ccstyle has to title all of them consistently.

| tool              | registered by                  | adapter label       |
| ----------------- | ------------------------------ | ------------------- |
| `mcp`             | `index.ts` `registerProxyTool` | `MCP`               |
| `mcpScript`       | `index.ts` (`scriptMode`)      | `MCP Script`        |
| `mcp__<server>`   | `namespace-tools.ts`           | `MCP: <server>`     |
| `<prefix>_<tool>` | `index.ts` `registerDirectTool`, only when `settings.directTools` is on | `MCP: <tool>` |

---

## Part 1 — Baseline improvements

Always on. No configuration.

### 1. One resolver for both render paths

`resolveToolTitle(definition, toolName, args)` in `renderer/tool/names.ts` is now the single source
of truth. Previously the single-tool card called `humanizeMcpToolName` while the group card only had
`humanizeToolLabel(toolName)`, so the same tool was titled differently depending on whether it
happened to land in a group.

### 2. Adapter labels are respected

`isMcpToolDefinition` matches `/^MCP\b/i` instead of `/^MCP(?::|$)/i`, so `MCP Script` is recognised.
`humanizeMcpToolName` now takes the label and prefers it:

- `MCP: <server>` → humanised server (`MCP: github` → `Github`)
- `MCP <rest>` → kept verbatim (`MCP Script`)
- bare `MCP` → derived from the tool name
- nothing usable → `MCP` (not `Mcp`)

### 3. Comparison

| tool                | adapter label       | isMcpDef | standalone (before) | group (before)      | both (after)   |
| ------------------- | ------------------- | -------- | ------------------- | ------------------- | -------------- |
| `mcp`               | `MCP`               | ✅ → ✅   | `Mcp`               | `Mcp`               | `MCP` ⁽¹⁾      |
| `mcpScript`         | `MCP Script`        | ❌ → ✅   | `MCP Script`        | `Mcp Script`        | `MCP Script`   |
| `mcp__github`       | `MCP: github`       | ✅ → ✅   | `Github`            | `Mcp Github`        | `Github`       |
| `mcp__exa`          | `MCP: exa`          | ✅ → ✅   | `Exa`               | `Mcp Exa`           | `Exa`          |
| `mcp__brave_search` | `MCP: brave-search` | ✅ → ✅   | `Brave Search`      | `Mcp Brave Search`  | `Brave Search` |
| `mcp__context7`     | `MCP: context7`     | ✅ → ✅   | `Context7`          | `Mcp Context7`      | `Context7`     |

⁽¹⁾ `mcp` can resolve further than `MCP` — see Part 2.

### 4. Renderer ownership is unchanged

All of these tools ship their own `renderCall`/`renderResult`, but `preservesOriginalRenderer` only
honours them when the tool name is in `excludeRenderers` (empty by default), so ccstyle still owns
the card. To hand rendering back to the adapter:

```json
{ "excludeRenderers": ["mcp", "mcpScript", "mcp__github", "mcp__exa", "mcp__brave_search"] }
```

---

## Part 2 — Optional: gateway server name

The `mcp` gateway is one tool that proxies every server, so its title is `MCP` for every call unless
the target is read out of the arguments. That inference is behind a flag.

```jsonc
// ~/.pi/agent/pi-cc-extensions.json
{ "enableMcpServerGuess": true }   // default; /ccstyle → MCP server guess
```

### Rules — `mcp` only

`mcpScript` and `mcp__*` are never affected by this flag.

| # | condition                       | title                                     |
| - | ------------------------------- | ----------------------------------------- |
| 1 | `args.tool` present             | humanised `args.server`, else the server recovered from the tool-name prefix |
| 2 | no `args.tool`, `args.server`   | humanised `args.server`                   |
| 3 | anything else                   | `MCP`                                     |

Rule 1's recovery inverts the adapter's `formatToolName`, which builds `${serverPrefix}_${tool}`:
match the **longest known server prefix**, comparing with `-` and `_` normalised (configured
`brave-search` vs model-written `brave_search`). Server names are learned during the session from
`mcp__<server>` mounts, and from `args.server` only once that gateway call has **settled without
error** — ccstyle cannot read `mcp.json`. "Without error" means both `isError` is false and the
result carries no `details.error`: pi-mcp-adapter returns `server_not_found`, `tool_not_found`,
`auth_required` etc. as ordinary results tagged only by `details.error`. A made-up server
(`{ server: "get", tool: "get_file_contents" }`) still titles its own call but is never learned;
otherwise it would reintroduce the first-token guess ruled out below.

When the flag is off, every gateway call renders `MCP`.

### Coverage

Measured over 1489 real `mcp` calls, before learning was restricted to successful calls (so the
730 is an upper bound):

```text
  267  rule 1 — args.server present
  730  rule 1 — server recovered from the tool name
  250  rule 2 — args.server, no tool
  237  rule 3 — neither
    5  rule 1 — tool present, server unrecoverable → "MCP"
```

```text
flag ON    Github 926 · Brave Search 191 · Exa 126 · Context7 3 · Nixos 1 · MCP 242
flag OFF   MCP 1489
```

### Failure mode

The 5 unrecoverable calls all used a tool name the adapter never registered
(`get_file_contents`, `brave_web_search`, `brave-search`) — every one of them failed with
`Tool "..." not found`. There is deliberately **no** "first token before `_`" fallback: it would
render `get_file_contents` as the server `Get`, which does not exist. Degrading to `MCP` is honest.

Server learning is per-session: the pool is cleared on every `session_start` (`/new`, `/resume`).
A gateway call that omits `server` before that server has been learned falls back to `MCP` and
self-corrects on the next re-render.

A group header uses the children's shared title; a run of gateway calls to different servers
(github then exa) is headed `MCP` rather than the first child's server.

The flag lives under `/ccstyle` → Style and applies on the next render — no restart.
