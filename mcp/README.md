# Repot MCP

Repot MCP puts the feature-transfer workflow inside an AI coding client: point it at a source repository, a destination repository, and describe what should move.

It uses the official Model Context Protocol TypeScript SDK v2 and serves over **stdio**. The current package is source-distributed from this repository; it is **not published to npm yet**.

## Tools

| Tool | Effect |
| --- | --- |
| `repot_inspect` | Read-only discovery. Finds likely implementation files, related tests/support, destination context, and warnings. No AI call. |
| `repot_draft` | Read-only draft. Sends only Repot's bounded selected context to the configured OpenAI model and returns a review ID + patch. No files are changed or executed. |
| `repot_apply` | Optional write. Applies the exact stored review after re-snapshotting the destination. Disabled by default. Never deletes files or runs shell/build/test commands. |

The server also exposes `repot://safety` and a `move-feature` prompt.

## Security model

Repot MCP is local and intentionally narrow.

1. **Allowed roots are mandatory.** Every repository path must resolve inside a directory passed with `--allow-root`.
2. **Symlinks are ignored during reads and refused at write targets.**
3. **Snapshots are bounded** to 1,500 eligible text files, 750 KB total, and 60 KB per file.
4. **Common secret/generated directories are excluded.** Sensitive-looking content fails closed.
5. **AI is optional.** `repot_inspect` never calls a provider. `repot_draft` requires `OPENAI_API_KEY` plus `REPOT_AI_MODEL`.
6. **Writes are off by default.** Enable with `--allow-writes` or `REPOT_MCP_ALLOW_WRITES=1`.
7. **Apply is stale-safe.** The destination fingerprint and updated-file hashes must still match the reviewed snapshot.
8. **No code execution.** Repot MCP does not run generated code, package managers, git hooks, builds, tests, or shell commands. Verification remains `not_run` until another isolated workflow actually runs it.

## Install from source

Requires Node.js 22+.

```sh
git clone https://github.com/shlbi/graft.git repot
cd repot/mcp
npm install
```

Test the local safety layer:

```sh
npm test
npm run check
```

To exercise the actual MCP protocol after dependencies are installed:

```sh
npx @modelcontextprotocol/inspector node server.mjs --allow-root /path/to/projects
```

## Cursor

Project config: `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "repot": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/repot/mcp/server.mjs",
        "--allow-root",
        "/absolute/path/to/projects"
      ],
      "env": {
        "OPENAI_API_KEY": "${env:OPENAI_API_KEY}",
        "REPOT_AI_MODEL": "${env:REPOT_AI_MODEL}"
      }
    }
  }
}
```

Start read-only. When you intentionally want Repot to write reviewed drafts, add `"--allow-writes"` to `args`. Cursor normally asks for tool approval; keep write-tool approval enabled.

## VS Code / Copilot

Portable workspace config: `.mcp.json`

```json
{
  "mcpServers": {
    "repot": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/repot/mcp/server.mjs",
        "--allow-root",
        "/absolute/path/to/projects"
      ]
    }
  }
}
```

You can also use `.vscode/mcp.json`, where VS Code uses a top-level `servers` object.

## Recommended agent workflow

1. Ask: `Use Repot to move the CSV export feature from /projects/a to /projects/b.`
2. Agent calls `repot_inspect`.
3. Review discovered files/tests and warnings.
4. Agent calls `repot_draft` only when AI is configured.
5. Review the returned patch and verification status.
6. Explicitly ask to apply that draft if desired.
7. Your normal coding workflow reviews the diff and runs builds/tests.

## Current scope

The transfer engine is strongest on JavaScript/TypeScript and has a bounded Jest→Vitest test adapter. Other source languages can participate in discovery, but automatic test relocation/adaptation is not claimed universally.

The MCP server is **local stdio only** in this release. There is no hosted remote MCP endpoint or OAuth flow yet.
