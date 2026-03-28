import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

function buildQuery(searchParams) {
  const qp = new URLSearchParams();
  const entries = Object.entries(searchParams || {});
  for (const [key, value] of entries) {
    if (typeof value === "string") {
      qp.set(key, value);
    } else if (Array.isArray(value)) {
      value.forEach((v) => {
        if (typeof v === "string") qp.append(key, v);
      });
    }
  }
  const qs = qp.toString();
  return qs ? `?${qs}` : "";
}

export default function InterviewRedirect({ searchParams }) {
  const suffix = buildQuery(searchParams);
  redirect(`/interview/index.html${suffix}`);
}
