import { createHash } from 'node:crypto';
import { REPORT_REASONS } from '../../../shared/safety-options.mjs';

export const safetyActions = ['reportProfile', 'blockProfile'];
export const connectionId = (a, b) => createHash('sha256').update([a, b].sort().join(':')).digest('hex').slice(0, 40);
const fail = (status, message) => Object.assign(new Error(message), { status });
const validUid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export async function handleSafety({ action, data, uid, db, FieldValue, rate }) {
  const target = data.targetUid;
  if (!validUid(target) || target === uid) throw fail(400, 'Choose another member to report or block.');
  const reporting = action === 'reportProfile';
  const id = connectionId(uid, target);
  if (data.matchId !== undefined && data.matchId !== id) throw fail(400, 'Choose a valid conversation.');
  let reportRef;
  let details;
  if (reporting) {
    if (!REPORT_REASONS.some(reason => reason.value === data.reason)) throw fail(400, 'Choose a reason for your report.');
    if (typeof data.details !== 'string' || data.details.length > 1000) throw fail(400, 'Keep report details within 1,000 characters.');
    if (typeof data.block !== 'boolean') throw fail(400, 'Choose whether to also block this person.');
    if (typeof data.clientId !== 'string' || !/^[A-Za-z0-9_-]{12,80}$/.test(data.clientId)) throw fail(400, 'Choose a valid report identifier.');
    details = data.details.trim();
    reportRef = db.doc(`memberReports/${createHash('sha256').update(`${uid}:${data.clientId}`).digest('hex')}`);
  }
  await rate(reporting ? 'report' : 'block', reporting ? 10 : 60, 86400000);
  return db.runTransaction(async tx => {
    const matchRef = db.doc(`matches/${id}`);
    const [profile, match, existing] = await Promise.all([
      tx.get(db.doc(`datingProfiles/${target}`)), tx.get(matchRef),
      reporting ? tx.get(reportRef) : Promise.resolve(null),
    ]);
    const wasMatched = match.exists && match.get('memberUids')?.length === 2
      && match.get('memberUids').includes(uid) && match.get('memberUids').includes(target);
    // A former match can still be reported after unmatching, blocking or profile deletion.
    if (data.matchId && !wasMatched) throw fail(403, 'This conversation is unavailable.');
    if (existing?.exists) {
      if (existing.get('targetUid') !== target || existing.get('reason') !== data.reason
        || existing.get('details') !== details || existing.get('blocked') !== data.block) throw fail(409, 'This report identifier has already been used.');
      return { reported: true, reportId: reportRef.id, blocked: existing.get('blocked') };
    }
    if (!profile.exists && !wasMatched) throw fail(404, 'This profile is no longer available.');
    let evidence = [];
    if (reporting && wasMatched) {
      const messages = await tx.get(matchRef.collection('messages').orderBy('sequence', 'desc').limit(20));
      evidence = messages.docs.map(message => ({ id: message.id, text: message.get('text'), senderUid: message.get('senderUid'), sequence: message.get('sequence') }));
    }
    const blocking = !reporting || data.block;
    if (reporting) tx.create(reportRef, {
      reporterUid: uid, targetUid: target, matchId: wasMatched ? id : null,
      reason: data.reason, details, blocked: blocking, evidence,
      status: 'open', createdAt: FieldValue.serverTimestamp(),
    });
    if (blocking) {
      tx.set(db.doc(`users/${uid}/blocks/${target}`), { createdAt: FieldValue.serverTimestamp() });
      if (wasMatched && match.get('state') === 'active') tx.set(matchRef, { state: 'blocked', endedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    return { ...(reporting ? { reported: true, reportId: reportRef.id } : {}), blocked: blocking };
  });
}
