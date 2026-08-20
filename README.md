# cline-workflow-guard

A [Cline](https://github.com/cline/cline) plugin that enforces workflow discipline through **deterministic hooks** — not prompt rules that models can ignore.

All policies run as `beforeTool` / `runStart` hooks (SDK/CLI/Kanban — not the VS Code/JetBrains extension) that execute as code and return `{ skip: true }` to block disallowed actions. Tool names match the current built-in set (`bash`, `editor`, `apply_patch`); legacy names are matched for older runtimes.

## What it enforces

All policies run as `beforeTool` / `runStart` hooks that execute as code and return `{ skip: true }` to block disallowed actions.

| # | Policy | Enforcement |
|---|--------|-------------|
| 1 | **Task breakdown** | Edit tools (`editor`, `apply_patch`) are blocked until the workspace root has `TASKS.md` / `TODO.md` / `PLAN.md` / `.cline/plan.md` containing at least one unchecked `- [ ]` item. Once all items are checked, edits block again — forcing a fresh task list per request. The task-list file itself is exempt. |
| 2 | **No pushes to main** | `git push … main/master` is blocked in any shell command. Feature branches are unaffected. |
| 3 | **PR changelog** | `gh pr create` is blocked unless the PR body contains a `Changelog:` section or the branch diff modifies a CHANGELOG file. |
| 4 | **Destructive-command guard** | Blocks only *destructive* CLI operations — non-destructive mutations (`kubectl apply`, `terraform apply`, `helm upgrade`, `az … create/update`, DB inserts, `curl` POST/PUT/PATCH, `ssh`) are allowed. Blocked: `kubectl delete/drain`, `helm uninstall/rollback`, `terraform/tofu destroy`, `pulumi destroy`, `az`/`aws`/`gcloud` delete/terminate/purge, DB `drop/delete/truncate/flushall`, remote `curl` DELETE (localhost exempt), and `git push --force` to protected branches. Force pushes (`--force`, `--force-with-lease`, `-f`) **to feature branches are allowed** — rebasing your own branch is normal workflow; pushes to main/master remain blocked by policy 2 in all forms. |
| 5 | **Azure DevOps** | Covers destructive `az repos/pipelines/boards/artifacts` operations (`delete`, `abandon`). |
| 6 | **MCP mutation guard** | MCP tools bypass the shell, so they're matched by name: GitHub and Azure/azmcp MCP tools with mutation verbs (`_create`, `_update`, `_delete`, `_merge`, …) are blocked; read-only tools (`_get`, `_list`, `_search`, …) pass. |
| 7 | **Settings tamper guard** | Blocks the agent from modifying its own approval gates: `cline yolo`, `cline config`, and writes to Cline settings files. Approval settings can only be changed manually by the user in the UI. |
| 8 | **Plan→Act gate** | Works together with Cline settings: keep `modeTransitions` / YOLO disabled so every Plan→Act switch requires user approval. `runStart` logs a reminder each run. |
| 9 | **Feature-branch workflow** | When the workspace repo is on `main`/`master`, edit tools and history-changing git commands (`commit`, `merge`, `rebase`, `cherry-pick`, `revert`, `apply`, `am`, `reset`, `restore`, `stash pop`) are blocked with a prompt to create a feature branch first. Read-only commands, branch creation, non-git workspaces, and task-list file edits are unaffected. |
| 10 | **Commit-per-task gate** | On feature branches, editing a task list to check off an item (`- [ ]` → `- [x]`) is blocked unless a new commit exists since the previous task was checked off (baseline tracked in `.cline/task-state.json`). Doc-only/verification tasks can opt out with a `(no-commit: reason)` marker on the task line. Non-git workspaces are unaffected. |

## Overrides ("unless otherwise specified")

Hooks can't read chat intent, so overrides are explicit and auditable:

- **Destructive commands:** append `# allow-live` to the command, or set `WORKFLOW_GUARD_ALLOW_LIVE=1`.
- **MCP mutations:** only `WORKFLOW_GUARD_ALLOW_LIVE=1` (MCP calls carry no command string).
- **Everything else:** no override — by design (that's the point of a policy).

## Install

> **Note:** plugins currently work with the **Cline CLI, SDK, and Kanban** — they are not yet supported in the VS Code / JetBrains extension.

Install directly from this repo (recommended):

```bash
cline plugin install https://github.com/ultus-net/cline-workflow-guard.git
```

Install per-project (`<project>/.cline/plugins` instead of `~/.cline/plugins`):

```bash
cline plugin install https://github.com/ultus-net/cline-workflow-guard.git --cwd .
```

Or install a single file / local clone:

```bash
cline plugin install https://github.com/ultus-net/cline-workflow-guard/blob/main/workflow-guard.ts
cline plugin install ./cline-workflow-guard/workflow-guard.ts
```

Verify it's loaded with `cline config` (check the plugin tab).

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
