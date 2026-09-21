import { NextResponse } from "next/server";

// Runtime configuration for the browser bundle. The API URL is read from
// the container's environment at request time rather than inlined into
// the client bundle at build time, so one built image can be reused
// across instances that talk to different API backends.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ apiUrl: process.env.API_URL ?? "" });
}
