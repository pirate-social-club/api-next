# Standalone HNS admission

This package independently owns its dependencies, lockfile, checks and Alchemy deployable. The workspace_owner selected Alchemy2.0.0-beta.87 and Effect4.1.4 for this service. This explicit standalone boundary supersedes the parent rc.109 pin only here; do not change the parent dependency graph. Verify Effect APIs against this package's installed source before use.

Run npm run check, npm test and npm run test:regtest here. The parent application checks remain integration requirements and are not replaced or reported as passing by package checks. Runtime state uses Alchemy Domain, platform adapters use Effect Layers, and no prior application/auth runtime is imported. Scope stops at ReadyToSubmit. No signer, broadcast or receipt-producing test fake belongs in production composition.
