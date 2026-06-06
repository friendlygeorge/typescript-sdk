---
'@modelcontextprotocol/client': patch
---

Fix misleading JSDoc on `PrivateKeyJwtProviderOptions.claims`. The previous
text claimed custom claims would override the reserved JWT claims (`iss`,
`sub`, `aud`, `exp`, `iat`, `jti`), but the implementation always keeps
the reserved claims authoritative via jose's setter methods. The doc now
states that reserved claims always win and that overlapping keys in
`claims` are ignored.

Fixes #1914
