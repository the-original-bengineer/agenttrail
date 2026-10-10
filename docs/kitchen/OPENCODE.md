# OpenCode in the harness fork

This fork adds OpenCode to Kitchen. Map is unchanged. The upstream
`agenttrail-kitchen@0.1.0-alpha.3` package does not include this adapter.

## Install and open

Keep this checkout next to `code-harness`. From the harness run:

```sh
make agenttrail
agenttrail /absolute/path/to/repo
```

The harness verifies the fork's recorded source checksum, builds in a private
staging directory using locked dependencies without npm lifecycle scripts, and
installs an independent snapshot. It does not commit, publish, start a service,
change login settings or add a shell-startup entry. Fresh-machine installs need
the approved checkout until a fork release is published. Editing the fork
requires updating the reviewed harness source pin before reinstalling.

Quit and restart OpenCode after configuration. Normal, local and visual managed
profiles include the plugin; safe mode does not. Open the dashboard before
working in OpenCode: the adapter does not replay historical OpenCode sessions.
Keep its terminal open and stop it with Ctrl-C. Multiple project folders can
be attached to the running Kitchen. The managed registration directory is
`~/.local/state/code-harness/agenttrail`, not upstream's `~/.agent-office`.

## What is visible

- Actual session and child-session identities (hashed locally).
- Known tool categories, tool starts and terminal success/error state.
- Permission waits, retries, interruption and idle/waiting state. Idle is not
  outcome completion. Permissions remain in OpenCode; Kitchen cannot grant them.
- Native todos from `todo.updated`, with their reported status and generic
  `Task 1`, `Task 2` labels. Canceled todos are withdrawn, not completed. A failed
  tool's proposed arguments never become a task list.
- Numeric token usage from observed completed assistant messages. Repeated
  message snapshots replace their metrics; no historical replay is implied.
- Recognized check categories with reported error/interruption or unknown
  result. A normally completed command tool is not automatically a passed test.

The **Observability** panel adds project/session summaries, observation freshness,
reported evidence, supported usage and optional private local history. See the
[fork guide](../../packages/kitchen/docs/OBSERVABILITY.md) for exact fields,
retention, deletion and unsupported metrics. History is off by default.

The plugin targets the event interface documented by
[`@opencode-ai/plugin@1.18.35`](https://unpkg.com/@opencode-ai/plugin@1.18.35/dist/index.d.ts)
and its [SDK types](https://unpkg.com/@opencode-ai/sdk@1.18.35/dist/gen/types.gen.d.ts).
It accepts both legacy permission-updated and modern permission-asked events.
No provider identity is disguised as Codex or Claude.

## Privacy and limits

The OpenCode adapter sends no prompts, reasoning, task text, commands, tool
arguments/outputs, error details or file contents. It does send the canonical
project directory and bounded hashed IDs. Unknown tools receive a generic label.
Only the authenticated loopback endpoint is used: private owned registration,
no redirects, 500 ms delivery timeout, bounded queue, two-second expiry and no
disk buffer. Missing/unsafe state, shutdown or networking errors disable
observation without affecting coding. State must not be group/world writable.

This does **not** make all Kitchen data anonymous. Kitchen's existing project
watcher and native Codex/Claude observers read local project/log metadata and
can show paths, task titles and plan context. Do not share screenshots without
reviewing them. No Gemini adapter, monetary cost accounting, full trace history or
quality judge is included. The optional metadata history is not a transcript
archive. Native Codex/Claude plan acknowledgement and Map
precedence limitations recorded in PLAN.md remain upstream issues. Observed
task completion is a provider report, not proof of delivery.
