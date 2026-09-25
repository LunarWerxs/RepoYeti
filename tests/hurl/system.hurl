# System probes and the machine-readable API description.
# Black-box conformance suite: run it with `bun run conformance` (scripts/hurl-conformance.ts),
# which supplies {{base}} (the daemon's origin) and {{uid}} (this run's namespace).

# Liveness: the probe every client and the tray launcher depend on.
GET {{base}}/api/health
HTTP 200
[Captures]
version: jsonpath "$.version"
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$.ok" == true
jsonpath "$.service" == "repoyeti"
jsonpath "$.version" isString
jsonpath "$.ts" isInteger

# The OpenAPI document is public and describes itself and the shared error envelope.
GET {{base}}/api/openapi.json
HTTP 200
[Asserts]
jsonpath "$.openapi" == "3.1.0"
jsonpath "$.info.title" == "RepoYeti API"
jsonpath "$.info.version" == "{{version}}"
jsonpath "$.paths['/api/health'].get" exists
jsonpath "$.components.schemas.ErrorResponse.required" includes "code"

# Runtime status reports the same build the health probe did.
GET {{base}}/api/status
HTTP 200
[Asserts]
jsonpath "$.ok" == true
jsonpath "$.version" == "{{version}}"
jsonpath "$.mode" isString

# Grouped operational errors: a list, possibly empty.
GET {{base}}/api/errors
HTTP 200
[Asserts]
jsonpath "$.ok" == true
jsonpath "$.errors" isCollection

# Database self-check is a read: it reports, it never repairs.
GET {{base}}/api/db/verify
HTTP 200
[Asserts]
jsonpath "$.ok" == true
jsonpath "$.report" exists
