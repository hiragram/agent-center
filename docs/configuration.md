# Configuration

Agent Center can run in configured mode with `--config`:

```sh
npm start -- --config agent-center.config.json
```

The config file is JSON. It defines which Event Emission Protocol streams to subscribe to, which service events to route, how to build the local prompt, and which local command to run.

## Top-Level Fields

- `execute`:
  Boolean. When `false`, Agent Center only logs the command it would run. When `true`, matching routes execute local commands.

- `codexBin`:
  Optional string. Path to the Codex CLI used by legacy built-in `codex` routes. Defaults to `/Applications/Codex.app/Contents/Resources/codex`.

- `openclawBin`:
  Optional string. Path to the OpenClaw CLI used by legacy built-in `openclaw` routes. Defaults to `openclaw`.

- `streams`:
  Required non-empty array. Each entry defines one SSE stream subscription.

## Stream Fields

Each `streams[]` entry has:

- `id`:
  Required string. Local name for the service stream, such as `github`, `docs`, or `billing`.

- `url`:
  Required string. Event Emission Protocol SSE endpoint.

- `headers`:
  Optional object of string values. These HTTP request headers are sent when Agent Center subscribes to the SSE endpoint. Use this for bearer tokens or other service-local authentication.

- `keepAliveIntervalHintSeconds`:
  Optional positive integer. Sends the `Event-Emission-Prefer-Keep-Alive-Interval` request header to the service.

- `routes`:
  Required non-empty array. Each route matches service events from this stream.

## Route Fields

Each `routes[]` entry has:

- `eventName`:
  Required string. Matches `message.event.event_name` from the received Event Emission Protocol message.

- `promptTemplate`:
  Optional string. Builds the prompt or command input from the received event. If omitted, Agent Center generates a generic prompt containing the full event JSON.

- `command`:
  Preferred execution configuration. Defines the exact local command to run.

- `agent`, `runner`, `cwd`, `model`, `thinking`, `sandbox`, `profile`, `json`:
  Legacy built-in runner fields. They are still supported, but new routes should prefer `command` because it makes the local CLI invocation explicit.

Events with no matching route are ignored.

## Command Fields

`command` is local trusted configuration. It is not read from service events.

- `bin`:
  Required string. Command binary or absolute path.

- `args`:
  Optional string array. Command arguments.

- `cwd`:
  Optional string. Working directory for the command.

- `env`:
  Optional object of string values. These values are added to the child process environment.

Agent Center executes commands with `spawn(bin, args)`. It does not run commands through a shell.

## Templates

Templates use `{{ path.to.value }}` placeholders. Missing values render as an empty string. Non-string values render as JSON.

Available template roots:

- `stream`: the local stream config, for example `{{ stream.id }}`.
- `route`: the matched route config, for example `{{ route.eventName }}`.
- `message`: the full Event Emission Protocol message.
- `event`: the message event body, equivalent to `message.event`.
- `data`: the service-specific event payload, equivalent to `message.event.data`.
- `prompt`: the rendered `promptTemplate`. Available in `command` templates.

Examples:

```text
{{ event.event_name }}
{{ message.message_id }}
{{ data.title }}
{{ data.url }}
{{ prompt }}
```

## Example: OpenClaw Agent

```json
{
  "execute": false,
  "streams": [
    {
      "id": "github",
      "url": "https://example.com/github/events",
      "headers": {
        "Authorization": "Bearer replace-with-token"
      },
      "routes": [
        {
          "eventName": "issue.opened",
          "promptTemplate": "A GitHub issue was opened.\n\nTitle: {{ data.title }}\nURL: {{ data.url }}\n\nReview the issue and decide the next action.",
          "command": {
            "bin": "openclaw",
            "args": [
              "agent",
              "--agent",
              "triage",
              "--message",
              "{{ prompt }}"
            ],
            "cwd": "/Users/rei/.openclaw/workspace/example-project"
          }
        }
      ]
    }
  ]
}
```

## Example: Codex CLI

```json
{
  "execute": false,
  "streams": [
    {
      "id": "docs",
      "url": "https://example.com/docs/events",
      "routes": [
        {
          "eventName": "comment.created",
          "promptTemplate": "A document comment was created.\n\nDocument: {{ data.document_title }}\nComment: {{ data.comment_text }}\n\nDecide whether documentation needs to be updated.",
          "command": {
            "bin": "/Applications/Codex.app/Contents/Resources/codex",
            "args": [
              "exec",
              "--sandbox",
              "workspace-write",
              "{{ prompt }}"
            ],
            "cwd": "/Users/rei/.openclaw/workspace/docs-project"
          }
        }
      ]
    }
  ]
}
```

## Safety Model

Service events are data. They should describe what happened in the service.

Agent Center decides locally:

- which event names are routed
- which prompts are generated
- which local commands run
- which working directory and environment are used

Only use `--execute` with authenticated, trusted SSE endpoints. Treat the config file as trusted code because it can run local commands.
