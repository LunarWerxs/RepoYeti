# Owner-only list surfaces the dashboard and agents read. Each is a pure read with a stable
# top-level shape; what is in the lists belongs to the host, so only the shape is asserted.

GET {{base}}/api/roots
HTTP 200
[Asserts]
jsonpath "$.roots" isCollection

GET {{base}}/api/scan
HTTP 200
[Asserts]
jsonpath "$.ok" == true
jsonpath "$.running" isBoolean

GET {{base}}/api/identity-rules
HTTP 200
[Asserts]
jsonpath "$.rules" isCollection

GET {{base}}/api/shares
HTTP 200
[Asserts]
jsonpath "$.shares" isCollection

GET {{base}}/api/collaborations
HTTP 200
[Asserts]
jsonpath "$.snapshots" isCollection

GET {{base}}/api/collaboration-links
HTTP 200
[Asserts]
jsonpath "$.links" isCollection

GET {{base}}/api/approvals
HTTP 200
[Asserts]
jsonpath "$.approvals" isCollection

GET {{base}}/api/approvals/hurl-{{uid}}-absent
HTTP 404
[Asserts]
jsonpath "$.code" == "NOT_FOUND"

GET {{base}}/api/automation/runs?limit=5
HTTP 200
[Asserts]
jsonpath "$.runs" isCollection

GET {{base}}/api/automation/runs/hurl-{{uid}}-absent
HTTP 404
[Asserts]
jsonpath "$.code" == "NOT_FOUND"

GET {{base}}/api/auto-commit/incidents?limit=5
HTTP 200
[Asserts]
jsonpath "$.incidents" isCollection
jsonpath "$.unacked" isInteger

# The AI catalog is static display metadata and never carries a key.
GET {{base}}/api/ai/catalog
HTTP 200
[Asserts]
jsonpath "$.catalog" exists
