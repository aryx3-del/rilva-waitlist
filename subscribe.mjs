import { createHash } from "node:crypto";

const json = (statusCode, body) => new Response(JSON.stringify(body), {
  status: statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

export default async (request) => {
  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed." });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Please try again." });
  }

  // Quietly accept bot submissions without storing or sending anything.
  if (body.company) return json(200, { ok: true });

  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return json(400, { error: "Please enter a valid email address." });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, RILVA_FROM_EMAIL } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !RESEND_API_KEY || !RILVA_FROM_EMAIL) {
    console.error("Waitlist environment variables are not configured.");
    return json(503, { error: "We’re getting the list ready. Please try again soon." });
  }

  try {
    const saved = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/waitlist?on_conflict=email`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify({ email }),
    });
    if (!saved.ok) {
      console.error("Waitlist storage failed:", saved.status, await saved.text());
      return json(500, { error: "We couldn’t save that just now. Please try again." });
    }

    // Resend's idempotency key makes repeated submits for the same address safe.
    const sent = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `rilva-welcome-${createHash("sha256").update(email).digest("hex")}`,
      },
      body: JSON.stringify({
        from: `Rilva <${RILVA_FROM_EMAIL}>`,
        to: [email],
        subject: "You’re on the Rilva list ♥",
        html: `<div style="font-family:Arial,sans-serif;color:#34251f;max-width:560px;margin:32px auto;padding:28px;background:#f8eee2;border-radius:18px"><p style="font-size:24px;font-weight:bold;color:#e4483d">rilva.</p><p>Hi there,</p><h1 style="font-family:Georgia,serif;font-size:32px">You’re in. And we’re glad you are.</h1><p>Thank you for being here at the very beginning. You’re officially on the Rilva waitlist. When we’re ready to open the doors, you’ll be one of the first to know.</p><p>Until then, here’s to the little things—and the people who make them feel like everything.</p><p>With love,<br><strong>Team Rilva</strong> ♥</p></div>`,
        text: "Hi there,\n\nYou’re in. And we’re glad you are.\n\nThank you for being here at the very beginning. You’re officially on the Rilva waitlist. When we’re ready to open the doors, you’ll be one of the first to know.\n\nUntil then, here’s to the little things—and the people who make them feel like everything.\n\nWith love,\nTeam Rilva ♥",
      }),
    });
    if (!sent.ok) {
      console.error("Welcome email failed:", sent.status, await sent.text());
      // Keep the signup; the launch list is intact even if email delivery needs attention.
    }
    return json(200, { ok: true });
  } catch (error) {
    console.error("Waitlist request failed:", error);
    return json(500, { error: "We couldn’t process that just now. Please try again." });
  }
};
