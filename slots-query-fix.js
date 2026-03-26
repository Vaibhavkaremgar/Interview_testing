// ── GET AVAILABLE SLOTS ───────────────────────────────────────
router.get("/available-slots", async (req, res) => {
  // Use DB if connected
  if (DB_ENABLED && pool) {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(`
        SELECT id, slot_date::text, slot_time, max_concurrent, current_bookings
        FROM interview_slots
        WHERE current_bookings < max_concurrent
          AND slot_date >= CURRENT_DATE
          AND slot_date <= CURRENT_DATE + INTERVAL '2 days'
          AND NOT (slot_date = CURRENT_DATE AND slot_time <= CURRENT_TIME + INTERVAL '30 minutes')
        ORDER BY slot_date, slot_time
      `);
      return res.json({
        success: true,
        mode: "db",
        slots: rows.map(r => ({
          slot_id:   r.id,
          slot_date: r.slot_date,
          slot_time: r.slot_time.slice(0, 5),
          available: r.max_concurrent - r.current_bookings,
        })),
      });
    } catch (e) {
      console.error("❌ DB slots error:", e.message);
      // Fall through to in-memory
    } finally {
      client.release();
    }
  }

  // In-memory fallback
  console.log("📋 Serving in-memory slots (DB not connected)");
  return res.json({ success: true, mode: "memory", slots: generateInMemorySlots() });
});
