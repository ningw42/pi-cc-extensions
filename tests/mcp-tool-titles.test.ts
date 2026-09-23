import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../extensions/config/config.ts";
import {
	learnMcpServerFromResult,
	resetMcpServerNames,
	resolveToolTitle,
} from "../extensions/renderer/tool/names.ts";

/** Definitions pi-mcp-adapter actually registers (index.ts / namespace-tools.ts). */
const GATEWAY = { name: "mcp", label: "MCP" };
const SCRIPT = { name: "mcpScript", label: "MCP Script" };
const GITHUB = { name: "mcp__github", label: "MCP: github" };
const EXA = { name: "mcp__exa", label: "MCP: exa" };
const BRAVE = { name: "mcp__brave_search", label: "MCP: brave-search" };

function withGatewayServerName<T>(enabled: boolean, run: () => T): T {
	const previous = config.enableMcpGatewayServerName;
	config.enableMcpGatewayServerName = enabled;
	resetMcpServerNames();
	try {
		return run();
	} finally {
		config.enableMcpGatewayServerName = previous;
		resetMcpServerNames();
	}
}

test("namespace proxies and mcpScript keep the adapter's label, gateway server-name flag is irrelevant", () => {
	for (const enabled of [true, false]) {
		withGatewayServerName(enabled, () => {
			assert.equal(resolveToolTitle(SCRIPT, "mcpScript", { code: "x" }), "MCP Script");
			assert.equal(resolveToolTitle(GITHUB, "mcp__github", { tool: "github_get_tag" }), "Github");
			assert.equal(resolveToolTitle(EXA, "mcp__exa", { tool: "get_code_context_exa" }), "Exa");
			assert.equal(resolveToolTitle(BRAVE, "mcp__brave_search", {}), "Brave Search");
		});
	}
});

test("mcp gateway resolves the requested or inferred target server when the flag is on", () => {
	withGatewayServerName(true, () => {
		// args.server is authoritative
		assert.equal(
			resolveToolTitle(GATEWAY, "mcp", { server: "github", tool: "get_file_contents" }),
			"Github",
		);
		// a successful call naming the server teaches the pool...
		learnMcpServerFromResult("mcp", { server: "github", tool: "get_me" }, { content: [] }, false);
		// ...so the server is recovered from the tool-name prefix formatToolName() built
		assert.equal(resolveToolTitle(GATEWAY, "mcp", { tool: "github_search_code" }), "Github");
		// separators normalised: configured brave-search vs model-written brave_search.
		// The server must be known first — here from the namespace proxy mount.
		resolveToolTitle(BRAVE, "mcp__brave_search", {});
		assert.equal(
			resolveToolTitle(GATEWAY, "mcp", { tool: "brave_search_brave_web_search" }),
			"Brave Search",
		);
		// no tool, but a server is named
		assert.equal(
			resolveToolTitle(GATEWAY, "mcp", { search: "issue_read", server: "github" }),
			"Github",
		);
	});
});

test("mcp gateway falls back to MCP rather than inventing a server", () => {
	withGatewayServerName(true, () => {
		// unprefixed tool name the adapter never registered -> no server is recoverable.
		// Must not degrade to the first token ("Get").
		assert.equal(resolveToolTitle(GATEWAY, "mcp", { tool: "get_file_contents" }), "MCP");
		assert.equal(resolveToolTitle(GATEWAY, "mcp", { describe: "github_pull_request_read" }), "MCP");
		assert.equal(resolveToolTitle(GATEWAY, "mcp", {}), "MCP");
	});
});

test("args.server is learned only from calls that settled without an adapter error", () => {
	withGatewayServerName(true, () => {
		const unknown = { server: "get", tool: "get_file_contents" };
		// the call still titles itself from its own args.server...
		assert.equal(resolveToolTitle(GATEWAY, "mcp", unknown), "Get");
		// ...and rendering the call alone never teaches the pool
		assert.equal(resolveToolTitle(GATEWAY, "mcp", { tool: "get_file_contents" }), "MCP");
		// pi-mcp-adapter returns server_not_found as a normal result: isError=false, details.error set
		const notFound = { content: [], details: { error: "server_not_found", server: "get" } };
		learnMcpServerFromResult("mcp", unknown, notFound, false);
		assert.equal(resolveToolTitle(GATEWAY, "mcp", { tool: "get_file_contents" }), "MCP");
		// a thrown/flagged failure is not learned either
		learnMcpServerFromResult("mcp", unknown, { content: [] }, true);
		assert.equal(resolveToolTitle(GATEWAY, "mcp", { tool: "get_file_contents" }), "MCP");
		// non-gateway tools never teach from args.server
		learnMcpServerFromResult("mcpScript", { server: "github" }, { content: [] }, false);
		assert.equal(resolveToolTitle(GATEWAY, "mcp", { tool: "github_search_code" }), "MCP");
		// a successful server-only call does
		learnMcpServerFromResult("mcp", { server: "github", search: "x" }, { content: [] }, false);
		assert.equal(resolveToolTitle(GATEWAY, "mcp", { tool: "github_search_code" }), "Github");
	});
});

test("enableMcpGatewayServerName=false pins the gateway to plain MCP", () => {
	withGatewayServerName(false, () => {
		assert.equal(resolveToolTitle(GATEWAY, "mcp", { tool: "github_search_code" }), "MCP");
		assert.equal(resolveToolTitle(GATEWAY, "mcp", { server: "github", tool: "x" }), "MCP");
		assert.equal(resolveToolTitle(GATEWAY, "mcp", { search: "x", server: "github" }), "MCP");
	});
});

test("server names are learned from mcp__<server> mounts", () => {
	withGatewayServerName(true, () => {
		// nothing learned yet: the prefix cannot be resolved
		assert.equal(resolveToolTitle(GATEWAY, "mcp", { tool: "github_search_code" }), "MCP");
		// rendering the namespace proxy teaches us the server name
		resolveToolTitle(GITHUB, "mcp__github", {});
		assert.equal(resolveToolTitle(GATEWAY, "mcp", { tool: "github_search_code" }), "Github");
	});
});

test("unknown definitions and direct-tool labels alone do not teach namespace server names", () => {
	withGatewayServerName(true, () => {
		for (const definition of [undefined, { name: "mcp__get", label: "mcp__get" }]) {
			resolveToolTitle(definition, "mcp__get", {});
			assert.equal(resolveToolTitle(GATEWAY, "mcp", { tool: "get_file_contents" }), "MCP");
		}
		learnMcpServerFromResult("mcp", { server: "github" }, { content: [] }, false);
		assert.equal(resolveToolTitle({ label: "MCP: search" }, "mcp__github_search", {}), "Search");
		assert.equal(resolveToolTitle(GATEWAY, "mcp", { tool: "github_search_code" }), "Github");
	});
});

test("namespace learning retains the real server behind encoded and hashed adapter names", () => {
	// Literal namespace/prefix pairs generated by pi-mcp-adapter 2.36.0, not by this resolver.
	const fixtures = [
		["team.github", "mcp___mcpns_team_2e_github", "team_2e_github", "Team.Github"],
		["a_b.c", "mcp___mcpns_a__b_2e_c", "a_b_2e_c", "A B.C"],
		["团队", "mcp___mcpns__56e2__961f_", "_56e2__961f_", "团队"],
		["_mcpns_a", "mcp___mcpns___mcpns__a", "_mcpns_a", " Mcpns A"],
		[
			"x".repeat(70),
			"mcp___mcpns__h_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx_c71bd109227e2343",
			"x".repeat(70),
			`X${"x".repeat(69)}`,
		],
	];
	for (const [server, name, prefix, title] of fixtures) {
		withGatewayServerName(true, () => {
			resolveToolTitle({ name, label: `MCP: ${server}` }, name, {});
			assert.equal(resolveToolTitle(GATEWAY, "mcp", { tool: `${prefix}_search` }), title);
		});
	}
});

test("gateway recovery matches the longest encoded default prefix without guessing other modes", () => {
	withGatewayServerName(true, () => {
		for (const server of ["github", "github.enterprise", "brave", "brave-search", "a.b", "a_2e"]) {
			learnMcpServerFromResult("mcp", { server }, { content: [] }, false);
		}
		assert.equal(
			resolveToolTitle(GATEWAY, "mcp", { tool: "github_2e_enterprise_search_code" }),
			"Github.Enterprise",
		);
		assert.equal(resolveToolTitle(GATEWAY, "mcp", { tool: "github_search_code" }), "Github");
		assert.equal(resolveToolTitle(GATEWAY, "mcp", { tool: "brave_search_search" }), "Brave Search");
		assert.equal(
			resolveToolTitle(GATEWAY, "mcp", { tool: "a_2e_b_search" }),
			"A.B",
			"compare encoded prefix length, not the original server-name length",
		);
		assert.equal(resolveToolTitle(GATEWAY, "mcp", { tool: "mcp__github_search_code" }), "MCP");
		assert.equal(resolveToolTitle(GATEWAY, "mcp", { tool: "search_code" }), "MCP");
	});
	withGatewayServerName(true, () => {
		learnMcpServerFromResult("mcp", { server: "github-mcp" }, { content: [] }, false);
		assert.equal(resolveToolTitle(GATEWAY, "mcp", { tool: "github_search_code" }), "MCP");
	});
});

test("non-MCP tools are unaffected by the shared resolver", () => {
	withGatewayServerName(true, () => {
		assert.equal(resolveToolTitle({ name: "bash" }, "bash", { command: "ls" }), "Bash");
		assert.equal(resolveToolTitle({ name: "read" }, "read", { path: "a.ts" }), "Read");
		assert.equal(resolveToolTitle({ name: "TaskCreate" }, "TaskCreate", {}), "Task Create");
		// an extension-supplied label still wins over the humanised name
		assert.equal(resolveToolTitle({ name: "wait", label: "Wait" }, "wait", {}), "Wait");
	});
});
