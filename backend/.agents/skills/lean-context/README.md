# Lean Context

A local skill for token-efficient coding work. It keeps agent behavior focused, avoids unnecessary repository scanning, and favors small targeted edits with proportionate verification.

## Use Cases

- Simple bug fixes in one or two files
- Questions about a specific service, route, or function
- "Explain this file" requests
- Situations where you want shorter answers and less context overhead

## Usage

Run:

```text
/lean-context
```

Or ask for it directly in plain language, for example:

```text
Use lean-context and fix the bug in appointments.routes.js
```

## What It Changes

- Starts from user-named files first
- Limits repository exploration
- Avoids duplicate reads and repeated summaries
- Prefers the smallest safe patch
- Uses focused verification instead of broad test runs

## Good Prompt Examples

```text
/lean-context explain why this route returns 500
```

```text
/lean-context patch only the WhatsApp session reconnect logic
```

```text
/lean-context answer briefly and do not scan the whole repo
```
