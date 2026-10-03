# Rilva waitlist — launch and email setup

This folder contains the site, Netlify signup function, and this guide. It is ready to deploy as a Netlify site, with Supabase storing the list and Resend sending the welcome note. Signup stays on the page; no redirect or extra step.

## 1. Create the waitlist table

Create a Supabase project, open **SQL Editor**, and run:

```sql
create table public.waitlist (
  id bigint generated always as identity primary key,
  email text not null unique,
  created_at timestamptz not null default now()
);

alter table public.waitlist enable row level security;
```

Do not expose the service role key in the website. It belongs only in Netlify’s server-side environment variables.

## 2. Set up the appreciation email

Create a Resend account, add and verify a sending domain you control (for example `mail.rilva.date`), then add the DNS records Resend gives you at Namecheap. Set `RILVA_FROM_EMAIL` to a verified sender such as `hello@mail.rilva.date`. The function sends this note after signup:

> You’re in. And we’re glad you are. Thank you for being here at the very beginning. You’re officially on the Rilva waitlist. When we’re ready to open the doors, you’ll be one of the first to know.

The email includes plain-text and HTML versions. A failed email send does not discard the saved signup; check Netlify function logs if delivery needs debugging.

## 3. Deploy

1. Put the contents of this `outputs` folder in a GitHub repository and connect it to Netlify. The signup handler is a Netlify Function, so use a Git-connected deploy or Netlify CLI; a static drag-and-drop upload will not publish the function.
2. In Netlify, add these environment variables under **Site configuration → Environment variables**:
   - `SUPABASE_URL` — your Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY` — the project service role key (secret)
   - `RESEND_API_KEY` — your Resend API key (secret)
   - `RILVA_FROM_EMAIL` — verified sender address, e.g. `hello@mail.rilva.date`
3. Trigger a deploy after setting the variables.
4. Test with your own email. Confirm a row appears in Supabase and the appreciation mail lands in your inbox (check spam/promotions too).

## 4. Point rilva.date from Namecheap to Netlify

In Netlify, add `rilva.date` and `www.rilva.date` under **Domain management**. Netlify will show the current DNS values for your site. In Namecheap, open **Domain List → Manage → Advanced DNS** and enter the records Netlify asks for. Remove conflicting parking/URL redirect records, keep any email-provider records, and set Netlify's primary domain preference. Allow DNS time to propagate, then enable HTTPS in Netlify. Use the exact values Netlify shows; they can vary by account/site.

## Before announcing the waitlist

- Add a privacy policy explaining what Rilva collects (email address), why (waitlist and launch updates), how long it is retained, and how someone can request deletion. The site currently includes a short signup consent note; it is not a complete privacy policy.
- Use a domain sending address rather than a personal mailbox and complete the sender's domain verification / SPF / DKIM setup so launch emails have a better chance of delivery.
- The starter endpoint has a honeypot, validation, and duplicate suppression. For a public campaign, add a rate limiter or CAPTCHA and a working unsubscribe process before sending ongoing marketing emails. The appreciation note here is a one-time confirmation; get appropriate consent for future promotional mail.

## Files

- `index.html` — responsive landing page and inline signup interaction
- `netlify/functions/subscribe.mjs` — signup storage and one-time thank-you email
- `netlify.toml` — Netlify publish and function configuration
