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

await plugin.hooks.runStart({});
check("runStart runs without error", true);

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
writeFileSync(join(repo2, "TASKS.md"), "# Tasks\n- [ ] one\n- [ ] two\n- [ ] three\n");
spawnSync("git", ["add", "."], { cwd: repo2 });
spawnSync("git", ["commit", "-m", "init"], { cwd: repo2 });
spawnSync("git", ["switch", "-c", "feat/x"], { cwd: repo2 });
plugin.setup({}, { workspaceInfo: { rootPath: repo2 } });
const editTask = (old_text: string, new_text: string) => call("editor", { path: join(repo2, "TASKS.md"), old_text, new_text });
check("first check-off allowed (baseline commit)", !(await editTask("- [ ] one", "- [x] one")));
check("second check-off blocked without new commit", blocked(await editTask("- [ ] two", "- [x] two")));
check("check-off with (no-commit: reason) marker allowed", !(await editTask("- [ ] two", "- [x] two (no-commit: verification only)")));
writeFileSync(join(repo2, "src.txt"), "change");
spawnSync("git", ["add", "."], { cwd: repo2 });
spawnSync("git", ["commit", "-m", "work"], { cwd: repo2 });
check("check-off allowed after new commit", !(await editTask("- [ ] three", "- [x] three")));
rmSync(repo2, { recursive: true, force: true });
plugin.setup({}, { workspaceInfo: { rootPath: root } }); // restore
// Non-git workspace: check-offs unaffected.
writeFileSync(join(root, "TASKS.md"), "# Tasks\n- [ ] do thing\n");
check("non-git workspace: check-off allowed", !(await call("editor", { path: join(root, "TASKS.md"), old_text: "- [ ] do thing", new_text: "- [x] do thing" })));

console.log("— Input shapes —");
check("single string command", blocked(await call("bash", "git push origin main")));
check("legacy tool name run_commands", blocked(await call("run_commands", { commands: ["git push origin main"] })));

rmSync(root, { recursive: true, force: true });
if (prevLive !== undefined) process.env.WORKFLOW_GUARD_ALLOW_LIVE = prevLive;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
