# The in-process MCP endpoint: plain JSON-RPC 2.0 over POST. Only protocol methods are called
# here (ping, tools/list); no tool runs, so nothing on the host changes and no approval is asked.

POST {{base}}/api/mcp
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "ping"
}
HTTP 200
[Asserts]
jsonpath "$.jsonrpc" == "2.0"
jsonpath "$.id" == 1
jsonpath "$.result" exists

POST {{base}}/api/mcp
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list"
}
HTTP 200
[Asserts]
jsonpath "$.id" == 2
jsonpath "$.result.tools" count > 0
jsonpath "$.result.tools[*].name" includes "list_repos"
jsonpath "$.result.tools[*].name" includes "repo_status"

# An unknown method is a JSON-RPC error, not an HTTP one.
POST {{base}}/api/mcp
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "hurl/not-a-method"
}
HTTP 200
[Asserts]
jsonpath "$.id" == 3
jsonpath "$.error.code" == -32601

# A notification (no id) gets no JSON-RPC response at all.
POST {{base}}/api/mcp
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
HTTP 202
