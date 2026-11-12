import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildTaxInvoice } from "@/features/billing/invoices";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orderId } = await params;
  if (!orderId || typeof orderId !== "string" || orderId.length > 64) {
    return NextResponse.json({ error: "Invalid order ID" }, { status: 400 });
  }

  const order = await prisma.paymentOrder.findUnique({
    where: { id: orderId },
    include: { user: { select: { id: true, name: true, email: true } } },
  });

  if (!order || order.userId !== userId) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }

  if (order.status !== "PAID") {
    return NextResponse.json(
      { error: "Invoice is only available for paid orders", status: order.status },
      { status: 400 },
    );
  }

  const invoice = buildTaxInvoice(order, {
    id: order.user.id,
    name: order.user.name,
    email: order.user.email,
  });

  return NextResponse.json({ invoice });
}
