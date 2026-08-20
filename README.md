# cline-workflow-guard

A [Cline](https://github.com/cline/cline) plugin that enforces workflow discipline through **deterministic hooks** — not prompt rules that models can ignore.

## What it enforces

All policies run as `beforeTool` / `runStart` hooks that execute as code and return `{ skip: true }` to block disallowed actions.

| # | Policy | Enforcement |
|---|--------|-------------|
| 1 | **Task breakdown** | Edit tools (`editor`, `apply_patch`, `write_file`) are blocked until the workspace root has `TASKS.md` / `TODO.md` / `PLAN.md` / `.cline/plan.md` containing at least one unchecked `- [ ]` item. Once all items are checked, edits block again — forcing a fresh task list per request. The task-list file itself is exempt. |
| 2 | **No pushes to main** | `git push … main/master` is blocked in any shell command. Feature branches are unaffected. |
| 3 | **PR changelog** | `gh pr create` is blocked unless the PR body contains a `Changelog:` section or the branch diff modifies a CHANGELOG file. |
| 4 | **Live-system guard** | Blocks mutations against live infrastructure: `kubectl` mutations, `helm install/upgrade`, `terraform/tofu apply/destroy`, `pulumi up`, `az`/`aws`/`gcloud` resource mutations, direct DB mutations (`psql`/`mysql`/`mongosh`/`redis-cli`/`sqlite3`), remote `curl` POST/PUT/PATCH/DELETE (localhost exempt), and `ssh user@host <cmd>`. Read-only ops (`kubectl get`, `terraform plan`, `az … show/list`) pass. |
| 5 | **Azure DevOps** | Covers `az repos/pipelines/boards/artifacts` mutations and `az devops invoke` with mutating HTTP methods. |
| 6 | **MCP mutation guard** | MCP tools bypass the shell, so they're matched by name: GitHub and Azure/azmcp MCP tools with mutation verbs (`_create`, `_update`, `_delete`, `_merge`, …) are blocked; read-only tools (`_get`, `_list`, `_search`, …) pass. |
| 7 | **Settings tamper guard** | Blocks the agent from modifying its own approval gates: `cline yolo`, `cline config`, and writes to Cline settings files. Approval settings can only be changed manually by the user in the UI. |
| 8 | **Plan→Act gate** | Works together with Cline settings: keep `modeTransitions` / YOLO disabled so every Plan→Act switch requires user approval. `runStart` logs a reminder each run. |

## Overrides ("unless otherwise specified")

Hooks can't read chat intent, so overrides are explicit and auditable:

- **Live-system changes:** append `# allow-live` to the command, or set `WORKFLOW_GUARD_ALLOW_LIVE=1`.
- **MCP mutations:** only `WORKFLOW_GUARD_ALLOW_LIVE=1` (MCP calls carry no command string).
- **Everything else:** no override — by design (that's the point of a policy).

## Install

```bash
cline plugin install https://github.com/ultus-net/cline-workflow-guard/blob/main/workflow-guard.ts --cwd .
```

Or clone and install locally:

```bash
git clone https://github.com/ultus-net/cline-workflow-guard
cline plugin install ./cline-workflow-guard/workflow-guard.ts --cwd .
```

## Recommended companion settings

`~/.cline/data/settings/auto-approve.json`:

```json
{
  "version": 1,
  "readFiles": true,
  "readFilesOutside": false,
  "editFiles": false,
  "editFilesOutside": false,
  "executeSafeCommands": false,
  "executeAllCommands": false,
  "useBrowser": false,
  "useMcp": false,
  "modeTransitions": false,
  "yoloMode": false,
  "notifications": true
}
```

`modeTransitions: false` forces a permission prompt on every Plan→Act switch; `yoloMode: false` prevents blanket auto-approval.

## Limitations

- Command matching is regex-based — obfuscated commands (`echo "kubectl delete …" | bash`) can evade it. For hard guarantees, pair with environment isolation (no production credentials in agent environments).
- The task gate enforces that a list exists, not that tasks are well-formed.

## License

MIT
