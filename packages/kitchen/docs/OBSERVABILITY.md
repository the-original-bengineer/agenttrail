# Observability in the harness fork

Open **Observability** beside **Connect agents**. This panel always shows live
server data, not scripted Example activity. The existing Kitchen remains the
working view; the panel adds a compact overview and optional history.

## Projects, sessions and connections

The overview covers the folders you explicitly opened, up to 12. It counts real
sessions, not inferred role chefs. Select a project to inspect providers and
session metadata, or choose **Open project** to return to its Kitchen.

Provider freshness means recent or quiet *observations*. It is not a heartbeat,
health guarantee or proof that an idle agent disconnected. Local log availability
is discovery on this machine, not a connection to the selected project. Hooks
configured means configuration was found, not that an event arrived. OpenCode
requires restarting the managed client after installation; safe mode excludes
its adapter. A lost browser connection explicitly marks the displayed data stale.

Session summaries show allowlisted activity, task counts and reported parent
identity where available. They do not invent ownership or blockers. OpenCode
task text stays private and labels remain generic. Existing Kitchen task tickets
and other observers can still show native titles and project paths; review
screenshots before sharing.

## Reported checks

Verification evidence is separate from native task completion. Only simple,
recognized test/build/lint/check commands are categorized. Compound commands
and unsupported formats remain unknown. The command and output are not included
in the evidence record.

- Supported Codex desktop completed-command records with an explicit exit code
  can report passed or failed. This is a command result, not independent proof
  of test coverage or delivery.
- OpenCode terminal tool parts and correlated Claude tool results can report
  an error or interruption. Normal completion without a supported exit record
  stays unknown; a tool successfully returning is not a test pass.
- Arbitrary successful commands, file changes, agent prose and finished todos
  do not generate passed verification evidence.

## Usage, not billing

OpenCode reports numeric tokens from observed completed assistant messages.
Repeated message snapshots replace the same message's metrics instead of adding
them again. This is partial observation, not a historical session reconstruction.
Codex reports the latest cumulative session token counter; replayed counters are
not summed. A lower counter is labeled as a reset rather than added to the old
one. No usage event changes an ended session back into a working agent.

Input/output/cached/reasoning numbers have provider-specific meanings. Cached
and reasoning fields can be subsets and are displayed separately, never added
to a fabricated total. Missing or invalid metrics are unknown, not zero. Claude
and Cursor token usage are currently unsupported. Monetary cost stays unknown;
the panel does not turn subscription usage into guessed API charges.

Source-backed schema fixtures:
- [OpenCode v1.18.35 Assistant and message events](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/schema/src/v1/session.ts):
  `message.updated` assistant `info.tokens` after `info.time.completed`.
- [Codex rust-v0.116.0 protocol](https://github.com/openai/codex/blob/rust-v0.116.0/codex-rs/protocol/src/protocol.rs):
  `token_count.info.total_token_usage`, not `last_token_usage` deltas.

Local log schemas are best-effort and can change between provider versions.
Unsupported changes must stay unknown rather than be interpreted speculatively.

## Choose local history

Open Kitchen through `agenttrail /path/to/repo` to authorize private history in
your browser. The launcher opens a mode-0600 handoff file in the private state
directory. A separate owner credential reaches JavaScript through a URL
fragment, is removed from the address bar, and stays in memory for authenticated
history requests. It is not printed, put in request URLs/process arguments, or
returned by public bootstrap/state/event endpoints.

A bare localhost visit can still show the existing live dashboard, but retained
history, recording settings and counts stay locked. Reloading the page loses
the in-memory credential; rerun `agenttrail` to reopen an authorized tab. Server
restart rotates authorization. `--no-open` intentionally does not print an
authorization link. Existing live observation remains a local-loopback view;
history authorization specifically protects the new durable records and controls
from other local accounts.

History is **disabled by default**, including after installation. Enable it in
Observability and save the settings. Only new timestamped observations are
recorded while enabled; existing logs are not backfilled. Restarting the server
loads retained records for browsing but does not turn them into live activity.

Default retention is seven days, adjustable from one to 30 days. The store caps
at 10,000 records and 10 MiB. Queries return at most 200 newest matching records;
the panel indicates history/query truncation. Use project/provider/session-key
filters; a complete session key selects that session, while a shorter hexadecimal
prefix can intentionally match several sessions.

Retained fields are hashed project/session/event keys, provider, timestamp,
generic state/tool category, task counts, allowlisted check metadata and supported
numeric usage. No native task titles, raw paths, prompts, reasoning, commands,
arguments, tool output, error details or credentials are retained by this store.
Identifiers and activity patterns can still be sensitive: local-only is not
anonymous.

Disabling stops recording but keeps existing history until it expires or you
choose **Clear history** and confirm. Clearing removes retained events from
memory and the on-disk JSON. Records are never re-ingested to revive agents or
complete tasks. History write errors are visible and do not block coding.

The managed file is `~/.local/state/code-harness/agenttrail/history.json`, mode
0600 inside the private state directory. Unsafe paths/files fail closed. A
corrupt file disables recording and requires explicit clearing before recovery.
Do not print or share `server.json` or `dashboard.html`: they contain local
connector/history credentials.
