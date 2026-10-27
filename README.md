# TileLang CI

![Offline demo of the resource queue dashboard](media/screenshots/dashboard-overview-demo.png)

*Browser preview of the bundled offline demo. These are synthetic jobs, not live CI data; VS Code supplies the native sidebar.*

**English** | [简体中文](README.zh-CN.md)

GitHub Actions resource queues and your pull request positions, inside VS Code. Select a repository, see jobs grouped by actual runner labels, and find the waiting jobs associated with your PRs.

TileLang CI is a standalone extension maintained by **easy-tilelang**, alongside [TileLang DevKit](https://github.com/easy-tilelang/tilelang-devkit-vscode). Its extension ID is `easy-tilelang.tilelang-ci-vscode`. It supports arbitrary **github.com** repositories, including private repositories you can access. It does not require Python, TileLang, GitHub CLI, or a separate local server.

## Install and start

Requires desktop **VS Code 1.95 or newer** on Windows, macOS, or Linux.

1. Install a built `tilelang-ci-vscode-0.1.1.vsix` using **Extensions → … → Install from VSIX…**, or run `code --install-extension tilelang-ci-vscode-0.1.1.vsix`.
2. Open the **TileLang CI** Activity Bar view, or run **TileLang CI: Open Dashboard** from the Command Palette.
3. Choose a GitHub repository. A single workspace candidate is selected automatically; use **Select Repository** to choose a remote, a saved repository, or enter `owner/repo` or its HTTPS GitHub URL.
4. Run **Sign in to GitHub** to identify your account and highlight PRs you created. Public repositories can also be read without signing in, subject to GitHub's lower anonymous API limit.
5. For a private repository, run **Enable Private Repository Access** and review the GitHub authorization prompt.

**Open Demo** displays an explicitly labeled offline example without authentication or network access. Choose a repository to leave the demo and return to live data. Demo counts and PRs are illustrative.

Marketplace publication is a separate maintainer release step. The repository's CI packages VSIX artifacts; it does not publish the extension automatically.

## What you can see

- The native sidebar shows the repository, account, resource groups, and your active PRs. Selecting an item opens or filters the editor dashboard.
- Resource cards use the complete runner label set. The dashboard lists waiting or running jobs, grouped by resource, with search and an **Only mine** filter.
- PR cards summarize the earliest waiting position in each resource and expand to show individual jobs. A PR with two jobs at positions 9 and 12 still occupies two job positions.
- Merged, closed, and older-commit jobs remain visible while active. Publication jobs after a merge can legitimately continue waiting.
- Workflows without displayable jobs, jobs without usable timestamps or labels, and other unranked work stay in **No resource position yet**.
- Overview counts distinguish jobs, unique PRs, and identified PR authors. The status bar shows your latest queued/running counts and the snapshot time in its tooltip.

Search, PR selection, and **Only mine** keep each job's original resource position. **All resources** displays separate resource tables rather than one global queue.

## What a position means

A position is the order of **visible `queued` jobs in the selected repository**, sorted by `job.created_at` and then job ID within an identical normalized label set. Label order, letter case, and duplicate labels do not create separate groups. `self-hosted + nvidia` and `self-hosted + nvidia + h100` remain separate groups. Running jobs do not occupy waiting positions.

This is a reference order, not a promise from GitHub's scheduler. A job's creation time does not prove when it became ready for a runner. Different label sets can share machines; runner-group restrictions, other repositories, dependencies, approvals, and concurrency controls may affect actual execution. TileLang CI does not predict a start time or assume that every queued job is waiting only for hardware.

The collector reads active workflow statuses and the latest attempt of each run. It uses validated PR references and conservative commit/repository matching. **My PRs** refers to the PR author, not the person who triggered or reran CI. Ambiguous associations stay unconfirmed. A matching branch name alone is insufficient to mark a job as yours, and scheduled jobs are not assigned to a PR merely because they share a default-branch commit.

Missing resource labels or creation times do not produce invented positions. Active workflows with no jobs remain visible without a resource rank. GitHub's API does not always expose their precise blocking reason.

## Refresh, permissions, and local state

Automatic refresh defaults to **120 seconds**, only while the sidebar or dashboard is visible **and the VS Code window has focus**. Hiding the views or switching away pauses future automatic collections. An in-flight collection may finish. Manual refresh is also available. Repeated refreshes share one collection; switching repository or account cancels the old collection. There are no background completion notifications.

Conditional requests and in-memory caching reduce API work. Rate limits honor GitHub's retry/reset time; manual refresh does not bypass that wait. Network failures retain the last successful snapshot with its timestamp. Partial queue collection and incomplete PR associations have separate notices; positions from an incomplete queue are explicitly marked as positions in the collected results. A failed request is not displayed as a successful empty queue.

Authentication uses VS Code's built-in GitHub provider. Public access requests `read:user`; private access additionally requests OAuth `repo`. **The OAuth `repo` scope includes write permissions, even though TileLang CI only makes read requests.** No Actions write, runner administration, workflow cancellation, rerun, approval, or log-download operation is implemented.

Tokens remain in the extension host and VS Code's authentication provider; they are not sent to the Webview or stored in extension settings. Saved repository choices are local user state; the selected repository and filters are workspace state. Private repository snapshots and request caches are kept in memory. Account/session changes clear associated results and caches. The extension has no telemetry or hosted backend.

## Local and Remote SSH workspaces

TileLang CI is a **UI extension**: install it on the **local VS Code client**. GitHub API requests and authentication run locally even when the workspace is on a Remote SSH host. The remote machine does not need Python, `gh`, TileLang, or an installation of this extension.

Repository discovery reads Git metadata through VS Code's filesystem API. It supports normal `.git` directories, gitfiles, standard worktrees with `commondir`, and standard submodules. It searches upward from workspace roots and an active file inside the workspace, without recursively scanning the project. A fork `origin` and an upstream remote appear as separate candidates. A manual selection stays selected when you switch source files.

Discovery finds repository candidates rather than reproducing every effective Git configuration. It does not expand conditional `include` files, URL rewrites, or SSH Host aliases. Such configurations show a discovery warning or require manually entering the GitHub repository. Manual selection also works when workspace metadata is unavailable. First-version support is limited to `github.com`; GitHub Enterprise and browser-hosted VS Code are outside the supported release scope.

## Commands and settings

| Command ID | Command Palette action |
| --- | --- |
| `tilelangCI.open` | Open Dashboard |
| `tilelangCI.selectRepository` | Select Repository |
| `tilelangCI.refresh` | Refresh |
| `tilelangCI.signIn` | Sign in to GitHub |
| `tilelangCI.switchAccount` | Switch GitHub Account |
| `tilelangCI.enablePrivate` | Enable Private Repository Access |
| `tilelangCI.showLogs` | Show Diagnostics |
| `tilelangCI.demo` | Open Demo |

All commands are prefixed **TileLang CI:** in the Command Palette.

| Setting | Default | Behavior |
| --- | --- | --- |
| `tilelangCI.autoRefresh` | `true` | Refresh while a CI view is visible and the window is focused. |
| `tilelangCI.refreshIntervalSeconds` | `120` | Refresh interval, between 60 and 3,600 seconds. |
| `tilelangCI.showStatusBar` | `true` | Show the latest personal queue counts for the selected repository. |

## Development and packaging

Build tools require **Node.js 22+**. From the repository root:

```sh
npm ci
npm run build
code tilelang-ci.code-workspace
```

Press **F5** and select **Run TileLang CI**. In the Extension Development Host, open the Activity Bar view or run **TileLang CI: Open Demo**. For continuous rebuilding, use `npm run watch` in a separate terminal.

Development checks:

```sh
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:webview
npm run test:extension
npm run package
```

On headless Linux, run Extension Host tests with `xvfb-run -a npm run test:extension`. Browser installation on a fresh Linux machine may need `npx playwright install --with-deps chromium`. `VSCODE_TEST_VERSION` chooses the downloaded test host; `VSCODE_EXECUTABLE_PATH` uses an existing VS Code executable. On Windows systems where PowerShell blocks `npm.ps1`, invoke `npm.cmd` and `npx.cmd` instead.

`npm run package` builds and creates `tilelang-ci-vscode-0.1.1.vsix`. Packaging includes bundled runtime assets, documentation, and license notices; it does not require runtime `node_modules`. A browser preview, when using `npm run preview`, uses a mock VS Code bridge and demo data; it cannot test the real authentication provider or remote filesystem integration.

The test suite covers queue semantics, PR association, Git discovery, request handling, refresh scheduling, and host message validation. Webview tests load bundled assets with an isolated mock host. Extension Host tests exercise actual extension activation and offline commands. These tests do not by themselves validate a live GitHub login, private access, or Remote SSH installation.

CI is configured to run type checks, unit tests, and builds on Linux, Windows, and macOS. Its Linux job additionally runs Chromium Webview tests, offline Extension Host tests, and VSIX packaging. Workflow configuration is not a claim that a particular local or remote environment has passed; inspect the corresponding run and perform the release checks below.

### Manual release acceptance

1. Install the VSIX into desktop VS Code; open the demo in light, dark, and high-contrast themes. Check keyboard operation, a narrow editor, and a wide window at 100% zoom.
2. Select a public repository, sign in, and compare a sampled resource group's jobs and your PR associations with GitHub. Confirm resource filtering retains original positions.
3. Authorize a private repository you can access. Verify authorization denial is recoverable, and switching accounts clears the previous account's results.
4. From a Windows client, open a Linux Remote SSH workspace with a normal checkout, a worktree, and fork/upstream remotes. Confirm the extension runs locally, candidates are accurate, and manual selection handles unsupported Git configuration.
5. Hide both CI views, change window focus, and reopen after the refresh interval. Verify refresh pauses/resumes, errors retain a timestamped snapshot, and queued refreshes do not overlap.
6. Review VSIX contents, version, CHANGELOG, notices, screenshots, and CI results before an `easy-tilelang` Publisher maintainer uploads the release to Marketplace.

## License

[MIT](LICENSE). Bundled runtime dependency notices are in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
