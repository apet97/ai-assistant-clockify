/**
 * Clockify's platform-wide RS256 **public** signing key (SPKI / PEM).
 *
 * Every Clockify add-on JWT — the component `auth_token` query param and the
 * `x-addon-lifecycle-token` header — is signed by Clockify with the matching
 * private key and verified against THIS key. It is a fixed, non-secret value
 * that Clockify publishes at `{apiUrl}/api/auth/public-key`; it is NOT a
 * per-installation or developer-console key. Embedding it as the built-in
 * default is how the marketplace reference add-ons ship (the Java SDK
 * `ClockifySignatureParser` and every sibling add-on use this same key), so the
 * add-on can verify install/lifecycle tokens out of the box.
 *
 * Override via `CLOCKIFY_ADDON_PUBLIC_KEY_PEM` only to point at a non-production
 * Clockify environment/region with a different signing key.
 *
 * SPKI sha256 fingerprint (pinned by tests/unit/clockify-public-key.test.ts):
 *   0cebc449014cf940ad0763e204b29b3a2263abfa1ccd298347c9bd2db2708b16
 */
export const CLOCKIFY_PLATFORM_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAubktufFNO/op+E5WBWL6
/Y9QRZGSGGCsV00FmPRl5A0mSfQu3yq2Yaq47IlN0zgFy9IUG8/JJfwiehsmbrKa
49t/xSkpG1u9w1GUyY0g4eKDUwofHKAt3IPw0St4qsWLK9mO+koUo56CGQOEpTui
5bMfmefVBBfShXTaZOtXPB349FdzSuYlU/5o3L12zVWMutNhiJCKyGfsuu2uXa9+
6uQnZBw1wO3/QEci7i4TbC+ZXqW1rCcbogSMORqHAP6qSAcTFRmrjFAEsOWiUUhZ
rLDg2QJ8VTDghFnUhYklNTJlGgfo80qEWe1NLIwvZj0h3bWRfrqZHsD/Yjh0duk6
yQIDAQAB
-----END PUBLIC KEY-----
`;
