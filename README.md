# Grocery List

A grocery list a household can share, so two people shop off one list that updates on both phones.

## What it is

Make a list, and it sorts itself into aisles as you type. Share it with a link or a QR code — the other person taps it once and you're connected. From then on, whatever either of you adds or checks off shows up on the other phone. No account, no sign-up, ever. When you're done shopping, "Finish shop" clears what you bought and keeps the list for next time.

## Who it's for

Anyone who runs a household off a shared list and is tired of the texts, the duplicate milk, and the apps that make you make an account first.

## How to get it

Free on the [App Store](https://apps.apple.com/us/app/id6779417031) and [Google Play](https://play.google.com/store/apps/details?id=com.joshapproved.grocerylist) — no account, nothing to sign up for. One link picks the right store for your phone: [joshapproved.com/apps/grocery-list](https://joshapproved.com/apps/grocery-list).

Or run it locally — see below.

## Run it locally

```
git clone https://github.com/josh-approved/grocery-list.git
cd grocery-list
npm install
npm run ios        # or: npm run android, or: npx expo start
```

Requires Node and the Expo tooling (plus Xcode for the iOS simulator, or Android Studio for the Android emulator).

## Privacy

Your data stays with you. When you share a list, changes pass between your phones end-to-end encrypted, through free public infrastructure we don't run and can't read. No accounts, no tracking, no analytics. See [PRIVACY.md](PRIVACY.md).

## License

MIT — see [LICENSE](LICENSE).

## Feedback

Email [feedback@joshapproved.com](mailto:feedback@joshapproved.com). If this app saved your household a subscription, you can [buy me a coffee](https://buymeacoffee.com/jtysonwilliams).
