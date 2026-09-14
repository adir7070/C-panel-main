---
name: lean-context
description: "Token-efficient coding workflow. Minimizes unnecessary scanning, re-reading, verbose updates, and oversized context during simple tasks."
---

# Lean Context

## Overview

Use this skill when the goal is to solve coding tasks with the smallest reasonable context footprint. Default to precise, local changes and avoid broad project exploration unless the task genuinely requires it.

## Core Rules

- Assume the user wants the shortest reliable path to completion.
- Read only the files that are directly named by the user first.
- Do not scan the whole repository unless a direct local read fails to answer the question.
- Do not re-open the same file unless new information makes it necessary.
- Keep progress updates to one short sentence unless the task becomes risky or ambiguous.
- Keep final output compact and implementation-focused.

## Efficiency Defaults

### 1) Start narrow

- If the user mentions a file, function, route, service, error, or stack trace, start there.
- Prefer one targeted `rg` query over multiple exploratory searches.
- Prefer `sed -n` or targeted reads over opening large files in full.

### 2) Limit exploration

- Avoid reading unrelated tests, configs, or neighboring modules unless:
  - the current file imports them
  - the fix depends on their contract
  - the user explicitly asks for broader investigation
- If two targeted reads do not unblock the task, explain the new scope briefly and then expand.

### 3) Avoid context churn

- Do not restate the full problem after every tool call.
- Do not summarize command output unless it changes the plan.
- Do not repeat file contents back to the user.
- Avoid duplicate searches for symbols already located.

### 4) Edit with minimal surface area

- Prefer the smallest safe patch.
- Preserve existing patterns instead of introducing new abstractions for simple fixes.
- Do not refactor adjacent code unless it directly reduces risk for the requested change.

### 5) Verify proportionally

- Run the narrowest check that gives confidence.
- For a local logic change, prefer one targeted test or lint command over a full suite.
- If verification is skipped, state that plainly in one line.

## Decision Guide

### Simple asks

Examples:
- explain a function
- fix a typo
- patch one route
- answer why a value is undefined

Workflow:
1. Read the named file or symbol.
2. Read at most one directly-related dependency if needed.
3. Implement the smallest fix.
4. Run one targeted verification if available.

### Medium asks

Examples:
- bug spans service plus route
- unclear ownership between two modules
- request mentions a flow, not a file

Workflow:
1. Find the primary entry point with one targeted search.
2. Read only the files on that execution path.
3. Stop expanding once the root cause is identified.
4. Implement and run focused verification.

### Broad asks

Examples:
- "audit the whole flow"
- "why is the system slow"
- "review this feature"

Workflow:
- Say explicitly that the task is broad and will require more context.
- Group investigation by feature area.
- Still avoid duplicate reads and unnecessary summaries.

## Response Style

- Use short, direct language.
- Prefer: "I traced this to X in `file.js` and patched Y."
- Avoid long plans unless the task has hidden consequences.
- Avoid educational deep-dives unless the user asks for them.

## Recommended Trigger Phrases

Use this skill proactively when the user asks for:

- faster / cheaper / leaner agent behavior
- lower token usage
- minimal context
- no repo-wide scan
- short answers
- targeted fixes only

## Output Contract

When this skill is active:

- Keep intermediary updates brief.
- Mention only the files that actually mattered.
- In the final response, include:
  - what changed
  - how it was verified
  - any single remaining risk, if relevant

## Anti-Patterns

Avoid these unless clearly justified:

- repo-wide `rg --files` for a single-file bug
- opening large files top-to-bottom without a target
- reading tests before understanding the failing code path
- verbose "thinking out loud" after every command
- broad refactors for isolated defects
- repeating the same explanation in updates and final output
