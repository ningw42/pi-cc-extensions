# MCP tool rendering

MCP support in Pi comes from the **`pi-mcp-adapter`** extension, not from Pi itself. It registers
several tools, and ccstyle has to title all of them consistently.

| tool              | registered by                  | adapter label       |
| ----------------- | ------------------------------ | ------------------- |
| `mcp`             | `index.ts` `registerProxyTool` | `MCP`               |
| `mcpScript`       | `index.ts` (`scriptMode`)      | `MCP Script`        |
| `mcp__<encoded server namespace>` | `namespace-tools.ts` | `MCP: <server>` |
| `<prefix>_<tool>` | `index.ts` `registerDirectTool`, when selected for direct registration | `MCP: <tool>` |

Direct selection can come from global `settings.directTools`, per-server `directTools` (including
lazy `"search"` selection), or the environment override. Direct names follow the configured prefix
mode; with `none`, the prefix is absent.

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
{ "enableMcpGatewayServerName": true }   // default; /ccstyle → MCP gateway server name
```

### Rules — `mcp` only

`mcpScript` and `mcp__*` are never affected by this flag.

| # | condition                       | title                                     |
| - | ------------------------------- | ----------------------------------------- |
| 1 | `args.tool` present             | humanised `args.server`, else the server recovered from the tool-name prefix |
| 2 | no `args.tool`, `args.server`   | humanised `args.server`                   |
| 3 | anything else                   | `MCP`                                     |

Rule 1's recovery recognises the adapter's **default `server` prefix mode** in `formatToolName`:
match the **longest known encoded server prefix**, comparing with `-` and `_` normalised (configured
`brave-search` vs model-written `brave_search`). Characters outside `[A-Za-z0-9_-]` are encoded as
`_<hex>_`: `team.github` becomes `team_2e_github`, for example.

ccstyle cannot read `mcp.json`, so it does not know configured `short`, `mcp`, or `none` prefix modes
or per-server overrides. It does not guess aliases for them. Unrecognised forms fall back to `MCP`;
a form that coincides with another known server's default prefix can resolve to that server.
Explicit `args.server` disambiguates the requested target.

Server names are learned during the session when ccstyle encounters a namespace-proxy definition
while resolving a standalone card or group row. Its tool name must match the adapter's encoded
namespace form of its `MCP: <server>` label; the label supplies the actual server name, including
for encoded or hashed namespaces. An unknown call name or a direct-tool label alone is not proof.
This does not scan registered tools, and excluded standalone renderers do not teach the pool.
Groups collect all child namespace evidence before resolving their headers and rows.

Name/label matching is not an adapter-provenance guarantee: a direct tool with an effective prefix
of exactly `mcp_` can have the same name and label as a namespace proxy. These fields cannot
distinguish that unusual configuration; use explicit `args.server` to avoid inference in that case.

`args.server` is learned only once that gateway call has **settled without error**. "Without error"
means both `isError` is false and the result carries no `details.error`: pi-mcp-adapter returns
`server_not_found`, `tool_not_found`, `auth_required` etc. as ordinary results tagged only by
`details.error`. A made-up server (`{ server: "get", tool: "get_file_contents" }`) still titles its own
call but is not learned when the adapter rejects it. This is an error-based eligibility rule, not
independent proof of server existence: an empty search scoped to an unknown server can succeed
without either error marker and is therefore learned.

When the flag is off, every gateway call renders `MCP`.

### Historical coverage (unverified)

The original feature notes reported the following counts over 1489 real `mcp` calls, before
learning was restricted to successful calls, describing 730 as an upper bound. No reproducible
corpus, extraction procedure, or replay results accompany these notes, so neither the observations
nor that bound have been independently verified. These are not current coverage guarantees:

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

The same unverified historical notes describe 5 unrecoverable calls using `get_file_contents`,
`brave_web_search`, or `brave-search`, reportedly unregistered in that environment and failing with
`Tool "..." not found`. The original call/result records are not supplied.

Independently of those observations, there is deliberately **no** "first token before `_`"
fallback: without a known matching prefix, `get_file_contents` must not invent a server `Get`.
Degrading to `MCP` is honest.

Server learning is per-session: the pool is cleared on every `session_start` (`/new`, `/resume`).
A gateway call that omits `server` before that server has been learned falls back to `MCP` and
self-corrects on the next re-render.

A group header uses the children's shared title even across different raw tool names (for example,
`mcp` and `mcp__github` both titled `Github`). A run of gateway calls to different servers (github
then exa) is headed `MCP` rather than the first child's server. Different tool names with different
titles retain `Multiple Tools`.

The flag lives under `/ccstyle` → Style and applies on the next render — no restart.
