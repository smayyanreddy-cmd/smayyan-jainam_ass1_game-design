/* PedalPace — deployment config. See docs/SETUP_FIREBASE.md. */
window.PEDALPACE_CONFIG = {
  // Firebase web app config (Firebase console → Project settings → Your apps → Web app).
  // Paste the object Firebase shows you here. Leave it as null to play offline:
  // single player, saved on this device only, no friends.
  // A Firebase web config is not a secret; the security rules in firestore.rules protect the data.
  firebase: null,
  // firebase: {
  //   apiKey: '...',
  //   authDomain: 'your-project.firebaseapp.com',
  //   projectId: 'your-project',
  //   storageBucket: 'your-project.appspot.com',
  //   messagingSenderId: '...',
  //   appId: '...',
  // },
};
