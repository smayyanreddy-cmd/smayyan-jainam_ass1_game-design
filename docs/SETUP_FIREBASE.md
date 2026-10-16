# Setting up online multiplayer (Firebase)

Without this setup, PedalPace runs in **offline mode**: single player, saved on one device, no friends. To play with friends, connect it to **Firebase**, Google's backend for apps. It's free on the **Spark plan**, and no credit card or billing is needed.

Firebase gives the app:

* **Sign-in:** Continue with Google, or play as a guest.
* **Cloud Firestore**, a database for players, friends, zones, live positions and notifications.

It takes about 10 minutes.

## 1. Create the project

1. Go to **https://console.firebase.google.com/** and click **Create a project** (e.g. `pedalpace`).
   *To reuse the Google Cloud project you made for sign-in earlier, pick it from the list instead.*
2. Turn Google Analytics **off** (it isn't needed), then **Create project**.

## 2. Turn on sign-in

1. Go to **Build → Authentication → Get started**.
2. Open the **Sign-in method** tab:
   * **Google** → Enable. Pick a support email → Save.
   * **Anonymous** → Enable → Save. (This powers "Play as a guest".)
3. Open the **Settings** tab → **Authorized domains**. `localhost` is already listed. Click **Add domain** and add `smayyanreddy-cmd.github.io`, or whatever domain you'll publish on.

## 3. Create the database

1. Go to **Build → Firestore Database → Create database**.
2. Location: **asia-south1 (Mumbai)**, which is closest to Pune. This can't be changed later.
3. Start in **production mode** → Create.
4. Open the **Rules** tab. Replace everything with the contents of [`firestore.rules`](../firestore.rules) from this repo, then click **Publish**.

## 4. Connect the app

1. Click the gear icon → **Project settings** → **General** → **Your apps** → the **Web** icon (`</>`).
2. App nickname `PedalPace` → **Register app**. Leave Firebase Hosting unticked.
3. Firebase shows a `firebaseConfig = { ... }` object. Copy it into [`js/config.js`](../js/config.js):

```js
window.PEDALPACE_CONFIG = {
  firebase: {
    apiKey: 'AIza…',
    authDomain: 'pedalpace-xxxx.firebaseapp.com',
    projectId: 'pedalpace-xxxx',
    storageBucket: 'pedalpace-xxxx.appspot.com',
    messagingSenderId: '…',
    appId: '…',
  },
};
```

The web config isn't a secret: it is meant to sit in browser code. The security rules decide who can read and write what.

Reload the app. It now asks you to sign in, and the **Friends** tab shows your friend code.

## 5. Play on phones (HTTPS)

Phones only allow GPS on secure `https://` pages, so friends need a public HTTPS link. The easiest option is **GitHub Pages**, which is free:

1. Push the project to GitHub.
2. Go to the repo's **Settings → Pages → Build and deployment**. Pick **Deploy from a branch**, then branch `main` and folder `/ (root)` → Save.
3. After a minute the game is at `https://smayyanreddy-cmd.github.io/smayyan-jainam_ass1_game-design/`.
4. Make sure that domain is in the Firebase **Authorized domains** list (step 2.3).

Share that link, or your invite link from the Friends tab, which adds you automatically.

## Free plan limits

The Spark plan allows **50,000 reads and 20,000 writes per day**. A player on a trip writes their live position every 5 s (720 writes an hour) plus zone damage every few seconds. That's plenty for a group of friends, but not for hundreds of players at once.

## Good to know

* **Anti-cheat runs on the phone.** The rules stop players from editing other people's profiles or zones, except lowering a zone's HP. A determined cheater could still fake GPS. A real launch would re-check trips on a server.
* **Testing at your desk:** on `localhost` (or with `?test` in the address), the GO sheet has **Test: draw a route and simulate it**. It runs a simulated trip through the same rules, and it does create real zones.
