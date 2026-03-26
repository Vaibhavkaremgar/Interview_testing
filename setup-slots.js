require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function setupSlots() {
  const client = await pool.connect();
  try {
    // Clear old slots first
    await client.query(`DELETE FROM interview_slots WHERE slot_date < CURRENT_DATE`);
    console.log("✅ Cleared past slots");

    // Generate slots for next 2 days, 9 AM to 5:30 PM, every 30 minutes
    const slots = [];
    const now = new Date();
    
    for (let d = 0; d < 2; d++) {
      const date = new Date(now);
      date.setDate(now.getDate() + d);
      const dateStr = date.toISOString().split("T")[0];
      
      for (let h = 9; h < 18; h++) {
        for (let m = 0; m < 60; m += 30) {
          const timeStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
          slots.push({
            slot_date: dateStr,
            slot_time: timeStr,
            max_concurrent: 3,
            current_bookings: 0,
          });
        }
      }
    }

    console.log(`📅 Generating slots for dates:`, slots[0].slot_date, "to", slots[slots.length - 1].slot_date);

    // Insert slots
    for (const slot of slots) {
      await client.query(
        `INSERT INTO interview_slots (slot_date, slot_time, max_concurrent, current_bookings)
         VALUES ($1, $2, $3, $4)`,
        [slot.slot_date, slot.slot_time, slot.max_concurrent, slot.current_bookings]
      );
    }

    console.log(`✅ Created ${slots.length} interview slots for next 2 days`);
  } catch (e) {
    console.error("❌ Error:", e.message);
  } finally {
    client.release();
    pool.end();
  }
}

setupSlots();
