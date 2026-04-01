import { NextResponse } from "next/server";
import { toggleSaved } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function PATCH(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ok = toggleSaved(id);
  if (!ok) return NextResponse.json({ error: "Market not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
