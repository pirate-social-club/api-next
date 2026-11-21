# Community HNS browser cookies, profile v4

The community HNS gateway and Solid ingress carry the three owned browser cookies. Session and renewal cookies require HttpOnly; the CSRF cookie remains readable. Existing Secure, host-only Path=/, SameSite=Lax, attribute, duplicate, byte, deadline and redirect checks remain. Unknown application cookies still fail closed. Public-handle and static-platform cookie policies are unchanged.

The new gateway profile is pirate-hns-community-app-interactive-gateway-v4. Its canonical UTF-8 length is 646 bytes and its SHA-256 is 705350bde58be27bf06a05efcf7dcc811e74f0a99ad7580e9be2de790e9c6561. The HMAC forwarder remains v3 and host-authority messages remain v2. Request forwarding already carries Cookie, Origin and CSRF; this repair changes response admission rather than browser or database authentication authority.

Profile v3 allowed only session and CSRF. It therefore rejected the new renewal cookie on issue, renewal and logout. A rejected logout response does not mean server revocation failed: the upstream operation may already have committed. Preserve the original outcome and reconcile; never repeat a write to obtain a clearer response.

The source and template update does not select a deployment. The recorded production A5/v3 manifest and existing staging manifest remain bound to their recorded old application sources. Do not relabel those artifacts as v4. The new native bundle, validator, recipe pin, manifest, Solid profile mirror, ingress fingerprint and deployment references must be qualified and reviewed as one matched successor through the maintained release tooling. Recovery after renewable browser sessions exist must retain family revocation and compatible native/Solid cookie transports.

Focused tests cover actual native response sanitization and the Solid verified API proxy for issue, renewal and clearing all three cookies, alongside incorrect HttpOnly modes, unknown or duplicate cookies, Domain and missing Secure refusals. These are local transport tests, not live HNS login or production acceptance. The paused TXT/421 repair, credentials, route authority and Rewards activation are outside this source change.
