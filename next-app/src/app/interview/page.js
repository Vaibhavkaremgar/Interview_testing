import { redirect } from "next/navigation";

export default function InterviewRedirect({ searchParams }) {
  const query = new URLSearchParams(searchParams || {}).toString();
  const suffix = query ? `?${query}` : "";
  redirect(`/interview/index.html${suffix}`);
}
