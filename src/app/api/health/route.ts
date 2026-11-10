export const dynamic = "force-dynamic";

/**
 * Health check endpoint supporting both process liveness and database readiness probes.
 *
 * 1. Liveness (default: GET /api/health):
 *    Ultra-lightweight process check. Returns 200 without touching database or external services.
 *    Never flaps if upstream databases experience transient latency.
 *
 * 2. Readiness (GET /api/health?probe=readiness):
 *    Verifies database connectivity with a strict 3-second timeout.
 *    Returns 200 when database responds to `SELECT 1`, or 503 if unreachable/timed out.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const probe = url.searchParams.get("probe");

  const headers = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Content-Type": "application/json; charset=utf-8",
  };

  if (probe === "readiness") {
    try {
      // Lazy import of prisma client to avoid eagerly initializing DB pool during build
      const { prisma } = await import("@/lib/prisma");

      const dbCheck = Promise.race([
        prisma.$queryRaw`SELECT 1`.then(() => true),
        new Promise<false>((_, reject) =>
          setTimeout(() => reject(new Error("Database readiness probe timed out")), 3000),
        ),
      ]);

      await dbCheck;

      return Response.json(
        {
          status: "ok",
          timestamp: new Date().toISOString(),
          checks: {
            process: "alive",
            database: "healthy",
          },
        },
        { status: 200, headers },
      );
    } catch {
      return Response.json(
        {
          status: "degraded",
          timestamp: new Date().toISOString(),
          checks: {
            process: "alive",
            database: "unhealthy",
          },
        },
        { status: 503, headers },
      );
    }
  }

  // Default: Process Liveness
  return Response.json(
    {
      status: "ok",
      timestamp: new Date().toISOString(),
      checks: {
        process: "alive",
      },
    },
    {
      status: 200,
      headers,
    },
  );
}
