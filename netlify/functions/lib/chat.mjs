import { queueNotification } from './notifications.mjs';
const actions = new Set(['listConversations', 'listMessages', 'sendMessage', 'markConversationRead', 'unmatchConversation', 'blockConversation']);
const fail = (status, message) => Object.assign(new Error(message), { status });
const iso = value => value?.toDate?.().toISOString() || null;
const integer = value => Number.isSafeInteger(value) && value >= 0;

// Every thread operation reads match state and both block records inside the
// same transaction as its messages/writes, including idempotent send retries.
async function member(tx, db, id, uid) {
  const ref = db.doc(`matches/${id}`);
  const snap = await tx.get(ref);
  const match = snap.data();
  if (!snap.exists || match.state !== 'active' || !Array.isArray(match.memberUids)
    || match.memberUids.length !== 2 || !match.memberUids.includes(uid)) throw fail(403, 'This conversation is no longer available.');
  const other = match.memberUids.find(value => value !== uid);
  if (!other) throw fail(403, 'This conversation is no longer available.');
  const blocks = await Promise.all([
    tx.get(db.doc(`users/${uid}/blocks/${other}`)), tx.get(db.doc(`users/${other}/blocks/${uid}`)),
  ]);
  if (blocks.some(value => value.exists)) throw fail(403, 'This conversation is no longer available.');
  return { ref, match, other };
}

export async function handleChat({ action, data, uid, db, FieldValue, rate, now = Date.now, pushEnabled = false }) {
  if (!actions.has(action)) return null;
  if (action === 'listConversations') {
    await rate('chat-inbox', 30, 60000);
    const rows = await db.collection('matches').where('memberUids', 'array-contains', uid).limit(100).get();
    const conversations = [];
    // Sequential bounded work keeps server load predictable; inaccessible
    // matches are skipped without returning their names or message previews.
    for (const row of rows.docs) {
      if (row.get('state') !== 'active') continue;
      try {
        const conversation = await db.runTransaction(async tx => {
          const { match, other } = await member(tx, db, row.id, uid);
          const person = await tx.get(db.doc(`datingProfiles/${other}`));
          if (!person.exists) return null;
          return { matchId: row.id, person: { uid: other, name: person.get('name') },
            preview: match.lastMessage?.text || '', lastSenderUid: match.lastMessage?.senderUid || null,
            updatedAt: iso(match.lastMessage?.createdAt || match.createdAt),
            unread: Math.max(0, (match.receivedCounts?.[uid] || 0) - (match.readCounts?.[uid] || 0)) };
        });
        if (conversation) conversations.push(conversation);
      } catch (error) { if (error.status !== 403) throw error; }
    }
    conversations.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') || a.matchId.localeCompare(b.matchId));
    return { conversations, hasMore: rows.size === 100 };
  }

  const id = data.matchId;
  if (typeof id !== 'string' || !/^[a-f0-9]{40}$/.test(id)) throw fail(400, 'Choose a valid conversation.');
  await rate(action === 'sendMessage' ? 'chat-send' : 'chat-read', action === 'sendMessage' ? 60 : 90, 60000);
  return db.runTransaction(async tx => {
    const { ref, match, other } = await member(tx, db, id, uid);
    if (action === 'listMessages') {
      if (data.before !== undefined && (!integer(data.before) || data.before === 0)) throw fail(400, 'Choose a valid message page.');
      let query = ref.collection('messages').orderBy('sequence', 'desc');
      if (data.before !== undefined) query = query.startAfter(data.before);
      const rows = await tx.get(query.limit(41));
      const page = rows.docs.slice(0, 40);
      return { messages: page.map(doc => ({ id: doc.id, text: doc.get('text'), senderUid: doc.get('senderUid'), sequence: doc.get('sequence'), createdAt: iso(doc.get('createdAt')) })).reverse(),
        before: page.length ? page[page.length - 1].get('sequence') : null, hasMore: rows.size > 40,
        readThrough: match.receivedCounts?.[uid] || 0 };
    }
    if (action === 'sendMessage') {
      if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 2000) throw fail(400, 'Write a message of up to 2,000 characters.');
      if (typeof data.clientId !== 'string' || !/^[A-Za-z0-9_-]{12,80}$/.test(data.clientId)) throw fail(400, 'Choose a valid message identifier.');
      const messageRef = ref.collection('messages').doc(`${uid}_${data.clientId}`);
      const existing = await tx.get(messageRef);
      if (existing.exists) {
        if (existing.get('text') !== data.text.trim()) throw fail(409, 'This message identifier has already been used.');
        return { sent: true, id: existing.id, sequence: existing.get('sequence') };
      }
      const sequence = (match.messageCount || 0) + 1;
      const message = { text: data.text.trim(), senderUid: uid, sequence, createdAt: FieldValue.serverTimestamp() };
      tx.create(messageRef, message);
      const eventId = `${id}_${messageRef.id}`;
      if (pushEnabled) queueNotification(tx, db, { eventId, matchId: id, recipient: other, kind: 'message', now });
      tx.set(ref, { messageCount: sequence, receivedCounts: { ...(match.receivedCounts || {}), [other]: (match.receivedCounts?.[other] || 0) + 1 }, lastMessage: message }, { merge: true });
      return { sent: true, id: messageRef.id, sequence, notificationEventIds: pushEnabled ? [eventId] : [] };
    }
    if (action === 'markConversationRead') {
      if (!integer(data.readThrough) || data.readThrough > (match.receivedCounts?.[uid] || 0)) throw fail(400, 'Choose a valid read position.');
      tx.set(ref, { readCounts: { ...(match.readCounts || {}), [uid]: Math.max(match.readCounts?.[uid] || 0, data.readThrough) } }, { merge: true });
      return { read: true };
    }
    if (action === 'blockConversation') tx.set(db.doc(`users/${uid}/blocks/${other}`), { createdAt: FieldValue.serverTimestamp() });
    tx.set(ref, { state: action === 'blockConversation' ? 'blocked' : 'unmatched', endedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { ended: true };
  });
}

export const chatActions = [...actions];
