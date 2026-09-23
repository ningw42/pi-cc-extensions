import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { oneLine } from "../../utils/format.ts";

function clip(value: unknown): string {
	return oneLine(value, config.inputClip);
}

/**
 * 工具名/标签人性化：与 default-mode 的 humanizeToolLabel、grouping 的 humanizeToolName
 * 逐字相同，收敛为一个共享实现。
 */
export function humanizeToolLabel(label: string): string {
	return label
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Pool of known MCP server names, used to recover pi-mcp-adapter's default server prefixes.
 * ccstyle cannot read mcp.json: learn from successful gateway results and verified namespace
 * definitions encountered by ccstyle rendering, not from arbitrary MCP-looking call names.
 */
const mcpServerNames = new Set<string>();
let mcpServerNamesRevision = 0;

function rememberMcpServer(server: string): void {
	if (mcpServerNames.has(server)) return;
	mcpServerNames.add(server);
	mcpServerNamesRevision++;
}

/** Cache dependency for gateway titles; learning cannot change titles while the flag is off. */
export function mcpGatewayTitleRevision(): number {
	return config.enableMcpGatewayServerName ? mcpServerNamesRevision : -1;
}

/** pi-mcp-adapter getServerPrefix(server, "server"), the default prefix mode. */
function adapterServerPrefix(server: string): string {
	return Array.from(server, (char) =>
		/^[A-Za-z0-9_-]$/.test(char) ? char : `_${char.codePointAt(0)!.toString(16)}_`,
	).join("");
}

/** pi-mcp-adapter namespaceProxyName/formatServerNamespace (2.36.0); distinct from tool prefixes. */
function adapterNamespaceProxyName(server: string): string {
	const normalized = server.replace(/-/g, "_");
	const safe = /^[A-Za-z0-9_]*$/.test(normalized) && !normalized.startsWith("_mcpns_");
	const body = safe
		? normalized
		: Array.from(normalized, (char) =>
				char === "_"
					? "__"
					: /^[A-Za-z0-9]$/.test(char)
						? char
						: `_${char.codePointAt(0)!.toString(16)}_`,
			).join("");
	const namespace = safe ? body : `_mcpns_${body}`;
	// Provider tool names allow 64 characters; the mcp__ prefix consumes five.
	if (namespace.length <= 59) return `mcp__${namespace}`;
	const digest = createHash("sha256").update(namespace, "utf8").digest("hex").slice(0, 16);
	const hashPrefix = "_mcpns__h_";
	return `mcp__${hashPrefix}${body.slice(0, 59 - hashPrefix.length - digest.length - 1)}_${digest}`;
}

/** Normalise separators: config says brave-search, models often write brave_search. */
function normalizeServerToken(value: string): string {
	return value.toLowerCase().replace(/-/g, "_");
}

/** For session_start and tests: server names are learned per session; a new session starts empty. */
export function resetMcpServerNames(): void {
	mcpServerNames.clear();
	mcpServerNamesRevision++;
}

/** Require matching namespace name/label metadata, not just an MCP-looking call name. */
export function learnMountedMcpServer(definition: any, toolName: string): void {
	const label = typeof definition?.label === "string" ? definition.label : "";
	const server = label.match(/^MCP: (.+)$/)?.[1];
	if (server && toolName === adapterNamespaceProxyName(server)) rememberMcpServer(server);
}

/**
 * Learn `args.server` only after a gateway call succeeds: a server the model got wrong (e.g.
 * `{ server: "get", tool: "get_file_contents" }`) would otherwise enter the pool and revive the
 * "first token is the server" misparse. pi-mcp-adapter returns failures such as
 * server_not_found as normal results (isError is false) and only flags them on
 * `details.error`, so both must be checked.
 */
export function learnMcpServerFromResult(
	toolName: string,
	args: unknown,
	result: unknown,
	isError: boolean,
): void {
	if (toolName !== "mcp" || isError) return;
	if ((result as any)?.details?.error !== undefined) return;
	const server = (args as any)?.server;
	if (typeof server === "string" && server) rememberMcpServer(server);
}

/**
 * Pick the longest matching known server prefix. Returns undefined when nothing matches — no
 * "first token is the server" fallback, otherwise an unprefixed call like `get_file_contents`
 * would render as a nonexistent server "Get".
 */
function serverFromMcpToolName(toolName: string): string | undefined {
	const target = normalizeServerToken(toolName);
	let best: string | undefined;
	let bestLength = 0;
	for (const server of mcpServerNames) {
		const prefix = normalizeServerToken(adapterServerPrefix(server));
		if (target.startsWith(`${prefix}_`) && prefix.length > bestLength) {
			best = server;
			bestLength = prefix.length;
		}
	}
	return best;
}

/** `mcp` gateway: requested or inferred target server; always "MCP" when the flag is off. */
function mcpGatewayTitle(args: unknown): string {
	if (!config.enableMcpGatewayServerName || !args || typeof args !== "object") return "MCP";
	const source = args as Record<string, unknown>;
	const server = typeof source.server === "string" && source.server ? source.server : "";
	const tool = typeof source.tool === "string" ? source.tool : "";
	const resolved = tool ? server || serverFromMcpToolName(tool) : server;
	return resolved ? humanizeToolLabel(resolved) : "MCP";
}

export function isMcpToolDefinition(definition: any, toolName: string): boolean {
	const label = typeof definition?.label === "string" ? definition.label.trim() : "";
	// `\b` rather than `(?::|$)`: pi-mcp-adapter labels mcpScript "MCP Script".
	if (/^MCP\b/i.test(label)) return true;
	if (toolName === "mcp" || /^mcp[_:-]|[_:-]mcp[_:-]/i.test(toolName)) return true;
	if (label) return false;
	const description = typeof definition?.description === "string" ? definition.description : "";
	return /\bModel Context Protocol\b/i.test(description);
}

/** MCP tool title: prefer the extension-supplied label, otherwise derive it from the tool name. */
export function humanizeMcpToolName(toolName: string, label = ""): string {
	const trimmed = String(label).trim();
	// "MCP: github" -> Github (namespace proxy / direct tool)
	const scoped = trimmed.match(/^MCP\s*:\s*(.+)$/i);
	if (scoped?.[1]) return humanizeToolLabel(scoped[1]);
	// "MCP Script" -> keep the extension's casing as-is
	if (/^MCP\s+\S/i.test(trimmed)) return trimmed;
	const rest = toolName.replace(/^mcp(?:[_:-]+)+/i, "");
	if (!rest || /^mcp$/i.test(rest)) return "MCP";
	return humanizeToolLabel(rest);
}

/**
 * Title resolution shared by single tool cards and group cards: both paths must produce
 * identical text. Group cards previously used only humanizeToolLabel(toolName), which
 * rendered mcp__github as "Mcp Github".
 */
export function resolveToolTitle(definition: any, toolName: string, args?: unknown): string {
	learnMountedMcpServer(definition, toolName);
	if (toolName === "mcp") return mcpGatewayTitle(args);
	if (isMcpToolDefinition(definition, toolName))
		return humanizeMcpToolName(toolName, definition?.label);
	const label = definition?.label || toolName;
	return label === toolName ? humanizeToolLabel(label) : label;
}

const AGENT_FAMILY_TOOL_NAMES = new Set([
	"Agent",
	"Agents",
	"get_subagent_result",
	"steer_subagent",
]);

/** default-mode（单工具卡）与 grouping（分组卡）在 agent/bash/grep/find/read/fallback 文案上不同。 */
export type ToolCallSummaryVariant = "default" | "grouping";

export type ToolCallSummaryOptions = {
	/** 已解析标题；缺省为 humanizeToolLabel(toolName)。 */
	title?: string;
	/** 文案变体；缺省 "default"。 */
	variant?: ToolCallSummaryVariant;
	/** 工具执行目录；仅用于生成展示路径，不修改调用参数。 */
	cwd?: string;
};

export type ToolCallSummary = {
	main: string;
	detail: string;
	/** 路径摘要保留结构，供最终渲染按实际宽度优先保留文件名。 */
	path?: { prefix: string; value: string };
};

function pathApi(value: string) {
	if (win32.isAbsolute(value)) return win32;
	if (posix.isAbsolute(value)) return posix;
	return undefined;
}

/** cwd 内绝对路径转相对路径；cwd 外路径保持不变。 */
export function displayPath(value: unknown, cwd?: string): string {
	const text = oneLine(value, 4096);
	const base = cwd ? oneLine(cwd, 4096) : "";
	const api = pathApi(text);
	if (!api || !base || !api.isAbsolute(base)) return text;
	const relative = api.relative(base, text);
	if (!relative) return api.basename(text) || ".";
	if (relative === ".." || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) {
		return text;
	}
	return relative;
}

function headToWidth(text: string, width: number, ellipsis = ""): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 0) return "";
	const suffix = visibleWidth(ellipsis) <= width ? ellipsis : "";
	const contentWidth = width - visibleWidth(suffix);
	let head = "";
	for (const char of Array.from(text)) {
		if (visibleWidth(head + char) > contentWidth) break;
		head += char;
	}
	return head + suffix;
}

function tailToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	let tail = "";
	for (const char of Array.from(text).reverse()) {
		if (visibleWidth(char + tail) > width) break;
		tail = char + tail;
	}
	return tail;
}

/** 中间截断路径：目录保留开头，末尾优先完整保留文件名。 */
export function truncatePathToWidth(path: string, width: number): string {
	if (visibleWidth(path) <= width) return path;
	if (width <= 1) return width === 1 ? "…" : "";
	const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const filename = separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
	const filenameWidth = visibleWidth(filename);
	if (separatorIndex >= 0 && filenameWidth + 1 <= width) {
		const separator = path[separatorIndex]!;
		const suffix = `${separator}${filename}`;
		const prefixWidth = width - visibleWidth(suffix) - 1;
		const prefix = headToWidth(path.slice(0, separatorIndex), Math.max(0, prefixWidth));
		return `${prefix}…${prefix ? suffix : filename}`;
	}
	const leftWidth = Math.max(1, Math.floor((width - 1) * 0.45));
	const rightWidth = Math.max(0, width - leftWidth - 1);
	return `${headToWidth(filename, leftWidth)}…${tailToWidth(filename, rightWidth)}`;
}

/** 路径展示的统一入口：相对化后按配置和当前可用宽度截断。 */
export function formatDisplayPath(value: unknown, cwd: string | undefined, width: number): string {
	return truncatePathToWidth(displayPath(value, cwd), Math.min(width, config.inputClip));
}

/** 按最终终端宽度渲染摘要；路径摘要不会再被整行头部截断。 */
export function fitToolCallSummary(summary: ToolCallSummary, width: number): string {
	if (!summary.path) return headToWidth(summary.main, width, "…");
	const prefix = summary.path.prefix;
	const pathWidth = Math.max(0, width - visibleWidth(prefix) - 1);
	if (pathWidth <= 0) return headToWidth(prefix, width, "…");
	return `${prefix} ${truncatePathToWidth(summary.path.value, Math.min(pathWidth, config.inputClip))}`;
}

function pathSummary(
	prefix: string,
	value: unknown,
	cwd: string | undefined,
	detail = "",
): ToolCallSummary {
	const path = displayPath(value, cwd);
	return {
		main: `${prefix} ${truncatePathToWidth(path, config.inputClip)}`,
		detail,
		path: { prefix, value: path },
	};
}

/**
 * 单工具调用摘要（{ main, detail }）。
 *
 * default-mode 与 grouping 共用；opts.variant 保留两处各自逐字一致的输出，
 * 不改动任何现有渲染字符串。
 */
export function toolCallSummary(
	toolName: string,
	args: any,
	opts: ToolCallSummaryOptions = {},
): ToolCallSummary {
	const title = opts.title ?? humanizeToolLabel(toolName);
	const variant = opts.variant ?? "default";
	if (!args || typeof args !== "object") return { main: title, detail: "" };
	const name = toolName.toLowerCase();
	const value = (fallback: string, ...keys: string[]) => {
		const found = keys.map((key) => args[key]).find((item) => typeof item === "string" && item);
		return `${title} ${clip(found || fallback)}`;
	};

	if (variant === "default" && AGENT_FAMILY_TOOL_NAMES.has(toolName) && args.agent_id) {
		return { main: `${title} ${clip(args.agent_id)}`, detail: "" };
	}
	if (variant === "grouping" && (name === "agent" || name === "agents")) {
		const displayName = args.subagent_type ?? args.agent_type ?? args.agent;
		if (typeof displayName === "string" && displayName) {
			return { main: `${title} ${displayName}`, detail: "" };
		}
		return {
			main: value(name === "agent" ? "launch agent" : "launch agents", "description", "prompt"),
			detail: "",
		};
	}
	if (variant === "grouping" && (name === "get_subagent_result" || name === "steer_subagent")) {
		return {
			main: value(name === "get_subagent_result" ? "agent result" : "steer agent", "agent_id"),
			detail: "",
		};
	}
	if (variant === "default" && name === "agents") {
		return { main: value("launch agents", "description", "prompt"), detail: "" };
	}
	if (name === "skill") return { main: value("run skill", "name"), detail: "" };
	if (name === "enterplanmode" || name === "enter_plan_mode") {
		return { main: `${title} enable read-only planning`, detail: "" };
	}
	if (name === "exitplanmode" || name === "exit_plan_mode") {
		return { main: `${title} present plan`, detail: "" };
	}
	if (name === "taskcreate") return { main: value("create task", "subject"), detail: "" };
	if (name === "tasklist") return { main: `${title} task list`, detail: "" };
	if (name === "taskget" || name === "taskupdate") {
		return { main: value("task", "taskId", "task_id"), detail: "" };
	}
	if (name === "taskoutput" || name === "taskstop") {
		return { main: value("background task", "task_id", "taskId"), detail: "" };
	}
	if (name === "taskexecute") {
		const ids = Array.isArray(args.task_ids)
			? args.task_ids
			: Array.isArray(args.taskIds)
				? args.taskIds
				: [];
		const summary = ids.length
			? `${ids[0]}${ids.length > 1 ? ` (+${ids.length - 1} tasks)` : ""}`
			: "start tasks";
		return { main: `${title} ${summary}`, detail: "" };
	}
	if (toolName === "read") {
		const details = [
			args.offset !== undefined ? `offset=${args.offset}` : "",
			args.limit !== undefined ? `limit=${args.limit}` : "",
		].filter(Boolean);
		const detail = details.length ? ` (${details.join(", ")})` : "";
		if (typeof args.path === "string" && args.path) {
			return pathSummary(variant === "grouping" ? "Read" : title, args.path, opts.cwd, detail);
		}
		return {
			main: variant === "grouping" ? "Read ..." : title,
			detail,
		};
	}
	if (variant === "grouping") {
		if (toolName === "bash") return { main: `Bash ${clip(args.command || "...")}`, detail: "" };
		if (toolName === "grep") {
			const pattern = clip(args.pattern || "...");
			return {
				main: `Grep ${JSON.stringify(pattern)}${args.path ? ` in ${clip(args.path)}` : ""}`,
				detail: "",
			};
		}
		if (toolName === "find") {
			const pattern = clip(args.pattern || "...");
			return {
				main: `Find ${JSON.stringify(pattern)}${args.path ? ` in ${clip(args.path)}` : ""}`,
				detail: "",
			};
		}
	}
	if (variant === "default") {
		const preferredPath = args.path ?? args.file_path;
		if (typeof preferredPath === "string" && preferredPath) {
			return pathSummary(title, preferredPath, opts.cwd);
		}
		const preferred =
			args.command ??
			args.query ??
			args.question ??
			args.pattern ??
			args.url ??
			args.name ??
			args.tool_use_id ??
			args.toolCallId ??
			args.id ??
			args.message;
		return {
			main:
				preferred !== undefined && preferred !== null && typeof preferred !== "object"
					? `${title} ${clip(preferred)}`
					: title,
			detail: "",
		};
	}
	const preferred =
		args.agent_id ??
		args.path ??
		args.file_path ??
		args.url ??
		args.description ??
		args.query ??
		args.name ??
		args.prompt;
	return {
		main: `${title}${preferred === undefined ? "" : ` ${clip(preferred)}`}`,
		detail: "",
	};
}
