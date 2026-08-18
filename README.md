# OpenCode ntfy plugin

A small local OpenCode plugin that:

- publishes a notification when a root session becomes idle;
- publishes a notification when OpenCode needs permission;
- dismisses completion, permission, and question notifications when they become stale or OpenCode shuts down cleanly;
- publishes a simple notification for `question.asked` events;
- hides chat-derived session titles by default, with an explicit opt-out.

This directory is deliberately outside `.opencode/plugin`, so merely having it here does not install or enable it.

## Configuration

The plugin accepts these options, with environment-variable fallbacks:

| Option | Environment variable | Default |
| --- | --- | --- |
| `topic` | `NTFY_TOPIC` | required |
| `server` | `NTFY_SERVER` | `https://ntfy.sh` |
| `token` | `NTFY_TOKEN` | none |
| `username` | `NTFY_USERNAME` | none |
| `password` | `NTFY_PASSWORD` | none |
| `hideChatContent` | `NTFY_HIDE_CHAT_CONTENT` | `true` |

`url` and `NTFY_URL` remain supported as aliases for `server` and `NTFY_SERVER`.
Plugin options take precedence over environment variables. If any primary
authentication option (`token`, `username`, or `password`) is present, the
plugin ignores all primary authentication environment variables instead of
mixing credentials from both sources.

Chat-derived text is excluded from ntfy payloads by default. Notifications use
`OpenCode` as their title and retain generic event text such as completion,
permission, and question notices. Set `hideChatContent` to `false`, or set
`NTFY_HIDE_CHAT_CONTENT` to `0`, `false`, `no`, or `off`, to include the current
session title. Question notifications never include prompts, descriptions, or
answer options.

Use an unguessable topic name. A topic on a public ntfy server is effectively a password.

If you later choose to enable the plugin, reference this file from OpenCode's `plugin` array. For example:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "/absolute/path/to/opencode-ntfy/index.ts",
      {
        "topic": "replace-with-random-topic",
        "server": "https://ntfy.example.com"
      }
    ]
  ]
}
```

No package installation is required by this plugin. Quit and restart OpenCode after changing its configuration.

Pass secrets through the environment inherited by the OpenCode process and omit
them from plugin options:

```sh
export NTFY_TOKEN="replace-with-plugin-token"
```

Direct plugin options are also supported for every setting, including `token`.
This places plaintext tokens in OpenCode configuration, so prefer environment
variables. Keep any configuration containing secrets private and out of source
control.

The plugin does not load `.env` files. Set both `username` and `password` for primary HTTP Basic authentication, or set `token` for primary bearer authentication. The plugin rejects partial Basic credentials and configurations containing both primary authentication methods. Use HTTPS to protect credentials in transit.

Use a non-admin ntfy account with this minimum ACL, where
`replace-with-random-topic` is the configured fixed topic:

| Account | Topic pattern | Access |
| --- | --- | --- |
| plugin | `replace-with-random-topic` | write-only |

Subscribe to the fixed topic in the ntfy Android app with an account allowed to read it.

## Notification behavior

Question notifications only report that OpenCode has a question. They do not show the question, list options, or support answering through ntfy. Answer questions in OpenCode.

Notification dismissal requires ntfy server 2.16.0 and ntfy Android 1.22.2 or newer. Completion notifications are dismissed when the session receives another prompt, is archived, or is deleted. Permission notifications are dismissed when answered or when their session is archived or deleted. They alert you to return to OpenCode and do not include remote approval actions. Question notifications are dismissed when answered or rejected, or when their session is archived or deleted. Closing a session tab in the Web/Desktop UI cannot dismiss notifications: tab state is client-local and OpenCode emits no plugin event for it. Quitting OpenCode dismisses all notifications created by that process when plugin shutdown completes; an abrupt process kill cannot.

The ntfy server URL must be reachable by both the machine running OpenCode and the phone. The OpenCode server itself remains local and does not need an exposed port.
