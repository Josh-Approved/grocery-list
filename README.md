# Grocery List

A grocery list a household can share, so two people shop off one list that updates on both phones.

## What it is

Make a list, and it sorts itself into aisles as you type. Share it with a link or a QR code — the other person taps it once and you're connected. From then on, whatever either of you adds or checks off shows up on the other phone. No account, no sign-up, ever. When you're done shopping, "Finish shop" clears what you bought and keeps the list for next time.

## Who it's for

Anyone who runs a household off a shared list and is tired of the texts, the duplicate milk, and the apps that make you make an account first.

## How to get it

Coming soon to the App Store and Google Play. Until then you can run it locally.

## Run it locally

```
git clone https://github.com/josh-approved/grocery-list.git
cd grocery-list
npm install
npm run ios        # or: npm run android, or: npx expo start
```

Requires Node and the Expo tooling (plus Xcode for the iOS simulator, or Android Studio for the Android emulator).

## Privacy

Your lists stay on your device. When you share a list, changes pass between the two phones end-to-end encrypted, through free public infrastructure that we don't run and can't read. No servers of ours, no accounts, no analytics. See [PRIVACY.md](PRIVACY.md).

## License

MIT — see [LICENSE](LICENSE).

## Feedback

Email [feedback@joshapproved.com](mailto:feedback@joshapproved.com). If this app saved your household a subscription, you can [buy me a coffee](https://buymeacoffee.com/jtysonwilliams).
