# OpenCode ntfy plugin

Requires **OpenCode 2.2.1 or newer**, including the background service. Older
versions are rejected before the plugin registers any hooks.

A small local OpenCode plugin that:

- publishes a notification when a root session becomes idle;
- publishes a notification when OpenCode needs permission, unless auto-approve answers it;
- dismisses completion, permission, and question notifications when they become stale or OpenCode shuts down cleanly;
- publishes a simple notification for `form.created` events;
- hides chat-derived session titles by default, with an explicit opt-out.

This directory is deliberately outside `.opencode/plugins`, so merely having it here does not install or enable it.

## Configuration

The plugin accepts these options, with environment-variable fallbacks:

| Option | Environment variable | Default |
| --- | --- | --- |
| `topic` | `NTFY_TOPIC` | required |
| `server` | `NTFY_SERVER` | `https://ntfy.sh` |
| `token` | `NTFY_TOKEN` | none |
| `username` | `NTFY_USERNAME` | none |
| `password` | `NTFY_PASSWORD` | none |
| `allowInsecureHttp` | `NTFY_ALLOW_INSECURE_HTTP` | `false` |
| `hideChatContent` | `NTFY_HIDE_CHAT_CONTENT` | `true` |
| `showProjectDirectory` | `NTFY_SHOW_PROJECT_DIRECTORY` | `false` |
| `priority` | `NTFY_PRIORITY` | `4` |
| `requestTimeoutMs` | `NTFY_REQUEST_TIMEOUT_MS` | `5000` |
| `retryAttempts` | `NTFY_RETRY_ATTEMPTS` | `3` |
| `retryDelayMs` | `NTFY_RETRY_DELAY_MS` | `250` |
| `permissionDelayMs` | `NTFY_PERMISSION_DELAY_MS` | `100` |

`url` and `NTFY_URL` remain supported as aliases for `server` and `NTFY_SERVER`.
Plugin options take precedence over environment variables. If any primary
authentication option (`token`, `username`, or `password`) is present, the
plugin ignores all primary authentication environment variables instead of
mixing credentials from both sources.

The numeric settings are bounded. `requestTimeoutMs` must be a finite integer
from 1 to 120000 milliseconds. `retryAttempts` is the total number of attempts,
including the first, and must be a finite integer from 1 to 5. `retryDelayMs` is
the initial delay for exponential retry backoff and must be a finite integer
from 0 to 30000 milliseconds. `permissionDelayMs` is the delay before publishing
a permission alert, allowing automatic replies to cancel it during that grace
period, and must be a finite integer from 0 to 60000 milliseconds. Supply
numeric plugin options as JSON numbers; environment variables are numeric
strings. Out-of-range and non-numeric values reject setup instead of silently
falling back to a default.

`priority` must be a finite integer from 1 to 5 and applies to completion,
question, and permission alerts. The default is 4, which ntfy Android treats as
high messaging priority, so push delivery is consistent across alert types. Set
`priority` to 3, or `NTFY_PRIORITY` to `3`, to choose normal priority explicitly.

Chat-derived text is excluded from ntfy payloads by default. Notifications use
`OpenCode` as their title and retain generic event text such as completion,
permission, and question notices. Set `hideChatContent` to `false`, or set
`NTFY_HIDE_CHAT_CONTENT` to `0`, `false`, `no`, or `off`, to include the current
session title. Question notifications never include prompts, descriptions, or
answer options.

Project directory names are omitted by default. Set `showProjectDirectory` to
`true`, or set `NTFY_SHOW_PROJECT_DIRECTORY` to `true`, `1`, `yes`, or `on`, to
append the basename of the session's directory as a second plain-text line in
the notification body. This is independent of `hideChatContent`: it never
includes the full path and does not change title hiding. If the directory is
unknown, empty, or a filesystem root, the body is unchanged. Invalid values
reject setup. To opt in, add the option to the plugin configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-ntfy",
      "options": {
        "topic": "replace-with-random-topic",
        "showProjectDirectory": true
      }
    }
  ]
}
```

Use an unguessable topic name. A topic on a public ntfy server is effectively a password.

If you later choose to enable the plugin, reference this file from OpenCode's native V2 `plugins` array. For example:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-ntfy",
      "options": {
        "topic": "replace-with-random-topic",
        "server": "https://ntfy.example.com"
      }
    }
  ]
}
```

Use OpenCode 2.2.1 or newer. Run `npm install` in the plugin directory before
loading it. This installs the pinned V2 plugin API and the development tools
used by the test suite. Unsupported hosts are rejected before hooks are
registered. Updating this package does not update the OpenCode CLI
or its background service. Check that the executable on your `PATH` reports
2.2.1 or newer, especially if you have multiple OpenCode installations:

```sh
opencode --version
```

Restart the OpenCode service after upgrading OpenCode or updating the plugin
or its configuration:

```sh
opencode service restart
```

Pass secrets through the environment inherited by the OpenCode process and omit
them from plugin options:

```sh
export NTFY_TOKEN="replace-with-plugin-token"
```

Direct plugin options are also supported for every setting, including `token`.
This places plaintext tokens in OpenCode configuration, so prefer environment
variables. Keep any configuration containing secrets private and out of source
control.

The plugin does not load `.env` files. Set both `username` and `password` for primary HTTP Basic authentication, or set `token` for primary bearer authentication. The plugin rejects partial Basic credentials and configurations containing both primary authentication methods.

The server URL must use HTTP or HTTPS and cannot contain embedded credentials,
a query string, or a fragment. Base paths are supported. Publish and dismissal
requests reject redirects, so configure the final ntfy URL directly.

Authentication requires HTTPS by default, including for loopback addresses.
For a trusted HTTP endpoint, set `allowInsecureHttp` to `true` or
`NTFY_ALLOW_INSECURE_HTTP` to `true`. This sends credentials without transport
encryption. The plugin option must be a JSON boolean; the environment variable
accepts `true`, `1`, `yes`, or `on` to enable it and `false`, `0`, `no`, or `off`
to disable it, ignoring case and surrounding whitespace. Invalid values reject
setup. Unauthenticated HTTP does not require this opt-in.

Use a non-admin ntfy account with this minimum ACL, where
`replace-with-random-topic` is the configured fixed topic:

| Account | Topic pattern | Access |
| --- | --- | --- |
| plugin | `replace-with-random-topic` | write-only |

Subscribe to the fixed topic in the ntfy Android app with an account allowed to read it.

## Notification behavior

Question notifications only report that OpenCode has a question. They do not show the question, list options, or support answering through ntfy. Answer questions in OpenCode.

Notification dismissal requires ntfy server 2.16.0 and ntfy Android 1.22.2 or newer. Completion notifications are dismissed when the session receives another prompt, is archived, or is deleted. Permission notifications wait briefly for an automatic answer, then check whether the request is still pending before publishing. Published permission notifications are dismissed when answered or when their session is archived or deleted. They alert you to return to OpenCode and do not include remote approval actions. Question notifications are dismissed when answered or rejected, or when their session is archived or deleted. Closing a session tab in the Web/Desktop UI cannot dismiss notifications: tab state is client-local and OpenCode emits no plugin event for it. Unloading the plugin or stopping the OpenCode service attempts to dismiss outstanding notifications. An abrupt process kill cannot clear them immediately; a later plugin startup retries stored dismissals.

### Delivery behavior

Completion alerts are driven primarily by the native `session.execution.succeeded` event. Idle events, including `session.idle` and status-idle fallbacks, are also observed and coalesced per activity cycle, so duplicate success or idle signals publish at most one completion notification until new activity begins another cycle. Execution failed or interrupted events do not produce success alerts. Retry handling observes OpenCode's retry decision without changing its policy. Completion notifications are published only for root sessions. When `hideChatContent` is enabled, question and permission alerts are sent without a session title lookup. If title content is enabled but the title is unavailable, request alerts fall back to `OpenCode`.

Publishes and dismissals use the configured request timeout and bounded retries for network failures, timeouts, and HTTP 408, 425, 429, 500, 502, 503, and 504. Other HTTP errors, including 400, 401, 403, and 404, fail without retry. A `Retry-After` header is honored when the requested delay is 30 seconds or less. A longer delay is logged as a failure rather than retried earlier than the server allows.

Retries reuse the same ntfy `sequence_id`, so retries do not create separate notification sequences. This is not an exact-once guarantee: if the server accepted a request but its HTTP response was lost, a retry can send the notification again.

Session metadata lookups retry once after a transient network failure, timeout,
or retryable HTTP status, using `retryDelayMs` between attempts and
`requestTimeoutMs` for each attempt. Setting `retryAttempts` to 1 disables this
retry. If the plugin cannot establish that a session is a root session, it skips
the completion alert.

Session-list, permission, and storage-scan requests use bounded deadlines so a
stalled dependency cannot hold reconciliation open indefinitely. Permission
evaluation schedules advisory checks only for `ask` decisions and coalesces
bursts per session. Allowed tool actions do not schedule advisory checks, and
the plugin does not change OpenCode's permission or retry policy.

The event subscription reconnects automatically after a failure or end of the
stream with exponential backoff and jitter, capped at 10 seconds. The backoff
resets after a connection remains open for 10 seconds, rather than on its first
event. The public OpenCode event stream is live-only, so events emitted while
disconnected cannot be replayed. Startup and reconnect reconciliation use
session snapshots and pending permission requests to repair notification state.
Sessions observed executing have durable activity checkpoints, allowing a later
snapshot to recover a missed successful completion. Startup does not send
completion alerts for every historical idle session. Prompt admission alone
does not create a recoverable execution checkpoint.

Notification sequence IDs are saved through `ctx.storage` before publishing.
Successful dismissal removes the stored record; failed dismissal retains it for
a later retry. Storage is scoped by server, topic, and plugin location so one
configuration does not clear another configuration's records. Stored records
exclude authentication credentials and chat-derived titles. If a notification
record cannot be saved, the plugin skips publication rather than creating an
alert it cannot track across a restart.

Snapshot recovery is not exact event replay. The public plugin context exposes
neither session event logs nor form lookup. Question events missed during a
disconnect cannot be reconstructed, and stored question notifications from a
previous process are cleared rather than assumed to remain pending.

The plugin targets the pinned OpenCode 2.2.1 API and requests only relevant
event types from its event subscription. Durable session events are ordered by
their aggregate ID and sequence number. Server event timestamps are not
compared with the local prompt clock.

When both the plugin and an event identify their workspace, workspace IDs take
precedence over directory spelling. Otherwise the plugin checks directories
and available project IDs, falling back to cached session locations when an
event omits its location. Sharing a project does not make separate worktrees
the same notification scope. Session metadata lookups also check the location
before publishing. Moving a session out of the plugin's location cancels pending
alerts and dismisses existing ones; moving it back permits notifications again.
Hidden-content request alerts do not perform an extra lookup solely to discover
an unknown location.

The prompt hook performs remote dismissal in the background so a slow ntfy server does not block OpenCode. Archiving or deleting a session, answering or rejecting a question, and answering a permission request cancel stale notifications. Clean shutdown attempts a bounded, best-effort clearing of notifications created by the process; an abruptly killed process cannot clear them.

A successful plugin-to-server POST means the ntfy server accepted the request; it does not measure delivery to the phone, and high priority does not guarantee immediate delivery. Phone battery restrictions, network conditions, or ntfy server configuration can add delay. If alerts are delayed, check those factors together with the ntfy app's subscription and notification settings.

The ntfy server URL must be reachable by both the machine running OpenCode and the phone. The OpenCode server itself remains local and does not need an exposed port.

## Development checks

Run `npm test` to execute every root `*.test.mjs` file, including transport and runtime coverage. Run `npm run typecheck` to typecheck `index.ts` and its imported modules.

Regression coverage includes request timeouts and abort release, bounded retry
and non-retry statuses, `Retry-After` limits, stalled response bodies, duplicate
idle coalescing, stale completion invalidation, question and permission dismissal,
auto-approval suppression, shutdown races, clock skew, reconnect backoff, URL and
authentication validation, metadata lookup retries, workspace identity,
out-of-order lifecycle events, durable notification recovery, storage scope
isolation, reconnect snapshots, filtered subscriptions, and hook cleanup.
