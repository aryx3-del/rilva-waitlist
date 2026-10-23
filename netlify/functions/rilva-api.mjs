import { createHash } from 'node:crypto';

const genders = new Set(['woman', 'man', 'nonbinary']);
const intents = new Set(['Meaningful', 'Exploring', 'Meeting people']);
const paces = new Set(['Slow & thoughtful', 'A little of both', 'Meet sooner']);
const paceFits = new Set(['too-fast', 'right', 'too-slow']);
const nowField = () => new Date();

function cleanText(value, max, field) {
  if (typeof value !== 'string') throw httpError(400, `${field} is required.`);
  const clean = value.trim().replace(/\s+/g, ' ');
  if (clean.length > max) throw httpError(400, `${field} is too long.`);
  return clean;
}
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
function mutualPreference(a, b) {
  return Array.isArray(a?.lookingFor) && a.lookingFor.includes(b?.gender)
    && Array.isArray(b?.lookingFor) && b.lookingFor.includes(a?.gender)
    && b?.age >= a?.minAge && b?.age <= a?.maxAge
    && a?.age >= b?.minAge && a?.age <= b?.maxAge;
}
function safeCard(uid, p, score = null, reasons = []) {
  return { uid, name: p.name, age: p.age, city: p.city, gender: p.gender, bio: p.bio,
    interests: p.interests || [], intention: p.intention, pace: p.pace, score, reasons };
}
function matchId(a, b) { return createHash('sha256').update([a, b].sort().join(':')).digest('hex').slice(0, 40); }
function validUid(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function iso(value) { return value?.toDate?.().toISOString?.() || (value instanceof Date ? value.toISOString() : null); }

async function createFirebase(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) throw httpError(503, 'Dating features are not configured yet. Add the Firebase service account to Netlify environment variables.');
  let credential;
  try { credential = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON); }
  catch { throw httpError(503, 'The Firebase server credential in Netlify is not valid JSON.'); }
  const [{ initializeApp, cert, getApps }, { getAuth }, { getFirestore, FieldValue, Timestamp }] = await Promise.all([
    import('firebase-admin/app'), import('firebase-admin/auth'), import('firebase-admin/firestore'),
  ]);
  const app = getApps()[0] || initializeApp({ credential: cert(credential), projectId: env.FIREBASE_PROJECT_ID || credential.project_id });
  return { auth: getAuth(app), db: getFirestore(app), FieldValue, Timestamp };
}

export function createHandler({ env = process.env, now = Date.now } = {}) {
  const bursts = new Map();
  const origins = new Set((env.RILVA_ALLOWED_ORIGINS || 'https://rilva-date.web.app,https://rilva-date.firebaseapp.com,https://rilva.date,http://localhost:800,http://localhost:8000,http://localhost:8888').split(',').map(x => x.trim()).filter(Boolean));
  if (env.URL) origins.add(env.URL);
  return async request => {
    const origin = request.headers.get('origin');
    const cors = origin && origins.has(origin) ? { 'access-control-allow-origin': origin } : {};
    const reply = (payload, status = 200, extra = {}) => new Response(payload === null ? null : JSON.stringify(payload), { status, headers: {
      'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Origin', ...cors, ...extra,
    } });
    if (origin && !origins.has(origin)) return reply({ error: { message: 'This app origin is not allowed.' } }, 403);
    if (request.method === 'OPTIONS') return reply(null, 204, { 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization', 'access-control-max-age': '600' });
    if (request.method !== 'POST') return reply({ error: { message: 'Use POST.' } }, 405);
    const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!token || token.length > 4096) return reply({ error: { message: 'Sign in to use Rilva.' } }, 401);
    let body;
    try { body = await request.json(); } catch { return reply({ error: { message: 'Send a valid JSON request.' } }, 400); }
    const action = body?.action;
    const data = body?.data && typeof body.data === 'object' ? body.data : {};
    const allowed = new Set(['getMyDatingProfile','listDateReflections','getLearningInsights','saveDatingProfile','findMatches','listMyMatches','getMatchChemistry','recordDatingPass','sendDatingLike','saveDateReflection','setNearbyPreference','setDiscoveryEnabled','getNearbyPulse','deleteDateReflection']);
    if (!allowed.has(action)) return reply({ error: { message: 'Unknown Rilva feature.' } }, 400);
    try {
      const { auth, db, FieldValue, Timestamp } = await createFirebase(env);
      const user = await auth.verifyIdToken(token, true);
      if (!user.email_verified) throw httpError(403, 'Verify your email before continuing.');
      const uid = user.uid;
      const profileRef = db.doc(`datingProfiles/${uid}`);
      const rate = async (key, limit, windowMs) => {
        const ref = db.doc(`featureRate/${uid}_${key}`);
        await db.runTransaction(async tx => {
          const snap = await tx.get(ref); const t = now(); const prior = snap.get('windowStart')?.toMillis?.() || 0;
          const count = t - prior < windowMs ? (snap.get('count') || 0) : 0;
          if (count >= limit) throw httpError(429, 'Please wait a little before trying again.');
          tx.set(ref, { windowStart: Timestamp.fromMillis(count ? prior : t), count: count + 1 });
        });
      };
      const blocked = async other => {
        const [a, b] = await Promise.all([db.doc(`users/${uid}/blocks/${other}`).get(), db.doc(`users/${other}/blocks/${uid}`).get()]);
        return a.exists || b.exists;
      };
      let result;
      switch (action) {
        case 'getMyDatingProfile': {
          const snap = await profileRef.get(); result = { profile: snap.exists ? snap.data() : null }; break;
        }
        case 'saveDatingProfile': {
          const name = cleanText(data.name,40,'Display name'), city = cleanText(data.city,60,'City'), bio = cleanText(data.bio || '',500,'Bio');
          const age = Number(data.age), minAge = Number(data.minAge), maxAge = Number(data.maxAge);
          if (name.length < 2 || !Number.isInteger(age) || age < 18 || age > 100) throw httpError(400,'Use a display name and confirm you are 18 or older.');
          if (!genders.has(data.gender) || !Array.isArray(data.lookingFor) || !data.lookingFor.length || data.lookingFor.length > 3 || data.lookingFor.some(g => !genders.has(g))) throw httpError(400,'Choose a valid gender and who you would like to meet.');
          if (!Number.isInteger(minAge) || !Number.isInteger(maxAge) || minAge < 18 || maxAge > 100 || minAge > maxAge || age < minAge || age > maxAge) throw httpError(400,'Choose an age range that includes your age and starts at 18 or above.');
          if (!intents.has(data.intention) || !paces.has(data.pace)) throw httpError(400,'Choose a valid intention and pace.');
          if (!Array.isArray(data.interests) || data.interests.length > 12 || data.interests.some(x => typeof x !== 'string' || x.trim().length < 2 || x.trim().length > 32)) throw httpError(400,'Add up to 12 interests, each 2–32 characters.');
          await rate('profile',10,3600000); const prior = await profileRef.get();
          await profileRef.set({ name, age, city, cityKey: city.normalize('NFKC').toLocaleLowerCase('en-IN'), bio, gender: data.gender, lookingFor: [...new Set(data.lookingFor)], minAge, maxAge, intention: data.intention, pace: data.pace, interests: [...new Set(data.interests.map(x => x.trim()))], discoveryEnabled: data.discoveryEnabled === true, createdAt: prior.get('createdAt') || FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
          result = { saved: true, discoverable: data.discoveryEnabled === true }; break;
        }
        case 'setDiscoveryEnabled': case 'setNearbyPreference': {
          if (typeof data.enabled !== 'boolean') throw httpError(400,'Choose whether this setting is enabled.');
          const ref = profileRef; if (!(await ref.get()).exists) throw httpError(412, action === 'setNearbyPreference' ? 'Save your dating profile first.' : 'Create your dating profile first.');
          const key = action === 'setNearbyPreference' ? 'nearbyEnabled' : 'discoveryEnabled'; await ref.set({ [key]: data.enabled, updatedAt: FieldValue.serverTimestamp() }, { merge: true }); result = { enabled: data.enabled }; break;
        }
        case 'findMatches': {
          await rate('discover',20,60000); const selfSnap = await profileRef.get(); const self = selfSnap.data();
          if (!self || !self.discoveryEnabled) throw httpError(412,'Finish and publish your dating profile to discover people.');
          const pool = await db.collection('datingProfiles').where('discoveryEnabled','==',true).limit(100).get(); const profiles = [];
          for (const doc of pool.docs) {
            const other = doc.data(); if (doc.id === uid || !mutualPreference(self,other) || await blocked(doc.id)) continue;
            if ((await db.doc(`datingLikes/${uid}/seen/${doc.id}`).get()).exists) continue;
            const interests = new Set((self.interests || []).map(x => x.toLocaleLowerCase('en-IN'))); const shared = (other.interests || []).filter(x => interests.has(x.toLocaleLowerCase('en-IN')));
            const reasons = []; if (shared.length) reasons.push(`${shared.length} shared interest${shared.length === 1 ? '' : 's'}`); if (self.intention === other.intention) reasons.push('similar dating intentions'); if (self.pace === other.pace) reasons.push('a similar pace'); if (self.cityKey === other.cityKey) reasons.push('same city');
            const score = Math.min(95,Math.min(40,shared.length*12)+(self.intention===other.intention?25:0)+(self.pace===other.pace?20:0)+(self.cityKey===other.cityKey?15:0)); profiles.push({ ...safeCard(doc.id,other,score,reasons), sharedInterests:shared });
          }
          profiles.sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)); result={profiles:profiles.slice(0,20),hasMore:profiles.length>20}; break;
        }
        case 'recordDatingPass': {
          const target = String(data.targetUid || ''); if (!validUid(target) || target === uid) throw httpError(400,'Choose a valid profile.'); await rate('pass',100,86400000);
          await db.doc(`datingLikes/${uid}/seen/${target}`).set({action:'passed',createdAt:FieldValue.serverTimestamp()}); result={recorded:true}; break;
        }
        case 'sendDatingLike': {
          const target = String(data.targetUid || ''); if (!validUid(target) || target === uid) throw httpError(400,'Choose a valid profile.'); await rate('like',60,86400000);
          const selfRef=profileRef,targetRef=db.doc(`datingProfiles/${target}`),out=db.doc(`datingLikes/${uid}/outgoing/${target}`),seen=db.doc(`datingLikes/${uid}/seen/${target}`),incoming=db.doc(`datingLikes/${target}/outgoing/${uid}`),matchRef=db.doc(`matches/${matchId(uid,target)}`); let matched=false;
          await db.runTransaction(async tx=>{ const [s,t,ib,ob,like,existing]=await Promise.all([tx.get(selfRef),tx.get(targetRef),tx.get(db.doc(`users/${uid}/blocks/${target}`)),tx.get(db.doc(`users/${target}/blocks/${uid}`)),tx.get(incoming),tx.get(matchRef)]);
            if(!s.exists||!t.exists||!s.get('discoveryEnabled')||!t.get('discoveryEnabled')||!mutualPreference(s.data(),t.data()))throw httpError(412,'This profile is no longer available for a match.'); if(ib.exists||ob.exists)throw httpError(403,'This profile is unavailable.');
            tx.set(out,{createdAt:FieldValue.serverTimestamp()});tx.set(seen,{action:'liked',createdAt:FieldValue.serverTimestamp()});if(like.exists||existing.exists){matched=true;if(!existing.exists)tx.create(matchRef,{memberUids:[uid,target],state:'active',createdAt:FieldValue.serverTimestamp(),chemistryUpdatedAt:null});}
          }); result={matched,matchId:matched?matchRef.id:null};break;
        }
        case 'getMatchChemistry': {
          await rate('chemistry',20,60000); const id=String(data.matchId||''); if(!/^[a-f0-9]{40}$/.test(id))throw httpError(400,'Choose a valid match.'); const ref=db.doc(`matches/${id}`),m=await ref.get(),members=m.get('memberUids')||[];
          if(!m.exists||!members.includes(uid)||m.get('state')!=='active')throw httpError(403,'An active mutual match is required.'); const otherUid=members.find(x=>x!==uid);
          const [s,o,hasBlock]=await Promise.all([profileRef.get(),db.doc(`datingProfiles/${otherUid}`).get(),blocked(otherUid)]); if(!s.exists||!o.exists||hasBlock)throw httpError(412,'Chemistry is not available for this match.');
          const a=s.data(),b=o.data(),keys=new Set((a.interests||[]).map(x=>x.toLocaleLowerCase('en-IN'))),shared=(b.interests||[]).filter(x=>keys.has(x.toLocaleLowerCase('en-IN'))),signals=[];
          if(shared.length)signals.push({label:'Shared interests',detail:shared.slice(0,5).join(', ')});if(a.intention===b.intention)signals.push({label:'Similar intention',detail:a.intention});if(a.pace===b.pace)signals.push({label:'Similar pace',detail:a.pace});
          const points=Math.min(100,shared.length*18+(a.intention===b.intention?25:0)+(a.pace===b.pace?20:0)),level=points>=65?'High':points>=35?'Promising':'Explore';
          await ref.set({chemistry:{level,signals,calculatedAt:FieldValue.serverTimestamp()},chemistryUpdatedAt:FieldValue.serverTimestamp()},{merge:true}); result={level,signals,prompts:shared.length?[`Ask what first got them into ${shared[0]}.`,'What does a great first date feel like to you?']:['What is something you have been curious about lately?','What does a great first date feel like to you?'],note:'Profile signals are conversation starters, not a prediction of real-life chemistry.'};break;
        }
        case 'listMyMatches': {
          await rate('matches',30,60000);const snaps=await db.collection('matches').where('memberUids','array-contains',uid).limit(50).get(),matches=[];
          for(const m of snaps.docs){if(m.get('state')!=='active')continue;const other=(m.get('memberUids')||[]).find(x=>x!==uid);if(!other||await blocked(other))continue;const p=await db.doc(`datingProfiles/${other}`).get();if(p.exists)matches.push({matchId:m.id,person:safeCard(other,p.data()),createdAt:iso(m.get('createdAt'))});} result={matches};break;
        }
        case 'saveDateReflection': {
          const reflection=cleanText(data.reflection||'',1200,'Reflection'),takeaway=cleanText(data.takeaway||'',600,'Takeaway'),rating=Number(data.rating),paceFit=data.paceFit;
          if(!Number.isInteger(rating)||rating<1||rating>5||!paceFits.has(paceFit))throw httpError(400,'Choose a date rating and how the pace felt.');if(!reflection&&!takeaway)throw httpError(400,'Add a reflection or takeaway before saving.');
          const match=data.matchId?String(data.matchId):null;if(match&&!/^[a-f0-9]{40}$/.test(match))throw httpError(400,'Choose a valid match.');if(match){const m=await db.doc(`matches/${match}`).get();if(!m.exists||!m.get('memberUids')?.includes(uid))throw httpError(403,'That match is unavailable.');}
          const supplied=String(data.id||'');if(supplied&&!/^[A-Za-z0-9_-]{10,40}$/.test(supplied))throw httpError(400,'Choose a valid note.');const col=db.collection(`users/${uid}/dateReflections`),ref=supplied?col.doc(supplied):col.doc();
          await ref.set({reflection,takeaway,rating,paceFit,matchId:match,updatedAt:FieldValue.serverTimestamp(),...(supplied?{}:{createdAt:FieldValue.serverTimestamp()})},{merge:true});result={saved:true,id:ref.id};break;
        }
        case 'listDateReflections': case 'getLearningInsights': {
          const snap=await db.collection(`users/${uid}/dateReflections`).orderBy('createdAt','desc').limit(30).get(),rows=snap.docs.map(d=>({id:d.id,reflection:d.get('reflection')||'',takeaway:d.get('takeaway')||'',rating:d.get('rating')||null,paceFit:d.get('paceFit')||null,createdAt:iso(d.get('createdAt'))}));
          if(action==='listDateReflections'){result={reflections:rows};break;} await rate('learning',20,60000);const valid=rows.filter(x=>Number.isInteger(x.rating)&&paceFits.has(x.paceFit));
          if(valid.length<2)result={totalDates:valid.length,ready:false,insight:'After a couple more reflections, Rilva can help you spot patterns in the pace and connection that feel right to you.'};
          else{const averageRating=Math.round(valid.reduce((s,x)=>s+x.rating,0)/valid.length*10)/10,counts=valid.reduce((c,x)=>({...c,[x.paceFit]:(c[x.paceFit]||0)+1}),{}),[pace,count]=Object.entries(counts).sort((a,b)=>b[1]-a[1])[0],phrase={'too-fast':'slower introductions',right:'a pace that feels right','too-slow':'more direct momentum'}[pace];result={totalDates:valid.length,ready:true,averageRating,commonPace:pace,count,insight:`Across your last ${valid.length} reflections, you most often noted ${phrase} (${count} times). Your average connection rating was ${averageRating}/5. Use this as a prompt for your own preferences—not a rule for judging future dates.`};}break;
        }
        case 'deleteDateReflection': {
          const id=String(data.id||'');if(!/^[A-Za-z0-9_-]{10,40}$/.test(id))throw httpError(400,'Choose a valid note.');await db.doc(`users/${uid}/dateReflections/${id}`).delete();result={deleted:true};break;
        }
        case 'getNearbyPulse': {
          await rate('nearby',12,60000);const p=(await profileRef.get()).data();if(!p?.city)throw httpError(412,'Save your city in your dating profile first.');if(p.nearbyEnabled!==true)throw httpError(412,'Enable nearby activity first.');
          const cutoff=Timestamp.fromMillis(now()-7*86400000),snap=await db.collection('datingProfiles').where('cityKey','==',p.cityKey).where('createdAt','>=',cutoff).orderBy('createdAt','desc').limit(500).get(),count=snap.docs.filter(d=>d.id!==uid&&d.get('discoveryEnabled')===true).length;
          result={city:p.city,newMembersThisWeek:snap.size===500?`${count}+`:count,asOf:new Date(now()).toISOString(),note:'City-level count only. No exact location or member identity is shared.'};break;
        }
      }
      return reply({ data: result });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : error?.code === 'auth/id-token-revoked' || error?.code === 'auth/invalid-id-token' ? 401 : 500;
      if (status >= 500) console.error('Rilva API request failed:', error?.code || error?.name || 'unknown');
      return reply({ error: { message: status >= 500 ? 'Rilva could not complete that request right now. Try again shortly.' : error.message } }, status);
    }
  };
}

export default createHandler();
