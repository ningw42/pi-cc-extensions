import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { config } from "../extensions/config/config.ts";
import { installDefaultMode } from "../extensions/renderer/default-mode.ts";
import claudeCodeStyleExtension from "../extensions/renderer/index.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/index.ts";
import { installToolGrouping, ToolGroupComponent } from "../extensions/renderer/tool/grouping.ts";
import {
	learnMcpServerFromResult,
	resetMcpServerNames,
	resolveToolTitle,
} from "../extensions/renderer/tool/names.ts";
import { stripAnsi } from "../extensions/utils/ansi-text.ts";

initTheme("dark");
const ui = { requestRender() {} } as any;
const gateway = { name: "mcp", label: "MCP" };
let defaultMode: ReturnType<typeof installDefaultMode>;
let grouping: ReturnType<typeof installToolGrouping>;
let previous: Pick<typeof config, "mode" | "excludeRenderers" | "enableMcpGatewayServerName">;

beforeEach(() => {
	previous = {
		mode: config.mode,
		excludeRenderers: config.excludeRenderers,
		enableMcpGatewayServerName: config.enableMcpGatewayServerName,
	};
	Object.assign(config, { mode: "on", excludeRenderers: [], enableMcpGatewayServerName: true });
	resetMcpServerNames();
	defaultMode = installDefaultMode(new WriteExecutionMetadataStore());
	grouping = installToolGrouping(() => true);
});

afterEach(() => {
	grouping.shutdown();
	defaultMode.shutdown();
	Object.assign(config, previous);
	resetMcpServerNames();
});

function tool(name: string, args: any = {}, label = name) {
	const definition = {
		name,
		label,
		renderCall: () => new Text("native call"),
		renderResult: () => new Text("native result"),
	} as any;
	const component = new ToolExecutionComponent(name, name, args, {}, definition, ui, process.cwd());
	component.updateResult({ content: [], isError: false });
	return component;
}

function group(...tools: ToolExecutionComponent[]): ToolGroupComponent {
	const parent = new Container();
	for (const child of tools) parent.addChild(child);
	assert.ok(parent.children[0] instanceof ToolGroupComponent);
	return parent.children[0];
}

function plain(component: { render(width: number): string[] }): string {
	return component.render(160).map(stripAnsi).join("\n");
}

test("settled gateway cards refresh after learning and toggling, then reuse their paint", () => {
	const card = tool("mcp", { tool: "github_search_code" }, "MCP");
	const ordinary = tool("custom", {}, "Custom");
	const ordinaryPaint = ordinary.render(160);
	const namespace = tool("mcp__exa", {}, "MCP: exa");
	const namespacePaint = namespace.render(160);
	const first = card.render(160);
	assert.match(first.map(stripAnsi).join("\n"), /✓ MCP/);
	assert.strictEqual(card.render(160), first);

	tool("mcp", { server: "github" }, "MCP");
	assert.match(plain(card), /✓ Github/);
	const learned = card.render(160);
	assert.notStrictEqual(learned, first);
	assert.strictEqual(card.render(160), learned);
	assert.strictEqual(ordinary.render(160), ordinaryPaint, "non-gateway paints are unaffected");
	assert.strictEqual(namespace.render(160), namespacePaint, "namespace paints are unaffected");

	learnMcpServerFromResult("mcp", { server: "github" }, { content: [] }, false);
	learnMcpServerFromResult("mcp", { server: "get" }, { details: { error: "not_found" } }, false);
	assert.strictEqual(card.render(160), learned, "duplicate and rejected evidence keep the cache");
	config.enableMcpGatewayServerName = false;
	assert.match(plain(card), /✓ MCP/);
	const disabled = card.render(160);
	learnMcpServerFromResult("mcp", { server: "context7" }, { content: [] }, false);
	assert.strictEqual(card.render(160), disabled, "learning while disabled does not repaint");
	config.enableMcpGatewayServerName = true;
	assert.match(plain(card), /✓ Github/);
	resetMcpServerNames();
	assert.match(plain(card), /✓ MCP/);
});

for (const expanded of [false, true]) {
	test(`gateway groups refresh titles with expanded=${expanded} and retain settled caching`, () => {
		const card = group(
			tool("mcp", { tool: "github_search_code" }, "MCP"),
			tool("mcp", { tool: "github_get_me" }, "MCP"),
		);
		card.setExpanded(expanded);
		assert.match(plain(card), /● MCP: 2 done/);
		tool("mcp", { server: "github" }, "MCP");
		assert.match(plain(card), /● Github: 2 done/);
		assert.equal(plain(card).match(/✓ Github/g)?.length, 2);
		const learned = card.render(160);
		assert.strictEqual(card.render(160), learned);
		config.enableMcpGatewayServerName = false;
		assert.match(plain(card), /● MCP: 2 done/);
		assert.equal(plain(card).match(/✓ MCP/g)?.length, 2);
		config.enableMcpGatewayServerName = true;
		assert.match(plain(card), /● Github: 2 done/);
		const enabled = card.render(160);
		for (let i = 0; i < 5; i++) assert.strictEqual(card.render(160), enabled);
	});
}

test("mixed tool names share a header only when their resolved titles agree", () => {
	const same = group(
		tool("mcp", { server: "github" }, "MCP"),
		tool("mcp__github", {}, "MCP: github"),
	);
	assert.match(plain(same), /● Github: 2 done • mcp, mcp__github/);
	const different = group(
		tool("mcp", { server: "exa" }, "MCP"),
		tool("mcp__github", {}, "MCP: github"),
	);
	assert.match(plain(different), /● Multiple Tools: 2 done/);
});

for (const namespaceFirst of [false, true]) {
	for (const pending of [false, true]) {
		test(`native namespace evidence precedes all titles (first=${namespaceFirst}, pending=${pending})`, () => {
			config.excludeRenderers = ["mcp", "mcp__github"];
			const call = tool("mcp", { tool: "github_search_code" }, "MCP");
			const namespace = tool("mcp__github", {}, "MCP: github");
			if (pending) namespace.updateResult({ content: [], isError: false }, true);
			const card = namespaceFirst ? group(namespace, call) : group(call, namespace);
			assert.match(plain(card), /● Github:/);
			assert.equal(plain(card).match(/Github/g)?.length, 3, "header and both rows agree");
			const first = card.render(160);
			if (!pending) assert.strictEqual(card.render(160), first);
		});
	}
}

test("a real SDK component for an unknown namespace call does not teach a server", () => {
	const unknown = new ToolExecutionComponent(
		"mcp__get",
		"unknown",
		{},
		{},
		undefined,
		ui,
		process.cwd(),
	);
	unknown.updateResult({ content: [], isError: true });
	unknown.render(160);
	assert.equal(resolveToolTitle(gateway, "mcp", { tool: "get_file_contents" }), "MCP");
});

test("session_start reset and transcript-order rebuilding still refresh earlier gateway cards", async () => {
	const events = new Map<string, Function>();
	claudeCodeStyleExtension({
		registerCommand() {},
		registerShortcut() {},
		on(name: string, handler: Function) {
			events.set(name, handler);
		},
	} as any);
	const earlier = tool("mcp", { tool: "github_search_code" }, "MCP");
	const later = tool("mcp", { server: "github" }, "MCP");
	try {
		await events.get("session_start")?.({ reason: "resume" }, { mode: "print", hasUI: false });
		earlier.invalidate();
		later.invalidate();
		assert.match(plain(earlier), /✓ Github/);
		const settled = earlier.render(160);
		assert.strictEqual(earlier.render(160), settled);
	} finally {
		await events.get("session_shutdown")?.({}, {});
	}
});
