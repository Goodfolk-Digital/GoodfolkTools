import { NextResponse } from "next/server";

// Company email-list subscribe endpoint for goodfolkdigital.com.
// The front door (a static Lovable site) posts here; this route validates
// server-side and writes the contact to a Resend Audience. It returns
// success ONLY after Resend confirms the contact was stored.
//
// Required env: RESEND_FULL_ACCESS_KEY (a Resend API key with full access;
// the sending-only key cannot manage audiences/contacts).
// Optional env: RESEND_AUDIENCE_ID. When unset, the route resolves the
// audience by name (AUDIENCE_NAME), creating it on first use.

const AUDIENCE_NAME = "Goodfolk company list";

const ALLOWED_ORIGINS = new Set([
  "https://goodfolkdigital.com",
  "https://www.goodfolkdigital.com",
  "https://tools.goodfolkdigital.com",
]);

function corsHeaders(origin: string | null) {
  const headers: Record<string, string> = { Vary: "Origin" };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

// Best-effort per-IP rate limit (in-memory; fine at this scale).
const hits = new Map<string, number[]>();
function rateLimited(ip: string) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 5;
}

let cachedAudienceId: string | null = process.env.RESEND_AUDIENCE_ID ?? null;

async function resend(path: string, init?: RequestInit) {
  const key = process.env.RESEND_FULL_ACCESS_KEY;
  const res = await fetch(`https://api.resend.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function resolveAudienceId(): Promise<string | null> {
  if (cachedAudienceId) return cachedAudienceId;
  const { res, data } = await resend("/audiences");
  if (!res.ok) return null;
  const found = (data?.data ?? []).find(
    (a: { name?: string }) => a?.name === AUDIENCE_NAME
  );
  if (found?.id) {
    cachedAudienceId = found.id as string;
    return cachedAudienceId;
  }
  const created = await resend("/audiences", {
    method: "POST",
    body: JSON.stringify({ name: AUDIENCE_NAME }),
  });
  if (created.res.ok && created.data?.id) {
    cachedAudienceId = created.data.id as string;
    return cachedAudienceId;
  }
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);

  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return NextResponse.json(
      { ok: false, error: "Origin not allowed" },
      { status: 403, headers }
    );
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts — please try again later." },
      { status: 429, headers }
    );
  }

  let body: { email?: unknown; website?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request" },
      { status: 400, headers }
    );
  }

  // Honeypot: real visitors never fill the hidden "website" field.
  // Bots get a fake success and nothing is stored.
  if (typeof body.website === "string" && body.website.length > 0) {
    return NextResponse.json({ ok: true }, { status: 200, headers });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return NextResponse.json(
      { ok: false, error: "Please enter a valid email address." },
      { status: 400, headers }
    );
  }

  if (!process.env.RESEND_FULL_ACCESS_KEY) {
    return NextResponse.json(
      { ok: false, error: "The list isn't configured yet." },
      { status: 503, headers }
    );
  }

  const audienceId = await resolveAudienceId();
  if (!audienceId) {
    return NextResponse.json(
      { ok: false, error: "The list isn't available right now." },
      { status: 502, headers }
    );
  }

  const { res, data } = await resend(`/audiences/${audienceId}/contacts`, {
    method: "POST",
    body: JSON.stringify({ email, unsubscribed: false }),
  });

  if (res.ok) {
    return NextResponse.json(
      { ok: true, id: data?.id ?? null },
      { status: 200, headers }
    );
  }

  // Idempotent subscribe: an already-listed address is a success.
  const message = String(data?.message ?? "");
  if (/already/i.test(message)) {
    return NextResponse.json({ ok: true }, { status: 200, headers });
  }

  return NextResponse.json(
    { ok: false, error: "Signup failed — please try again." },
    { status: 502, headers }
  );
}
