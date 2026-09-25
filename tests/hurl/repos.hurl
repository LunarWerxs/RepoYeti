# Repository reads. The host's repositories are whatever it has, so this file asserts shapes, and
# the error contract every repo-scoped read shares: an unknown id is a 404 with the NOT_FOUND
# envelope, never a 500 and never an empty 200. The ids below cannot exist: they carry this run's uid.

GET {{base}}/api/repos
HTTP 200
[Asserts]
jsonpath "$.repos" isCollection

GET {{base}}/api/repos/fetch-all
HTTP 200
[Asserts]
jsonpath "$.ok" == true

GET {{base}}/api/repos/hurl-{{uid}}-absent/branches
HTTP 404
[Asserts]
jsonpath "$.ok" == false
jsonpath "$.code" == "NOT_FOUND"
jsonpath "$.message" isString

GET {{base}}/api/repos/hurl-{{uid}}-absent/log?limit=5
HTTP 404
[Asserts]
jsonpath "$.ok" == false
jsonpath "$.code" == "NOT_FOUND"

GET {{base}}/api/repos/hurl-{{uid}}-absent/activity
HTTP 404
[Asserts]
jsonpath "$.ok" == false
jsonpath "$.code" == "NOT_FOUND"

GET {{base}}/api/repos/hurl-{{uid}}-absent/stashes
HTTP 404
[Asserts]
jsonpath "$.ok" == false
jsonpath "$.code" == "NOT_FOUND"

GET {{base}}/api/repos/hurl-{{uid}}-absent/tags
HTTP 404
[Asserts]
jsonpath "$.ok" == false
jsonpath "$.code" == "NOT_FOUND"
