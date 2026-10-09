# Setting up "Sign in with Google"

PedalPace uses **Google Identity Services** (the official "Continue with Google" button). There's no backend: the app reads your name, email and photo from the sign-in token and keeps progress on the device under that account.

You need one thing from Google: an **OAuth 2.0 Client ID**. It's free, and no billing is required.

## 1. Create the Client ID (≈5 minutes)

1. Go to **https://console.cloud.google.com/** and create a project (e.g. `pedalpace`), or pick an existing one.
2. **APIs & Services → OAuth consent screen** (also called "Google Auth Platform → Branding"):
   * User type: **External**.
   * App name `PedalPace`, plus your support email and developer contact email.
   * Scopes: none needed (the defaults `openid`, `email`, `profile` are enough).
   * While the app is in **Testing**, add every Google account that should be able to sign in under **Test users** (Audience → Test users).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   * Application type: **Web application**.
   * **Authorized JavaScript origins**: add every address the app will run from, for example:
     * `http://localhost:5173` (local testing with `node serve.js`)
     * `http://localhost` (some browsers send this for localhost)
     * `https://smayyanreddy-cmd.github.io` (if you publish with GitHub Pages)
   * **Authorized redirect URIs**: leave empty. The popup flow doesn't use them.
4. Copy the Client ID. It looks like `1234567890-abc123.apps.googleusercontent.com`.

## 2. Put it in the app

Open [`js/config.js`](../js/config.js):

```js
window.PEDALPACE_CONFIG = {
  googleClientId: '1234567890-abc123.apps.googleusercontent.com',
};
```

A Client ID is not a secret. It's designed to sit in browser code, so it's fine to commit it.

## 3. Run from a real address

Google refuses sign-in from `file://` pages. Start the local server:

```
node serve.js
```

Then open **http://localhost:5173**. The "Continue with Google" button appears on the last onboarding step and in **Profile**.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Google sign-in isn't configured yet" | `googleClientId` in `js/config.js` is empty. |
| "Google sign-in needs a web address" | You opened `index.html` directly. Use `node serve.js`. |
| Popup says **origin_mismatch** / "not a valid origin" | Add the exact origin (scheme + host + port) to *Authorized JavaScript origins*. Changes can take a few minutes to apply. |
| "Access blocked: app has not completed verification" | Add that Google account as a **Test user** on the consent screen. |
| Button never appears | Ad/tracker blockers sometimes block `accounts.google.com`. Allow it for this site. |

## Security note for production

The prototype decodes the sign-in token (a JWT) in the browser only to *display* the profile. It does **not verify** it, which is fine for a prototype that stores everything locally. A production version with a server must send the token to the backend and verify it there (signature, `aud` = your Client ID, `iss`, `exp`), for example with Google's `google-auth-library`, before trusting the account.

---

# Live GPS on a phone

Browsers only allow GPS on **secure origins**: `https://…` or `http://localhost`. The easiest way to play outdoors on your phone:

1. In the GitHub repo: **Settings → Pages → Deploy from branch**, then choose your branch and folder `/ (root)`.
2. Open `https://<your-user>.github.io/smayyan-jainam_ass1_game-design/` on the phone. Add that origin to the Client ID (step 1.3) so sign-in works there too.
3. In the app: onboarding → **Where do you play? → Around me** (or **Profile → Move board to my location**). Then **GO → Live GPS: go outside**.

Notes:

* Keep the app open with the screen on. The app asks the browser to keep the screen awake (Wake Lock), but web apps can't record GPS in the background. A native app would be needed for that.
* GPS fixes with accuracy worse than ±35 m are ignored, and the HUD shows a "weak" GPS chip.
* Real heart-rate straps aren't connected yet, so live activities use speed-based intensity.
