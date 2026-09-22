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
 * 已知 MCP server 名池。pi-mcp-adapter 的 formatToolName 把 server 前缀拼进 tool 名
 * （`${server}_${tool}`），这里做它的逆运算。ccstyle 读不到 mcp.json，因此改为在渲染
 * 过程中从 `args.server` 和 `mcp__<server>` 工具名里学习。
 */
const mcpServerNames = new Set<string>();

/** 分隔符归一：配置里写 brave-search，模型常写成 brave_search。 */
function normalizeServerToken(value: string): string {
	return value.toLowerCase().replace(/-/g, "_");
}

/** 测试与 /reload 用：清空已学习的 server 名。 */
export function resetMcpServerNames(): void {
	mcpServerNames.clear();
}

/** 从一次调用里学习 server 名，供后续缺少 server 参数的网关调用反查。 */
function learnMcpServerNames(toolName: string, args: unknown): void {
	const proxied = toolName.match(/^mcp[_:-]+(.+)$/i);
	if (proxied?.[1]) mcpServerNames.add(proxied[1]);
	const server = (args as any)?.server;
	if (typeof server === "string" && server) mcpServerNames.add(server);
}

/**
 * 取匹配最长的已知 server 前缀。没有匹配时返回 undefined —— 不退回“首段即 server”，
 * 否则 `get_file_contents` 这类无前缀调用会被渲染成并不存在的 server "Get"。
 */
function serverFromMcpToolName(toolName: string): string | undefined {
	const target = normalizeServerToken(toolName);
	let best: string | undefined;
	for (const server of mcpServerNames) {
		const prefix = normalizeServerToken(server);
		if (target.startsWith(`${prefix}_`) && (!best || server.length > best.length)) best = server;
	}
	return best;
}

/** `mcp` 网关：标题取实际执行目标的 server 名；config.enableMcpServerGuess 关闭时恒为 "MCP"。 */
function mcpGatewayTitle(args: unknown): string {
	if (!config.enableMcpServerGuess || !args || typeof args !== "object") return "MCP";
	const source = args as Record<string, unknown>;
	const server = typeof source.server === "string" && source.server ? source.server : "";
	const tool = typeof source.tool === "string" ? source.tool : "";
	const resolved = tool ? server || serverFromMcpToolName(tool) : server;
	return resolved ? humanizeToolLabel(resolved) : "MCP";
}

export function isMcpToolDefinition(definition: any, toolName: string): boolean {
	const label = typeof definition?.label === "string" ? definition.label.trim() : "";
	// `\b` 而非 `(?::|$)`：pi-mcp-adapter 的 mcpScript 标签是 "MCP Script"。
	if (/^MCP\b/i.test(label)) return true;
	if (toolName === "mcp" || /^mcp[_:-]|[_:-]mcp[_:-]/i.test(toolName)) return true;
	if (label) return false;
	const description = typeof definition?.description === "string" ? definition.description : "";
	return /\bModel Context Protocol\b/i.test(description);
}

/** MCP 工具标题：优先用扩展自带的 label，其次从工具名推导。 */
export function humanizeMcpToolName(toolName: string, label = ""): string {
	const trimmed = String(label).trim();
	// "MCP: github" -> Github（namespace proxy / direct tool）
	const scoped = trimmed.match(/^MCP\s*:\s*(.+)$/i);
	if (scoped?.[1]) return humanizeToolLabel(scoped[1]);
	// "MCP Script" -> 原样保留扩展提供的大小写
	if (/^MCP\s+\S/i.test(trimmed)) return trimmed;
	const rest = toolName.replace(/^mcp(?:[_:-]+)+/i, "");
	if (!rest || /^mcp$/i.test(rest)) return "MCP";
	return humanizeToolLabel(rest);
}

/**
 * 单工具卡与分组卡共用的标题解析：两条路径必须得到逐字相同的结果。
 * 分组卡此前只有 humanizeToolLabel(toolName)，会把 mcp__github 渲染成 "Mcp Github"。
 */
export function resolveToolTitle(definition: any, toolName: string, args?: unknown): string {
	learnMcpServerNames(toolName, args);
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
