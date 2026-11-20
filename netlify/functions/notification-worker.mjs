import { createFirebase } from './rilva-api.mjs';
import { processNotificationQueue } from './lib/notifications.mjs';

export const config = { schedule: '*/5 * * * *' };
export default async function () {
  if (process.env.RILVA_PUSH_ENABLED !== 'true') return new Response(null, { status: 204 });
  try {
    const { db } = await createFirebase(process.env);
    await processNotificationQueue({ db });
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error('Push queue check failed:', error.code || error.name || 'unknown');
    return new Response(null, { status: 500 });
  }
}
