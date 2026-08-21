import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL(join(import.meta.dirname, "workflow-guard.ts")).href);
const plugin = mod.default ?? mod.plugin;
const beforeTool = plugin.hooks.beforeTool;

let pass = 0, fail = 0;
const check = (name: string, cond: boolean): void => { cond ? (pass++, console.log("  ok  " + name)) : (fail++, console.log("FAIL  " + name)); };

const root = mkdtempSync(join(tmpdir(), "wg-test-"));
const prevLive = process.env.WORKFLOW_GUARD_ALLOW_LIVE;
delete process.env.WORKFLOW_GUARD_ALLOW_LIVE;
plugin.setup({}, { workspaceInfo: { rootPath: root } });

const call = async (toolName: string, input: unknown) => {
  const r = await beforeTool({ toolCall: { toolName }, input });
  return r?.skip ? r : undefined;
};
const shell = (cmd: string) => call("bash", { commands: [cmd] });
const blocked = (r: unknown): boolean => !!(r as { skip?: boolean } | undefined)?.skip;

await plugin.hooks.beforeRun({});
check("beforeRun runs without error", true);

console.log("— Policy 1: task-list gate —");
writeFileSync(join(root, "TASKS.md"), "# Tasks\n- [ ] do thing\n- [x] done\n");
check("editor allowed with unchecked task", !(await call("editor", { path: join(root, "a.ts"), new_text: "x" })));
check("apply_patch allowed with unchecked task", !(await call("apply_patch", { patch: "*** x" })));
writeFileSync(join(root, "TASKS.md"), "# Tasks\n- [x] all done\n");
check("editor blocked when all tasks checked", blocked(await call("editor", { path: join(root, "a.ts"), new_text: "x" })));
rmSync(join(root, "TASKS.md"));
check("editor blocked with no task list", blocked(await call("editor", { path: join(root, "a.ts"), new_text: "x" })));
writeFileSync(join(root, "TASKS.md"), "# Tasks\n- [ ] do thing\n");
check("task-list file itself exempt", !(await call("editor", { path: join(root, "TASKS.md"), new_text: "x" })));

console.log("— Policy 2: push to main/master —");
check("block git push origin main", blocked(await shell("git push origin main")));
check("block git push origin master", blocked(await shell("git push origin master")));
check("block git push --force origin main", blocked(await shell("git push --force origin main")));
check("allow git push origin feature/x", !(await shell("git push origin feature/x")));
check("allow push to main-backup (ref-like path)", !(await shell("git push origin main-backup")));
check("block refspec push HEAD:main", blocked(await shell("git push origin HEAD:main")));
check("block refspec push HEAD:master", blocked(await shell("git push origin HEAD:master")));
check("block branch deletion push :main", blocked(await shell("git push origin :main")));
check("allow refspec push HEAD:feat/x", !(await shell("git push origin HEAD:feat/x")));

console.log("— Policy 3: PR changelog —");
check("block gh pr create without changelog", blocked(await shell("gh pr create --title t --body 'no changes here'")));
check("allow gh pr create with Changelog: body", !(await shell("gh pr create --title t --body 'Changelog: fixed stuff'")));
const bodyFile = join(root, "pr-body.md");
writeFileSync(bodyFile, "## Changelog\n- fix\n");
check("allow gh pr create with -F body-file containing changelog", !(await shell(`gh pr create -F ${bodyFile}`)));

console.log("— Policy 4: destructive commands —");
check("block kubectl delete", blocked(await shell("kubectl delete pod foo")));
check("block helm uninstall", blocked(await shell("helm uninstall my-release")));
check("block terraform destroy", blocked(await shell("terraform destroy -auto-approve")));
check("block tofu destroy", blocked(await shell("tofu destroy")));
check("block pulumi destroy", blocked(await shell("pulumi destroy")));
check("block az group delete", blocked(await shell("az group delete -g rg-prod")));
check("block aws ec2 terminate-instances", blocked(await shell("aws ec2 terminate-instances --instance-ids i-1")));
check("block psql drop table", blocked(await shell("psql -c 'DROP TABLE users'")));
check("block redis-cli flushall", blocked(await shell("redis-cli flushall")));
check("block remote curl DELETE", blocked(await shell("curl -X DELETE https://api.example.com/thing")));
check("allow localhost curl DELETE", !(await shell("curl -X DELETE http://localhost:3000/thing")));
check("allow curl POST remote", !(await shell("curl -X POST https://api.example.com/thing -d x")));
check("allow kubectl apply", !(await shell("kubectl apply -f deploy.yaml")));
check("allow terraform apply", !(await shell("terraform apply")));
check("allow az group create", !(await shell("az group create -g rg --location westeurope")));
check("allow ssh", !(await shell("ssh user@host 'uptime'")));
check("allow psql insert", !(await shell('psql -c "INSERT INTO t VALUES (1)"')));
check("block git push --force (feature branch)", blocked(await shell("git push --force origin feature/x")));
check("allow-live comment override", !(await shell("kubectl delete pod foo # allow-live")));
process.env.WORKFLOW_GUARD_ALLOW_LIVE = "1";
check("env override WORKFLOW_GUARD_ALLOW_LIVE=1", !(await shell("kubectl delete pod foo")));
delete process.env.WORKFLOW_GUARD_ALLOW_LIVE;

console.log("— Policy 5: Azure DevOps —");
check("block az repos pr delete", blocked(await shell("az repos pr delete --id 42")));
check("block az pipelines abandon", blocked(await shell("az pipelines run abandon --id 7")));

console.log("— Policy 6: MCP mutations —");
check("block mcp__github__create_issue", blocked(await call("mcp__github__create_issue", { title: "x" })));
check("block mcp__github__merge_pull_request", blocked(await call("mcp__github__merge_pull_request", {})));
check("block mcp__azmcp__repos_pr_update", blocked(await call("mcp__azmcp__repos_pr_update", {})));
check("allow mcp__github__get_issue", !(await call("mcp__github__get_issue", {})));
check("allow mcp__github__list_pull_requests", !(await call("mcp__github__list_pull_requests", {})));
check("allow mcp__azure__repos_pr_list", !(await call("mcp__azure__repos_pr_list", {})));
check("allow unrelated mcp server tool", !(await call("mcp__slack__post_message", {})));

console.log("— Policy 7: settings tamper —");
check("block cline yolo", blocked(await shell("cline yolo")));
check("block cline config set autoApprove", blocked(await shell("cline config set autoApprove true")));
check("block cline settings", blocked(await shell("cline settings set readFiles true")));
check("block echo yolo mode", blocked(await shell("enable yolo mode now")));
check("block writing auto-approve.json", blocked(await shell(`echo '{}' > ${root}/settings/auto-approve.json`)));
check("block editor write to auto-approve.json (edit-tool path)", blocked(await call("editor", { path: "/var/home/x/.cline/data/settings/auto-approve.json", new_text: "{}" })));
check("block apply_patch on auto-approve.json (edit-tool path)", blocked(await call("apply_patch", { input: "*** Begin Patch\n*** Update File: /var/home/x/.cline/data/settings/auto-approve.json\n@@\n+{}\n*** End Patch" })));
check("block writing ~/.cline/settings/vscode-cline.json", blocked(await shell(`echo '{}' > /var/home/x/.cline/settings/vscode-cline.json`)));
check("block saoudrizwan state.db write", blocked(await shell(`rm /var/home/x/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/state.db`)));
check("FIXED: multiline cmd w/ plugin dir + 'settings' + '.json' allowed", !(await shell("cd /var/home/csh/cline-workflow-guard\nls -la\ncat package.json\n# note about settings files\n# e.g. foo.json")));
check("FIXED: bare 'echo yolo' allowed", !(await shell("echo yolo")));
check("FIXED: mention of auto-approve in prose allowed", !(await shell("echo 'the auto-approve feature is documented here'")));
check("still blocks real tamper on same line", blocked(await shell(`echo '{}' > /var/home/x/.cline/data/settings/auto-approve.json`)));
check("allow normal command", !(await shell("ls -la && git status")));

console.log("— Policy 8: branch guard —");
// Non-git workspace (current `root` is a plain temp dir): git writes allowed.
check("non-git workspace: git commit allowed", !(await shell("git commit -m test")));
check("non-git workspace: editor allowed", !(await call("editor", { path: join(root, "a.ts"), new_text: "x" })));
// Real git repo on main.
const repo = mkdtempSync(join(tmpdir(), "wg-repo-"));
spawnSync("git", ["init", "-b", "main"], { cwd: repo });
writeFileSync(join(root, "TASKS.md"), "# Tasks\n- [ ] do thing\n");
// Point the plugin's workspaceRoot at the repo.
plugin.setup({}, { workspaceInfo: { rootPath: repo } });
writeFileSync(join(repo, "TASKS.md"), "# Tasks\n- [ ] do thing\n");
check("on main: editor blocked", blocked(await call("editor", { path: join(repo, "a.ts"), new_text: "x" })));
check("on main: git commit blocked", blocked(await shell("git commit -m test")));
check("on main: git merge blocked", blocked(await shell("git merge feature/x")));
check("on main: git switch -c allowed (branch creation)", !(await shell("git switch -c feat/x")));
check("on main: git status allowed", !(await shell("git status")));
check("on main: task-list file edit still exempt", !(await call("editor", { path: join(repo, "TASKS.md"), new_text: "x" })));
check("on main: apply_patch to task list still exempt", !(await call("apply_patch", { input: "*** Begin Patch\n*** Update File: TASKS.md\n@@\n+note\n*** End Patch" })));
check("on main: docs/TASKS.md NOT exempt (exact match only)", blocked(await call("editor", { path: join(repo, "docs", "TASKS.md"), new_text: "x" })));
spawnSync("git", ["switch", "-c", "feat/x"], { cwd: repo });
check("on feature branch: editor allowed", !(await call("editor", { path: join(repo, "a.ts"), new_text: "x" })));
check("on feature branch: git commit allowed", !(await shell("git commit -m test")));
check("on feature branch: force push allowed", !(await shell("git push --force origin feat/x")));
check("on feature branch: force-with-lease allowed", !(await shell("git push --force-with-lease origin feat/x")));
check("on feature branch: force push to main still blocked", blocked(await shell("git push --force origin main")));
rmSync(repo, { recursive: true, force: true });
plugin.setup({}, { workspaceInfo: { rootPath: root } }); // restore

console.log("— Policy 10: task-completion commit gate —");
const repo2 = mkdtempSync(join(tmpdir(), "wg-taskgate-"));
spawnSync("git", ["init", "-b", "main"], { cwd: repo2 });
spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: repo2 });
spawnSync("git", ["config", "user.name", "Test"], { cwd: repo2 });
writeFileSync(join(repo2, "TASKS.md"), "# Tasks\n- [ ] (one) first task\n- [ ] (two) second task\n- [ ] (three) third task\n");
spawnSync("git", ["add", "."], { cwd: repo2 });
spawnSync("git", ["commit", "-m", "init"], { cwd: repo2 });
spawnSync("git", ["switch", "-c", "feat/x"], { cwd: repo2 });
plugin.setup({}, { workspaceInfo: { rootPath: repo2 } });
const editTask = (old_text: string, new_text: string) => call("editor", { path: join(repo2, "TASKS.md"), old_text, new_text });
const patchTask = (from: string, to: string) => call("apply_patch", { input: `*** Begin Patch\n*** Update File: TASKS.md\n@@\n-${from}\n+${to}\n*** End Patch` });
const setTasks = (c: string) => writeFileSync(join(repo2, "TASKS.md"), c);
check("unlabeled task line blocked", blocked(await editTask("- [ ] (one) first task", "- [x] no-label rewrite\n- [x] (one) first task")));
check("first check-off allowed (baseline commit)", !(await editTask("- [ ] (one) first task", "- [x] (one) first task")));
setTasks("# Tasks\n- [x] (one) first task\n- [ ] (two) second task\n- [ ] (three) third task\n");
check("second check-off blocked without new commit", blocked(await editTask("- [ ] (two) second task", "- [x] (two) second task")));
check("out-of-order check-off blocked (three before two)", blocked(await editTask("- [ ] (three) third task", "- [x] (three) third task")));
check("apply_patch check-off blocked without new commit", blocked(await patchTask("- [ ] (two) second task", "- [x] (two) second task")));
check("apply_patch check-off with (no-commit) marker allowed", !(await patchTask("- [ ] (two) second task", "- [x] (two) second task (no-commit: verification only)")));
check("check-off with (no-commit: reason) marker allowed", !(await editTask("- [ ] (two) second task", "- [x] (two) second task (no-commit: verification only)")));
setTasks("# Tasks\n- [x] (one) first task\n- [x] (two) second task (no-commit: verification only)\n- [ ] (three) third task\n");
// A commit that only touches the task list / plugin state must not count as work.
spawnSync("git", ["add", "."], { cwd: repo2 });
spawnSync("git", ["commit", "-m", "tasks only"], { cwd: repo2 });
check("task-list-only commit does not satisfy gate", blocked(await editTask("- [ ] (three) third task", "- [x] (three) third task")));
writeFileSync(join(repo2, "src.txt"), "change");
spawnSync("git", ["add", "."], { cwd: repo2 });
spawnSync("git", ["commit", "-m", "work"], { cwd: repo2 });
check("check-off allowed after new work commit", !(await editTask("- [ ] (three) third task", "- [x] (three) third task")));

console.log("— Policy 12: task lifecycle (cleanup + changelog) —");
// repo2 list is now: all three tasks checked (one was checked off via patch).
setTasks("# Tasks\n- [x] (one) first task\n- [x] (two) second task (no-commit: verification only)\n- [x] (three) third task\n");
// Mid-flight removal protection is moot here (all checked); test cleanup gate:
check("cleanup blocked without CHANGELOG.md", blocked(await editTask("- [x] (one) first task\n", "")));
writeFileSync(join(repo2, "CHANGELOG.md"), "# Changelog\n\n## 1.0.0\n- (one) old release entry\n");
check("cleanup blocked when entry only exists under an old release", blocked(await editTask("- [x] (one) first task\n", "")));
check("changelog edit without Unreleased heading blocked in cleanup phase", blocked(await call("editor", { path: join(repo2, "CHANGELOG.md"), old_text: "# Changelog", new_text: "# Changelog\nmore" })));
check("changelog edit adding Unreleased section allowed", !(await call("editor", { path: join(repo2, "CHANGELOG.md"), old_text: "# Changelog\n", new_text: "# Changelog\n\n## Unreleased\n- (one) Add first task\n- (two) Add second task\n- (three) Add third task\n" })));
writeFileSync(join(repo2, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n- (one) Add first task\n- (two) Add second task\n- (three) Add third task\n\n## 1.0.0\n- old release\n");
check("cleanup allowed once all labels are in Unreleased", !(await editTask("# Tasks\n- [x] (one) first task\n- [x] (two) second task (no-commit: verification only)\n- [x] (three) third task\n", "# Tasks\n")));
// Partial cleanup: (three) not yet logged → still blocked, even with
// completely different changelog wording (label match, not prose match).
setTasks("# Tasks\n- [x] (one) first task\n- [x] (three) third task\n");
writeFileSync(join(repo2, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n- (one) Totally reworded description of the first task\n");
check("partial cleanup blocked for unlogged label", blocked(await editTask("- [x] (three) third task\n", "")));
check("reworded changelog entry accepted via label match", !(await editTask("- [x] (one) first task\n", "")));
// Fresh cycle: new unchecked tasks added to an empty list are fine.
setTasks("# Tasks\n");
check("adding fresh labeled tasks after cleanup allowed", !(await editTask("# Tasks\n", "# Tasks\n- [ ] (next) next thing\n")));
// Mid-flight removal protection (unchecked task deleted).
setTasks("# Tasks\n- [ ] (alpha) alpha task\n- [ ] (beta) beta task\n");
writeFileSync(join(repo2, "src2.txt"), "w");
spawnSync("git", ["add", "."], { cwd: repo2 });
spawnSync("git", ["commit", "-m", "w2"], { cwd: repo2 });
check("mid-flight deletion of unchecked task blocked", blocked(await editTask("- [ ] (beta) beta task\n", "")));
check("mid-flight rewording of unchecked task blocked", blocked(await editTask("- [ ] (beta) beta task", "- [ ] (beta) beta reworded")));
check("mid-flight removal of (no-commit) checked line allowed", !(await editTask("- [ ] (alpha) alpha task", "- [x] (alpha) alpha task (no-commit: docs)")));
setTasks("# Tasks\n- [x] (alpha) alpha task (no-commit: docs)\n- [ ] (beta) beta task\n");
check("obsolete marked checked line removal allowed", !(await editTask("- [x] (alpha) alpha task (no-commit: docs)\n", "")));
rmSync(repo2, { recursive: true, force: true });
plugin.setup({}, { workspaceInfo: { rootPath: root } }); // restore
// Non-git workspace: check-offs unaffected.
writeFileSync(join(root, "TASKS.md"), "# Tasks\n- [ ] do thing\n");
check("non-git workspace: check-off allowed", !(await call("editor", { path: join(root, "TASKS.md"), old_text: "- [ ] do thing", new_text: "- [x] do thing" })));

console.log("— Labels: shell rewrites of task lists —");
{
  const repo3 = mkdtempSync(join(tmpdir(), "wg-shellwrite-"));
  spawnSync("git", ["init", "-b", "main"], { cwd: repo3 });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: repo3 });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: repo3 });
  writeFileSync(join(repo3, "TASKS.md"), "# Tasks\n- [ ] (x) x\n");
  spawnSync("git", ["add", "."], { cwd: repo3 });
  spawnSync("git", ["commit", "-m", "init"], { cwd: repo3 });
  spawnSync("git", ["switch", "-c", "feat/y"], { cwd: repo3 });
  plugin.setup({}, { workspaceInfo: { rootPath: repo3 } });
  check("heredoc rewrite with unlabeled tasks blocked", blocked(await shell("cat <<'EOF' > TASKS.md\n# Tasks\n- [ ] no label here\nEOF")));
  check("heredoc rewrite with labeled tasks allowed", !(await shell("cat <<'EOF' > TASKS.md\n# Tasks\n- [ ] (x) relabeled fine\nEOF")));
  check("heredoc to non-task file ignored", !(await shell("cat <<'EOF' > NOTES.md\n- [ ] no label needed here\nEOF")));
  rmSync(repo3, { recursive: true, force: true });
  plugin.setup({}, { workspaceInfo: { rootPath: root } }); // restore
}

console.log("— Input shapes —");
check("single string command", blocked(await call("bash", "git push origin main")));
check("legacy tool name run_commands", blocked(await call("run_commands", { commands: ["git push origin main"] })));

rmSync(root, { recursive: true, force: true });
if (prevLive !== undefined) process.env.WORKFLOW_GUARD_ALLOW_LIVE = prevLive;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
