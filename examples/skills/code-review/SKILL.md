---
name: code-review
description: Review a diff or file for real bugs (not style nits) and report findings by severity.
---

# Code review

Use this when the user asks to review code, a diff, or a pull request.

## Steps

1. Identify the scope. If the user gave no path, run `git status --short` and `git diff` in the workspace.
2. Read the changed files **in full**, plus the functions they call. Never review a diff in isolation.
3. Look for, in this order:
   - correctness bugs (wrong condition, off-by-one, unhandled null, race)
   - data loss / security issues (unvalidated input, path traversal, leaked secrets)
   - broken error handling (swallowed errors, missing await)
   - API/contract mismatches with callers
4. Verify each suspicion before reporting it. If you can run the tests or a quick repro, do it.
5. Report only issues you are confident about, grouped as **Blocker / Should fix / Nit**, each with
   `file:line`, what breaks, and a concrete fix. If nothing is wrong, say so plainly.

## Rules

- No style preferences unless they cause real problems.
- Never paste the whole file back. Quote the 1-3 relevant lines.
- Do not edit code unless the user asked for fixes.
