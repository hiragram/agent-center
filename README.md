# Agent Center

Relay Event Emission Protocol events to local command and agent runs.

This is an implementation app, not part of the Event Emission Protocol specification. The protocol only delivers service events; this relay decides locally which events should invoke commands or agents.

## Event Contract

Single-stream compatibility mode listens for `codex.run.requested` events.

```json
{
  "protocol_version": "0.1.0",
  "message_id": "msg_123",
  "type": "event.created",
  "created_at": "2026-05-15T12:00:00Z",
  "event": {
    "event_name": "codex.run.requested",
    "data": {
      "prompt": "Summarize the repository status",
      "cwd": "/Users/rei/.openclaw/workspace/event-emission-protocol-ts",
      "model": "gpt-5.2",
      "thinking": "medium"
    }
  }
}
```

Configured mode treats service events as facts about what happened. Events do not need to contain agent instructions or `prompt`.

## Usage

Until the TypeScript SDK packages are published to npm, this repository uses vendored SDK package tarballs in `vendor/`.

```sh
git clone https://github.com/hiragram/agent-center.git
cd agent-center
npm install
npm test
npm start -- --url http://127.0.0.1:8787/events --execute
```

Without `--execute`, the relay runs in dry-run mode and logs what it would invoke.

### Route Events to Commands

Use a config file when different services or events should run different local commands:

```sh
cp agent-center.config.example.json agent-center.config.json
npm start -- --config agent-center.config.json
```

Full configuration reference: [`docs/configuration.md`](docs/configuration.md).

Example:

```json
{
  "execute": false,
  "streams": [
    {
      "id": "github",
      "url": "https://example.com/github/events",
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
    },
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

Agent Center creates command input locally from `promptTemplate`. Templates can reference the received event with paths such as `{{ event.event_name }}`, `{{ data.title }}`, or `{{ message.message_id }}`.

`command.bin`, `command.args[]`, `command.cwd`, and `command.env` are also templates. `{{ prompt }}` contains the rendered prompt. Agent Center uses `spawn` with an argument array; it does not run command templates through a shell.

Without `promptTemplate`, Agent Center sends a generic prompt containing the full event JSON. Events with no matching route are ignored.

For compatibility, routes without `command` can still use the built-in `agent`, `runner`, `cwd`, `model`, `thinking`, `sandbox`, `profile`, and `json` fields. New routes should prefer `command` because it makes the exact CLI invocation explicit.

To refresh the vendored SDK tarballs from a sibling SDK checkout:

```sh
mkdir -p vendor
npm pack ../event-emission-protocol-ts/packages/core --pack-destination vendor
npm pack ../event-emission-protocol-ts/packages/client --pack-destination vendor
npm install
```

Environment variables:

- `EEP_STREAM_URL`: SSE endpoint URL.
- `CODEX_BIN`: Codex CLI path. Defaults to `/Applications/Codex.app/Contents/Resources/codex`.
- `CODEX_RELAY_EXECUTE`: set to `1` to execute without `--execute`.
- `CODEX_RELAY_KEEP_ALIVE_SECONDS`: preferred SSE keep-alive interval hint.

## Security Notes

The SSE endpoint should be authenticated before using `--execute`. Events can cause local commands to run, so do not point this relay at an untrusted stream.

Command templates are local configuration and should be treated as trusted code. Event data is only interpolated into arguments; commands are not evaluated through a shell.
