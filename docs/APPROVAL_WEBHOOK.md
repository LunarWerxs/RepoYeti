# Approval webhook

The agent approval gate normally parks every mutating MCP call (commit, branch, checkout, push,
pull, fetch) in the dashboard until you approve or deny it, or a timer does. Webhook mode hands
that decision to a small service you run instead, so a rule such as "agents never push to `main`"
or "prefix every agent commit message" is a few lines of your own code, not a feature request.

## Turning it on

Set `mcpApprovalWebhookUrl` to an absolute `http://` or `https://` URL (credentials in the URL
are refused), either in `~/.repoyeti/config.json` or with
`PUT /api/settings {"mcpApprovalWebhookUrl": "http://127.0.0.1:9000/policy"}`. An empty string
turns it off again. The gate itself must be on (`mcpApprovalGate`, on by default); while a URL is
set, the dashboard queue and the auto-deny and auto-approve timers are not used. The URL is never
synced to your other machines.

## The request

For each mutating call RepoYeti sends one `POST` with a JSON body, and the same request id in the
`X-RepoYeti-Reqid` header:

```json
{
  "version": 1,
  "op": "mcp_tool_call",
  "reqId": "5f0c...",
  "content": {
    "tool": "git_commit",
    "repo": "my-repo",
    "args": { "message": "fix: handle empty input" },
    "truncated": false,
    "hidden": []
  }
}
```

`args` is what the dashboard would show you: long values are clipped (`truncated` says so) and
secret-looking fields read `"[hidden]"` (their names are listed in `hidden`).

## The three answers

Reply `200` with one of:

| Reply | Effect |
| --- | --- |
| `{"decision": "approve"}` | The call runs as the agent asked. |
| `{"decision": "deny", "reason": "..."}` | The call does not run; the agent's error carries your reason and the request id. |
| `{"decision": "rewrite", "args": {"message": "agent: ..."}}` | The call runs with these keys replacing the agent's. |

A rewrite may only change arguments the tool declares, and never `repo`, `collaboration` or a
hidden field: sending a call to a different repository is a different action, not an edit.

## Failing closed

Anything else denies the call: no answer within 10 seconds, a connection error, a redirect, a
status other than 200, a reply over 64 KB, a body that is not a JSON object, an unknown
`decision`, or a rewrite of a key it may not touch.

## Tracing

Every verdict is logged by the daemon as `approval webhook <reqId>: <tool> approved|denied (...)`
and broadcast on the dashboard's event stream as `approval_resolved` with `via: "webhook"`, so the
id your service logs, the id in the daemon log and the id in the agent's error all match.
