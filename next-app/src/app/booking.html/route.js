import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";

export async function GET() {
  const filePath = path.join(process.cwd(), "public", "booking.html");

  try {
    const html = await fs.readFile(filePath, "utf8");
    const interviewBaseUrl = (
      process.env.INTERVIEW_BASE_URL ||
      process.env.NEXT_PUBLIC_INTERVIEW_BASE_URL ||
      ""
    ).trim().replace(/\/+$/, "");
    const configScript = `<script>window.__BOOKING_CONFIG__ = ${JSON.stringify({
      interviewBaseUrl,
    })};</script>`;
    const renderedHtml = html.includes("</head>")
      ? html.replace("</head>", `${configScript}</head>`)
      : `${configScript}${html}`;

    return new Response(renderedHtml, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(
      {
        success: false,
        error: "Unable to load booking page",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
