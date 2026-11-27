# iAgent for iOS

The iOS target uses the iAgent edition of Cherry Studio Mobile. It requires iOS 17 or later.
The production bundle ID is `dev.iagent.app`. The preview target uses `dev.iagent.app.preview`.

## Review flow

- Launch to the chat workspace as a guest. Open Settings → Model service to add your own endpoint and API key.
- Sign in to an existing iAgent account from the sidebar or when starting an iAgent request. Accounts with two-factor authentication enter their authenticator code on the next screen.
- Open Creative Studio from the sidebar to choose image or video generation. iAgent models and groups follow account permissions. Existing workspace keys are reused.

For App Review, provide an existing test account with access to the chat and media models included in the submission. Describe the guest, custom provider and iAgent sign-in flows in Review Notes. Declare the data sent to iAgent and any configured third-party provider in the app’s privacy answers and policy.

## Website recharge

The account screen displays balance and usage. For a verified production installation on the U.S. App Store storefront, **Top up on the website** opens [the iAgent recharge page](https://ai.iagent.dev/app/billing#recharge) in the device’s browser. The browser uses its own iAgent session. The account screen refreshes the balance when the app returns to the foreground.

Describe the U.S. storefront button and its destination in App Review Notes. Simulators can preview the browser handoff. TestFlight and App Store storefronts outside the U.S. display the account’s balance and usage. Use funded test accounts for TestFlight. [App Review Guidelines §3.1.1(a)](https://developer.apple.com/app-store/review/guidelines/#payments) and [Apple Developer Program License Agreement §7.4](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/)

## Generate the production project

Run from a checkout of the iAgent source using the toolchain in [Local Builds](local-builds.md). Generate the project in a checkout without native build folders when retaining a local preview project.

```sh
corepack pnpm@12.2.1 install --frozen-lockfile
PROFILE=production corepack pnpm@12.2.1 exec expo prebuild --platform ios --no-install
cd ios
PROFILE=production pod install
open iAgent.xcworkspace
```

In Xcode, select your Apple Developer team under Signing & Capabilities for iAgent, ExpoWidgetsTarget and CherryShareExtension. Match the two App Groups and extension bundle IDs to your account.

| Target | Bundle ID |
| --- | --- |
| iAgent | `dev.iagent.app` |
| ExpoWidgetsTarget | `dev.iagent.app.ExpoWidgetsTarget` |
| CherryShareExtension | `dev.iagent.app.CherryShareExtension` |

The App Groups are `group.dev.iagent.app` and `group.dev.iagent.app.system-integration`.
Select a generic iOS device and use Product → Archive. In the Organizer, distribute the signed build to your App Store Connect app and set the storefronts in Pricing and Availability.

The included source follows [AGPL-3.0](../../LICENSE). When distributing this fork, make the corresponding source available under the license and verify that the distribution terms are compatible with it.
