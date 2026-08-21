/**
 * Workflow Guard Plugin (hooks-only — no prompt rules)
 *
 * Deterministic enforcement:
 *  1. Task list gate: file-editing tools are blocked until the workspace has
 *     a task list (TASKS.md / TODO.md / PLAN.md / .cline/plan.md) containing
 *     at least one unchecked item ("- [ ]"). Tasks are then worked top-down.
 *  2. Git pushes to main/master are hard-blocked.
 *  3. PR creation (gh) requires a changelog — either a CHANGELOG update in
 *     the branch's diff or a "Changelog:" section in the PR body.
 *  4. Live-system guard: commands that mutate live infrastructure, databases,
 *     or remote APIs are blocked unless explicitly overridden with an
 *     `# allow-live` comment in the command or WORKFLOW_GUARD_ALLOW_LIVE=1.
 *
 * CLI usage:
 *   cline plugin install ~/.cline/plugins/workflow-guard/workflow-guard.ts --cwd .
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentPlugin } from "@cline/sdk";

// The published @cline/sdk dist typings currently degrade `AgentPlugin` to
// `any` (the AgentExtension alias fails to resolve through the d.ts export
// chain), so no contextual typing reaches hook implementations. The slices
// below mirror the verified SDK contracts instead:
//  - AgentBeforeToolContext / AgentBeforeToolResult
//    (sdk/packages/shared/src/agent.ts — toolCall.toolName, skip/reason)
//  - PluginSetupContext.workspaceInfo.rootPath
//    (sdk/packages/shared/src/extensions/contribution-registry.ts)
interface BeforeToolContext {
	toolCall: { toolName: string };
	input: unknown;
}
interface HookResult {
	skip?: boolean;
	reason?: string;
}
interface SetupContext {
	workspaceInfo?: { rootPath?: string };
}

// Current runtime tool names (sdk/packages/core/src/extensions/tools/
// definitions.ts): run_commands, editor, apply_patch, read_files,
// search_codebase, fetch_web_content, ask_question. The docs page
// (docs.cline.bot/tools-reference) still lists older aliases (bash, search,
// fetch_web), so both current and legacy/alias names are matched.
const SHELL_TOOL_NAMES = new Set(["bash", "run_commands", "execute_command", "shell"]);

let workspaceRoot = process.cwd();

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

/** Pull the command string(s) out of a shell tool input. */
function extractCommands(input: unknown): string[] {
	if (typeof input === "string") {
		return [input];
	}
	const record = asRecord(input);
	if (!record) {
		return [];
	}
	const commands: string[] = [];
	if (typeof record.command === "string") commands.push(record.command);
	if (Array.isArray(record.commands)) {
		for (const c of record.commands) {
			if (typeof c === "string") commands.push(c);
		}
	}
	return commands;
}

/** Collapse excess whitespace for regex matching. */
function normalize(cmd: string): string {
	return cmd.replace(/\s+/g, " ");
}

// Matches "git push ... main|master" as a ref or refspec target — including
// "HEAD:main" (colon separator) and ":main" (branch deletion) — but not
// paths like feature/main-fix or origin/main-backup.
const PUSH_TO_MAIN_RE =
	/\bgit\s+push\b[^|;&]*(?:\s|\/|:|^)(?:main|master)(?![\w./:-])/;
const PR_CREATE_RE = /\bgh\s+pr\s+create\b/;
// A real changelog section: a "Changelog:" label or a "# Changelog" heading.
// (A bare mention of the word "changelog" in prose does not count.)
const CHANGELOG_SECTION_RE = /changelog\s*:|^#+\s*changelog\b/im;

// ── Task-list gate ───────────────────────────────────────────────────────────

const EDIT_TOOL_NAMES = new Set(["editor", "apply_patch"]);
const TASK_LIST_FILES = ["TASKS.md", "TODO.md", "PLAN.md", ".cline/plan.md"];
const UNCHECKED_TASK_RE = /^\s*[-*]\s+\[ \]\s+\S/m;

function findActiveTaskList(root: string): string | undefined {
	for (const name of TASK_LIST_FILES) {
		const path = resolve(root, name);
		try {
			const content = readFileSync(path, "utf8");
			if (UNCHECKED_TASK_RE.test(content)) {
				return name;
			}
		} catch {
			// File missing/unreadable — try the next candidate.
		}
	}
	return undefined;
}

// ── Task-completion commit gate ───────────────────────────────────────────────
// Checking off a task ("- [ ]" -> "- [x]") requires a new commit since the
// previous task was completed. This checkpoints each task's work into git so
// history maps to the task list and crashed runs lose nothing.
//
// Escape hatch: append a "(no-commit: reason)" marker to the task line for
// doc-only / verification tasks that need no commit.
//
// Scope: git repos on feature branches only. Non-git workspaces and task
// edits on main/master (where commits are already blocked by the branch
// guard) are unaffected.

const TASK_STATE_FILE = ".cline/task-state.json";
const NO_COMMIT_MARKER_RE = /\(no-commit(?::[^)]*)?\)/i;
const CHECKED_TASK_RE = /^\s*[-*]\s+\[[xX]\]/gm;
const TASK_LINE_RE = /^\s*[-*]\s+\[[ xX]\]/;
const CHANGELOG_FILE = "CHANGELOG.md";

/**
 * True when a changelog entry exists for `task` under a section that comes
 * before any versioned release heading (i.e. the "Unreleased" bucket, whether
 * or not the heading is spelled that way). Older release sections are not
 * re-scanned, so new work must produce new entries.
 */
function changelogHasUnreleasedEntry(content: string, task: string): boolean {
	let inUnreleased = false;
	let foundHeading = false;
	for (const line of content.split("\n")) {
		const heading = line.match(/^#{1,6}\s+(.*)$/);
		if (heading) {
			const title = heading[1] ?? "";
			if (/unreleased/i.test(title)) {
				foundHeading = true;
				inUnreleased = true;
				continue;
			}
			if (/\d+\.\d+/.test(title) || (foundHeading && inUnreleased)) {
				// Versioned release (or any heading after Unreleased) — the
				// unreleased bucket is over.
				inUnreleased = false;
			}
			continue;
		}
		if (inUnreleased && line.includes(task)) {
			return true;
		}
	}
	return false;
}

function gitHead(root: string): string | undefined {
	const result = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
		timeout: 10_000,
	});
	if (result.status !== 0) return undefined;
	return result.stdout.trim() || undefined;
}

interface TaskState {
	head?: string;
}

function readTaskState(root: string): TaskState {
	try {
		const parsed = JSON.parse(
			readFileSync(resolve(root, TASK_STATE_FILE), "utf8"),
		);
		if (typeof parsed?.head === "string") return { head: parsed.head };
	} catch {
		// Missing/corrupt state — treat as no baseline yet.
	}
	return {};
}

function writeTaskState(root: string, state: TaskState): void {
	try {
		mkdirSync(resolve(root, ".cline"), { recursive: true });
		writeFileSync(resolve(root, TASK_STATE_FILE), JSON.stringify(state));
	} catch {
		// Best effort — state tracking is an optimization baseline.
	}
}

const UNCHECKED_LINE_RE = /^\s*[-*]\s+\[ \]/m;
const CHECKED_LINE_RE = /^\s*[-*]\s+\[[xX]\]/m;

/** Exact-match a tool target path against the known task-list files. */
function taskListNameForTarget(
	root: string,
	target: string,
): string | undefined {
	if (!target) return undefined;
	const abs = resolve(root, target);
	return TASK_LIST_FILES.find((name) => resolve(root, name) === abs);
}

/** File paths touched by an apply_patch payload. */
function patchTargetPaths(patch: string): string[] {
	const paths: string[] = [];
	for (const m of patch.matchAll(
		/^\*\*\*\s*(?:Add|Update|Delete) File:\s+(.+?)\s*$/gm,
	)) {
		if (m[1]) paths.push(m[1]);
	}
	return paths;
}

/** Tool input → target paths (editor: `path`; apply_patch: patch headers). */
function editTargets(input: unknown): string[] {
	const record = asRecord(input);
	if (typeof record?.path === "string") return [record.path];
	if (typeof input === "string") return [input]; // legacy editor-as-string
	const patch =
		typeof record?.input === "string"
			? record.input
			: typeof record?.patch === "string"
				? record.patch
				: "";
	return patch ? patchTargetPaths(patch) : [];
}

/** Task text without checkbox / no-commit marker, for order comparison. */
function taskText(line: string): string {
	return line
		.replace(/^\s*[-*]\s+\[[ xX]\]\s*/, "")
		.replace(/\s*\(no-commit(?::[^)]*)?\)\s*/i, "")
		.trim();
}

interface TaskEditInfo {
	/** Task text of lines checked off by this edit ([ ] → [x]). */
	flipped: string[];
	/** Raw added/removed task lines (both checkbox states). */
	addedTasks: string[];
	removedTasks: string[];
	/** True when every flipped line carries a (no-commit: …) marker. */
	optedOut: boolean;
}

/**
 * Analyze a task-list edit (editor old_text/new_text or apply_patch payload)
 * in terms of task lines added, removed, and checked off.
 */
function analyzeTaskEdit(
	content: string,
	input: unknown,
): TaskEditInfo | undefined {
	const record = asRecord(input);
	let added: string[];
	let removed: string[];

	const patch =
		typeof record?.input === "string"
			? record.input
			: typeof record?.patch === "string"
				? record.patch
				: undefined;
	if (patch !== undefined) {
		added = patch
			.split("\n")
			.filter((l) => l.startsWith("+") && !l.startsWith("+++"))
			.map((l) => l.slice(1));
		removed = patch
			.split("\n")
			.filter((l) => l.startsWith("-") && !l.startsWith("---"))
			.map((l) => l.slice(1));
	} else {
		const oldText =
			typeof record?.old_text === "string" ? record.old_text : "";
		const newText =
			typeof record?.new_text === "string" ? record.new_text : "";
		if (!newText && !oldText) return undefined;
		added = newText.split("\n");
		removed = oldText.split("\n");
	}

	const addedTasks = added.filter((l) => TASK_LINE_RE.test(l));
	const removedTasks = removed.filter((l) => TASK_LINE_RE.test(l));
	const removedUnchecked = new Set(
		removedTasks.filter((l) => UNCHECKED_LINE_RE.test(l)).map(taskText),
	);
	const flipped = addedTasks.filter(
		(l) => CHECKED_LINE_RE.test(l) && removedUnchecked.has(taskText(l)),
	);
	if (flipped.length === 0 && addedTasks.length === 0 && removedTasks.length === 0) {
		return undefined; // Edit does not touch task lines at all.
	}
	return {
		flipped: flipped.map(String),
		addedTasks,
		removedTasks,
		optedOut:
			flipped.length > 0 &&
			flipped.every((l) => NO_COMMIT_MARKER_RE.test(l)),
	};
}

/**
 * True when the commits between `base` and `head` touch at least one file
 * other than the task list itself or the plugin state file — committing the
 * check-off alone must not satisfy the commit-per-task gate.
 */
function commitsIncludeWork(
	root: string,
	base: string,
	head: string,
	taskFile: string,
): boolean {
	const diff = spawnSync("git", ["diff", "--name-only", `${base}..${head}`], {
		cwd: root,
		encoding: "utf8",
		timeout: 10_000,
	});
	if (diff.status !== 0) return true; // Cannot tell — do not block on git errors.
	const excluded = new Set([taskFile, TASK_STATE_FILE]);
	return diff.stdout
		.split("\n")
		.filter(Boolean)
		.some((f) => !excluded.has(f));
}

/**
 * Gate task check-offs:
 *  1. Tasks must be completed top-down — checking off a task while an earlier
 *     task is still unchecked is blocked (agents love skipping items).
 *  2. A check-off requires a new commit with real work since the previous
 *     completed task. Returns a skip result when the edit must be blocked.
 */
function taskCheckoffGate(
	root: string,
	taskFile: string,
	input: unknown,
): { skip: true; reason: string } | undefined {
	// Feature-branch git repos only.
	const branch = currentGitBranch(root);
	if (branch === undefined || branch === "" || PROTECTED_BRANCHES.has(branch)) {
		return undefined;
	}
	let content: string;
	try {
		content = readFileSync(resolve(root, taskFile), "utf8");
	} catch {
		return undefined; // Cannot read the list — other policies handle it.
	}
	const info = analyzeTaskEdit(content, input);
	if (!info) return undefined; // Edit does not touch task lines.

	// ── Final cleanup: all tasks done → remove the list, log the work ──
	// The completed tasks may only be removed from the list once CHANGELOG.md
	// records them under Unreleased — otherwise tasks silently vanish.
	if (!UNCHECKED_LINE_RE.test(content)) {
		const removedChecked = info.removedTasks.filter((l) =>
			CHECKED_LINE_RE.test(l),
		);
		if (removedChecked.length > 0) {
			if (info.optedOut) return undefined;
			let changelog: string;
			try {
				changelog = readFileSync(resolve(root, CHANGELOG_FILE), "utf8");
			} catch {
				console.error(
					"[workflow-guard] blocked task cleanup: no CHANGELOG.md",
				);
				return {
					skip: true,
					reason:
						`Blocked: all tasks are complete. Before removing them from ` +
						`${taskFile}, create ${CHANGELOG_FILE} with an '## Unreleased' ` +
						"section listing what was done (one bullet per task).",
				};
			}
			const missing = removedChecked.filter(
				(l) => !changelogHasUnreleasedEntry(changelog, taskText(l)),
			);
			if (missing.length > 0) {
				console.error(
					`[workflow-guard] blocked task cleanup: no changelog entry for "${taskText(missing[0] ?? "").slice(0, 80)}"`,
				);
				return {
					skip: true,
					reason:
						"Blocked: completed tasks may only be removed from the list " +
						`once they are recorded in ${CHANGELOG_FILE} under an ` +
						`'## Unreleased' section. Missing entry for: ` +
						missing.map((l) => `"${taskText(l).slice(0, 60)}"`).join(", ") +
						". Add the changelog entries first (this edit is exempt from " +
						"the commit-per-task gate), then remove the tasks.",
				};
			}
			// Legitimate cleanup — reset the baseline for the next request.
			const head = gitHead(root);
			if (head) writeTaskState(root, { head });
			return undefined;
		}
		// Pure additions to an all-checked list start the next request cycle.
		if (info.flipped.length === 0) {
			if (info.addedTasks.length > 0) {
				const head = gitHead(root);
				if (head) writeTaskState(root, { head });
			}
			return undefined;
		}
	}

	if (info.flipped.length === 0) {
		// ── Task-line removals mid-flight ──
		// Only checked lines carrying an explicit (no-commit: reason) marker
		// may be deleted; unchecked tasks must be checked off, not vanish.
		const flippedTexts = new Set(info.flipped.map(taskText));
		const removedChecked = info.removedTasks.filter(
			(l) => CHECKED_LINE_RE.test(l) && !flippedTexts.has(taskText(l)),
		);
		if (
			removedChecked.length > 0 &&
			removedChecked.every((l) => NO_COMMIT_MARKER_RE.test(l))
		) {
			return undefined; // Documented removals (obsolete task, with reason).
		}
		console.error(
			"[workflow-guard] blocked task removal: tasks must be checked off, not deleted",
		);
		return {
			skip: true,
			reason:
				"Blocked: task lines may not be removed from the list while work " +
				"is in progress — check them off (- [x]) instead, so nothing goes " +
				"missing. Once ALL tasks are checked, remove them together and " +
				`record them in ${CHANGELOG_FILE} under '## Unreleased'. If a ` +
				'task is genuinely obsolete, mark it "(no-commit: obsolete — ' +
				'reason)" before removing it.',
		};
	}
	// ── Top-down order: the first unchecked task must be the one completed ──
	const firstUnchecked = content.split("\n").find((l) => UNCHECKED_LINE_RE.test(l));
	if (firstUnchecked) {
		const expected = taskText(firstUnchecked);
		const skipped = info.flipped.filter((l) => taskText(l) !== expected);
		const firstSkipped = skipped[0];
		if (firstSkipped !== undefined) {
			console.error(
				`[workflow-guard] blocked out-of-order check-off: ${taskText(firstSkipped).slice(0, 80)}`,
			);
			return {
				skip: true,
				reason:
					"Blocked: tasks must be completed top-down. The first unchecked " +
					`task is "${expected.slice(0, 80)}" — complete and check off ` +
					"tasks in order; do not skip ahead. If an earlier task is " +
					"obsolete, remove it from the list first (with a note why).",
			};
		}
	}

	// ── Opt-out for doc-only / verification tasks ──
	if (info.optedOut) {
		const head = gitHead(root);
		if (head) writeTaskState(root, { head });
		return undefined;
	}

	// ── Commit-per-task checkpointing ──
	const head = gitHead(root);
	if (!head) return undefined; // No commits yet — nothing to compare.
	const state = readTaskState(root);
	if (state.head === undefined) {
		writeTaskState(root, { head });
		return undefined; // First check-off — establish the baseline.
	}
	if (state.head !== head) {
		if (commitsIncludeWork(root, state.head, head, taskFile)) {
			writeTaskState(root, { head });
			return undefined; // New work commit since last check-off — allowed.
		}
		console.error(
			"[workflow-guard] blocked task check-off: commits since the last " +
				"check-off only touch the task list itself",
		);
		return {
			skip: true,
			reason:
				"Blocked: the commits since the previous check-off only modify " +
				"the task list. Commit the actual work for this task first " +
				"(`git add … && git commit -m …`), then check it off.",
		};
	}
	console.error(
		"[workflow-guard] blocked task check-off: no new commit since the last completed task",
	);
	return {
		skip: true,
		reason:
			"Blocked: checking off a task requires a new commit since the " +
			"previous task was completed (commit-per-task checkpointing). " +
			"Commit the work first (`git add … && git commit -m …`), or — if " +
			"the task needs no commit (docs-only, verification) — append " +
			"\"(no-commit: reason)\" to the task line.",
	};
}

/**
 * Gate changelog edits while the task list is in its all-checked state:
 * the completed work must be recorded under '## Unreleased' (or, in a
 * changelog with no release sections yet, at the top of the file).
 */
function changelogGate(
	root: string,
	input: unknown,
): { skip: true; reason: string } | undefined {
	const taskFile = TASK_LIST_FILES.find((name) => {
		try {
			const content = readFileSync(resolve(root, name), "utf8");
			return content.split("\n").some((l) => TASK_LINE_RE.test(l));
		} catch {
			return false;
		}
	});
	if (!taskFile) return undefined; // No task list — nothing to enforce.
	let content: string;
	try {
		content = readFileSync(resolve(root, taskFile), "utf8");
	} catch {
		return undefined;
	}
	if (UNCHECKED_LINE_RE.test(content)) return undefined; // Work in progress.

	const record = asRecord(input);
	const addedText =
		typeof record?.new_text === "string"
			? record.new_text
			: typeof record?.input === "string"
				? record.input // apply_patch payload
				: typeof record?.patch === "string"
					? record.patch
					: "";
	if (/(^|\n|\+)#{1,6}\s*.*unreleased/i.test(addedText)) return undefined;

	let changelog = "";
	try {
		changelog = readFileSync(resolve(root, CHANGELOG_FILE), "utf8");
	} catch {
		// No changelog yet — a creation edit without an Unreleased heading is
		// still a reasonable start (the heading check applies to the task
		// cleanup, which re-verifies entries per task). Allow.
		return undefined;
	}
	if (/^#{1,6}\s+.*unreleased/im.test(changelog)) return undefined;

	console.error(
		"[workflow-guard] changelog edit while tasks await cleanup lacks an '## Unreleased' section",
	);
	return {
		skip: true,
		reason:
			"Blocked: all tasks are complete but not yet recorded. Add the " +
			"entries under an '## Unreleased' heading in CHANGELOG.md, then " +
			`remove the completed tasks from ${taskFile}.`,
	};
}

// ── Branch guard ─────────────────────────────────────────────────────────────
// All changes must be made on a feature branch, never directly on main/master.
// The check applies inside git repos only; non-git workspaces are unaffected.

const PROTECTED_BRANCHES = new Set(["main", "master"]);
const GIT_WRITE_RE =
	/\bgit\s+(commit|merge|rebase|cherry-pick|revert|stash\s+pop|apply|am|restore|reset)\b/;

function currentGitBranch(root: string): string | undefined {
	const result = spawnSync("git", ["branch", "--show-current"], {
		cwd: root,
		encoding: "utf8",
		timeout: 10_000,
	});
	if (result.status === 0 && result.stdout.trim()) {
		return result.stdout.trim();
	}
	// Fallback for unborn branches / odd runtimes: read .git/HEAD directly.
	try {
		const head = readFileSync(resolve(root, ".git", "HEAD"), "utf8").trim();
		const match = head.match(/^ref:\s+refs\/heads\/(\S+)/);
		if (match) return match[1];
	} catch {
		// Not a repo (or worktree without .git dir) — no gate.
	}
	if (result.status === 0) return ""; // detached HEAD — treat as unprotected
	return undefined;
}

function onProtectedBranch(root: string): boolean {
	const branch = currentGitBranch(root);
	return branch !== undefined && PROTECTED_BRANCHES.has(branch);
}

function branchGuardReason(): string {
	return (
		"Blocked: the workspace is on a protected branch (main/master). " +
		"Create a feature branch first — e.g. " +
		"`git switch -c feat/description` — and make all changes there, " +
		"then open a PR. Direct changes on main/master are not allowed."
	);
}

// ── Live-system guard ────────────────────────────────────────────────────────

const ALLOW_LIVE_MARKER = /#\s*allow-live\b/;

// Force push: --force / --force-with-lease / -f anywhere before the first
// separator in a `git push` command.
const FORCE_PUSH_RE =
	/\bgit\s+push\b[^|;&]*(--force\b|--force-with-lease\b|\s-f\b)/;

interface LivePattern {
	re: RegExp;
	what: string;
	/** When true the pattern is skipped on feature branches (git force pushes). */
	allowedOnFeatureBranch?: boolean;
}

const LIVE_MUTATION_PATTERNS: LivePattern[] = [
	// Only DESTRUCTIVE operations are blocked. Create/update/apply/set-style
	// commands are allowed — they're normal work and reviewable in diffs.
	// Infrastructure / orchestration
	{ re: /\bkubectl\s+(delete|drain|cordon)\b/, what: "destructive kubectl command" },
	{ re: /\bkubectl\s+rollout\s+(undo|restart)\b/, what: "destructive kubectl rollout" },
	{ re: /\bhelm\s+(uninstall|rollback|delete)\b/, what: "helm release removal/rollback" },
	{ re: /\b(terraform|tofu)\s+destroy\b/, what: "terraform/tofu destroy" },
	{ re: /\bpulumi\s+destroy\b/, what: "pulumi destroy" },
	// Cloud CLI deletions
	{ re: /\baz\s+\S+\s+(delete|purge)\b/, what: "Azure resource deletion" },
	{ re: /\baz\s+(devops|repos|pipelines|boards|artifacts)\s+[\w-]*\s*(delete|abandon)\b/, what: "Azure DevOps deletion" },
	{ re: /\baws\s+\S+\s+(delete|terminate)-?\w*\b/, what: "AWS resource deletion" },
	{ re: /\bgcloud\s+\S+\s+(delete|abandon)\b/, what: "GCP resource deletion" },
	// Database destruction via CLI clients (insert/update/create are allowed)
	{ re: /\b(psql|mysql|mariadb|mongosh|mongo|redis-cli|sqlite3)\b[^|;&]*\b(drop|delete|truncate|flushall|flushdb)\b/i, what: "destructive database command" },
	// Destructive remote HTTP calls (DELETE only; POST/PUT/PATCH are normal API work)
	{ re: /\bcurl\b(?=[^|;&]*(?:(?<!\S)(?:-X|--request)\s*=?\s*DELETE))(?=[^|;&]*https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]))/, what: "remote HTTP DELETE" },
	// Destructive git operations: force pushes are only destructive on
	// protected branches — rebasing/rewriting your own feature branch is
	// normal workflow. Pushes to main/master are blocked by Policy 2
	// regardless, and force pushes on main/master additionally match here.
	{
		re: FORCE_PUSH_RE,
		what: "force push",
		allowedOnFeatureBranch: true,
	},
];

function liveMutationIn(
	command: string,
	onFeatureBranch: boolean,
): string | undefined {
	for (const { re, what, allowedOnFeatureBranch } of LIVE_MUTATION_PATTERNS) {
		if (re.test(command)) {
			if (allowedOnFeatureBranch && onFeatureBranch) continue;
			return what;
		}
	}
	return undefined;
}

// ── MCP mutation tool guard ──────────────────────────────────────────────────
// MCP tools bypass the shell entirely, so they need their own name-based
// matching. Cline exposes MCP tools with names like `mcp__<server>__<tool>`;
// some runtimes use plain `<server>_<tool>` names instead, so both forms are
// matched. Read-only tool names (get/list/search/show/query/describe/…) are
// always allowed; mutating names are blocked unless explicitly allowed.

// Destructive verbs always block, even when the name also contains a
// read-only token (e.g. "github_delete_log", "ado_abandon_status_update").
const MCP_DESTRUCTIVE_VERB_RE =
	/(_delete|_remove|_merge|_abandon|_push|_trigger|_rerun)/;
const MCP_MUTATION_VERB_RE =
	/(_create|_update|_close|_edit|_set|_fork|_cancel|_add|_assign|_approve|_complete)/;
const MCP_READ_ONLY_RE =
	/(_get|_list|_search|_show|_query|_describe|_find|_read|_status|_diff|_log)/;

interface GuardedMcpServer {
	nameRe: RegExp;
	what: string;
}

const GUARDED_MCP_SERVERS: GuardedMcpServer[] = [
	{ nameRe: /(?:^|__)(?:github)(?:__|$)/i, what: "GitHub" },
	{ nameRe: /(?:^|__)(?:azure|azmcp|ado|devops)(?:__|$)/i, what: "Azure/Azure DevOps" },
	// Legacy flat naming: github_create_issue, azure_repos_pr_create, …
	{ nameRe: /(^|_)(github|azure|azmcp|ado|devops)(_|$)/i, what: "GitHub/Azure DevOps" },
];

function mcpMutationTool(toolName: string): string | undefined {
	const mutating =
		MCP_DESTRUCTIVE_VERB_RE.test(toolName) ||
		(MCP_MUTATION_VERB_RE.test(toolName) &&
			!MCP_READ_ONLY_RE.test(toolName));
	if (!mutating) {
		return undefined;
	}
	for (const { nameRe, what } of GUARDED_MCP_SERVERS) {
		if (nameRe.test(toolName)) {
			return what;
		}
	}
	return undefined;
}

// ── Cline settings tamper guard ──────────────────────────────────────────────
// The model must not be able to flip its own approval gates (e.g. enable YOLO
// mode or auto-approve "act" mode transitions) by editing settings files.

// Tamper patterns are evaluated per command segment (split on newlines, |, ;,
// &) so that tokens appearing on unrelated lines of a multi-line command can't
// combine into a false match. Segments are built in isSettingsTamper below.
const SETTINGS_TAMPER_PATTERNS: RegExp[] = [
	// Direct writes to Cline data/settings or globalStorage — the words must
	// appear within a single path-like token, not merely anywhere in a segment.
	/[\w\/.-]*(?:cline|saoudrizwan)[\w\/.-]*\b(?:settings|auto-approve|config|state)\b[\w\/.-]*\.(?:json|db|yaml)\b/i,
	// The well-known Cline settings file by name.
	/[\w\/.-]*\bauto-approve\.json\b/i,
	// CLI/TUI config edit commands — matched as command verbs, not bare words.
	/\bcline\s+(?:config|settings|auto-approve|yolo)\b/i,
	/\byolo\s+(?:mode|on|enable|true)\b/i,
];

function isSettingsTamper(command: string): boolean {
	// Evaluate each segment independently so regexes cannot span lines or
	// shell separators (a bare "\n" between "cline" and "settings" used to
	// combine into a false positive).
	const segments = command.split(/[\n|;&]+/);
	return segments.some((segment) =>
		SETTINGS_TAMPER_PATTERNS.some((re) => re.test(segment)),
	);
}

// Edit tools (editor / apply_patch) bypass the shell entirely, so the
// settings tamper guard must also match the *target path* of file edits.
// Approval settings may only be changed manually by the user in the UI.
const SETTINGS_FILE_PATTERNS: RegExp[] = [
	/(^|[/\\])auto-approve\.json$/i,
	// Global Cline data directory (settings, state DB, globalStorage).
	/[/\\]\.cline[/\\]data[/\\]/i,
	/[/\\]cline[^/\\]*[/\\](?:settings|state|config)\.(?:json|db|ya?ml)$/i,
	// VS Code globalStorage for the Cline extension.
	/[/\\]globalStorage[/\\]saoudrizwan\./i,
];

function isSettingsPath(path: string): boolean {
	return SETTINGS_FILE_PATTERNS.some((re) => re.test(path));
}

function branchHasChangelogChange(root: string): boolean {
	try {
		const baseCandidates = ["origin/HEAD", "origin/main", "origin/master"];
		for (const base of baseCandidates) {
			const mergeBase = spawnSync(
				"git",
				["merge-base", "HEAD", base],
				{ cwd: root, encoding: "utf8", timeout: 10_000 },
			);
			if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) continue;
			const diff = spawnSync(
				"git",
				["diff", "--name-only", `${mergeBase.stdout.trim()}...HEAD`],
				{ cwd: root, encoding: "utf8", timeout: 10_000 },
			);
			if (diff.status !== 0) continue;
			if (diff.stdout.split("\n").some((f) => /changelog/i.test(f))) {
				return true;
			}
		}
		// Last resort: diff against HEAD~1 (single-commit branches).
		const last = spawnSync("git", ["diff", "--name-only", "HEAD~1"], {
			cwd: root,
			encoding: "utf8",
			timeout: 10_000,
		});
		return (
			last.status === 0 &&
			last.stdout.split("\n").some((f) => /changelog/i.test(f))
		);
	} catch {
		return false;
	}
}

function prBodyIncludesChangelog(command: string): boolean {
	// Handle inline --body "..." with a Changelog section.
	const bodyMatch = command.match(/--body\s+(?:"([^"]*)"|'([^']*)')/);
	const body = bodyMatch?.[1] ?? bodyMatch?.[2] ?? "";
	if (CHANGELOG_SECTION_RE.test(body)) {
		return true;
	}
	// Handle --body-file <path> / -F <path>: read the referenced file.
	const bodyFileMatch = command.match(
		/(?:--body-file|-F)\s+(?:"([^"]*)"|'([^']*)'|(\S+))/,
	);
	const bodyFile =
		bodyFileMatch?.[1] ?? bodyFileMatch?.[2] ?? bodyFileMatch?.[3];
	if (bodyFile) {
		try {
			return CHANGELOG_SECTION_RE.test(
				readFileSync(resolve(workspaceRoot, bodyFile), "utf8"),
			);
		} catch {
			return false;
		}
	}
	return false;
}

const plugin: AgentPlugin = {
	name: "workflow-guard",
	manifest: {
		capabilities: ["hooks"],
	},

	setup(_api: unknown, ctx: SetupContext) {
		workspaceRoot = ctx.workspaceInfo?.rootPath ?? process.cwd();
	},

	hooks: {
		// Inject a Plan-mode reminder when a run starts so the model knows not
		// to attempt acting. This is advisory; the hard gate is YOLO/auto-approve
		// being disabled in settings.
		// NOTE: this must be `beforeRun` — the AgentExtension hooks bag supports
		// beforeRun/afterRun/beforeModel/afterModel/beforeTool/afterTool/onEvent
		// only (`run_start` is a .cline/hooks file stage name, not a plugin hook).
		async beforeRun(): Promise<undefined> {
			console.error(
				"[workflow-guard] run started — Plan mode is active; do not " +
				"switch to Act mode or execute mutations without explicit " +
				"user approval.",
			);
			return undefined;
		},

		async beforeTool({
			toolCall,
			input,
		}: BeforeToolContext): Promise<HookResult | undefined> {
			// ── Policies 1/7/9/10: edit tools (editor, apply_patch) ──────
			if (EDIT_TOOL_NAMES.has(toolCall.toolName)) {
				const targets = editTargets(input);

				// ── Policy 7: settings tamper via edit tools ──────────────
				// (The shell-based tamper check cannot see these writes.)
				for (const target of targets) {
					if (isSettingsPath(resolve(workspaceRoot, target))) {
						console.error(
							`[workflow-guard] blocked settings file edit: ${target.slice(0, 120)}`,
						);
						return {
							skip: true,
							reason:
								"Blocked: modifying Cline settings / auto-approve / YOLO " +
								"configuration is not allowed from the agent. The user " +
								"must change approval settings manually in the Cline UI.",
						};
					}
				}

				// Exact match against the known task-list files — a file merely
				// *ending* in e.g. "TASKS.md" (docs/TASKS.md, NOT_TASKS.md) does
				// not get the exemption.
				const taskFile = targets
					.map((t) => taskListNameForTarget(workspaceRoot, t))
					.find((name) => name !== undefined);
				const touchesOnlyTaskLists =
					targets.length > 0 &&
					targets.every(
						(t) => taskListNameForTarget(workspaceRoot, t) !== undefined,
					);

				// Changelog writes are part of the task-completion ceremony, so
				// they are exempt from the task-list gate — but when all tasks
				// are complete the entry must appear under '## Unreleased'.
				const touchesOnlyChangelog =
					targets.length > 0 &&
					targets.every(
						(t) =>
							resolve(workspaceRoot, t) ===
							resolve(workspaceRoot, CHANGELOG_FILE),
					);
				if (touchesOnlyChangelog) {
					const gate = changelogGate(workspaceRoot, input);
					if (gate) return gate;
					if (!onProtectedBranch(workspaceRoot)) return undefined;
					// On main/master, fall through to the branch guard below.
				}

				// ── Policy 10: commit-per-task + top-down check-off gate ──
				if (taskFile) {
					const gate = taskCheckoffGate(workspaceRoot, taskFile, input);
					if (gate) return gate;
				}

				// ── Policy 9: no edits on protected branches ──────────────
				if (
					!touchesOnlyTaskLists &&
					onProtectedBranch(workspaceRoot)
				) {
					console.error(
						`[workflow-guard] blocked ${toolCall.toolName}: on protected branch ${currentGitBranch(workspaceRoot)}`,
					);
					return { skip: true, reason: branchGuardReason() };
				}

				// ── Policy 1: edits require an active task list ───────────
				if (!touchesOnlyTaskLists && !findActiveTaskList(workspaceRoot)) {
					console.error(
						`[workflow-guard] blocked ${toolCall.toolName}: no active task list`,
					);
					return {
						skip: true,
						reason:
							"Blocked: no active task list found. First create " +
							"TASKS.md (or TODO.md / PLAN.md / .cline/plan.md) in the " +
							"workspace root with the request broken down as '- [ ]' " +
							"checkbox items, then work through them top to bottom.",
					};
				}
				return undefined;
			}

			const allowLive =
				process.env.WORKFLOW_GUARD_ALLOW_LIVE === "1";

			// ── Policy 5: MCP tools that mutate GitHub / Azure / DevOps ──
			// MCP calls carry no command string, so the only override is the
			// WORKFLOW_GUARD_ALLOW_LIVE env var.
			if (!allowLive) {
				const mcpWhat = mcpMutationTool(toolCall.toolName);
				if (mcpWhat) {
					console.error(
						`[workflow-guard] blocked MCP tool ${toolCall.toolName} (${mcpWhat} mutation)`,
					);
					return {
						skip: true,
						reason:
							`Blocked: ${toolCall.toolName} mutates ${mcpWhat} — a live ` +
							"system. Changes must be made in code unless the user " +
							"explicitly allows live changes. To override, the user must " +
							"restart the agent with WORKFLOW_GUARD_ALLOW_LIVE=1.",
					};
				}
			}

			if (!SHELL_TOOL_NAMES.has(toolCall.toolName)) {
				return undefined;
			}

			const commands = extractCommands(input);
			for (const raw of commands) {
				const command = normalize(raw);

				// ── Policy 8: changes only on feature branches ───────────
				// Block git history-changing commands while on main/master.
				if (GIT_WRITE_RE.test(command) && onProtectedBranch(workspaceRoot)) {
					console.error(
						`[workflow-guard] blocked git write on protected branch: ${command.slice(0, 120)}`,
					);
					return { skip: true, reason: branchGuardReason() };
				}

				// ── Policy 6: block self-modification of approval gates ──
				if (isSettingsTamper(command)) {
					console.error(
						`[workflow-guard] blocked settings tamper: ${command.slice(0, 120)}`,
					);
					return {
						skip: true,
						reason:
							"Blocked: modifying Cline settings / auto-approve / YOLO " +
							"configuration is not allowed from the agent. The user " +
							"must change approval settings manually in the Cline UI.",
					};
				}

				// ── Policy 4: live-system mutations need explicit opt-in ──
				if (!allowLive && !ALLOW_LIVE_MARKER.test(command)) {
					const what = liveMutationIn(
					command,
					(() => {
						const branch = currentGitBranch(workspaceRoot);
						return (
							branch !== undefined &&
							branch !== "" &&
							!PROTECTED_BRANCHES.has(branch)
						);
					})(),
				);
					if (what) {
						console.error(
							`[workflow-guard] blocked ${what}: ${command.slice(0, 120)}`,
						);
						return {
							skip: true,
							reason:
								`Blocked: ${what} targets a live system. Changes must be ` +
								"made in code (IaC, migrations, source) unless the user " +
								"explicitly allows live changes. To override: re-run with " +
								"'# allow-live' appended to the command, or set " +
								"WORKFLOW_GUARD_ALLOW_LIVE=1.",
						};
					}
				}

				// ── Policy 1: block git push to main/master ──────────────────
				if (PUSH_TO_MAIN_RE.test(command)) {
					console.error(
						`[workflow-guard] blocked push to main/master: ${command}`,
					);
					return {
						skip: true,
						reason:
							"Blocked: direct pushes to main/master are not allowed. " +
							"Create a feature branch and open a PR instead.",
					};
				}

				// ── Policy 2: PRs must include a changelog ─────────────────────
				if (PR_CREATE_RE.test(command)) {
					const hasChangelog =
						prBodyIncludesChangelog(command) ||
						branchHasChangelogChange(workspaceRoot);
					if (!hasChangelog) {
						console.error(
							"[workflow-guard] blocked gh pr create: no changelog found",
						);
						return {
							skip: true,
							reason:
								"Blocked: PR must include a changelog. Either update a " +
								"CHANGELOG file in this branch's diff, or include a " +
								"'Changelog:' section in the PR body (--body).",
						};
					}
				}
			}

			return undefined;
		},
	},
};

export { plugin };
export default plugin;
