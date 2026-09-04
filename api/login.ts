import {
  createSessionCookie,
  DASHBOARD_PASSWORD_ENV,
  requiredSecret,
  SESSION_SECRET_ENV,
  validDashboardPassword,
} from "../src/hosted/auth.ts";

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const supplied = form.get("password");
    const password = requiredSecret(DASHBOARD_PASSWORD_ENV);
    const secret = requiredSecret(SESSION_SECRET_ENV);
    if (typeof supplied !== "string" || !(await validDashboardPassword(supplied, password))) {
      return Response.redirect(new URL("/login?error=1", request.url), 303);
    }
    return new Response(null, {
      status: 303,
      headers: {
        location: "/",
        "set-cookie": await createSessionCookie(secret),
        "cache-control": "no-store",
      },
    });
  } catch {
    return Response.redirect(new URL("/login?error=configuration", request.url), 303);
  }
}

export function GET(request: Request): Response {
  return Response.redirect(new URL("/login", request.url), 303);
}
