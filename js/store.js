/* PedalPace — data layer. One interface, two back ends:
 *  - cloud: Firebase Auth (Google or guest) + Cloud Firestore. Multiplayer: friends,
 *           shared zones, live positions, notifications. Used when js/config.js has a
 *           Firebase config.
 *  - local: this device only (localStorage). Single player, no friends. Used until
 *           Firebase is set up, so the game is playable straight away.
 * Zones travel as { ...zone, geo } with geo a GeoJSON geometry object; Firestore can't
 * store nested arrays, so it's saved as a JSON string. */
(function () {
  'use strict';
  const cfg = (window.PEDALPACE_CONFIG || {}).firebase;
  const FB_VER = '10.12.2';
  const ZONE_WINDOW_DEG = 0.05; // zones are loaded within ~5.5 km (north-south) of you

  const listeners = (set) => (fn) => { set.add(fn); return () => set.delete(fn); };
  const loadScript = (src) => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });

  // ================================================================ local (this device)

  function createLocal() {
    const K = { prof: 'pp2.profile', zones: 'pp2.zones', notifs: 'pp2.notifs' };
    const read = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
    const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } };
    const zoneSubs = new Set(), notifSubs = new Set();
    let zones = read(K.zones, {}), notifs = read(K.notifs, []);
    const user = { uid: 'local', name: '', email: '', photo: '', anonymous: true };
    const pushZones = () => { write(K.zones, zones); const all = Object.values(zones); zoneSubs.forEach((f) => f(all)); };
    const pushNotifs = () => { write(K.notifs, notifs); notifSubs.forEach((f) => f(notifs.slice())); };
    const noFriends = () => { throw new Error('Friends need online mode. Set up Firebase (docs/SETUP_FIREBASE.md).'); };

    return {
      mode: 'local',
      async init(onAuth) { onAuth(user); },
      async signInGoogle() { /* no accounts offline */ },
      async signInGuest() {},
      async linkGoogle() { noFriends(); },
      async signOut() {},
      async loadProfile() { return read(K.prof, null); },
      async saveProfile(uid, p) { write(K.prof, p); },
      watchProfile() { return () => {}; },
      async resetLocal() { localStorage.removeItem(K.prof); localStorage.removeItem(K.zones); localStorage.removeItem(K.notifs); zones = {}; notifs = []; },

      watchZones(lat, lng, cb) { const off = listeners(zoneSubs)(cb); cb(Object.values(zones)); return off; },
      async myZones(uid) { return Object.values(zones).filter((z) => z.owner === uid); },
      async createZone(z) { const id = 'z' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); zones[id] = { ...z, id }; pushZones(); return id; },
      async updateZone(id, patch) { if (zones[id]) { Object.assign(zones[id], patch); pushZones(); } },
      async damageZone(id, hp) { if (zones[id]) { zones[id].hp -= hp; pushZones(); } },
      async healZone(id, hp) { if (zones[id]) { zones[id].hp = Math.min(zones[id].maxHp, zones[id].hp + hp); pushZones(); } },
      async breakZone(id) { delete zones[id]; pushZones(); },
      async deleteZone(id) { delete zones[id]; pushZones(); },

      async findUserByCode() { noFriends(); },
      async getUsers() { return []; },
      async addFriend() { noFriends(); },
      async removeFriend() {},
      async topUsers() { return []; },
      async publishLive() {},
      watchLive() { return () => {}; },

      async sendNotif(uid, n) { notifs.unshift({ id: Date.now() + '' + Math.random(), ts: Date.now(), read: false, ...n }); notifs = notifs.slice(0, 40); pushNotifs(); },
      watchNotifs(uid, cb) { const off = listeners(notifSubs)(cb); cb(notifs.slice()); return off; },
      async markRead() { notifs.forEach((n) => (n.read = true)); pushNotifs(); },
    };
  }

  // ================================================================ cloud (Firebase)

  function createCloud() {
    let fb, auth, db, FV;
    const zoneIn = (d) => { const z = d.data(); return { ...z, id: d.id, geo: typeof z.geo === 'string' ? JSON.parse(z.geo) : z.geo }; };
    const zoneOut = (z) => { const o = { ...z, geo: JSON.stringify(z.geo), updated: FV.serverTimestamp() }; delete o.id; return o; };
    const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
    const toUser = (u) => u && { uid: u.uid, name: u.displayName || '', email: u.email || '', photo: u.photoURL || '', anonymous: u.isAnonymous };
    // Fields other players may change on your profile (friends): never overwritten by a save.
    const stripShared = (p) => { const o = { ...p }; delete o.friends; return o; };

    async function googlePopup(fn) {
      const provider = new fb.auth.GoogleAuthProvider();
      try { return await fn(provider, 'popup'); } catch (e) {
        if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') return fn(provider, 'redirect');
        throw e;
      }
    }

    return {
      mode: 'cloud',
      async init(onAuth) {
        const base = `https://www.gstatic.com/firebasejs/${FB_VER}/`;
        await loadScript(base + 'firebase-app-compat.js');
        await Promise.all([loadScript(base + 'firebase-auth-compat.js'), loadScript(base + 'firebase-firestore-compat.js')]);
        fb = window.firebase;
        fb.initializeApp(cfg);
        auth = fb.auth(); db = fb.firestore(); FV = fb.firestore.FieldValue;
        try { await auth.getRedirectResult(); } catch (e) { console.warn('Sign-in redirect:', e); }
        auth.onAuthStateChanged((u) => onAuth(toUser(u)));
      },
      signInGoogle() { return googlePopup((p, how) => (how === 'popup' ? auth.signInWithPopup(p) : auth.signInWithRedirect(p))); },
      signInGuest() { return auth.signInAnonymously(); },
      /** Turn a guest into a Google account, keeping progress. */
      linkGoogle() {
        const u = auth.currentUser;
        return googlePopup((p, how) => (how === 'popup' ? u.linkWithPopup(p) : u.linkWithRedirect(p)));
      },
      signOut() { return auth.signOut(); },

      async loadProfile(uid) { const d = await db.collection('users').doc(uid).get(); return d.exists ? d.data() : null; },
      async saveProfile(uid, p, first) {
        const ref = db.collection('users').doc(uid);
        if (first) await ref.set({ ...p, friends: p.friends || [] });
        else await ref.set(stripShared(p), { merge: true });
      },
      /** Live copy of your own profile (friends added by others arrive here). */
      watchProfile(uid, cb) { return db.collection('users').doc(uid).onSnapshot((d) => d.exists && cb(d.data()), (e) => console.warn(e)); },

      watchZones(lat, lng, cb) {
        return db.collection('zones').where('clat', '>=', lat - ZONE_WINDOW_DEG).where('clat', '<=', lat + ZONE_WINDOW_DEG)
          .onSnapshot((s) => cb(s.docs.map(zoneIn).filter((z) => Math.abs(z.clng - lng) < ZONE_WINDOW_DEG * 1.5)), (e) => console.warn('zones', e));
      },
      async myZones(uid) { const s = await db.collection('zones').where('owner', '==', uid).get(); return s.docs.map(zoneIn); },
      async createZone(z) { const r = await db.collection('zones').add(zoneOut(z)); return r.id; },
      async updateZone(id, patch) {
        const o = { ...patch, updated: FV.serverTimestamp() };
        if (o.geo) o.geo = JSON.stringify(o.geo);
        await db.collection('zones').doc(id).update(o);
      },
      damageZone(id, hp) { return db.collection('zones').doc(id).update({ hp: FV.increment(-hp), updated: FV.serverTimestamp() }); },
      healZone(id, hp) { return db.collection('zones').doc(id).update({ hp: FV.increment(hp), updated: FV.serverTimestamp() }); },
      /** Knock a rival zone to 0 HP and remove it (the rules only allow deleting a zone at 0 HP). */
      async breakZone(id) {
        const ref = db.collection('zones').doc(id);
        try { await ref.update({ hp: 0, updated: FV.serverTimestamp() }); } catch (e) { /* already at 0 or gone */ }
        try { await ref.delete(); } catch (e) { console.warn('break zone', e); }
      },
      deleteZone(id) { return db.collection('zones').doc(id).delete(); },

      async findUserByCode(code) {
        const s = await db.collection('users').where('code', '==', code.toUpperCase()).limit(1).get();
        return s.empty ? null : { uid: s.docs[0].id, ...s.docs[0].data() };
      },
      async getUsers(uids) {
        const out = [];
        for (const c of chunks(uids, 10)) {
          const s = await db.collection('users').where(fb.firestore.FieldPath.documentId(), 'in', c).get();
          s.docs.forEach((d) => out.push({ uid: d.id, ...d.data() }));
        }
        return out;
      },
      addFriend(me, other) {
        const b = db.batch(), u = db.collection('users');
        b.update(u.doc(me), { friends: FV.arrayUnion(other) });
        b.update(u.doc(other), { friends: FV.arrayUnion(me) });
        return b.commit();
      },
      removeFriend(me, other) {
        const b = db.batch(), u = db.collection('users');
        b.update(u.doc(me), { friends: FV.arrayRemove(other) });
        b.update(u.doc(other), { friends: FV.arrayRemove(me) });
        return b.commit();
      },
      async topUsers(n) {
        const s = await db.collection('users').orderBy('stats.totalPoints', 'desc').limit(n || 50).get();
        return s.docs.map((d) => ({ uid: d.id, ...d.data() }));
      },

      /** Share where you are while recording (null = stop sharing). */
      publishLive(uid, pos) {
        const ref = db.collection('live').doc(uid);
        return pos ? ref.set({ ...pos, ts: Date.now() }) : ref.delete();
      },
      watchLive(uids, cb) {
        const all = {};
        const offs = chunks(uids, 10).map((c) => db.collection('live').where(fb.firestore.FieldPath.documentId(), 'in', c)
          .onSnapshot((s) => {
            c.forEach((id) => delete all[id]);
            s.docs.forEach((d) => (all[d.id] = { uid: d.id, ...d.data() }));
            cb({ ...all });
          }, (e) => console.warn('live', e)));
        return () => offs.forEach((f) => f());
      },

      sendNotif(uid, n) { return db.collection('users').doc(uid).collection('notifs').add({ ...n, ts: Date.now(), read: false }); },
      watchNotifs(uid, cb) {
        return db.collection('users').doc(uid).collection('notifs').orderBy('ts', 'desc').limit(30)
          .onSnapshot((s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))), (e) => console.warn('notifs', e));
      },
      async markRead(uid, ids) {
        if (!ids.length) return;
        const b = db.batch(), col = db.collection('users').doc(uid).collection('notifs');
        ids.forEach((id) => b.update(col.doc(id), { read: true }));
        await b.commit();
      },
    };
  }

  window.Store = cfg && cfg.apiKey && cfg.projectId ? createCloud() : createLocal();
})();
