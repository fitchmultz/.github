# Native fork packing fixture

The four files in `scripts/` are unmodified snapshots from maintained
`fitchmultz/pi` commit `f0da894bce0206caa285ad570bf2acdd3f5242e0`
(tree `cce5f3fa220e3fe5473a97f262b30d6995bef0a2`).
`package-artifacts.mjs` and its three dependencies exercise the real
canonical artifact API with native Git and npm, not a mock packing API.
Refresh these files together when that API changes.

The owning CLI test creates small public/private workspaces and built payload
bytes. It does not build a Pi host, activate a runtime, or certify real model
data or full-host integration.
