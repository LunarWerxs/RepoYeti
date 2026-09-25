# The public auth probes the sign-in screen decides from. These answer without credentials in
# every mode, so they are the first thing to check when a client cannot get in.

GET {{base}}/api/auth/status
HTTP 200
[Asserts]
jsonpath "$.authEnforced" isBoolean
jsonpath "$.mode" isString
jsonpath "$.authenticated" isBoolean
jsonpath "$.ownerClaimed" isBoolean
jsonpath "$.canContinueLocal" isBoolean

GET {{base}}/api/auth/me
HTTP 200
[Asserts]
jsonpath "$.ok" == true
