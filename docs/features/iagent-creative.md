# iAgent Creative Studio

The iAgent edition opens the local workspace with chat and custom providers available as a guest.
iAgent chat, image and video requests use the account only when the user submits to an iAgent model.

## User Entry

- Open Creative Studio from the local sidebar using `testID:sidebar-paintings`.
- Select Image or Video, enter the request in `testID:iagent-studio-prompt`, and use `testID:iagent-studio-generate`.
- The iAgent sign-in modal exposes `testID:iagent-email`, `testID:iagent-password`, and `testID:iagent-login-close`.
- Open Settings → Model Prices to inspect public quotes or signed-in group prices using
  `testID:settings-iagent-prices` and `testID:iagent-price-models`.

## Verification Driver

- Use fresh iOS and Android development devices with `agent-device` for guest access, sign-in,
  model selection, price display, and draft preservation.
- Use fixture responses for chat streaming, generation, and media uploads. See
  [iAgent for iOS](../guides/iagent-ios.md) for the website recharge entry.

## Observable Acceptance

- Launch straight into chat as a guest and open model service settings.
- Use the model sent with an iAgent chat or studio draft to open login. Dismissing login returns
  to the existing draft.
- Prices preserve group order and show base and multiplier-adjusted amounts in USD. On a signed-in
  account, the available groups and their provided rates determine the quote.
- GPT Image generation sends the chosen output settings. Wan sends the selected duration,
  resolution, and the assigned roles for reference media.
- A submitted media task keeps its server ID and is checked after visiting the result.
  A completed task displays `testID:iagent-studio-result` with the image or video player.

## Known Pitfalls

- Image and video queries reuse the original workspace key and task ID. Do not repeat a paid
  submission after a timeout or ambiguous response.
- Only the iAgent service receives a workspace key. Media downloads to third-party URLs carry
  neither the key nor the login token.
