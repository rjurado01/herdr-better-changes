// Modified from munza/herdr-mods: adds review comments, context controls and syntax highlighting.
// Sidebar status/commit controls and a reusable diff-tab view share this class.
// Pure Git-output parsing and diff-row transformations live in model.js.
import { em, codeFont } from "./typography.js";
import { loadSettings, duration } from "./settings.js";
import { changedFiles, fileTree, diffRows, splitDiffRows, parseLog, commitFiles, timeAgo, githubRepo } from "./model.js";
import { highlightDiff } from "./syntax.js";
import { View, div, svg } from "gpui-kit";
import {
  v_flex,
  h_flex,
  TextareaState,
  Textarea,
  Popover,
  Scrollbar,
  v_virtual_list,
} from "gpui-base";
import {
  spaces,
  panes,
  agents,
  focused,
  exec,
  readTextFile,
  watchFolder,
  theme,
  props,
  shared,
  setShared,
  run,
  layout,
  nextCommand,
} from "herdr";

// Status polling must not take optional index locks or trigger filesystem-monitor
// helpers. Diff reads also disable external diff/textconv helpers at the call site.
const READ_ONLY_GIT_OPTIONS = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.autoRefreshIndex=false",
];
const MAX_FILES = 1000;
const MAX_DIFF_LINES = 1500;
const MAX_LINE_LENGTH = 4000;
const CONTEXT_POLL_MS = 300;
const STATUS_POLL_MS = 10000;
const TAB_OPEN_TIMEOUT_MS = 1500;
const COMMIT_PAGE = 50;
// Preferences a person may change in the installed mod.json under `settings`.
const DEFAULT_SETTINGS = {
  refresh: { status: "10s" },
  limits: { files: 1000, diff_lines: 1500, line_length: 4000, commits_per_page: 50 },
  default: { view: "tree", diff: "inline" },
};
const LOG_FORMAT = "--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%b%x1e";

// Follow the active terminal unless the active tab is our diff viewer. Mod panes
// have no terminal cwd, so that case must use the repository saved for the tab.
function location() {
  const space = spaces().find((s) => s.active);
  const tab = space?.tabs?.find((t) => t.active)?.id;
  const candidates = panes().filter((p) => p.tab === tab && p.cwd);
  if (!candidates.length && panes().some((p) => p.tab === tab && p.mod === "better-changes")) {
    const source = (shared("better-changes.diff-tabs") ?? {})[space?.id]?.source;
    if (source) return source;
  }
  return {
    cwd:
      candidates.find((p) => p.focused)?.cwd ??
      candidates[0]?.cwd ??
      focused()?.cwd ??
      space?.folder,
    on: space?.machine ?? null,
  };
}

// One View class serves two roles: a sidebar and a regular diff tab. Each copy
// owns its local state; shared("better-changes.*") connects the separate copies.
export default class Changes extends View {
  // ── Lifecycle and cross-view synchronization ──────────────────────────────

  init(_props, cx) {
    this.mode = props()?.mode ?? _props?.mode ?? "sidebar";
    this.diffSpace = props()?.space ?? _props?.space;
    this.source = props()?.source ?? _props?.source;
    this.restoreDiffSelection(_props);
    this.settings = DEFAULT_SETTINGS;
    this.view = localStorage.getItem("better-changes.view") === "flat" ? "flat" : "tree";
    // Optional Better Tabs integration: an icon for the diff tab.
    setShared("mod-icons", {
      ...(shared("mod-icons") ?? {}),
      "better-changes": "mods/better-changes/file.svg",
    });
    this.tab = localStorage.getItem("better-changes.tab") === "commits" ? "commits" : "changes";
    this.resetCommits();
    this.diffLayout =
      shared("better-changes.diff-layout") ??
      (localStorage.getItem("better-changes.diff-layout") === "split" ? "split" : "inline");
    if (this.mode === "sidebar" || !shared("better-changes.diff-layout"))
      setShared("better-changes.diff-layout", this.diffLayout);
    // Local display state. Collapsed folders use "scope:path" keys so staged
    // and unstaged groups can collapse the same directory independently.
    this.splitOffset = 0;
    this.closed = new Set();
    this.files = [];
    this.rows = [];
    this.diffContext = 3;
    this.diffToken = 0; // Monotonically increasing ID for async preview requests.
    this.message = "";
    this.messageRevision = 0;
    this.commitMode = "commit";
    this.commitMenuOpen = false;
    this.commitMenuIndex = 0;
    this.commitTriggerFocus = cx.focus_handle();
    this.commitMenuFocus = cx.focus_handle();
    this.amendToken = 0;
    this.amendLoading = false;
    this.amendHead = null;
    this.input = TextareaState.new({ placeholder: "Commit message…", rows: 4 });
    this.commentInput = TextareaState.new({ placeholder: "Comentario para OpenCode…", rows: 3 });
    this.commentInput.on("change", (_e, cx) => cx.notify());
    this.commentSelection = null;
    this.commentTarget = null;
    this.commentBusy = false;
    this.commentNotice = null;
    this.input.on("change", (_e, cx) => {
      this.message = this.input.value();
      this.messageRevision++;
      cx.notify();
    });
    // Enter belongs to the multiline editor. Only the explicit button commits.
    this.startPolling(cx);
    this.listenForCommands(cx);
    this.refresh(cx);
  }

  // A reopened diff tab can restore its selection from local storage. Never
  // replace an existing shared entry: it may contain a more recent file pick.
  restoreDiffSelection(_props) {
    if (this.mode === "diff" && this.diffSpace) {
      const entries = shared("better-changes.diff-tabs") ?? {};
      if (!entries[this.diffSpace]) {
        let selected = props()?.selection ?? _props?.selection;
        let source = this.source;
        try {
          const saved = JSON.parse(localStorage.getItem("diff.selection"));
          if (typeof saved?.path === "string" && typeof JSON.parse(saved.context)?.cwd === "string")
            selected = saved;
        } catch {
          // Missing or malformed saved state is harmless; use the supplied props.
        }
        try {
          if (selected) source = JSON.parse(selected.context);
        } catch {
          selected = null;
        }
        setShared("better-changes.diff-tabs", {
          ...entries,
          [this.diffSpace]: { source, selection: selected },
        });
      }
    }
  }

  // Context changes need a quick response; full Git status reads are slower.
  // Remote repositories rely on polling because watchFolder is local-only.
  startPolling(cx) {
    cx.timer.every(CONTEXT_POLL_MS, (cx) => {
      const style = shared("better-changes.diff-layout");
      if (style && style !== this.diffLayout) {
        this.diffLayout = style;
        localStorage.setItem("better-changes.diff-layout", style);
        cx.notify();
      }
      if (this.contextKey() !== this.context) this.refresh(cx);
      if (this.mode === "diff") this.syncSelection(cx);
      const reload = shared("better-changes.reload");
      if (
        reload &&
        reload.at !== this.reload &&
        reload.root === this.root &&
        reload.on === (this.on ?? null) &&
        !this.loading &&
        !this.busy
      ) {
        this.reload = reload.at;
        this.refresh(cx);
      }
    });
    this.applySettings(cx);
  }

  listenForCommands(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "diff-inline" || command === "diff-split")
          this.setDiffLayout(command.slice(5), cx);
        if (command.startsWith("open:")) {
          const file = this.files.find((f) => f.path === command.slice(5));
          if (file) this.pick(file, cx);
        }
      }
    });
  }

  // ── Repository context and status ─────────────────────────────────────────

  location() {
    return this.mode === "diff"
      ? ((shared("better-changes.diff-tabs") ?? {})[this.diffSpace]?.source ??
          this.source ??
          location())
      : (this.source ?? location());
  }

  // Include both cwd and machine: identical paths on different machines are
  // different repositories. Async reads compare this key before publishing.
  contextKey() {
    return JSON.stringify(this.location());
  }

  currentSelection() {
    return this.mode === "diff"
      ? ((shared("better-changes.diff-tabs") ?? {})[this.diffSpace]?.selection ??
          shared("better-changes.selection"))
      : shared("better-changes.selection");
  }

  diffTab(space = this.diffSpace) {
    const target = spaces().find((s) => s.id === space);
    const ids = new Set((target?.tabs ?? []).map((t) => t.id));
    return panes().find((p) => p.mod === "better-changes" && ids.has(p.tab))?.tab;
  }

  git(args, root = this.root, on = this.on) {
    return exec("git", [...READ_ONLY_GIT_OPTIONS, ...args], { cwd: root, on });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = this.location();
    const context = this.contextKey();
    // Clear every repository-specific field before loading the new context.
    // Incrementing diffToken invalidates previews still in flight.
    if (context !== this.context) {
      this.context = context;
      this.root = null;
      this.files = [];
      this.committed = null;
      this.path = null;
      this.rows = [];
      this.closed = new Set();
      this.diffToken++;
      this.selection = null;
      this.diffLoading = false;
      this.error = null;
      this.note = null;
      this.watched = null;
      this.message = "";
      this.input.set_value("");
      this.commitMode = "commit";
      this.commitMenuOpen = false;
      this.amendToken++;
      this.amendLoading = false;
      this.amendHead = null;
      this.resetCommits();
      this.repo = null;
    }
    if (!cwd) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const top = await this.git(["rev-parse", "--show-toplevel"], cwd, on);
        if (context !== this.contextKey()) return;
        if (top.code !== 0) {
          this.root = null;
          this.files = [];
          this.rows = [];
          this.error = "Not a Git repository";
          return;
        }
        const root = top.stdout.trim();
        const git = (args) => this.git(args, root, on);
        const status = await git([
          "status",
          "--porcelain=v1",
          "-z",
          "--no-renames",
          "--untracked-files=all",
        ]);
        if (status.code !== 0) throw Error(status.stderr || "Cannot read changes");
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const hasHead = head.code === 0;
        const statArgs = ["--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv"];
        const stats = [
          await git(["diff", "--cached", ...statArgs]),
          await git(["diff", ...statArgs]),
        ];
        for (const stat of stats)
          if (stat.code !== 0) throw Error(stat.stderr || "Cannot read change statistics");
        // Only the sidebar links commits to GitHub; a missing or foreign remote is fine.
        const origin = this.mode === "sidebar" ? await git(["remote", "get-url", "origin"]) : null;
        if (context !== this.contextKey()) return;
        this.repo = origin?.code === 0 ? githubRepo(origin.stdout) : null;
        const files = changedFiles(
          status.stdout,
          stats.map((r) => r.stdout),
        );
        this.root = root;
        this.on = on;
        this.hasHead = hasHead;
        this.total = files.length;
        this.stagedCount = files.filter((f) => f.staged).length;
        this.unstagedCount = files.filter((f) => f.unstaged).length;
        this.conflicts = files.some((f) => f.conflict);
        this.files = files.slice(0, this.settings.limits.files || MAX_FILES);
        this.error = null;
        if (this.mode === "sidebar") {
          const committed = await this.readCommitted(git);
          if (context !== this.contextKey()) return;
          this.committed = committed;
        }
        this.watch(root, cx);
        if (this.mode === "sidebar" && this.tab === "commits") this.loadCommits(cx);
        if (this.mode === "diff") {
          this.syncSelection(cx);
          if (this.path && !this.diffLoading) this.loadDiff(cx);
        }
      } catch (error) {
        if (context === this.contextKey()) this.error = error.message;
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch {
        if (this.watched === root) this.watched = null;
      }
    });
  }
  // ── Files committed on this branch ────────────────────────────────────────

  // What this branch adds over the remote's default branch, or over its upstream
  // when the clone never recorded a default. On the default branch itself that
  // is what is not pushed yet. Null when there is nothing to compare with. These
  // read the last fetch and never fetch.
  async readCommitted(git) {
    try {
      const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
      const tracked = upstream.code === 0 ? upstream.stdout.trim() : null;
      const remote = tracked?.split("/")[0] ?? "origin";
      const fallback = tracked ? { ref: "@{u}", name: tracked } : null;
      const remoteHead = await git(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
      const against =
        remoteHead.code === 0 && remoteHead.stdout.trim()
          ? { ref: `refs/remotes/${remote}/HEAD`, name: remoteHead.stdout.trim() }
          : fallback;
      if (!against) return null;
      const base = await git(["merge-base", "HEAD", against.ref]);
      const head = await git(["rev-parse", "--verify", "HEAD"]);
      if (base.code !== 0 || head.code !== 0) return null;
      const from = base.stdout.trim();
      const key = `${from}:${head.stdout.trim()}`;
      // Polled with the status, and only a new commit or fetch can change it.
      if (this.committed?.key === key) return this.committed;
      const diff = (flag) =>
        git(["diff", "--no-renames", "--no-ext-diff", "--no-textconv", flag, "-z", from, "HEAD"]);
      const numstat = await diff("--numstat");
      const names = await diff("--name-status");
      if (numstat.code !== 0 || names.code !== 0) return null;
      const files = commitFiles(numstat.stdout, names.stdout);
      return {
        key,
        base: from,
        name: against.name,
        total: files.length,
        files: files.slice(0, this.settings.limits.files || MAX_FILES),
      };
    } catch {
      return null;
    }
  }

  // ── File selection and reusable diff tabs ─────────────────────────────────

  pick(file, cx, scope = "all") {
    const space = spaces().find((s) => s.active);
    if (!space) return;
    const selected = {
      context: this.context,
      root: this.root,
      on: this.on,
      path: file.path,
      scope,
      at: Date.now(),
    };
    if (scope === "commit") {
      // The diff tab has no commit list, so the pick carries what it needs.
      const { hash, short, subject } = this.selectedCommit;
      selected.commit = { hash, short, subject };
      selected.file = file;
    }
    if (scope === "committed") {
      selected.commit = { base: this.committed.base, name: this.committed.name };
      selected.file = file;
    }
    const entries = shared("better-changes.diff-tabs") ?? {};
    const old = entries[space.id];
    const tab = this.diffTab(space.id);
    const source = JSON.parse(this.context);
    const name = file.path.split("/").pop();
    // Publish before opening/selecting the tab so its View sees the latest pick.
    // A pending timestamp prevents rapid clicks from creating duplicate tabs.
    setShared("better-changes.selection", selected);
    setShared("better-changes.diff-tabs", {
      ...entries,
      [space.id]: {
        source,
        selection: selected,
        pending: tab ? null : (old?.pending ?? Date.now()),
      },
    });
    if (tab) {
      run("tab.rename", { id: tab, name });
      run("tab.select", { id: tab });
    } else if (!old?.pending || Date.now() - old.pending > TAB_OPEN_TIMEOUT_MS) {
      run("tab.new", {
        space: space.id,
        name,
        mod: "better-changes",
        props: { mode: "diff", space: space.id, source, selection: selected },
      });
    }
    // Layouts with an optional center stack (such as Factory) need their tab view
    // revealed. Ordinary Herdr layouts already show the selected tab directly.
    const find = (node) =>
      node?.id === "center-body" ? node : (node?.children ?? []).map(find).find(Boolean);
    const center = find(layout());
    if (center?.type === "stack" && center.children?.some((child) => child.id === "main"))
      run("layout.select", { stack: center.id, child: "main" });
    cx.notify();
  }

  syncSelection(cx) {
    const selected = this.currentSelection();
    if (!selected || selected.context !== this.context) {
      if (this.path) {
        this.path = null;
        this.rows = [];
        this.diffToken++;
        this.diffLoading = false;
        cx.notify();
      }
      return;
    }
    const id = JSON.stringify(selected);
    if (id === this.selection) return;
    localStorage.setItem("diff.selection", JSON.stringify(selected));
    const tab = this.diffTab();
    if (tab) {
      const name = selected.path.split("/").pop();
      const live = spaces()
        .find((s) => s.id === this.diffSpace)
        ?.tabs?.find((t) => t.id === tab);
      if (live?.name !== name) run("tab.rename", { id: tab, name });
      const entries = shared("better-changes.diff-tabs") ?? {};
      if (entries[this.diffSpace]?.pending)
        setShared("better-changes.diff-tabs", {
          ...entries,
          [this.diffSpace]: { ...entries[this.diffSpace], pending: null },
        });
    }
    this.splitOffset = 0;
    this.selection = id;
    this.path = selected.path;
    this.scope = selected.scope || "all";
    this.commitRef = selected.commit ?? null;
    this.commitFile = selected.file ?? null;
    this.rows = [];
    this.note = null;
    this.diffToken++;
    this.diffLoading = false;
    if (this.root) this.loadDiff(cx);
    cx.notify();
  }
  // ── Read-only diff loading ────────────────────────────────────────────────

  loadDiff(cx) {
    const path = this.path;
    const context = this.context;
    const root = this.root;
    const on = this.on;
    const hasHead = this.hasHead;
    const scope = this.scope || "all";
    const commit = this.commitRef;
    const file =
      scope === "commit" || scope === "committed"
        ? this.commitFile
        : this.files.find((f) => f.path === path);
    const token = ++this.diffToken;
    this.note = null;
    if (!file) {
      this.rows = [];
      this.note = `This file has no remaining changes, or is outside the first ${(this.settings.limits.files || MAX_FILES).toLocaleString()} listed files.`;
      this.diffLoading = false;
      cx.notify();
      return;
    }
    if ((scope === "staged" && !file.staged) || (scope === "unstaged" && !file.unstaged)) {
      this.rows = [];
      this.note = `No ${scope} changes remain for this file.`;
      this.diffLoading = false;
      cx.notify();
      return;
    }
    this.diffLoading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        let lines;
        // Untracked files (and all-changes previews before the first commit)
        // have no HEAD version to diff against. Build an all-additions hunk.
        if (file.fresh || (!hasHead && file.status === "A" && scope === "all")) {
          const text = await readTextFile(`${root}/${path}`, { on });
          if (text === null)
            lines = ["Cannot preview this file: binary, too large, or unreadable."];
          else if (text.includes("\0")) lines = ["Binary file · no text diff"];
          else if (!text) lines = ["Empty new file"];
          else {
            const all = text.replace(/\n$/, "").split("\n");
            file.add = all.length;
            lines = [`@@ -0,0 +1,${all.length} @@`, ...all.map((line) => `+${line}`)];
          }
        } else {
          // `--` separates paths from options, but still allows Git patterns.
          // Treat the selected filename literally, just like index mutations.
          const result = await this.git(
            [
              "--literal-pathspecs",
              ...(scope === "commit"
                ? ["show", "--diff-merges=first-parent", "--format=", commit.hash]
                : scope === "committed"
                  ? ["diff", commit.base, "HEAD"]
                  : [
                    "diff",
                    ...(scope === "staged"
                      ? ["--cached"]
                      : scope === "unstaged"
                        ? []
                        : hasHead
                          ? ["HEAD"]
                          : []),
                  ]),
              "--no-ext-diff",
              "--no-textconv",
              "--no-color",
              `--unified=${this.diffContext}`,
              "--",
              path,
            ],
            root,
            on,
          );
          if (result.code !== 0) throw Error(result.stderr || "Cannot read diff");
          const all = result.stdout.replace(/\n$/, "").split("\n");
          const first = all.findIndex((line) => line.startsWith("@@"));
          lines =
            first < 0
              ? [
                  file.binary
                    ? "Binary file changed"
                    : "No text diff available (mode-only or submodule change)",
                ]
              : all.slice(first);
        }
        // A later click or repository switch may have overtaken this request.
        if (token !== this.diffToken || context !== this.contextKey()) return;
        const maxLines = this.settings.limits.diff_lines || MAX_DIFF_LINES;
        const maxLength = this.settings.limits.line_length || MAX_LINE_LENGTH;
        this.truncated =
          lines.length > maxLines || lines.some((line) => line.length > maxLength);
        const visible = lines
          .slice(0, maxLines)
          .map((line) =>
            line.length > maxLength ? line.slice(0, maxLength) + "…" : line,
          );
        this.rows = diffRows(visible);
        this.syntaxTokens = highlightDiff(this.rows.map(row => ({ ...row, new: row.next })), path);
        this.width = Math.max(300, ...visible.map((line) => line.length * em(0.7) + 110));
      } catch (error) {
        if (token === this.diffToken && context === this.contextKey()) {
          this.rows = [];
          this.note = error.message;
        }
      } finally {
        if (token === this.diffToken) {
          this.diffLoading = false;
          cx.notify();
        }
      }
    });
  }
  // Read the installed mod.json once, then start the status poll at its pace.
  // The view and diff defaults apply only where nothing was chosen before.
  applySettings(cx) {
    cx.spawn(async (cx) => {
      const { settings, problems } = await loadSettings("better-changes", DEFAULT_SETTINGS);
      this.settings = settings;
      for (const problem of problems) console.warn(`better-changes mod.json settings: ${problem}`);
      if (localStorage.getItem("better-changes.view") === null && ["tree", "flat"].includes(settings.default.view))
        this.view = settings.default.view;
      if (
        this.mode === "sidebar" &&
        localStorage.getItem("better-changes.diff-layout") === null &&
        ["inline", "split"].includes(settings.default.diff)
      ) {
        this.diffLayout = settings.default.diff;
        setShared("better-changes.diff-layout", this.diffLayout);
      }
      // A floor, so a bare number read as milliseconds cannot spin Git.
      const every = Math.max(1000, duration(settings.refresh.status, STATUS_POLL_MS));
      cx.timer.every(every, (cx) => this.refresh(cx));
      cx.notify();
    });
  }

  // ── Git mutations (sidebar only) ──────────────────────────────────────────

  // Never reset working files. Unstage changes only the index; before the first
  // commit there is no HEAD, so remove index entries with git rm --cached.
  // Literal pathspecs keep names such as [sample].txt from acting as patterns.
  indexAction(action, path, cx) {
    if (
      !this.root ||
      this.loading ||
      this.busy ||
      this.contextKey() !== this.context ||
      this.mode !== "sidebar"
    )
      return;
    if (
      path &&
      !this.files.some((f) => f.path === path && (action === "stage" ? f.unstaged : f.staged))
    )
      return;
    const root = this.root;
    const on = this.on;
    const context = this.context;
    let args;
    if (action === "stage")
      args = path ? ["--literal-pathspecs", "add", "--", path] : ["add", "-A"];
    else if (action === "unstage")
      args = this.hasHead
        ? ["--literal-pathspecs", "reset", "-q", "HEAD", "--", path || "."]
        : ["--literal-pathspecs", "rm", "--cached", "-r", "-f", "--", path || "."];
    else return;
    this.busy = true;
    this.operation = action;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await this.git(args, root, on);
        if (result.code !== 0) throw Error((result.stderr || result.stdout).trim());
        const at = Date.now();
        this.reload = at;
        setShared("better-changes.reload", { root, on: on ?? null, at });
      } catch (error) {
        if (context === this.contextKey())
          this.note = `${action === "stage" ? "Stage" : "Unstage"} failed: ${error.message}`;
      } finally {
        this.busy = false;
        this.operation = null;
        this.refresh(cx);
        cx.notify();
      }
    });
  }

  setCommitMode(mode, cx) {
    if (
      !["commit", "amend"].includes(mode) ||
      !this.root ||
      this.loading ||
      this.busy ||
      this.contextKey() !== this.context ||
      this.mode !== "sidebar" ||
      (mode === "amend" && !this.hasHead)
    )
      return;

    this.commitMode = mode;
    this.commitMenuOpen = false;
    this.note = null;
    this.amendHead = null;
    const token = ++this.amendToken;
    this.amendLoading = mode === "amend";
    cx.notify();
    if (mode !== "amend") return;

    const context = this.context;
    const root = this.root;
    const on = this.on;
    const revision = this.messageRevision;
    cx.spawn(async (cx) => {
      try {
        // Read the commit ID and full message together. Never replace a draft
        // the user already wrote, or one edited while this read was in flight.
        const result = await this.git(["log", "-1", "--format=%H%x00%B"], root, on);
        if (token !== this.amendToken || context !== this.contextKey()) return;
        if (result.code !== 0) throw Error((result.stderr || result.stdout).trim());
        const separator = result.stdout.indexOf("\0");
        const head = result.stdout.slice(0, separator);
        if (separator < 0 || !/^[0-9a-f]{40,64}$/i.test(head))
          throw Error("Cannot read the latest commit.");
        this.amendHead = head;
        if (!this.message.trim() && this.messageRevision === revision) {
          this.message = result.stdout.slice(separator + 1).trimEnd();
          this.input.set_value(this.message);
        }
      } catch (error) {
        if (token === this.amendToken && context === this.contextKey())
          this.note = `Cannot prepare amend: ${error.message}`;
      } finally {
        if (token === this.amendToken) {
          this.amendLoading = false;
          cx.notify();
        }
      }
    });
  }

  canCommit() {
    const ready =
      this.message.trim() &&
      this.root &&
      !this.busy &&
      !this.loading &&
      !this.conflicts &&
      this.mode === "sidebar" &&
      this.contextKey() === this.context;
    // A message-only amend is valid; a new commit still needs staged changes.
    return Boolean(
      ready &&
      (this.commitMode === "amend"
        ? this.hasHead && this.amendHead && !this.amendLoading
        : this.stagedCount),
    );
  }

  // Both operations use the existing index, never `-a` or an implicit stage-all.
  // Preserve the draft on failure, and any new text typed during a successful write.
  commit(cx) {
    if (!this.canCommit()) return;
    const root = this.root;
    const on = this.on;
    const context = this.context;
    const originalMessage = this.message;
    const message = originalMessage.trim();
    const amend = this.commitMode === "amend";
    const expectedHead = this.amendHead;
    this.busy = true;
    this.operation = amend ? "amend" : "commit";
    this.commitMenuOpen = false;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (amend) {
          // Recheck after the human edits the message: another tool may have
          // advanced HEAD since they selected Amend. Do not rewrite it silently.
          const head = await this.git(["rev-parse", "--verify", "HEAD"], root, on);
          if (head.code !== 0 || head.stdout.trim() !== expectedHead)
            throw Error("Latest commit changed. Choose Amend again before retrying.");
        }
        const args = ["commit", ...(amend ? ["--amend"] : []), "-m", message];
        const result = await this.git(args, root, on);
        if (result.code !== 0) throw Error((result.stderr || result.stdout).trim());
        const at = Date.now();
        this.reload = at;
        setShared("better-changes.reload", { root, on: on ?? null, at });
        if (context === this.contextKey()) {
          if (this.message === originalMessage) {
            this.message = "";
            this.input.set_value("");
          }
          this.commitMode = "commit";
          this.amendHead = null;
        }
      } catch (error) {
        if (context === this.contextKey())
          this.note = `${amend ? "Amend" : "Commit"} failed: ${error.message}`;
      } finally {
        this.busy = false;
        this.operation = null;
        this.refresh(cx);
        cx.notify();
      }
    });
  }
  // ── Commit history (sidebar only) ─────────────────────────────────────────

  resetCommits() {
    this.commits = [];
    this.upstream = null;
    this.remoteHead = null;
    this.commitsDone = false;
    this.commitsLoading = false;
    this.commitsError = null;
    this.selectedCommit = null;
    this.commitFiles = [];
    this.commitFilesLoading = false;
    this.commitFilesError = null;
    // History and the open commit load independently, so each has its own token.
    this.commitsToken = (this.commitsToken ?? 0) + 1;
    this.commitToken = (this.commitToken ?? 0) + 1;
  }

  setTab(tab, cx) {
    this.tab = tab;
    localStorage.setItem("better-changes.tab", tab);
    if (tab === "commits" && !this.commits.length) this.loadCommits(cx);
    cx.notify();
  }

  // Reload keeps the pages already shown; `more` appends the next page.
  // Where the branch's remote head was at the last fetch: {name, unpushed, behind},
  // or null when the branch tracks nothing. This never fetches.
  async readUpstream() {
    const name = await this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if (name.code !== 0) return null;
    const sides = await this.git(["rev-list", "--left-right", "HEAD...@{u}"]);
    if (sides.code !== 0) return null;
    const lines = sides.stdout.split("\n");
    return {
      name: name.stdout.trim(),
      unpushed: new Set(lines.filter((l) => l[0] === "<").map((l) => l.slice(1))),
      behind: lines.filter((l) => l[0] === ">").length,
    };
  }

  // The remote's default branch, from the upstream's remote or else origin:
  // {name, target, base, behind}, with base the last commit shared with it.
  // Null when the clone never recorded one, since finding out would need the network.
  async readRemoteHead(upstream) {
    const remote = upstream?.name.split("/")[0] ?? "origin";
    const ref = `refs/remotes/${remote}/HEAD`;
    const target = await this.git(["symbolic-ref", "--short", ref]);
    if (target.code !== 0 || !target.stdout.trim()) return null;
    const base = await this.git(["merge-base", "HEAD", ref]);
    const behind = await this.git(["rev-list", "--count", `HEAD..${ref}`]);
    if (base.code !== 0 || behind.code !== 0) return null;
    return {
      name: `${remote}/HEAD`,
      target: target.stdout.trim(),
      base: base.stdout.trim(),
      behind: Number(behind.stdout) || 0,
    };
  }

  // A line in the history naming the remote refs that sit at this commit.
  remoteMarker(id, labels, t) {
    return h_flex()
      .id(id)
      .flex_none()
      .px(8)
      .py(4)
      .gap(6)
      .items_center()
      .text_size(em(0.8))
      .text_color(t.accent)
      .child(div().flex_none().child(labels.join(", ")))
      .child(div().flex_1().h(1).bg(t.accent));
  }

  loadCommits(cx, more = false) {
    if (this.commitsLoading || !this.root) return;
    if (!this.hasHead) {
      this.commits = [];
      this.commitsDone = true;
      return;
    }
    const context = this.context;
    const token = ++this.commitsToken;
    const page = this.settings.limits.commits_per_page || COMMIT_PAGE;
    const count = more ? page : Math.max(page, this.commits.length);
    const skip = more ? this.commits.length : 0;
    this.commitsLoading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await this.git([
          "log",
          "--no-color",
          LOG_FORMAT,
          "-n",
          String(count),
          "--skip",
          String(skip),
        ]);
        if (token !== this.commitsToken || context !== this.contextKey()) return;
        if (result.code !== 0) throw Error(result.stderr || "Cannot read history");
        const page = parseLog(result.stdout);
        const upstream = more ? this.upstream : await this.readUpstream();
        const remoteHead = more ? this.remoteHead : await this.readRemoteHead(upstream);
        if (token !== this.commitsToken || context !== this.contextKey()) return;
        this.upstream = upstream;
        this.remoteHead = remoteHead;
        this.commits = more ? [...this.commits, ...page] : page;
        this.commitsDone = page.length < count;
        this.commitsError = null;
      } catch (error) {
        if (token === this.commitsToken) this.commitsError = error.message;
      } finally {
        if (token === this.commitsToken) {
          this.commitsLoading = false;
          cx.notify();
        }
      }
    });
  }

  openCommit(commit, cx) {
    const context = this.context;
    const token = ++this.commitToken;
    this.selectedCommit = commit;
    this.commitFiles = [];
    this.commitFilesError = null;
    this.commitFilesLoading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // `--numstat --name-status` together print only the last one, so ask twice.
        const show = (flag) =>
          this.git([
            "show",
            "--diff-merges=first-parent",
            "--format=",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            flag,
            "-z",
            commit.hash,
          ]);
        const numstat = await show("--numstat");
        const names = await show("--name-status");
        if (token !== this.commitToken || context !== this.contextKey()) return;
        if (numstat.code !== 0 || names.code !== 0)
          throw Error(numstat.stderr || names.stderr || "Cannot read commit");
        this.commitFiles = commitFiles(numstat.stdout, names.stdout);
      } catch (error) {
        if (token === this.commitToken) this.commitFilesError = error.message;
      } finally {
        if (token === this.commitToken) {
          this.commitFilesLoading = false;
          cx.notify();
        }
      }
    });
  }

  closeCommit(cx) {
    this.selectedCommit = null;
    this.commitFiles = [];
    this.commitToken++;
    this.commitFilesLoading = false;
    cx.notify();
  }
  // ── Shared controls and file rows ─────────────────────────────────────────

  icon(id, asset, label, action, t, active = false, disabled = false, size = 24) {
    return div()
      .id(id)
      .size(size)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(5)
      // Stage/unstage buttons keep a resting fill so they read as actions; the rest fill on hover only.
      .when(active || asset === "stage" || asset === "unstage", (el) => el.bg(t.selected))
      .text_color(disabled ? t.dim : active ? t.foreground : t.muted)
      .tooltip(label)
      .accessibility_label(label)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .when(!disabled, (el) =>
        el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)),
      )
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (!disabled) action(cx);
      })
      .child(svg(`mods/better-changes/${asset}.svg`).size(size <= 22 ? 12 : 14));
  }

  // One 12px slot per ancestor level, each with a faint guide line under its chevron.
  guides(depth, height, t) {
    const slots = [];
    for (let level = 0; level < depth; level++)
      slots.push(div().w(12).h(height).flex_none().child(div().w(1).h_full().ml(5).bg(t.border)));
    return slots;
  }

  fileRow(file, depth, t, scope = "all") {
    const flat = this.view === "flat";
    const parts = file.path.split("/");
    const name = parts.pop();
    const selected = this.currentSelection();
    return h_flex()
      .id(`change-${scope}-${file.path}`)
      .h(30)
      .flex_none()
      .pl(8)
      .pr(8)
      .gap(7)
      .items_center()
      .rounded(5)
      .cursor_pointer()
      .when(
        selected?.context === this.context &&
          selected?.path === file.path &&
          (selected.scope || "all") === scope,
        (el) => el.bg(t.selected),
      )
      .hover((s) => s.bg(t.hover))
      .tooltip(file.path)
      .on_click((_e, cx) => this.pick(file, cx, scope))
      .children(this.guides(depth, 30, t))
      .child(svg("mods/better-changes/file.svg").size(13).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().child(name))
      .when(flat && parts.length > 0, (el) =>
        el.child(
          div().max_w(110).truncate().text_size(em(0.8)).text_color(t.dim).child(parts.join("/")),
        ),
      )
      .when(file.add > 0, (el) =>
        el.child(div().text_size(em(0.8)).text_color(t.ansi2).child(`+${file.add}`)),
      )
      .when(file.del > 0, (el) =>
        el.child(div().text_size(em(0.8)).text_color(t.ansi1).child(`−${file.del}`)),
      )
      .child(
        div()
          .w(13)
          .text_size(em(0.8))
          .text_color(
            file.status === "A"
              ? t.ansi2
              : file.status === "D" || file.status === "U"
                ? t.ansi1
                : t.blocked,
          )
          .child(file.status),
      )
      .when(scope === "staged" || scope === "unstaged", (el) =>
        el.child(
          this.icon(
            `changes-${scope === "staged" ? "unstage" : "stage"}-${file.path}`,
            scope === "staged" ? "unstage" : "stage",
            scope === "staged" ? "Unstage file" : "Stage file",
            (cx) => this.indexAction(scope === "staged" ? "unstage" : "stage", file.path, cx),
            t,
            false,
            this.busy || this.loading,
            20,
          ),
        ),
      );
  }

  setDiffLayout(style, cx) {
    if (!["inline", "split"].includes(style)) return;
    this.diffLayout = style;
    localStorage.setItem("better-changes.diff-layout", style);
    setShared("better-changes.diff-layout", style);
    cx.notify();
  }

  diffLayoutToggle(t) {
    const row = h_flex()
      .id("changes-diff-layout")
      .p(2)
      .gap(2)
      .items_center()
      .flex_none()
      .rounded(7)
      .border_1()
      .border_color(t.selected);
    for (const [style, label] of [
      ["inline", "Inline diff"],
      ["split", "Side-by-side diff"],
    ]) {
      const active = this.diffLayout === style;
      row.child(
        div()
          .id(`changes-diff-${style}`)
          .size(22)
          .flex()
          .items_center()
          .justify_center()
          .rounded(5)
          .when(active, (el) => el.bg(t.selected))
          .text_color(active ? t.foreground : t.muted)
          .cursor_pointer()
          .tooltip(label)
          .accessibility_label(label)
          .hover((el) => el.bg(active ? t.selected : t.hover))
          .on_click((_e, cx) => this.setDiffLayout(style, cx))
          .child(svg(`mods/better-changes/diff-${style}.svg`).size(13)),
      );
    }
    return row;
  }
  // ── Sidebar rendering ────────────────────────────────────────────────────

  render() {
    const t = theme();
    const root = v_flex()
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .border_1()
      .border_color(t.border)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(em(1));
    if (this.mode === "diff") return this.renderDiff(root, t);
    root.child(this.renderSidebarHeader(t));
    if (this.tab === "commits") {
      root.child(this.selectedCommit ? this.renderCommitDetail(t) : this.renderCommitList(t));
      return root;
    }
    root.child(this.renderFileList(t));
    if (this.error && this.files.length)
      root.child(div().px(12).py(6).text_color(t.ansi1).child(this.error));
    if (this.note) root.child(div().px(12).py(6).text_color(t.ansi1).child(this.note));
    root.child(this.renderCommitFooter(t));
    return root;
  }

  renderSidebarHeader(t) {
    const head = h_flex()
      .h(44)
      .px(12)
      .gap(6)
      .flex_none()
      .items_center()
      .border_b(1)
      .border_color(t.border);
    const tabs = h_flex()
      .id("changes-tabs")
      .p(2)
      .gap(2)
      .items_center()
      .flex_none()
      .rounded(7)
      .border_1()
      .border_color(t.selected);
    for (const [tab, label] of [
      ["changes", "Changes"],
      ["commits", "Commits"],
    ]) {
      const active = this.tab === tab;
      tabs.child(
        div()
          .id(`changes-tab-${tab}`)
          .h(22)
          .px(8)
          .flex()
          .items_center()
          .rounded(5)
          .text_size(em(0.85))
          .when(active, (el) => el.bg(t.selected))
          .text_color(active ? t.foreground : t.muted)
          .cursor_pointer()
          .hover((el) => el.bg(active ? t.selected : t.hover))
          .gap(5)
          .on_click((_e, cx) => this.setTab(tab, cx))
          .child(label)
          .when(tab === "changes", (el) =>
            el.child(div().text_size(em(0.75)).text_color(t.dim).child(String(this.total ?? 0))),
          ),
      );
    }
    head.child(tabs);
    head.child(div().flex_1());
    head.child(this.diffLayoutToggle(t));
    const fileViews = h_flex()
      .id("changes-file-view")
      .p(2)
      .gap(2)
      .items_center()
      .flex_none()
      .rounded(7)
      .border_1()
      .border_color(t.selected);
    for (const view of ["tree", "flat"]) {
      const active = this.view === view;
      const label = view === "tree" ? "Tree view" : "Flat view";
      fileViews.child(
        div()
          .id(`changes-${view}`)
          .size(22)
          .flex()
          .items_center()
          .justify_center()
          .rounded(5)
          .when(active, (el) => el.bg(t.selected))
          .text_color(active ? t.foreground : t.muted)
          .cursor_pointer()
          .tooltip(label)
          .accessibility_label(label)
          .hover((el) => el.bg(active ? t.selected : t.hover))
          .on_click((_e, cx) => {
            this.view = view;
            localStorage.setItem("better-changes.view", view);
            cx.notify();
          })
          .child(svg(`mods/better-changes/${view}.svg`).size(13)),
      );
    }
    head.child(fileViews);
    head.child(
      this.icon("changes-refresh", "refresh", "Refresh changes", (cx) => this.refresh(cx), t),
    );
    return head;
  }

  renderFileList(t) {
    const list = v_flex().id("changes-list").flex_1().min_h(0).overflow_y_scrollbar().p(6);
    for (const [scope, label, count] of [
      ["staged", "Staged", this.stagedCount ?? 0],
      ["unstaged", "Unstaged", this.unstagedCount ?? 0],
    ]) {
      const isStaged = scope === "staged";
      const action = isStaged ? "unstage" : "stage";
      // A partially staged file appears twice. Render each group's own status
      // and line counts rather than the totals across index and working tree.
      const group = this.files
        .filter((file) => (isStaged ? file.staged : file.unstaged))
        .map((file) => ({
          ...file,
          status: (isStaged ? file.stagedStatus : file.unstagedStatus) || file.status,
          ...(isStaged ? file.stagedStats : file.unstagedStats),
        }));
      if (!isStaged) list.child(div().h(1).w_full().flex_none().my(4).bg(t.border));
      list.child(
        h_flex()
          .id(`changes-section-${scope}`)
          .h(34)
          .px(8)
          .gap(6)
          .items_center()
          .flex_none()
          .child(div().font_semibold().text_size(em(0.9)).child(label))
          .child(div().text_size(em(0.8)).text_color(t.dim).child(String(count)))
          .child(div().flex_1())
          .child(
            this.icon(
              `changes-${action}-all`,
              action,
              isStaged ? "Unstage all" : "Stage all",
              (cx) => this.indexAction(action, null, cx),
              t,
              false,
              !count || this.busy || this.loading,
              22,
            ),
          ),
      );
      if (!group.length) {
        list.child(
          div()
            .px(8)
            .pb(6)
            .text_size(em(0.85))
            .text_color(t.dim)
            .child(scope === "staged" ? "No staged changes" : "No unstaged changes"),
        );
        continue;
      }
      list.children(this.fileRows(group, scope, t));
    }
    if (!this.files.length)
      list.child(
        div()
          .p(10)
          .text_color(t.dim)
          .child(
            this.error ||
              (this.loading
                ? "Loading changes…"
                : this.root
                  ? "No uncommitted changes"
                  : "No folder selected"),
          ),
      );
    this.renderCommitted(list, t);
    return list;
  }

  renderCommitted(list, t) {
    const committed = this.committed;
    if (!committed) return;
    list.child(div().h(1).w_full().flex_none().my(4).bg(t.border));
    list.child(
      h_flex()
        .id("changes-section-committed")
        .h(34)
        .px(8)
        .gap(6)
        .items_center()
        .flex_none()
        .child(div().font_semibold().text_size(em(0.9)).child("Committed"))
        .child(div().text_size(em(0.8)).text_color(t.dim).child(String(committed.total)))
        .child(div().flex_1())
        .child(
          div().min_w(0).truncate().text_size(em(0.8)).text_color(t.dim).child(`since ${committed.name}`),
        ),
    );
    if (committed.files.length) list.children(this.fileRows(committed.files, "committed", t));
    else
      list.child(
        div().px(8).pb(6).text_size(em(0.85)).text_color(t.dim).child("Nothing committed on this branch yet"),
      );
  }

  // Tree or flat rows for one group, honouring the sidebar's view toggle.
  fileRows(group, scope, t) {
    if (this.view === "flat") return group.map((file) => this.fileRow(file, 0, t, scope));
    const closed = new Set(
      [...this.closed].filter((k) => k.startsWith(scope + ":")).map((k) => k.slice(scope.length + 1)),
    );
    return fileTree(group, closed).map((row) =>
      row.kind === "file"
        ? this.fileRow(row.file, row.depth, t, scope)
        : this.folderRow(row, scope, t),
    );
  }

  renderCommitList(t) {
    const list = v_flex().id("commit-list").flex_1().min_h(0).overflow_y_scrollbar().p(6);
    const { upstream, remoteHead } = this;
    const unpushed = upstream?.unpushed;
    const notPulled = (name, behind) => (behind ? `${name} · ${behind} not pulled` : name);
    // On the default branch the two are the same ref, so they share the upstream's line.
    const sameRef = remoteHead?.target === upstream?.name;
    let marked = false;
    if (this.commits.length && !this.upstream && !this.commitsLoading)
      list.child(
        div()
          .id("commit-no-upstream")
          .flex_none()
          .px(8)
          .py(4)
          .text_size(em(0.8))
          .text_color(t.dim)
          .child("This branch has no remote to compare with"),
      );
    for (const commit of this.commits) {
      const isNew = Boolean(unpushed?.has(commit.hash));
      const labels = [];
      if (upstream && !isNew && !marked) {
        marked = true;
        labels.push(notPulled(upstream.name, upstream.behind));
        if (sameRef) labels.push(remoteHead.name);
      }
      if (remoteHead && !sameRef && commit.hash === remoteHead.base)
        labels.push(notPulled(remoteHead.name, remoteHead.behind));
      if (labels.length)
        list.child(
          this.remoteMarker(
            labels[0].startsWith(upstream?.name) ? "commit-upstream" : "commit-remote-head",
            labels,
            t,
          ),
        );
      list.child(
        v_flex()
          .id(`commit-${commit.hash}`)
          .px(8)
          .py(6)
          .gap(2)
          .flex_none()
          .rounded(5)
          .cursor_pointer()
          .hover((el) => el.bg(t.hover))
          .on_click((_e, cx) => this.openCommit(commit, cx))
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .when(isNew, (el) =>
                el.child(
                  div()
                    .size(6)
                    .flex_none()
                    .rounded(3)
                    .bg(t.accent)
                    .accessibility_label("Not pushed"),
                ),
              )
              .child(div().flex_1().min_w(0).truncate().child(commit.subject || "(no message)")),
          )
          .child(
            h_flex()
              .gap(6)
              .text_size(em(0.8))
              .text_color(t.dim)
              .child(div().flex_1().truncate().child(`${commit.author} · ${timeAgo(commit.at)}`))
              .child(div().child(commit.short)),
          ),
      );
    }
    if (this.commitsError) list.child(div().p(10).text_color(t.ansi1).child(this.commitsError));
    else if (this.commitsLoading && !this.commits.length)
      list.child(div().p(10).text_color(t.dim).child("Loading commits…"));
    else if (!this.commits.length)
      list.child(div().p(10).text_color(t.dim).child(this.root ? "No commits yet" : "No folder selected"));
    else if (!this.commitsDone)
      list.child(
        div()
          .id("commit-more")
          .h(30)
          .flex()
          .items_center()
          .justify_center()
          .rounded(5)
          .text_size(em(0.85))
          .text_color(t.muted)
          .cursor_pointer()
          .hover((el) => el.bg(t.hover))
          .on_click((_e, cx) => this.loadCommits(cx, true))
          .child(this.commitsLoading ? "Loading…" : "Load more"),
      );
    return list;
  }

  renderCommitDetail(t) {
    const commit = this.selectedCommit;
    const list = v_flex().id("commit-detail").flex_1().min_h(0).overflow_y_scrollbar().p(6);
    list.child(
      h_flex()
        .id("commit-back")
        .h(28)
        .px(6)
        .gap(6)
        .flex_none()
        .items_center()
        .rounded(5)
        .cursor_pointer()
        .text_color(t.muted)
        .hover((el) => el.bg(t.hover))
        .on_click((_e, cx) => this.closeCommit(cx))
        .child(svg("mods/better-changes/chevron-left.svg").size(11))
        .child(div().text_size(em(0.85)).child("Commits")),
    );
    list.child(div().px(8).py(4).font_semibold().whitespace_normal().child(commit.subject));
    const url = this.repo ? `https://github.com/${this.repo}/commit/${commit.hash}` : null;
    list.child(
      h_flex()
        .px(8)
        .gap(4)
        .flex_wrap()
        .text_size(em(0.8))
        .text_color(t.dim)
        .child(div().child(`${commit.author} · ${new Date(commit.at * 1000).toLocaleString()} ·`))
        .child(
          div()
            .id("commit-link")
            .child(commit.short)
            .when(Boolean(url), (el) =>
              el
                .cursor_pointer()
                .text_color(t.accent)
                .underline()
                .tooltip(`${url}\nCmd-click (Ctrl-click on other platforms) to open on GitHub`)
                .hover((s) => s.text_color(t.foreground))
                .on_click((event, cx) => {
                  if (event.modifiers?.platform || event.modifiers?.control) {
                    cx.stop_propagation();
                    cx.open_url(url);
                  }
                }),
            ),
        ),
    );
    if (commit.body)
      list.child(div().px(8).py(6).text_size(em(0.9)).text_color(t.muted).whitespace_normal().child(commit.body));
    list.child(div().h(1).w_full().flex_none().my(4).bg(t.border));
    list.child(
      h_flex()
        .h(34)
        .px(8)
        .gap(6)
        .items_center()
        .flex_none()
        .child(div().font_semibold().text_size(em(0.9)).child("Files"))
        .child(div().text_size(em(0.8)).text_color(t.dim).child(String(this.commitFiles.length))),
    );
    if (this.commitFilesError) list.child(div().px(8).text_color(t.ansi1).child(this.commitFilesError));
    else if (this.commitFilesLoading && !this.commitFiles.length)
      list.child(div().px(8).text_color(t.dim).child("Loading files…"));
    list.children(this.fileRows(this.commitFiles, "commit", t));
    return list;
  }

  folderRow(row, scope, t) {
    const closedKey = `${scope}:${row.path}`;
    const chevron = this.closed.has(closedKey) ? "chevron-right" : "chevron-down";
    return h_flex()
      .id(`changes-folder-${scope}-${row.path}`)
      .h(28)
      .pl(8)
      .gap(6)
      .flex_none()
      .items_center()
      .rounded(5)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .on_click((_e, cx) => {
        if (this.closed.has(closedKey)) this.closed.delete(closedKey);
        else this.closed.add(closedKey);
        cx.notify();
      })
      .children(this.guides(row.depth, 28, t))
      .child(svg(`mods/better-changes/${chevron}.svg`).size(11).text_color(t.muted))
      .child(div().min_w(0).truncate().child(row.name));
  }

  renderCommitDropdown(t) {
    const available = Boolean(this.root && !this.busy && !this.loading);
    const choices = [
      { mode: "commit", label: "Commit", icon: "commit" },
      { mode: "amend", label: "Amend", icon: "amend", disabled: !this.hasHead },
    ];
    const menu = v_flex()
      .id("changes-commit-menu")
      .w(190)
      .p(5)
      .gap(2)
      .rounded(7)
      .border_1()
      .border_color(t.border)
      .bg(t.popover)
      .text_color(t.foreground)
      .track_focus(this.commitMenuFocus)
      .on_key_down((event, cx) => {
        const enabled = choices.filter((choice) => !choice.disabled);
        if (event.key === "up" || event.key === "down") {
          this.commitMenuIndex =
            (this.commitMenuIndex + (event.key === "down" ? 1 : enabled.length - 1)) %
            enabled.length;
        } else if (event.key === "enter") {
          this.setCommitMode(enabled[this.commitMenuIndex % enabled.length].mode, cx);
          this.commitTriggerFocus.focus();
        } else if (event.key === "escape") {
          this.commitMenuOpen = false;
          this.commitTriggerFocus.focus();
        } else return;
        cx.stop_propagation();
        cx.notify();
      });
    for (const [index, choice] of choices.entries()) {
      menu.child(
        h_flex()
          .id(`changes-mode-${choice.mode}`)
          .h(30)
          .px(8)
          .gap(8)
          .items_center()
          .rounded(4)
          .text_size(12.8)
          .role("list_box_option")
          .aria_selected(this.commitMode === choice.mode)
          .when(!choice.disabled && index === this.commitMenuIndex, (el) =>
            el.bg(t.selected).aria_active_descendant(),
          )
          .text_color(choice.disabled ? t.dim : t.foreground)
          .tooltip(
            choice.mode === "amend"
              ? this.hasHead
                ? "Rewrite the latest commit; unstaged changes stay untouched"
                : "Create a first commit before amending"
              : "Create a commit from staged changes only",
          )
          .when(!choice.disabled, (el) =>
            el
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_event, cx) => {
                this.setCommitMode(choice.mode, cx);
                this.commitTriggerFocus.focus();
              }),
          )
          .child(svg(`mods/better-changes/${choice.icon}.svg`).size(14).flex_none())
          .child(choice.label),
      );
    }
    const trigger = div()
      .id("changes-commit-options")
      .w(30)
      .h(32)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .border_l(1)
      .border_color(t.border)
      .track_focus(this.commitTriggerFocus)
      .tooltip("Commit options")
      .accessibility_label("Commit options")
      .text_color(available ? t.foreground : t.dim)
      .when(available, (el) =>
        el
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_key_down((event, cx) => {
            if (!["enter", "space", "up", "down"].includes(event.key)) return;
            this.commitMenuOpen = !this.commitMenuOpen;
            this.commitMenuIndex = this.commitMode === "amend" && this.hasHead ? 1 : 0;
            if (this.commitMenuOpen) this.commitMenuFocus.focus();
            cx.stop_propagation();
            cx.notify();
          }),
      )
      .child(svg("mods/better-changes/chevron-down.svg").size(12));
    return Popover.new("changes-commit-dropdown")
      .open(Boolean(available && this.commitMenuOpen))
      .anchor("bottom_right")
      .track_focus(this.commitMenuFocus)
      .on_open_change((open, cx) => {
        this.commitMenuOpen = available && open;
        this.commitMenuIndex = this.commitMode === "amend" && this.hasHead ? 1 : 0;
        cx.notify();
      })
      .trigger(trigger)
      .when(available && this.commitMenuOpen, (el) => el.content(menu));
  }

  renderCommitFooter(t) {
    const enabled = this.canCommit();
    const amend = this.commitMode === "amend";
    const label =
      this.operation === "commit"
        ? "Committing…"
        : this.operation === "amend"
          ? "Amending…"
          : amend
            ? "Amend"
            : "Commit staged";
    return v_flex()
      .p(10)
      .gap(8)
      .flex_none()
      .border_t(1)
      .border_color(t.border)
      .child(
        Textarea.new(this.input)
          .id("changes-commit-message")
          .w_full()
          .h(84)
          .px(8)
          .py(7)
          .rounded(6)
          .border_1()
          .border_color(t.border)
          .bg(t.input)
          .text_color(t.foreground)
          .text_size(em(0.9))
          .accessibility_label("Commit message"),
      )
      .child(
        h_flex()
          .h(32)
          .w_full()
          .items_center()
          .rounded(6)
          .border_1()
          .border_color(t.border)
          .bg(t.raised)
          .text_size(em(0.9))
          .child(
            h_flex()
              .id("changes-commit")
              .h_full()
              .flex_1()
              .min_w(0)
              .px(10)
              .gap(7)
              .items_center()
              .justify_center()
              .rounded_l(5)
              .bg(enabled ? t.solid : t.raised)
              .text_color(enabled ? t.solid_foreground : t.dim)
              .tooltip(
                amend
                  ? "Amend the latest commit with this message and staged changes"
                  : "Commit staged changes only",
              )
              .accessibility_label(label)
              .when(enabled, (el) =>
                el
                  .cursor_pointer()
                  .hover((s) => s.bg(t.accent))
                  .on_click((_event, cx) => this.commit(cx)),
              )
              .child(
                svg(amend ? "mods/better-changes/amend.svg" : "mods/better-changes/commit.svg")
                  .size(14)
                  .flex_none(),
              )
              .child(label),
          )
          .child(this.renderCommitDropdown(t)),
      )
      .child(
        div()
          .text_size(em(0.8))
          .text_color(amend ? t.ansi3 : t.dim)
          .whitespace_normal()
          .child(
            this.amendLoading
              ? "Loading latest commit…"
              : this.conflicts
                ? "Resolve conflicts and stage the files before committing"
                : amend
                  ? "Amend rewrites the latest commit. Unstaged changes stay untouched."
                  : "Commit includes staged changes only",
          ),
      )
      .when(this.total > (this.settings.limits.files || MAX_FILES), (el) =>
        el.child(
          div()
            .text_size(em(0.8))
            .text_color(t.dim)
            .child(`First ${(this.settings.limits.files || MAX_FILES).toLocaleString()} files shown`),
        ),
      );
  }

  // ── Diff rendering (inline and side-by-side) ───────────────────────────────

  renderDiff(root, t) {
    const original =
      this.scope === "commit" || this.scope === "committed"
        ? this.commitFile
        : this.files.find((f) => f.path === this.path);
    const file = original
      ? {
          ...original,
          ...(this.scope === "staged"
            ? original.stagedStats
            : this.scope === "unstaged"
              ? original.unstagedStats
              : {}),
        }
      : null;
    const head = h_flex()
      .min_h(46)
      .px(14)
      .py(8)
      .gap(8)
      .items_center()
      .flex_none()
      .border_b(1)
      .border_color(t.border)
      .child(svg("mods/better-changes/file.svg").size(15).text_color(t.muted))
      .child(
        div()
          .flex_1()
          .min_w(0)
          .whitespace_normal()
          .font_semibold()
          .child(this.path || "File diff"),
      );
    const setContext = value => cx => {
      this.diffContext = value;
      this.commentSelection = null;
      this.loadDiff(cx);
    };
    if (file)
      head
        .child(div().text_size(em(0.85)).text_color(t.ansi2).child(`+${file.add}`))
        .child(div().text_size(em(0.85)).text_color(t.ansi1).child(`−${file.del}`));
    head
      .child(this.icon("diff-context-compact", "context-compact", "Contexto compacto", setContext(3), t, this.diffContext === 3))
      .child(this.icon("diff-context-more", "context-more", "Mostrar 20 líneas de contexto", setContext(20), t, this.diffContext === 20))
      .child(this.icon("diff-context-full", "context-full", "Mostrar archivo completo", setContext(1000000), t, this.diffContext === 1000000))
      .child(this.icon("diff-refresh", "refresh", "Refresh diff", (cx) => this.refresh(cx), t))
      .child(
        this.icon(
          "diff-close",
          "close",
          "Close diff",
          () => {
            const tab = this.diffTab();
            if (tab) run("tab.close", { id: tab });
          },
          t,
        ),
      );
    root.child(head);
    if (this.commentSelection && (this.commentSelection.path !== this.path || this.commentSelection.context !== this.context || this.commentSelection.scope !== this.scope))
      this.commentSelection = null;
    root.child(this.commentPanel(t));
    root.child(
      h_flex()
        .h(30)
        .px(14)
        .gap(10)
        .items_center()
        .flex_none()
        .text_size(em(0.8))
        .text_color(t.dim)
        .child(
          div()
            .flex_1()
            .truncate()
            .child(
              `${this.scope === "commit" ? `Commit ${this.commitRef?.short} · ${this.commitRef?.subject}` : this.scope === "committed" ? `Committed · ${this.commitRef?.name} → HEAD` : this.scope === "staged" ? "Staged · HEAD → Index" : this.scope === "unstaged" ? "Unstaged · Index → Working tree" : "All changes"} · ${this.root || ""}`,
            ),
        )
        .child(div().text_color(t.ansi2).child("+ Added"))
        .child(div().text_color(t.ansi1).child("− Removed")),
    );
    if (this.diffLoading && !this.rows.length)
      root.child(div().p(14).text_color(t.dim).child("Loading diff…"));
    if (this.error || this.note)
      root.child(
        div()
          .px(14)
          .py(8)
          .text_color(t.ansi1)
          .child(this.error || this.note),
      );
    if (!this.path)
      root.child(
        div().p(14).text_color(t.dim).child("Select a changed file in Changes to view its diff."),
      );
    const height = Math.ceil(em(1.65));
    const split = this.diffLayout === "split";
    if (split)
      root.child(
        h_flex()
          .h(28)
          .flex_none()
          .items_center()
          .border_y(1)
          .border_color(t.border)
          .text_size(em(0.8))
          .text_color(t.muted)
          .child(div().flex_1().px(12).child("Before"))
          .child(
            h_flex()
              .flex_1()
              .px(12)
              .gap(5)
              .items_center()
              .border_l(1)
              .border_color(t.border)
              .child(div().flex_1().child("After"))
              .child(
                this.icon(
                  "diff-scroll-left",
                  "chevron-left",
                  "Scroll both sides left",
                  (cx) => this.scrollSplit(-em(16), cx),
                  t,
                  false,
                  !this.splitOffset,
                  20,
                ),
              )
              .child(
                this.icon(
                  "diff-scroll-right",
                  "chevron-right",
                  "Scroll both sides right",
                  (cx) => this.scrollSplit(em(16), cx),
                  t,
                  false,
                  this.splitOffset >= Math.max(0, (this.width || 300) - 160),
                  20,
                ),
              ),
          ),
      );
    // Cache paired rows by array identity. Both sides share one virtual list,
    // which keeps their vertical positions aligned even for unequal hunks.
    if (this.pairedSource !== this.rows) {
      this.pairedSource = this.rows;
      this.pairedRows = splitDiffRows(this.rows);
    }
    const rows = split ? this.pairedRows : this.rows;
    const listId = `factory-diff-${this.context}-${this.path}-${this.scope}-${this.diffLayout}`;
    const viewport = div()
      .flex_1()
      .min_h(0)
      .relative()
      .when(Boolean(codeFont()), (el) => el.font_family(codeFont()))
      .text_size(em(1));
    if (split)
      viewport.child(
        v_virtual_list(
          listId,
          rows.length,
          height,
          (i) => String(i),
          (range) => rows.slice(range.start, range.end).map((row, i) => this.splitRow(row, t, height, range.start + i)),
        )
          .size_full()
          .on_item_click((key, cx) => this.selectSplitCommentLine(Number(key), cx))
          .on_scroll_wheel((e, cx) => {
            const delta = e.delta.x || (e.modifiers?.shift ? e.delta.y : 0);
            if (delta) {
              this.scrollSplit(-delta, cx);
              cx.stop_propagation();
            }
          }),
      );
    else
      viewport.child(
        div()
          .id("factory-diff-x")
          .size_full()
          .overflow_x_scrollbar()
          .child(
            div()
              .w_full()
              .min_w(this.width || 300)
              .h_full()
              .child(
                v_virtual_list(
                  listId,
                  rows.length,
                  height,
                  (i) => String(i),
                  (range) =>
                    rows.slice(range.start, range.end).map((row, i) => this.diffRow(row, t, height, range.start + i)),
                ).size_full().on_item_click((key, cx) => this.selectCommentLine(Number(key), cx)),
              ),
          ),
      );
    viewport.child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0());
    root.child(viewport);
    if (this.truncated)
      root.child(
        div()
          .px(14)
          .py(6)
          .text_size(em(0.8))
          .text_color(t.dim)
          .child("Preview limited to 1,500 lines and 4,000 characters per line."),
      );
    return root;
  }

  // One horizontal offset moves both text columns, leaving line gutters fixed.
  scrollSplit(delta, cx) {
    this.splitOffset = Math.max(
      0,
      Math.min(Math.max(0, (this.width || 300) - 160), this.splitOffset + delta),
    );
    cx.notify();
  }

  selectCommentLine(index, cx) {
    const row = this.rows[index];
    if (!row || (row.old === undefined && row.next === undefined)) return;
    const side = row.kind === "-" ? "old" : "next";
    const number = row[side];
    const previous = this.commentSelection;
    if (!previous || previous.layout !== "inline" || previous.end !== null || previous.side !== side) {
      this.commentSelection = { path: this.path, context: this.context, scope: this.scope, layout: "inline", side, start: number, end: null };
    } else {
      this.commentSelection = { ...previous, end: number };
    }
    this.commentNotice = null;
    cx.notify();
  }

  selectSplitCommentLine(index, cx) {
    const row = this.pairedRows[index];
    if (!row || row.kind !== "pair") return;
    const previous = this.commentSelection;
    if (!previous || previous.layout !== "split" || previous.end !== null) {
      this.commentSelection = { path: this.path, context: this.context, scope: this.scope, layout: "split", start: index, end: null };
    } else {
      this.commentSelection = { ...previous, end: index };
    }
    this.commentNotice = null;
    cx.notify();
  }

  commentAgents() {
    return agents().filter(a => a.space === this.diffSpace &&
      (a.app === "opencode" || a.program?.key === "opencode" || a.program?.name === "OpenCode"));
  }

  sendComment(cx) {
    const selection = this.commentSelection;
    const text = this.commentInput.value().trim();
    const candidates = this.commentAgents();
    const target = candidates.length === 1 ? candidates[0] : candidates.find(a => a.address === this.commentTarget);
    if (!selection || !text || !target || this.commentBusy) return;
    if (target.status !== "idle" && target.status !== "working") {
      this.commentNotice = "La sesión no está disponible para recibir mensajes."; cx.notify(); return;
    }
    const start = Math.min(selection.start, selection.end ?? selection.start);
    const end = Math.max(selection.start, selection.end ?? selection.start);
    let excerpt, description;
    if (selection.layout === "split") {
      const rows = this.pairedRows.slice(start, end + 1);
      if (rows.some(r => r.kind !== "pair")) {
        this.commentNotice = "Selecciona un rango dentro del mismo bloque del diff."; cx.notify(); return;
      }
      const before = rows.filter(r => r.left).map(r => `${r.left.old}: ${r.left.text}`).join("\n") || "(sin líneas)";
      const after = rows.filter(r => r.right).map(r => `${r.right.next}: ${r.right.text}`).join("\n") || "(sin líneas)";
      excerpt = `Antes:\n${before}\n\nDespués:\n${after}`;
      description = "ambos lados del diff";
    } else {
      const rows = this.rows.filter(r => r[selection.side] >= start && r[selection.side] <= end);
      const numbers = rows.map(r => r[selection.side]);
      if (numbers.length !== end - start + 1 || numbers.some((n, i) => n !== start + i)) {
        this.commentNotice = "El rango debe contener líneas consecutivas visibles del mismo lado del diff."; cx.notify(); return;
      }
      excerpt = rows.map(r => `${r[selection.side]}: ${r.text}`).join("\n");
      description = `${selection.side === "old" ? "versión anterior" : "versión nueva"}, líneas ${start}-${end}`;
    }
    const message = `Comentario sobre el diff de ${selection.path} (${description}):\n\n\`\`\`\n${excerpt}\n\`\`\`\n\n${text}`;
    if (message.length > 32000) { this.commentNotice = "El comentario y el fragmento superan el límite de 32000 caracteres."; cx.notify(); return; }
    this.commentBusy = true; this.commentNotice = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await exec("hc", ["send", "--if", target.status, target.address, message]);
        if (result.code !== 0) throw new Error(result.stderr || "No se pudo confirmar el envío; comprueba el chat antes de reintentar.");
        this.commentInput.set_value(""); this.commentSelection = null; this.commentNotice = "Comentario enviado a OpenCode.";
      } catch (e) { this.commentNotice = `Envío no confirmado: ${String(e?.message ?? e)} Comprueba el chat antes de reintentar.`; }
      finally { this.commentBusy = false; cx.notify(); }
    });
  }

  commentPanel(t) {
    const selection = this.commentSelection;
    const candidates = this.commentAgents();
    const button = (id, label, click) => div().id(id).px(8).py(4).rounded(4).bg(t.raised).hover(s => s.bg(t.hover)).on_click((_e, cx) => click(cx)).child(label);
    const panel = v_flex().px(14).py(6).gap(5).flex_none().text_size(em(0.85));
    panel.child(div().text_color(t.muted).child(selection ? selection.layout === "split" ? `Ambos lados: ${selection.end === null ? "fila seleccionada (elige otra para un rango)" : "rango seleccionado"}` : `${selection.side === "old" ? "Antes" : "Después"}: línea ${selection.start}${selection.end === null ? " (elige otra para un rango)" : `–${selection.end}`}` : "Haz clic en una línea del diff; otro clic selecciona un rango."));
    if (selection) {
      panel.child(Textarea.new(this.commentInput).w_full());
      if (candidates.length === 0) panel.child(div().text_color(t.ansi3).child("No hay sesiones de OpenCode en este espacio."));
      if (candidates.length > 1) panel.child(v_flex().gap(3).child(div().child("Elige sesión de OpenCode:"))
        .children(candidates.map(a => button(`comment-target-${a.address}`, `${a.address === this.commentTarget ? "●" : "○"} ${a.title || a.tab_name || a.address} (${a.address}, ${a.status})`, cx => { this.commentTarget = a.address; cx.notify(); }))));
      panel.child(h_flex().gap(6)
        .child(button("comment-send", this.commentBusy ? "Enviando…" : "Enviar a OpenCode", cx => this.sendComment(cx)))
        .child(button("comment-clear", "Cancelar selección", cx => { this.commentSelection = null; cx.notify(); })));
    }
    if (this.commentNotice) panel.child(div().text_color(t.muted).child(this.commentNotice));
    return panel;
  }

  splitRow(row, t, height, index) {
    if (row.kind !== "pair")
      return div()
        .h(height)
        .px(12)
        .w_full()
        .bg(t.raised)
        .text_color(row.kind === "@" ? t.accent : t.dim)
        .truncate()
        .child(row.text);
    const selection = this.commentSelection;
    const highlighted = selection?.layout === "split" && index >= Math.min(selection.start, selection.end ?? selection.start) && index <= Math.max(selection.start, selection.end ?? selection.start);
    const line = h_flex().id(`diff-hover-pair-${index}`).h(height).w_full()
      .hover((s) => s.bg(highlighted ? t.selected : t.hover));
    for (const [side, entry] of [
      ["left", row.left],
      ["right", row.right],
    ]) {
      const changed = entry?.kind === "+" || entry?.kind === "-";
      const color = entry?.kind === "+" ? t.ansi2 : entry?.kind === "-" ? t.ansi1 : t.foreground;
      line.child(
        h_flex()
          .id(`diff-hover-${index}-${side}`)
          .flex_1()
          .min_w(0)
          .h_full()
          .gap(6)
          .items_center()
          .overflow_hidden()
          .when(side === "right", (el) => el.border_l(1).border_color(t.border))
          .when(changed, (el) => el.bg(color + "18"))
          .when(!entry, (el) => el.bg(t.raised + "80"))
          .when(Boolean(highlighted), (el) => el.bg(t.selected))
          .child(
            div()
              .w(38)
              .flex_none()
              .text_right()
              .text_color(t.dim)
              .child(entry ? String((side === "left" ? entry.old : entry.next) ?? "") : ""),
          )
          .child(
            div()
              .w(10)
              .flex_none()
              .text_color(color)
              .child(changed ? entry.kind : ""),
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .overflow_hidden()
              .tooltip(entry?.text || "")
              .child(
                this.syntaxLine(entry, side === "left" ? "old" : "new", t, color)
                  .w(this.width || 300)
                  .flex_none()
                  .ml(-this.splitOffset)
                  .whitespace_nowrap(),
              ),
          ),
      );
    }
    return line;
  }

  diffRow(row, t, height, index) {
    if (row.kind === "@")
      return div().h(height).px(12).w_full().bg(t.raised).text_color(t.accent).child(row.text);
    const color = row.kind === "+" ? t.ansi2 : row.kind === "-" ? t.ansi1 : t.foreground;
    const selection = this.commentSelection;
    const n = selection?.layout === "inline" ? row[selection.side] : undefined;
    const highlighted = n !== undefined && selection && n >= Math.min(selection.start, selection.end ?? selection.start) && n <= Math.max(selection.start, selection.end ?? selection.start);
    return h_flex()
      .id(`diff-hover-${index}`)
      .h(height)
      .w_full()
      .gap(8)
      .items_center()
      .when(row.kind === "+" || row.kind === "-", (el) => el.bg(color + "18"))
      .when(Boolean(highlighted), (el) => el.bg(t.selected))
      .hover((s) => s.bg(highlighted ? t.selected : t.hover))
      .child(
        div()
          .w(38)
          .flex_none()
          .text_right()
          .text_color(t.dim)
          .child(row.old === undefined ? "" : String(row.old)),
      )
      .child(
        div()
          .w(38)
          .flex_none()
          .text_right()
          .text_color(t.dim)
          .child(row.next === undefined ? "" : String(row.next)),
      )
      .child(div().w(12).flex_none().text_color(color).child(row.kind))
      .child(
        this.syntaxLine(row, row.next !== undefined ? "new" : "old", t, color)
          .flex_1()
          .min_w(0)
          .whitespace_nowrap(),
      );
  }

  syntaxLine(row, side, t, fallback) {
    const number = side === "new" ? row?.next : row?.old;
    const tokens = number === undefined ? null : this.syntaxTokens?.get(`${side}:${number}`);
    if (!tokens?.some(token => token.kind !== "plain")) return div().text_color(fallback).child(row?.text || " ");
    const colors = { keyword: t.ansi5, string: t.ansi2, comment: t.muted, number: t.ansi3,
      literal: t.ansi3, function: t.ansi4, type: t.ansi6, property: t.ansi4, plain: fallback };
    return h_flex().gap(0).children(tokens.map(token => div().flex_none().whitespace_nowrap().text_color(colors[token.kind] ?? fallback).child(token.text)));
  }
}
