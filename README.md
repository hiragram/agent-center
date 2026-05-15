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

Until the TypeScript SDK packages are published to npm, clone this repository next to `event-emission-protocol-ts` so the local file dependencies resolve:

```sh
git clone https://github.com/hiragram/event-emission-protocol-ts.git
git clone https://github.com/hiragram/agent-center.git
cd agent-center
npm install
npm test
npm start -- --url http://127.0.0.1:8787/events --execute
```

Without `--execute`, the relay runs in dry-run mode and logs what it would invoke.

Environment variables:

- `EEP_STREAM_URL`: SSE endpoint URL.
- `CODEX_BIN`: Codex CLI path. Defaults to `/Applications/Codex.app/Contents/Resources/codex`.
- `CODEX_RELAY_EXECUTE`: set to `1` to execute without `--execute`.
- `CODEX_RELAY_KEEP_ALIVE_SECONDS`: preferred SSE keep-alive interval hint.

## Security Notes

The SSE endpoint should be authenticated before using `--execute`. Events can cause local agent work, so do not point this relay at an untrusted stream.
