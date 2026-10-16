/* PedalPace — deployment config. See docs/SETUP_FIREBASE.md. */
window.PEDALPACE_CONFIG = {
  // Firebase web app config (Firebase console → Project settings → Your apps → Web app).
  // Paste the object Firebase shows you here. Leave it as null to play offline:
  // single player, saved on this device only, no friends.
  // A Firebase web config is not a secret; the security rules in firestore.rules protect the data.
  firebase: {
    apiKey: 'AIzaSyDHOTiFSCBkraXsPoFMPWAl2e8i-nBdLZs',
    authDomain: 'pedalpace.firebaseapp.com',
    projectId: 'pedalpace',
    storageBucket: 'pedalpace.firebasestorage.app',
    messagingSenderId: '872976391741',
    appId: '1:872976391741:web:b04f16fa8f9880badfd454',
  },
};
