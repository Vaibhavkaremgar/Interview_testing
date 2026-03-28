import { NextResponse } from "next/server";
import { processWebhook } from "@/lib/vapi.js";
import { corsHeaders, withCors } from "@/lib/cors.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  processWebhook(body).catch(e => console.error("Webhook error:", e));
  return withCors(NextResponse.json({ received: true }));
}
