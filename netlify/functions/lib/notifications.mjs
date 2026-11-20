import { createHash } from 'node:crypto';

export const notificationActions = ['registerPushDevice', 'unregisterPushDevice', 'getNotificationPreferences', 'setNotificationPreferences'];
const fail = (status, message) => Object.assign(new Error(message), { status });
const tokenId = token => createHash('sha256').update(token).digest('hex');
const validToken = value => typeof value === 'string' && /^(ExpoPushToken|ExponentPushToken)\[[A-Za-z0-9_-]{10,200}\]$/.test(value);

export async function handleNotifications({ action, data, uid, db, rate, now = Date.now }) {
  await rate('push-settings', 30, 60000);
  const prefs = db.doc(`users/${uid}/notificationSettings/preferences`);
  if (action === 'getNotificationPreferences') {
    const row = await prefs.get();
    return { messages: row.get('messages') === true, matches: row.get('matches') === true };
  }
  if (action === 'setNotificationPreferences') {
    if (typeof data.messages !== 'boolean' || typeof data.matches !== 'boolean') throw fail(400, 'Choose your notification preferences.');
    await prefs.set({ messages: data.messages, matches: data.matches });
    return { messages: data.messages, matches: data.matches };
  }
  if (!validToken(data.token)) throw fail(400, 'This device notification token is invalid.');
  const ref = db.doc(`pushDevices/${tokenId(data.token)}`);
  if (action === 'unregisterPushDevice') {
    await db.runTransaction(async tx => {
      const row = await tx.get(ref);
      if (row.get('uid') === uid) tx.set(ref, { enabled: false }, { merge: true });
    });
    return { removed: true };
  }
  if (!['android', 'ios'].includes(data.platform)) throw fail(400, 'Choose a supported device platform.');
  await ref.set({ uid, token: data.token, platform: data.platform, enabled: true, expiresAt: now() + 30 * 86400000 });
  return { registered: true };
}

export function queueNotification(tx, db, { eventId, matchId, recipient, kind, now = Date.now }) {
  tx.create(db.doc(`notificationEvents/${eventId}`), { matchId, recipient, kind, state: 'pending', attempts: 0, createdAt: now(), retryAt: now(), leaseUntil: 0 });
}

async function disableDevice(db, id, uid) {
  await db.runTransaction(async tx => {
    const ref = db.doc(`pushDevices/${id}`), row = await tx.get(ref);
    if (row.get('uid') === uid) tx.set(ref, { enabled: false }, { merge: true });
  });
}

// Durable outbox: chat commits independently of Expo availability. Messages and
// profile names never enter notification payloads or operational logs.
export async function deliverNotification({ db, eventId, env = process.env, fetchImpl = fetch, now = Date.now }) {
  if (env.RILVA_PUSH_ENABLED !== 'true') return { disabled: true };
  const eventRef = db.doc(`notificationEvents/${eventId}`);
  const claim = await db.runTransaction(async tx => {
    const snap = await tx.get(eventRef), event = snap.data();
    if (!event || event.state !== 'pending' || event.retryAt > now() || event.leaseUntil > now()) return null;
    if (event.createdAt < now() - 3600000) { tx.set(eventRef, { state: 'expired' }, { merge: true }); return null; }
    const match = await tx.get(db.doc(`matches/${event.matchId}`));
    const members = match.get('memberUids') || [];
    if (match.get('state') !== 'active' || !members.includes(event.recipient) || members.length !== 2) { tx.set(eventRef, { state: 'cancelled' }, { merge: true }); return null; }
    const other = members.find(value => value !== event.recipient);
    const [a, b, prefs, devices] = await Promise.all([
      tx.get(db.doc(`users/${event.recipient}/blocks/${other}`)), tx.get(db.doc(`users/${other}/blocks/${event.recipient}`)),
      tx.get(db.doc(`users/${event.recipient}/notificationSettings/preferences`)),
      tx.get(db.collection('pushDevices').where('uid', '==', event.recipient).limit(20)),
    ]);
    if (a.exists || b.exists || prefs.get(event.kind === 'message' ? 'messages' : 'matches') !== true) { tx.set(eventRef, { state: 'cancelled' }, { merge: true }); return null; }
    const targets = devices.docs.filter(doc => doc.get('enabled') === true && doc.get('expiresAt') > now()).map(doc => ({ id: doc.id, token: doc.get('token') }));
    if (!targets.length) { tx.set(eventRef, { state: 'cancelled' }, { merge: true }); return null; }
    tx.set(eventRef, { leaseUntil: now() + 60000, attempts: event.attempts + 1 }, { merge: true });
    return { ...event, targets, attempts: event.attempts + 1 };
  });
  if (!claim) return { skipped: true };
  try {
    const headers = { 'content-type': 'application/json' };
    if (env.EXPO_ACCESS_TOKEN) headers.authorization = `Bearer ${env.EXPO_ACCESS_TOKEN}`;
    const response = await fetchImpl('https://exp.host/--/api/v2/push/send', {
      method: 'POST', headers, signal: AbortSignal.timeout(8000),
      body: JSON.stringify(claim.targets.map(target => ({ to: target.token, title: 'Rilva', body: claim.kind === 'message' ? 'You have a new message.' : 'You have a new mutual match.', sound: 'default', channelId: 'connections', data: { matchId: claim.matchId, type: claim.kind }, ttl: 3600 }))),
    });
    if (!response.ok) throw new Error('Push provider unavailable');
    const payload = await response.json();
    if (!Array.isArray(payload.data) || payload.data.length !== claim.targets.length) throw new Error('Invalid push response');
    for (const [index, ticket] of payload.data.entries()) {
      const target = claim.targets[index];
      if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') await disableDevice(db, target.id, claim.recipient);
      if (ticket.status === 'ok' && ticket.id) await db.doc(`pushReceipts/${ticket.id}`).set({ deviceId: target.id, uid: claim.recipient, state: 'pending', checkAfter: now() + 15 * 60000 });
    }
    const failed = payload.data.some(ticket => ticket.status !== 'ok' && ticket.details?.error !== 'DeviceNotRegistered');
    if (failed) throw new Error('Push provider rejected notification');
    await eventRef.set({ state: 'submitted', leaseUntil: 0 }, { merge: true });
    return { submitted: true };
  } catch {
    await eventRef.set({ state: claim.attempts >= 5 ? 'failed' : 'pending', retryAt: now() + Math.min(3600000, 60000 * 2 ** claim.attempts), leaseUntil: 0 }, { merge: true });
    return { retry: true };
  }
}

export async function processNotificationQueue({ db, env = process.env, fetchImpl = fetch, now = Date.now }) {
  if (env.RILVA_PUSH_ENABLED !== 'true') return { disabled: true };
  const events = await db.collection('notificationEvents').where('state', '==', 'pending').limit(100).get();
  for (const row of events.docs.filter(doc => doc.get('retryAt') <= now()).slice(0, 20)) await deliverNotification({ db, eventId: row.id, env, fetchImpl, now });
  const receipts = await db.collection('pushReceipts').where('state', '==', 'pending').limit(100).get();
  const due = receipts.docs.filter(row => row.get('checkAfter') <= now());
  if (!due.length) return { checked: true };
  const headers = { 'content-type': 'application/json' };
  if (env.EXPO_ACCESS_TOKEN) headers.authorization = `Bearer ${env.EXPO_ACCESS_TOKEN}`;
  const response = await fetchImpl('https://exp.host/--/api/v2/push/getReceipts', { method: 'POST', headers, body: JSON.stringify({ ids: due.map(row => row.id) }), signal: AbortSignal.timeout(8000) });
  if (!response.ok) return { checked: false };
  const payload = await response.json();
  for (const row of due) {
    const receipt = payload.data?.[row.id];
    if (receipt?.details?.error === 'DeviceNotRegistered') await disableDevice(db, row.get('deviceId'), row.get('uid'));
    if (receipt || row.get('checkAfter') < now() - 86400000) await row.ref.set({ state: receipt?.status || 'expired' }, { merge: true });
  }
  return { checked: true };
}
