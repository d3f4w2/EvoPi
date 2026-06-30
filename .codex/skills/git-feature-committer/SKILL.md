---
name: git-feature-committer
description: Use when Codex has finished a small feature slice and should verify git state, stage only related files, write a clear commit, push if requested, or update this skill when git workflow mistakes or better practices are discovered.
---

# Git Feature Committer

## Purpose

Use this workflow after each small completed feature or documentation slice. The goal is to keep history reviewable: one coherent change per commit, a clear message, and no accidental dependency, build, secret, or nested-repository artifacts.

## Workflow

1. Verify the repository before staging.
   - Run `git rev-parse --is-inside-work-tree`.
   - If it fails but `.git` exists, inspect whether `.git` is empty or invalid before running `git init`.
   - Run `git status --short` and identify unrelated changes.

2. Protect the repository before the first commit.
   - Ensure `.gitignore` excludes dependency and generated folders such as `node_modules/`, `dist/`, `.cache/`, logs, env files, and runtime trace outputs.
   - For nested repositories, do not blindly `git add .`. Decide whether they are ignored, vendored intentionally, or added as submodules.

3. Stage only the current feature slice.
   - Prefer explicit paths: `git add README.md .gitignore`.
   - Use `git diff --staged --stat` and `git diff --staged -- <path>` before committing.
   - Never stage unrelated user changes just because they are present.

4. Commit with a clear message.
   - Use concise Chinese messages with a conventional scope:
     - `chore: 初始化 EvoPi 仓库`
     - `docs: 添加 EvoPi Harness 模块文档`
     - `feat: 添加 EvoPi trace harness 扩展`
     - `docs(skill): 添加 Git 小步提交工作流`
   - Body is optional, but add one when the commit has multiple moving parts or important verification notes.

5. Verify after commit.
   - Run `git status --short`.
   - Run `git log --oneline -5` when preparing to report or push.

6. Push only when requested or clearly part of the task.
   - Ensure remote is correct with `git remote -v`.
   - Use `git push -u origin main` for the first push of `main`.
   - If push fails due authentication/network, report the exact failure and do not rewrite history.

## Update Rule

When a new git mistake, environment issue, or better practice appears, update this skill in the same session and commit that update separately.

Examples from this project:

- An empty `.git` directory is not a valid repository; verify with `git rev-parse` after initialization.
- Run `.gitignore` setup before broad staging so failed dependency installs do not get committed.
- Avoid `git add .` when the workspace contains nested repositories such as `pi/`.
- If a nested repository is only a local upstream checkout/reference, ignore the whole directory, not only its `.git` and generated artifacts.
- If a nested repo reports dubious ownership, do not change global trust unless the operation truly requires inspecting that nested repo.
- On Windows, avoid saving `SKILL.md` with a UTF-8 BOM; if validation fails unexpectedly, rerun validation with `PYTHONUTF8=1` and inspect the first bytes/frontmatter.

