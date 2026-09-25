# Git identities: a full create, read, update, delete round trip. Everything this file creates is
# named hurl-{{uid}} and deleted before the file ends, so it is safe against a daemon in real use;
# a run cut off halfway leaves at most one hurl-<uid> identity, which no later run collides with.

POST {{base}}/api/identities
{
  "displayName": "hurl-{{uid}}",
  "gitUsername": "hurl-{{uid}}",
  "gitEmail": "hurl-{{uid}}@example.com"
}
HTTP 201
[Captures]
identity_id: jsonpath "$.identity.id"
[Asserts]
jsonpath "$.identity.displayName" == "hurl-{{uid}}"
jsonpath "$.identity.gitEmail" == "hurl-{{uid}}@example.com"

# Creation is idempotent by natural key: the same submission returns the same identity.
POST {{base}}/api/identities
{
  "displayName": "hurl-{{uid}}",
  "gitUsername": "hurl-{{uid}}",
  "gitEmail": "hurl-{{uid}}@example.com"
}
HTTP 201
[Asserts]
jsonpath "$.identity.id" == "{{identity_id}}"

GET {{base}}/api/identities
HTTP 200
[Asserts]
jsonpath "$.identities[*].id" includes "{{identity_id}}"

PUT {{base}}/api/identities/{{identity_id}}
{
  "displayName": "hurl-{{uid}}-renamed"
}
HTTP 200
[Asserts]
jsonpath "$.identity.id" == "{{identity_id}}"
jsonpath "$.identity.displayName" == "hurl-{{uid}}-renamed"

# A malformed email is refused with the VALIDATION code, and nothing is stored.
POST {{base}}/api/identities
{
  "displayName": "hurl-{{uid}}-bad",
  "gitUsername": "hurl-{{uid}}",
  "gitEmail": "not-an-email"
}
HTTP 400
[Asserts]
jsonpath "$.ok" == false
jsonpath "$.code" == "VALIDATION"

# A body missing a required field is refused before it reaches the store.
POST {{base}}/api/identities
{
  "displayName": "hurl-{{uid}}-incomplete"
}
HTTP 400
[Asserts]
jsonpath "$.ok" == false
jsonpath "$.code" == "BAD_REQUEST"

DELETE {{base}}/api/identities/{{identity_id}}
HTTP 200
[Asserts]
jsonpath "$.ok" == true

# Gone means gone: a second delete and an update both 404, and the list no longer has it.
DELETE {{base}}/api/identities/{{identity_id}}
HTTP 404
[Asserts]
jsonpath "$.code" == "NOT_FOUND"

PUT {{base}}/api/identities/{{identity_id}}
{
  "displayName": "hurl-{{uid}}-ghost"
}
HTTP 404
[Asserts]
jsonpath "$.code" == "NOT_FOUND"

GET {{base}}/api/identities
HTTP 200
[Asserts]
jsonpath "$.identities[*].id" not includes "{{identity_id}}"
