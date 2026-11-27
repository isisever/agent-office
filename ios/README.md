# Agent Office Remote (iOS) - P0 spike

Native SwiftUI app that runs the desktop's P2P link stack (hyperswarm/hyperdht) in an embedded Bare worklet
(holepunchto/bare-kit-swift 2.4.3, Bare Kit 3.2.1).

## Build

```sh
cd ios/core && npm install && npm run prebuild   # bare-link addons + bare-pack app.bundle (also a scheme pre-action)
cd .. && xcodegen generate
xcodebuild -project AgentOfficeRemote.xcodeproj -scheme AgentOfficeRemote -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath build/DerivedData CODE_SIGNING_ALLOWED=NO build
```

If package resolution hangs on the BareKit binary download, fetch the two release zips with curl and copy them to
`~/Library/Caches/org.swift.swiftpm/artifacts/https___github_com_holepunchto_bare_kit_swift_releases_download_v2_4_3_<asset with . replaced by _>`,
then build with `-scmProvider system`.

Launch with `xcrun simctl launch <udid> com.thinkone.agentoffice.remote -pairCode word-word-word-word-word` to connect
without typing. Worklet log: `log show --predicate 'process == "AgentOfficeRemote" AND category == "worklet"'`.

## Without a phone

The phone side is `core/controller.js` (the IPC commands) on `core/ctl-client.js` (the v3.121 controller protocol),
which use `app/src/link-wire.js` itself; bare-pack bundles it from there.

- `node core/dev-run.mjs --selftest` pairs a desktop `Link` (app/src/link.js) and the phone on a local DHT testnet,
  receives `ctl-view` and gets an HQ turn `queued`.
- `node core/dev-run.mjs '<agentoffice://pair?... URL>'` plays the phone against a running desktop (use a dev profile,
  `AGENT_OFFICE_USER_DATA`): lines on stdin become HQ turns, `/reports` asks for the reports.
- `app/test/link-ctl.test.cjs` runs the same pairing in CI.

Crypto shim check: `cd app && node --test test/crypto-shim.test.cjs` (needs `npm install` in ios/core; not in CI yet).
