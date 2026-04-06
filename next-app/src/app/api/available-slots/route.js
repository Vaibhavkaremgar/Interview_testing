import { NextResponse } from "next/server";
import { pool, DB_READY } from "@/lib/db.js";
import { deletePastSlots, generateSlots, generateInMemorySlots, localDateStr, addDays, localTimeStr } from "@/lib/slots.js";
import { corsHeaders, withCors } from "@/lib/cors.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function GET() {
  if (DB_READY && pool) {
    let client;
    try {
      client = await pool.connect();
      await deletePastSlots();
      await generateSlots();
      const { rows: timeRows } = await client.query("SELECT NOW() AT TIME ZONE 'Asia/Kolkata' AS now");
      const now = new Date(timeRows[0].now + '+05:30');
      const serverNowIso = now.toISOString();
      const serverDateStr = localDateStr(now);
      const todayStr = localDateStr(now);
      const day1Str = localDateStr(addDays(now, 1));
      const day2Str = localDateStr(addDays(now, 2));
      const currentTime = localTimeStr(now);

      const { rows } = await client.query(
        `SELECT id, slot_date::text, slot_time, max_concurrent, current_bookings
         FROM interview_slots
         WHERE current_bookings < max_concurrent
           AND (
             (slot_date = $1 AND slot_time >= $4)
             OR slot_date = $2
             OR slot_date = $3
           )
         ORDER BY slot_date, slot_time`,
        [todayStr, day1Str, day2Str, currentTime]
      );

      return withCors(NextResponse.json({
        success: true,
        mode: "db",
        server_now_iso: serverNowIso,
        server_date: serverDateStr,
        server_timezone: "Asia/Kolkata",
        slots: rows.map(r => ({
          slot_id: r.id,
          slot_date: r.slot_date,
          slot_time: r.slot_time.slice(0, 5),
          available: r.max_concurrent - r.current_bookings,
        })),
      }));
    } catch (e) {
      console.error("DB slots error:", e.message);
      const now = new Date();
      return withCors(NextResponse.json({
        success: true,
        mode: "memory",
        server_now_iso: now.toISOString(),
        server_date: localDateStr(now),
        server_timezone: "Asia/Kolkata",
        slots: generateInMemorySlots(),
      }));
    } finally {
      if (client) client.release();
    }
  }

  const now = new Date();
  return withCors(NextResponse.json({
    success: true,
    mode: "memory",
    server_now_iso: now.toISOString(),
    server_date: localDateStr(now),
    server_timezone: "Asia/Kolkata",
    slots: generateInMemorySlots(),
  }));
}
