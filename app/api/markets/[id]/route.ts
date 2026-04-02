import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function PATCH(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = sql();
  const rows = await db`
    UPDATE markets SET saved = NOT saved WHERE id = ${id} RETURNING id
  `;
  if (rows.length === 0) return NextResponse.json({ error: "Market not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
