# Agent Center

Relay Event Emission Protocol events to local Codex agent runs.

This is an implementation app, not part of the Event Emission Protocol specification. The protocol only delivers service events; this relay decides locally which events should invoke Codex.

## Event Contract

The relay listens for `codex.run.requested` events.

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

Only `prompt` is required. The relay ignores all other event names.

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

### Route Events to Agents

Use a config file when different services or events should go to different agents:

```sh
cp agent-center.config.example.json agent-center.config.json
npm start -- --config agent-center.config.json
```

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
          "agent": "triage",
          "cwd": "/Users/rei/.openclaw/workspace/example-project",
          "thinking": "medium"
        }
      ]
    },
    {
      "id": "docs",
      "url": "https://example.com/docs/events",
      "routes": [
        {
          "eventName": "comment.created",
          "agent": "docs"
        }
      ]
    }
  ]
}
```

With `agent`, the relay invokes:

```sh
openclaw agent --agent <agent> --message <prompt>
```

The prompt still comes from `event.data.prompt`. Route-level `cwd`, `model`, `thinking`, `sandbox`, `profile`, and `json` are applied as local defaults and overrides. Events with no matching route are ignored.

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

The SSE endpoint should be authenticated before using `--execute`. Events can cause local agent work, so do not point this relay at an untrusted stream.
